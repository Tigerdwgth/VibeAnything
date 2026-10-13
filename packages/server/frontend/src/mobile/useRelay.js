import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeActiveSessions } from '../session-merge';
import { loadHideOthers } from '../machine-prefs';
import { playSound } from '../sound';

// 手机版与 relay 的连接：一条 WebSocket + 它带来的全部会话状态。
// 桌面版 Dashboard 把连接和界面揉在一个组件里，手机版把连接独立成 hook，
// 界面组件只消费状态、调用 send()。
//
// 协议与桌面版完全一致（同一个 relay、同一份 BROWSER_POLICY），差别只在
// 手机版用不到的消息（文件浏览、历史会话、分屏、用量）不订阅也不处理。

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1000;
// 乐观红绿灯：hook_event 先把灯点亮，服务端 2.5s 轮询的 active_sessions 随后覆盖
const HOOK_STATE_RUNNING = 'running';

/**
 * @param {string} token 登录 JWT
 * @param {object} handlers
 * @param {() => void} handlers.onAuthFailed      relay 回 4001（token 失效）→ 退出登录
 * @param {(machineId: string, sessionId: string) => void} [handlers.onSessionDenied]
 *        会话归属鉴权被拒：把这个会话的终端关掉，否则它会每次重连都重试
 * @param {(machineId: string, oldSessionId: string, newSessionId: string) => void} [handlers.onSessionRenamed]
 *        会话改名成功（sessionId 就是 tmux 名，改名后它会变）：把开着的标签换成新名
 */
export default function useRelay(token, { onAuthFailed, onSessionDenied, onSessionRenamed } = {}) {
  const [ws, setWs] = useState(null);
  const [wsReady, setWsReady] = useState(false);
  const [machines, setMachines] = useState([]);          // machine_list：在线开发机
  const [sessions, setSessions] = useState([]);          // session_list：hook 上报的会话
  const [activeSessions, setActiveSessions] = useState([]); // active_sessions：机器上真实存在的 tmux 会话
  const [foldersByMachine, setFoldersByMachine] = useState({}); // { [machineId]: [{id,name,parentId}] }
  // 文件夹/改名这类「没有自己的窗口」的操作出错时的行内提示（手机上不弹系统框，见下）
  const [actionError, setActionError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [username, setUsername] = useState('');
  const wsRef = useRef(null);

  // 回调放 ref：它们来自组件，每次渲染都是新函数；进 deps 会让 WS 每渲染一次就重连
  const handlersRef = useRef({ onAuthFailed, onSessionDenied, onSessionRenamed });
  useEffect(() => { handlersRef.current = { onAuthFailed, onSessionDenied, onSessionRenamed }; });

  useEffect(() => {
    if (!token) return undefined;
    let reconnectTimer = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY;
    let disposed = false;

    function handleMessage(msg) {
      if (msg.type === 'whoami') {
        setIsAdmin(msg.role === 'admin');
        setUsername(msg.username || '');
      } else if (msg.type === 'machine_list') {
        setMachines(msg.machines || []);
      } else if (msg.type === 'session_list') {
        setSessions(msg.sessions || []);
      } else if (msg.type === 'active_sessions') {
        setActiveSessions(prev => mergeActiveSessions(prev, msg.sessions, msg.machineId));
      } else if (msg.type === 'folders') {
        // 每条 folders 消息带一台机器的全量文件夹树，按 machineId 分区替换。
        // 与 active_sessions 同理：整表替换会把别的机器的文件夹清空。
        setFoldersByMachine(prev => ({ ...prev, [msg.machineId]: msg.folders || [] }));
      } else if (msg.type === 'folder_error') {
        // 桌面版这里是 alert()，手机上弹系统框会挡住半屏且要多点一次，
        // 改成把错误交给界面用行内提示显示。
        setActionError(msg.error || '文件夹操作失败');
      } else if (msg.type === 'rename_error') {
        setActionError(msg.error || '重命名失败');
      } else if (msg.type === 'session_renamed') {
        // 改名成功。会话列表由开发机随后推的 active_sessions 刷新，这里只管一件
        // 列表管不了的事：把开着的那个标签指向新名（旧名已经不存在了）。
        handlersRef.current.onSessionRenamed?.(msg.machineId, msg.oldSessionId, msg.newSessionId);
      } else if (msg.type === 'hook_event') {
        playSound(msg.hookEvent);
        if (msg.hookState && msg.sessionId) {
          const running = msg.hookState === HOOK_STATE_RUNNING;
          setActiveSessions(prev => prev.map(s =>
            s.sessionId === msg.sessionId ? { ...s, isRunning: running } : s
          ));
        }
      } else if (msg.type === 'pty_error' && msg.sessionId) {
        // 不弹窗：localStorage 里可能存着隔离前打开的旧会话，每次重连都会重发
        // open_terminal，弹窗会被刷屏。直接把这个无权会话关掉。
        console.warn('[mobile] 会话操作被拒:', msg.action, msg.sessionId, msg.error);
        handlersRef.current.onSessionDenied?.(msg.machineId, msg.sessionId);
      }
    }

    function createWs() {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const basePath = location.pathname.replace(/\/m(\/.*)?$/, '').replace(/\/+$/, '');
      // ownOnly 与桌面版共用同一份偏好：同一个浏览器里两个页面对「看谁的会话」要一致
      const scope = loadHideOthers() ? '1' : '0';
      const socket = new WebSocket(`${proto}://${location.host}${basePath}/ws?token=${token}&ownOnly=${scope}`);
      wsRef.current = socket;
      setWs(socket);

      socket.onopen = () => {
        setWsReady(true);
        reconnectDelay = INITIAL_RECONNECT_DELAY;
      };
      socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        handleMessage(msg);
      };
      socket.onerror = (e) => console.error('[mobile] WebSocket error:', e);
      socket.onclose = (e) => {
        setWsReady(false);
        if (e.code === 4001) { handlersRef.current.onAuthFailed?.(); return; }
        if (disposed) return;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
          createWs();
        }, reconnectDelay);
      };
    }

    createWs();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [token]);

  const send = useCallback((payload) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  // 停止会话：真杀进程。列表立刻移除，不等服务端回推（它下一轮扫描也会这么说）。
  const stopSession = useCallback((machineId, sessionId) => {
    send({ type: 'stop_terminal', machineId, sessionId });
    setActiveSessions(prev => prev.filter(s => s.sessionId !== sessionId));
  }, [send]);

  // ── 会话 ──
  // 真改开发机上的 tmux 名，成功后 sessionId 会跟着变（新名由开发机回的 session_renamed 给出），
  // 所以这里**不做乐观改名**：本地猜的名字和 tmux 清洗（`.`/`:`/空白 → `-`）后的结果可能不一样。
  const renameSession = useCallback((machineId, sessionId, newName) => {
    const name = String(newName || '').trim();
    if (!name) return;
    send({ type: 'rename_session', machineId, sessionId, newName: name });
  }, [send]);

  // ── 文件夹 ──
  // 乐观更新的取舍与桌面版一致：改名/移动这类纯元数据操作立刻反映到本地，
  // 新建/删除等服务端回推全量 folders（id 由服务端生成，本地造不出来）。

  const moveSession = useCallback((machineId, sessionId, folderId) => {
    const fid = folderId || null;
    send({ type: 'move_session', machineId, sessionId, folderId: fid });
    setActiveSessions(prev => prev.map(s => (s.sessionId === sessionId ? { ...s, folderId: fid } : s)));
  }, [send]);

  const createFolder = useCallback((machineId, name, parentId) => {
    send({ type: 'create_folder', machineId, name: String(name || '').trim() || '新文件夹', parentId: parentId || null });
  }, [send]);

  const renameFolder = useCallback((machineId, folderId, newName) => {
    const name = String(newName || '').trim();
    if (!name) return;
    send({ type: 'rename_folder', machineId, folderId, newName: name });
    setFoldersByMachine(prev => ({
      ...prev,
      [machineId]: (prev[machineId] || []).map(f => (f.id === folderId ? { ...f, name } : f)),
    }));
  }, [send]);

  const deleteFolder = useCallback((machineId, folderId) => {
    send({ type: 'delete_folder', machineId, folderId });
  }, [send]);

  const moveFolder = useCallback((machineId, folderId, parentId) => {
    const pid = parentId || null;
    send({ type: 'move_folder', machineId, folderId, parentId: pid });
    setFoldersByMachine(prev => ({
      ...prev,
      [machineId]: (prev[machineId] || []).map(f => (f.id === folderId ? { ...f, parentId: pid } : f)),
    }));
  }, [send]);

  const clearActionError = useCallback(() => setActionError(''), []);

  return {
    ws, wsReady, machines, sessions, activeSessions, isAdmin, username, send, stopSession,
    foldersByMachine, actionError, clearActionError,
    renameSession, moveSession, createFolder, renameFolder, deleteFolder, moveFolder,
  };
}
