import { useState, useEffect, useRef, useMemo } from 'react';
import TerminalPanel from './TerminalPanel';
import AddUser from './AddUser';
import MachinesPanel from './MachinesPanel';
import NoticeStack from './NoticeStack';
import useNotices from './useNotices';
import useBuildWatch from './useBuildWatch';
// 点小人打开会话时要拼启动命令（与侧栏点会话走同一套规则）
import { getRunningSessionCommand } from './session-list-utils';
import SessionTabs from './SessionTabs';
import PixelView from './PixelView';
import MarkdownPreview from './MarkdownPreview';
import MachineSelector from './MachineSelector';
import ChangePasswordModal from './ChangePasswordModal';
import ProfileModal from './ProfileModal';
import Avatar from './Avatar';
import { displayNameOf } from './profile';
import UsagePanel from './UsagePanel';
import { useTheme } from './theme';
import useResizable from './useResizable';
import { playSound, isSoundEnabled, setSoundEnabled } from './sound';
import { createSessionId, getLaunchCommand } from './launch-config';
import { FULL_VIEWPORT_HEIGHT } from './mobile-layout-config';
import { resolveDefaultMachine, loadPreferredMachine, savePreferredMachine, loadHideOthers, saveHideOthers } from './machine-prefs';
import { mergeActiveSessions } from './session-merge';

// 顶栏胶囊按钮：三处（隐藏他人会话 / 视图切换 / 并列）同款，只有选中态不同
const pillStyle = (T, active) => ({
  background: active ? T.accentDim : 'none',
  border: `1px solid ${active ? T.borderAccent : 'transparent'}`,
  color: active ? T.accent : T.textMuted,
  borderRadius: T.radiusPill,
  cursor: 'pointer', padding: '3px 12px',
  fontSize: '0.72rem', fontWeight: 500,
  fontFamily: T.fontSans,
  transition: 'all 0.15s',
});

// 分屏工具条的四个方向。「新建」与「切换」两组共用同一份定义 ——
// 新建走 tmux split-window（切出新窗格），切换走 tmux select-pane（只挪焦点）。
const SPLIT_DIRECTIONS = [
  { key: 'up', arrow: '↑', zh: '上' },
  { key: 'down', arrow: '↓', zh: '下' },
  { key: 'left', arrow: '←', zh: '左' },
  { key: 'right', arrow: '→', zh: '右' },
];

// 「新建 / 切换」这类组内小标签：比 SPLIT 主标签更弱，只用来分隔两组同形箭头
const splitGroupLabelStyle = (T) => ({
  fontSize: '0.62rem',
  color: T.textMuted,
  opacity: 0.75,
  marginLeft: '2px',
});

// 分屏工具条按钮：9 个按钮同款，只有「删除」用危险色区分
const splitBtnStyle = (T, enabled, { danger = false } = {}) => ({
  background: enabled ? (danger ? T.dangerDim : 'none') : T.bgCard,
  border: `1px solid ${enabled ? (danger ? T.danger : 'transparent') : T.border}`,
  color: enabled ? (danger ? T.danger : T.textSecondary) : T.textMuted,
  borderRadius: T.radiusPill,
  cursor: enabled ? 'pointer' : 'not-allowed',
  // 箭头是等宽符号，给个 minWidth 让 9 个按钮排出来是齐的
  padding: '3px 8px',
  minWidth: '26px',
  fontSize: '0.72rem',
  fontWeight: 500,
  fontFamily: T.fontSans,
  opacity: enabled ? 1 : 0.65,
  transition: 'all 0.15s',
});

export default function Dashboard({ token, onLogout, onAuthFailed, onTokenRenewed, isDark, onToggleTheme }) {
  const T = useTheme();
  const sidebar = useResizable({ min: 160, max: 400, defaultWidth: 240 });
  const [sessions, setSessions]             = useState([]);
  const [onlineMachines, setOnlineMachines] = useState([]); // 在线机器列表（独立于 session）
  const [activeSessions, setActiveSessions] = useState([]);
  const [foldersByMachine, setFoldersByMachine] = useState({}); // { [machineId]: [{id,name,parentId}] }
  const [historySessions, setHistorySessions] = useState([]);
  const [active, setActive]                 = useState(null);
  const [wsReady, setWsReady]               = useState(false);
  const [showAddUser, setShowAddUser]       = useState(false);
  const [showMachines, setShowMachines]     = useState(false);   // 开发机台账（仅管理员）
  const [viewMode, setViewMode]             = useState('terminal');
  // 行内提示（替掉 alert：Dashboard 开一整天，弹窗会把整个标签页阻塞到有人点确定）
  const { notices, notify, dismiss } = useNotices();
  const [mdPreview, setMdPreview]           = useState(null); // { path, content } or null
  const [openTerminals, setOpenTerminals]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('openTerminals') || '[]'); } catch { return []; }
  }); // [{machineId, sessionId, cwd, command}]
  const openTerminalsRef = useRef([]);
  useEffect(() => { openTerminalsRef.current = openTerminals; }, [openTerminals]);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  // 线上换了前端产物（部署只 rsync dist、不重启服务）→ 提示这个开着好几天的标签页去刷新。
  // 不自动刷：页面上可能有没发出去的输入框内容，什么时候重载由用户决定。
  useBuildWatch(() => notify('前端有新版本已上线', 'info', {
    sticky: true, actionLabel: '刷新', onAction: () => window.location.reload(),
  }));
  // 持久化到 localStorage
  useEffect(() => {
    localStorage.setItem('openTerminals', JSON.stringify(openTerminals));
  }, [openTerminals]);
  const [isMobile, setIsMobile]             = useState(() => window.innerWidth < 768);
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // 提示音开关：按浏览器记忆（见 sound.js），默认静音，想听提醒的那台自己打开
  const [soundOn, setSoundOn]               = useState(isSoundEnabled);
  const [selectedMachine, setSelectedMachine] = useState(() => loadPreferredMachine() || '');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  // 个人信息（昵称 / 头像）。走 HTTP 而不是 whoami：昵称改完要立刻生效，
  // 而 whoami 来自要隔很久才续期的 JWT，那里塞不进会变的字段。
  const [profile, setProfile] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);   // 由 relay 连接时下发的 whoami 决定
  const [username, setUsername] = useState('');    // 同上，用量面板「仅我」要用
  // 管理员的「隐藏他人会话」开关：默认开着 —— 管理员日常只关心自己的窗口。
  // 真正的隐藏在服务端（relay 不再下发他人会话的列表 / PTY 流 / hook 事件），
  // 这里只是记住选择并同步给 relay。
  const [hideOthers, setHideOthers] = useState(loadHideOthers);
  const wsRef = useRef(null);
  // 重连要用最新的票：续期会换票，而连接的 effect 只建一次（换票不能让终端断线重连），
  // 闭包里的 token 会过时。
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  const authCallbacksRef = useRef({ onAuthFailed });
  useEffect(() => { authCallbacksRef.current = { onAuthFailed }; });
  // ws 的 onmessage 是建连那一刻的闭包，而 notify 每次渲染都是新函数 —— 走 ref 拿最新的那个
  const notifyRef = useRef(notify);

  const machines = useMemo(() => {
    // 优先用服务器推送的在线机器列表；session 里的机器作为补充
    const map = new Map();
    onlineMachines.forEach(m => map.set(m.machineId, { machineId: m.machineId, sessionCount: 0, defaultWorkDir: m.defaultWorkDir || '' }));
    sessions.forEach(s => {
      if (!map.has(s.machineId)) map.set(s.machineId, { machineId: s.machineId, sessionCount: 0 });
      map.get(s.machineId).sessionCount++;
    });
    return Array.from(map.values());
  }, [onlineMachines, sessions]);

  const filteredSessions = useMemo(() => {
    if (!selectedMachine) return sessions;
    return sessions.filter(s => s.machineId === selectedMachine);
  }, [sessions, selectedMachine]);

  const activeTerminal = useMemo(() => {
    if (!active) return null;
    return openTerminals.find(t =>
      t.sessionId === active.sessionId && t.machineId === active.machineId
    ) || null;
  }, [active, openTerminals]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 拉个人信息。拉不到不算错：侧边栏会退回「用户名 + 默认头像」，
  // 这条链路挂了不该把整个面板拦在门外。
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(p => { if (!cancelled && p) setProfile(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  // 关闭一个 tab（不杀进程）。不读闭包里的 openTerminals/active —— ws 消息回调
  // （归属被拒时自动关窗）拿到的是首次渲染的旧闭包，必须走 ref + 函数式更新。
  function closeTerminal(machineId, sessionId) {
    const remaining = openTerminalsRef.current.filter(t => t.sessionId !== sessionId);
    setOpenTerminals(remaining);
    setActive(cur => cur?.sessionId !== sessionId ? cur
      : (remaining[0] ? { machineId: remaining[0].machineId, sessionId: remaining[0].sessionId } : null));
  }

  useEffect(() => {
    let reconnectTimer = null;
    let reconnectDelay = 1000;  // 起始 1s，指数退避
    const MAX_RECONNECT_DELAY = 30_000;
    let disposed = false;

    function createWs() {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const basePath = location.pathname.replace(/\/+$/, '');
      // ownOnly 随握手带上（原因见 relay.js 的浏览器连接处）。直接读偏好而不是读
      // state：切开关时同步写了偏好，两者恒等，这样也不必把 hideOthers 放进 deps 重连。
      const scope = loadHideOthers() ? '1' : '0';
      const wsUrl = `${proto}://${location.host}${basePath}/ws?token=${tokenRef.current}&ownOnly=${scope}`;
      console.log('[dashboard] WebSocket connecting to:', wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[dashboard] WebSocket connected');
        setWsReady(true);
        reconnectDelay = 1000;  // 连接成功，重置退避
        ws.send(JSON.stringify({ type: 'scan_history', machineId: '_all' }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          console.log('[dashboard] ←', msg.type);
          if (msg.type === 'whoami')        { setIsAdmin(msg.role === 'admin'); setUsername(msg.username || ''); }
          if (msg.type === 'session_list')    setSessions(msg.sessions || []);
          if (msg.type === 'machine_list')    setOnlineMachines(msg.machines || []);
          if (msg.type === 'active_sessions') {
            // 按 machineId 分区合并（规则与手机版共用，见 session-merge.js）
            setActiveSessions(prev => mergeActiveSessions(prev, msg.sessions, msg.machineId));
          }
          if (msg.type === 'folders') {
            // 按 machineId 分区合并：每条 folders 消息携带一台机器的全量文件夹树，只替换该机器
            const mid = msg.machineId;
            setFoldersByMachine(prev => ({ ...prev, [mid]: msg.folders || [] }));
          }
          if (msg.type === 'rename_error') {
            notifyRef.current(`重命名失败：${msg.error || '未知错误'}`, 'error');
          }
          if (msg.type === 'folder_error') {
            // 文件夹归属被拒：多半是别人的分组，或管理员切了隐藏后动到无权的旧节点
            notifyRef.current(`文件夹操作失败：${msg.error || '未知错误'}`, 'error');
          }
          if (msg.type === 'session_history') {
            const mid = msg.machineId;
            const incoming = (msg.sessions || []).map(s => ({ ...s, machineId: s.machineId || mid }));
            setHistorySessions(prev => [...prev.filter(s => s.machineId !== mid), ...incoming]);
          }
          if (msg.type === 'session_deleted') setHistorySessions(prev => prev.filter(s => s.sessionId !== msg.sessionId));
          if (msg.type === 'file_content') {
            if (msg.error) { notifyRef.current(`文件读取失败：${msg.error}`, 'error'); }
            else { setMdPreview({ path: msg.path, content: msg.content }); setViewMode('markdown'); }
          }
          if (msg.type === 'hook_event') {
            playSound(msg.hookEvent);
            // 乐观更新红绿灯：hookState 为 running/done 时即时改对应会话的 isRunning，
            // 不必等下一轮 active_sessions（后端 2.5s 轮询也会兜底刷新）。
            if (msg.hookState && msg.sessionId) {
              const running = msg.hookState === 'running';
              setActiveSessions(prev => prev.map(s =>
                s.sessionId === msg.sessionId ? { ...s, isRunning: running } : s
              ));
            }
            window.dispatchEvent(new CustomEvent('hook:event', { detail: msg }));
          }
          if (msg.type === 'pty_error') {
            if (msg.action === 'split') {
              notifyRef.current(`tmux 分屏失败：${msg.error}`, 'error');
            } else if (msg.action === 'kill_pane') {
              notifyRef.current(`删除分屏失败：${msg.error}`, 'error');
            } else if (msg.action === 'select_pane') {
              // 切换焦点失败只是没动，不值得打断用户
              console.warn('[dashboard] 切换分屏失败:', msg.error);
            } else if (msg.sessionId) {
              // 会话归属鉴权拒绝：不弹窗。localStorage 里可能存着隔离前打开的旧 tab，
              // 每次重连都会重发 open_terminal，弹窗会被刷屏。
              // 直接关掉这个无权会话的 tab，避免它无限重试。
              console.warn('[dashboard] 会话操作被拒:', msg.action, msg.sessionId, msg.error);
              closeTerminal(msg.machineId, msg.sessionId);
            }
          }
        } catch {}
      };

      ws.onerror = (e) => console.error('[dashboard] WebSocket error:', e);

      ws.onclose = (e) => {
        console.log('[dashboard] WebSocket closed:', e.code, e.reason);
        setWsReady(false);
        if (e.code === 4001) {
          // 票失效不等于登录失效：多半只是改过密码 / 服务端撤销了旧版本，先续期换票。
          // 真被撤销时续期被拒，App 会退出登录，本组件卸载后 disposed 为真，不再重连。
          Promise.resolve(authCallbacksRef.current.onAuthFailed()).then((fresh) => {
            if (fresh) tokenRef.current = fresh;
            scheduleReconnect();
          });
          return;
        }
        // 其他关闭 → 自动重连（指数退避）
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (disposed) return;
      console.log(`[dashboard] ${reconnectDelay / 1000}s 后自动重连...`);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        createWs();
      }, reconnectDelay);
    }

    createWs();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 在线机器列表到达/变化后确定默认开发机：优先用户上次的选择，其次主力开发机 macmini。
  // 选中的机器掉线时也在这里回落，避免侧边栏与目录树空着却没有任何提示。
  useEffect(() => {
    const resolved = resolveDefaultMachine(machines, loadPreferredMachine());
    if (resolved !== selectedMachine) setSelectedMachine(resolved);
  }, [machines]); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseMachine(mid) {
    setSelectedMachine(mid);
    savePreferredMachine(mid);
  }

  // 管理员切换「隐藏他人会话」。服务端才是权威：relay 收到后会摘掉他人会话的订阅、
  // 回 pty_error 关掉已打开的他人窗口，并按新范围重推列表。
  // 本地先清空列表只为即时反馈，紧接着就会被服务端下发的数据覆盖。
  function toggleHideOthers() {
    const next = !hideOthers;
    setHideOthers(next);
    saveHideOthers(next);
    setSessions([]);
    setActiveSessions([]);
    sendWs({ type: 'set_visibility_scope', ownOnly: next });
  }

  // 「现在该对哪台机器操作」的唯一答案：选中的机器；选了「所有开发机」时取第一台在线的。
  // 各处再各写一条回退链会各给各的答案（历史上回退到过并不存在的 'local-dev'）。
  function currentMachineId() {
    return selectedMachine || resolveDefaultMachine(machines, null);
  }

  function openTerminal(machineId, sessionId, command, cwd) {
    const isResume = command?.includes('--resume');
    const exists = openTerminals.some(t => t.sessionId === sessionId);
    const launchCommand = getLaunchCommand(command);
    if (!exists) {
      setOpenTerminals(prev => [...prev, { machineId, sessionId, cwd, command: launchCommand }]);
      // open_terminal 由 TerminalPanel useEffect 在注册 listener 后发送（保证时序）
      // 乐观更新：恢复的 session 立即出现在运行中 Tab
      if (isResume) {
        setActiveSessions(prev => {
          if (prev.some(s => s.sessionId === sessionId)) return prev;
          return [...prev, { sessionId, machineId, cwd, mtime: new Date().toISOString(), _optimistic: true }];
        });
        setTimeout(() => {
          setActiveSessions(prev => prev.filter(s => !(s.sessionId === sessionId && s._optimistic)));
        }, 10000);
      }
    }
    setActive({ machineId, sessionId });
    setViewMode('terminal');
    if (isMobile) setMobileMenuOpen(false);
  }

  function launchInDir(cwd, command, overrideMachineId) {
    // FileBrowser 传入 overrideMachineId 时优先使用（保证目录树选择的机器与启动目标一致）
    const mid = overrideMachineId || currentMachineId();
    const launchCommand = getLaunchCommand(command);
    const sessionId = createSessionId(launchCommand);
    openTerminal(mid, sessionId, launchCommand, cwd);
  }

  function previewMd(filePath) {
    const mid = currentMachineId();
    wsRef.current?.send(JSON.stringify({ type: 'read_file', machineId: mid, path: filePath }));
  }

  function deleteSession(machineId, sessionId) {
    if (!confirm('确定删除此 session？')) return;
    wsRef.current?.send(JSON.stringify({ type: 'delete_session', machineId, sessionId }));
    setHistorySessions(prev => prev.filter(s => s.sessionId !== sessionId));
  }

  function stopSession(machineId, sessionId) {
    if (!confirm('确定停止此 session？claude 进程将被终止。')) return;
    wsRef.current?.send(JSON.stringify({ type: 'stop_terminal', machineId, sessionId }));
    setOpenTerminals(prev => prev.filter(t => t.sessionId !== sessionId));
    setActiveSessions(prev => prev.filter(s => s.sessionId !== sessionId));
    if (active?.sessionId === sessionId) setActive(null);
  }

  // ── 会话重命名 + 文件夹分组 ──────────────────────────────────
  function sendWs(payload) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
  function renameSession(machineId, sessionId, newName) {
    const name = String(newName || '').trim();
    if (!name) return;
    // 真改 tmux 名 → sessionId 会变，不做乐观改名，等服务器回推刷新
    sendWs({ type: 'rename_session', machineId, sessionId, newName: name });
  }
  function moveSession(machineId, sessionId, folderId) {
    const fid = folderId || null;
    sendWs({ type: 'move_session', machineId, sessionId, folderId: fid });
    setActiveSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, folderId: fid } : s));
  }
  function createFolder(machineId, name, parentId) {
    sendWs({ type: 'create_folder', machineId, name: name || '新文件夹', parentId: parentId || null });
  }
  function renameFolder(machineId, folderId, newName) {
    const name = String(newName || '').trim();
    if (!name) return;
    sendWs({ type: 'rename_folder', machineId, folderId, newName: name });
    setFoldersByMachine(prev => ({
      ...prev,
      [machineId]: (prev[machineId] || []).map(f => f.id === folderId ? { ...f, name } : f),
    }));
  }
  function deleteFolder(machineId, folderId) {
    sendWs({ type: 'delete_folder', machineId, folderId });
  }
  function moveFolder(machineId, folderId, parentId) {
    const pid = parentId || null;
    sendWs({ type: 'move_folder', machineId, folderId, parentId: pid });
    setFoldersByMachine(prev => ({
      ...prev,
      [machineId]: (prev[machineId] || []).map(f => f.id === folderId ? { ...f, parentId: pid } : f),
    }));
  }

  function splitActiveTerminal(direction) {
    const currentWs = wsRef.current;
    if (!activeTerminal) {
      notify('请先点一个终端，再分屏');
      return;
    }
    if (currentWs?.readyState !== WebSocket.OPEN) {
      notify('还没连上服务器，无法分屏', 'error');
      return;
    }

    currentWs.send(JSON.stringify({
      type: 'split_terminal',
      machineId: activeTerminal.machineId,
      sessionId: activeTerminal.sessionId,
      direction,
      cwd: activeTerminal.cwd,
    }));
  }

  // 在已有分屏之间移动焦点。tmux 到边界会回绕到另一头，只有一个窗格时原地不动，
  // 两种情况都不报错，所以这里不需要额外判定。
  // 分屏工具条的可用性：要有激活的终端，且 ws 通着（9 个按钮同一个条件）
  const splitEnabled = !!activeTerminal && wsReady;

  function selectPane(direction) {
    const currentWs = wsRef.current;
    if (!activeTerminal || currentWs?.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({
      type: 'select_pane',
      machineId: activeTerminal.machineId,
      sessionId: activeTerminal.sessionId,
      direction,
    }));
  }

  // 删除当前分屏。会连里面跑着的进程一起收掉，所以先确认。
  // 只剩一个窗格时删掉等于结束整个会话 —— 那由开发机侧拒绝并回一条 pty_error，
  // 不在这里猜（前端拿不到实时的 pane 数）。
  function killActivePane() {
    const currentWs = wsRef.current;
    if (!activeTerminal || currentWs?.readyState !== WebSocket.OPEN) return;
    if (!window.confirm('删除当前分屏？该窗格内正在运行的进程会一起结束。')) return;
    currentWs.send(JSON.stringify({
      type: 'kill_pane',
      machineId: activeTerminal.machineId,
      sessionId: activeTerminal.sessionId,
    }));
  }

  // 向当前激活的终端发送 /model <model>，快速切换模型省 token。
  // 先 Ctrl+C 打断当前输出回到输入框（和 /clear、/compact 按钮同一套路），再发命令。
  // Claude Code 切模型会弹 y/n 确认（实测需要多按一次回车），这里隔 1.2s / 2.6s 各补一个
  // 回车兜底确认 —— 空回车在提示符处无副作用，早发被吞掉第二发还能接住，不用用户再手摁。
  function sendModelCommand(model) {
    const t = activeTerminal;
    const currentWs = wsRef.current;
    if (!t || currentWs?.readyState !== WebSocket.OPEN) return;
    const encode = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    const payload = (data) => JSON.stringify({
      type: 'terminal_input',
      machineId: t.machineId,
      sessionId: t.sessionId,
      data: encode(data),
    });
    currentWs.send(payload('\x03'));
    setTimeout(() => {
      if (currentWs.readyState !== WebSocket.OPEN) return;
      currentWs.send(payload(`/model ${model}\r`));
      // 确认 y/n 提示（两次兜底，覆盖慢速场景；已确认的话多余回车在提示符处是空操作）
      [1200, 2600].forEach((delay) => {
        setTimeout(() => {
          if (currentWs.readyState === WebSocket.OPEN) currentWs.send(payload('\r'));
        }, delay);
      });
    }, 60);
  }

  const machineId = sessions[0]?.machineId || activeSessions[0]?.machineId;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
        .sidebar-btn:hover { background: ${T.bgHover} !important; color: ${T.textPrimary} !important; }
        .view-pill:hover { background: ${T.bgHover} !important; }
        .topbar-btn:hover { background: ${T.bgHover} !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideIn { from{opacity:0;transform:translateX(-8px)} to{opacity:1;transform:translateX(0)} }
        @media (max-width: 768px) {
          button, [role="button"], a { min-height: 44px; min-width: 44px; }
          /* 会话/历史列表里的小图标按钮（✕ 关闭 / ■ 停止 / 新建文件夹）不撑成 44px，
             否则整行标题被挤到只剩省略号、文字全部看不见 */
          .sess-item button, .hist-item button, .folder-add-btn { min-width: 0; min-height: 0; }
          /* 手机端没有 hover，历史会话的操作按钮（▶新建/↩恢复/✕删除）常显，否则点了没反应 */
          .hist-actions { opacity: 1 !important; }
          .sess-item { padding: 0.5rem 0.6rem !important; }
        }
      `}</style>

      <div style={{
        display: 'flex', height: FULL_VIEWPORT_HEIGHT,
        background: T.bgBase, color: T.textPrimary,
        fontFamily: T.fontSans, overflow: 'hidden',
      }}>
        {/* 移动端汉堡按钮 */}
        {isMobile && (
          <button onClick={() => setMobileMenuOpen(true)}
            style={{
              position: 'fixed', top: 8, left: 8, zIndex: 1001,
              background: T.bgCard, border: `1px solid ${T.border}`,
              color: T.textPrimary, borderRadius: T.radiusSm,
              cursor: 'pointer', padding: '6px 10px', fontSize: '1rem',
            }}>
            ☰
          </button>
        )}

        {/* 移动端遮罩层 */}
        {isMobile && mobileMenuOpen && (
          <div onClick={() => setMobileMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999 }} />
        )}

        {/* ── 左侧面板 ── */}
        <div style={{
          width: isMobile ? '280px' : `${sidebar.width}px`,
          flexShrink: 0,
          background: T.bgPanel,
          borderRight: `1px solid ${T.border}`,
          display: 'flex', flexDirection: 'column',
          transition: sidebar.dragging ? 'none' : 'width 0.2s ease, transform 0.25s ease',
          overflow: 'hidden', position: isMobile ? 'fixed' : 'relative',
          ...(isMobile ? {
            top: 0, left: 0, bottom: 0, zIndex: 1000,
            transform: mobileMenuOpen ? 'translateX(0)' : 'translateX(-100%)',
            boxShadow: mobileMenuOpen ? '4px 0 24px rgba(0,0,0,0.5)' : 'none',
          } : {}),
          animation: isMobile ? 'none' : 'slideIn 0.3s ease',
        }}>
          {/* 折叠按钮 */}
          <button
            onClick={sidebar.toggle}
            style={{
              position: 'absolute', top: '8px', right: '6px', zIndex: 2,
              background: 'none', border: 'none', color: T.textMuted,
              cursor: 'pointer', fontSize: '0.8rem', padding: '2px 4px',
              borderRadius: T.radiusSm, transition: 'color 0.15s',
            }}
            title={sidebar.collapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {sidebar.collapsed ? '›' : '‹'}
          </button>
          {/* 顶部 Logo + 状态 */}
          <div style={{
            padding: '0.875rem 1rem',
            borderBottom: `1px solid ${T.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
              <img
                src="/usagi.png" alt="VibeAnything" draggable={false}
                style={{
                  width: '26px', height: '26px', borderRadius: '6px',
                  objectFit: 'cover', flexShrink: 0, userSelect: 'none',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '0.875rem', letterSpacing: '-0.01em', display: sidebar.collapsed ? 'none' : 'inline' }}>VibeAnything</span>
            </div>

            {/* 连接状态 badge */}
            {!sidebar.collapsed && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '3px 8px', borderRadius: T.radiusPill,
              background: wsReady ? T.successDim : T.dangerDim,
              border: `1px solid ${wsReady ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
              fontSize: '0.7rem', fontWeight: 500,
              color: wsReady ? T.success : T.danger,
            }}>
              <span style={{
                width: '5px', height: '5px', borderRadius: '50%',
                background: wsReady ? T.success : T.danger,
                animation: wsReady ? 'none' : 'pulse 1.5s infinite',
                display: 'inline-block',
              }} />
              {wsReady ? (machineId || '已连接') : '连接中…'}
            </div>
            )}

            {/* 当前用户：头像 + 昵称，点开改自己的个人信息。
                profile 还没拉回来时用 whoami 给的用户名顶上，头像自然是默认那只兔子 ——
                这一行不该出现「先空着、拉回来再冒出来」的跳变。 */}
            <button
              type="button"
              className="sidebar-btn"
              onClick={() => setShowProfileModal(true)}
              title="个人信息"
              aria-label="个人信息"
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                width: '100%', marginTop: '0.6rem', padding: '4px 6px',
                background: 'none', border: '1px solid transparent',
                borderRadius: T.radiusSm, cursor: 'pointer',
                color: T.textSecondary, fontFamily: T.fontSans,
                justifyContent: sidebar.collapsed ? 'center' : 'flex-start',
                transition: 'all 0.15s',
              }}
            >
              <Avatar profile={profile || { username }} size={22} radius="50%" />
              {!sidebar.collapsed && (
                <span style={{
                  flex: 1, minWidth: 0, textAlign: 'left',
                  fontSize: '0.78rem', fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{displayNameOf(profile || { username }) || '未登录'}</span>
              )}
            </button>
          </div>

          {/* 工具栏 */}
          {!sidebar.collapsed && (
          <div style={{
            padding: '0.5rem 0.75rem',
            borderBottom: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: '4px',
          }}>
            <span style={{
              flex: 1, fontSize: '0.68rem', fontWeight: 600,
              color: T.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>Sessions</span>
            <button
              className="sidebar-btn"
              onClick={() => setShowPasswordModal(true)}
              title="修改密码"
              aria-label="修改密码"
              style={{
                background: 'none', border: '1px solid transparent',
                color: T.textMuted, borderRadius: T.radiusSm,
                cursor: 'pointer', padding: '3px 6px', fontSize: '0.78rem',
                transition: 'all 0.15s',
              }}>🔑</button>
            <button
              className="sidebar-btn"
              onClick={() => setShowAddUser(true)}
              title="添加用户"
              aria-label="添加用户"
              style={{
                background: 'none', border: '1px solid transparent',
                color: T.textMuted, borderRadius: T.radiusSm,
                cursor: 'pointer', padding: '3px 6px', fontSize: '0.78rem',
                transition: 'all 0.15s',
              }}>👤</button>
            {/* 开发机台账 + 发装机邀请码。只有管理员能签发，所以按钮也只给管理员。 */}
            {isAdmin && (
            <button
              className="sidebar-btn"
              onClick={() => setShowMachines(true)}
              title="开发机（装机邀请码 / 撤销）"
              aria-label="开发机"
              style={{
                background: 'none', border: '1px solid transparent',
                color: T.textMuted, borderRadius: T.radiusSm,
                cursor: 'pointer', padding: '3px 6px', fontSize: '0.78rem',
                transition: 'all 0.15s',
              }}>🖥</button>
            )}
            <button
              className="sidebar-btn"
              onClick={() => { if (window.confirm('退出登录？下次打开要重新输密码。')) onLogout(); }}
              title="退出登录"
              aria-label="退出登录"
              style={{
                background: 'none', border: '1px solid transparent',
                color: T.textMuted, borderRadius: T.radiusSm,
                cursor: 'pointer', padding: '3px 6px', fontSize: '0.72rem',
                transition: 'all 0.15s',
              }}>⏻</button>
          </div>
          )}

          {/* Session Tabs */}
          {!sidebar.collapsed ? (
            <>
              <MachineSelector
                machines={machines}
                currentMachine={selectedMachine}
                onSelect={chooseMachine}
              />
              <SessionTabs
                token={token}
                sessions={filteredSessions}
                activeSessions={activeSessions}
                foldersByMachine={foldersByMachine}
                historySessions={historySessions}
                openTerminals={openTerminals}
                active={active}
                onOpen={openTerminal}
                onClose={closeTerminal}
                onDelete={deleteSession}
                onStop={stopSession}
                onRenameSession={renameSession}
                onMoveSession={moveSession}
                onCreateFolder={createFolder}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                onMoveFolder={moveFolder}
                ws={wsRef.current}
                machineId={currentMachineId()}
                machines={machines}
                onLaunch={launchInDir}
                onPreviewMd={previewMd}
                onSelectMachine={chooseMachine}
              />
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
              <button className="sidebar-btn" onClick={() => sidebar.toggle()} title="活跃" aria-label="活跃" style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: '1rem', padding: '6px' }}>📡</button>
              <button className="sidebar-btn" onClick={() => sidebar.toggle()} title="运行中" aria-label="运行中" style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: '1rem', padding: '6px' }}>⚡</button>
              <button className="sidebar-btn" onClick={() => sidebar.toggle()} title="历史" aria-label="历史" style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: '1rem', padding: '6px' }}>📁</button>
            </div>
          )}

          {/* 拖拽手柄：Pointer Events 统一鼠标与触屏，触摸设备加宽命中区并 touch-action:none
              （否则平板手指拖不动，侧边栏调不了宽，会话名只能被省略号截断） */}
          <div
            onPointerDown={sidebar.onPointerDown}
            onDoubleClick={sidebar.onDoubleClick}
            style={{
              position: 'absolute', right: 0, top: 0, bottom: 0,
              width: isTouchDevice ? '18px' : '6px',
              cursor: 'col-resize',
              touchAction: 'none',
              display: 'flex', alignItems: 'stretch', justifyContent: 'center',
              zIndex: 1,
            }}
          >
            <div style={{
              width: '3px', alignSelf: 'stretch',
              background: sidebar.dragging ? T.accent : 'transparent',
              transition: 'background 0.15s',
            }} />
          </div>
        </div>

        {/* ── 右侧主区域 ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* 顶栏 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: isMobile ? 'nowrap' : 'wrap',
            // 移动端左侧让出 52px 给固定定位的汉堡按钮，避免内容被盖住
            padding: isMobile ? '6px 8px 6px 52px' : '6px 12px',
            borderBottom: `1px solid ${T.border}`,
            background: T.bgPanel, flexShrink: 0,
            gap: isMobile ? '4px' : '8px',
          }}>
            {/* 分屏 —— 移动端隐藏（手机上一个终端就够用，分屏在窄屏没意义） */}
            {!isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '0.68rem', fontWeight: 600,
                color: T.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>Split</span>

              {/* 新建分屏：在当前窗格的某一侧切出一个新窗格 */}
              <span style={splitGroupLabelStyle(T)}>新建</span>
              {SPLIT_DIRECTIONS.map(({ key, arrow, zh }) => (
                <button
                  key={`new-${key}`}
                  className="topbar-btn"
                  onClick={() => splitActiveTerminal(key)}
                  disabled={!splitEnabled}
                  title={splitEnabled ? `在当前窗格${zh}侧新建分屏` : '先打开并激活一个终端'}
                  style={splitBtnStyle(T, splitEnabled)}
                >
                  {arrow}
                </button>
              ))}

              {/* 切换焦点：在已有分屏之间移动，键盘输入随之转到目标窗格 */}
              <span style={splitGroupLabelStyle(T)}>切换</span>
              {SPLIT_DIRECTIONS.map(({ key, arrow, zh }) => (
                <button
                  key={`go-${key}`}
                  className="topbar-btn"
                  onClick={() => selectPane(key)}
                  disabled={!splitEnabled}
                  title={splitEnabled ? `切换到${zh}边的分屏` : '先打开并激活一个终端'}
                  style={splitBtnStyle(T, splitEnabled)}
                >
                  {arrow}
                </button>
              ))}

              {/* 删除当前分屏 */}
              <button
                className="topbar-btn"
                onClick={killActivePane}
                disabled={!splitEnabled}
                title={splitEnabled
                  ? '删除当前分屏（窗格内运行的进程会一起结束；只剩一个窗格时不允许删）'
                  : '先打开并激活一个终端'}
                style={splitBtnStyle(T, splitEnabled, { danger: true })}
              >
                ✕
              </button>
            </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center',
              justifyContent: isMobile ? 'flex-start' : 'flex-end',
              gap: isMobile ? '2px' : '4px',
              flexWrap: 'nowrap',
              flex: isMobile ? '1 1 auto' : 'none',
              minWidth: 0,
              marginLeft: isMobile ? 0 : 'auto',
              // 一排放不下时横向滚动，保证所有按钮都够得着
              overflowX: isMobile ? 'auto' : 'visible',
              WebkitOverflowScrolling: 'touch',
            }}>
              {/* 隐藏他人会话 —— 仅管理员可见（普通用户本来就只看得到自己的） */}
              {isAdmin && (
                <button
                  className="view-pill"
                  onClick={toggleHideOthers}
                  title={hideOthers
                    ? '当前：只看我的会话。服务端已停止下发他人会话的列表、终端数据与提示音（无主会话仍显示）。点击查看全部'
                    : '当前：查看全部会话（管理员视图）。点击隐藏其他用户的会话'}
                  style={{
                    ...pillStyle(T, hideOthers),
                    padding: isMobile ? '3px 8px' : '3px 12px',
                    fontSize: isMobile ? '0.68rem' : '0.72rem',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {hideOthers ? '🙈 只看我的' : '👥 全部会话'}
                </button>
              )}
              <button
                className="view-pill"
                onClick={() => {
                  const next = !soundOn;
                  setSoundEnabled(next);
                  setSoundOn(next);
                }}
                title={soundOn
                  ? '提示音：开（只影响这台机器的浏览器，点此静音）'
                  : '提示音：关（只影响这台机器的浏览器，点此开启）'}
                style={{
                  background: 'none',
                  border: `1px solid transparent`,
                  color: T.textMuted,
                  borderRadius: T.radiusPill,
                  cursor: 'pointer',
                  padding: isMobile ? '3px 8px' : '3px 10px',
                  fontSize: isMobile ? '0.72rem' : '0.85rem',
                  transition: 'all 0.15s',
                  marginRight: '4px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {soundOn ? '🔔' : '🔕'}
              </button>
              <button
                className="view-pill"
                onClick={onToggleTheme}
                title={isDark ? '切换到日间模式' : '切换到夜间模式'}
                style={{
                  background: 'none',
                  border: `1px solid transparent`,
                  color: T.textMuted,
                  borderRadius: T.radiusPill,
                  cursor: 'pointer',
                  padding: isMobile ? '3px 8px' : '3px 10px',
                  fontSize: isMobile ? '0.72rem' : '0.85rem',
                  transition: 'all 0.15s',
                  marginRight: '4px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {isDark ? '☀' : '🌙'}
              </button>
              {/* 快速切换模型：自动向当前终端发 /model opus|fable，省 token */}
              {[
                { model: 'opus', label: 'Opus', fg: '#818cf8', bg: 'rgba(99,102,241,0.12)', bd: 'rgba(99,102,241,0.3)' },
                { model: 'fable', label: 'Fable', fg: '#fb923c', bg: 'rgba(249,115,22,0.12)', bd: 'rgba(249,115,22,0.3)' },
              ].map(({ model, label, fg, bg, bd }) => (
                <button
                  key={model}
                  className="view-pill model-pill"
                  onClick={() => sendModelCommand(model)}
                  disabled={!activeTerminal || !wsReady}
                  title={`切换模型为 ${model}（向当前终端发送 /model ${model}）`}
                  style={{
                    background: bg, border: `1px solid ${bd}`, color: fg,
                    borderRadius: T.radiusPill,
                    cursor: activeTerminal && wsReady ? 'pointer' : 'not-allowed',
                    padding: isMobile ? '3px 8px' : '3px 10px',
                    fontSize: isMobile ? '0.68rem' : '0.72rem',
                    fontWeight: 600, fontFamily: T.fontSans,
                    whiteSpace: 'nowrap', flexShrink: 0,
                    opacity: activeTerminal && wsReady ? 1 : 0.45,
                    transition: 'all 0.15s',
                  }}
                >
                  {label}
                </button>
              ))}
              {[
                { key: 'terminal', label: '⌨ 终端' },
                { key: 'pixel', label: '🎮 像素' },
                { key: 'usage', label: '📊 用量' },
                ...(mdPreview ? [{ key: 'markdown', label: '📄 预览' }] : []),
              ].map(({ key, label }) => (
                <button
                  key={key}
                  className="view-pill"
                  onClick={() => setViewMode(key)}
                  style={{
                    background: viewMode === key ? T.bgHover : 'none',
                    border: `1px solid ${viewMode === key ? T.border : 'transparent'}`,
                    color: viewMode === key ? T.textPrimary : T.textMuted,
                    borderRadius: T.radiusPill,
                    cursor: 'pointer',
                    padding: isMobile ? '3px 8px' : '3px 12px',
                    fontSize: isMobile ? '0.68rem' : '0.72rem',
                    fontWeight: 500,
                    fontFamily: T.fontSans,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    transition: 'all 0.15s',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 内容区：终端始终挂载，避免切视图时 xterm 实例被销毁 */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
            {/* 终端层（始终挂载，仅在非终端视图时隐藏） */}
            <div style={{ flex: 1, display: viewMode === 'terminal' ? 'flex' : 'none', overflow: 'hidden' }}>
              {openTerminals.map(t => (
                <TerminalPanel
                  key={t.sessionId}
                  machineId={t.machineId}
                  sessionId={t.sessionId}
                  command={t.command}
                  cwd={t.cwd}
                  ws={wsRef.current}
                  visible={active?.sessionId === t.sessionId}
                />
              ))}
              {!active && (
                <div style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'column', gap: '0.75rem',
                  color: T.textMuted,
                }}>
                  <div style={{
                    width: '56px', height: '56px', borderRadius: '14px',
                    background: T.bgCard, border: `1px solid ${T.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.5rem', marginBottom: '0.25rem',
                  }}>⌨</div>
                  <div style={{ fontSize: '0.9rem', color: T.textSecondary, fontWeight: 500 }}>
                    选择 Session 或新建终端
                  </div>
                  <div style={{ fontSize: '0.78rem', color: T.textMuted }}>
                    从左侧面板选择，或点击"目录" Tab
                  </div>
                </div>
              )}
            </div>

            {/* 像素视图层 */}
            {viewMode === 'pixel' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <PixelView activeSessions={(() => {
                  // 合并 activeSessions（服务器扫描，权威）与 openTerminals（本浏览器打开的标签）。
                  // 去重必须带 machineId：两台机器上同名 tmux 是两个会话，按 sessionId 去重
                  // 会把其中一个吃掉（小镇里就只剩一个小人）。
                  const key = (s) => `${s.machineId || 'local'}::${s.sessionId}`;
                  const merged = [...activeSessions];
                  const seen = new Set(merged.map(key));
                  for (const t of openTerminals) {
                    if (seen.has(key(t))) continue;
                    // 不在 activeSessions 里 = 这台机器上已经没有这个会话了（localStorage 里
                    // 存着几天前的死标签）。照旧显示，但标成离线，而不是假装它是个活会话。
                    merged.push({ ...t, offline: true });
                    seen.add(key(t));
                  }
                  return merged;
                })()} machines={machines} foldersByMachine={foldersByMachine} onFocusSession={(sessionId, machineId) => {
                  // 点小人 = 打开那个会话的终端。原来只 setActive 不 openTerminal ——
                  // 对一个还没开过标签的会话，切过去是一片空占位（终端层只渲染 openTerminals）。
                  const sameMachine = (s) => (s.machineId || 'local') === (machineId || 'local');
                  const found = [...openTerminals, ...activeSessions].find(s => s.sessionId === sessionId && sameMachine(s));
                  if (found) {
                    openTerminal(found.machineId, sessionId, found.command || getRunningSessionCommand(found), found.cwd);
                  } else {
                    notify('这个会话已经不在了', 'error');
                  }
                }} onCloseSession={(machineId, sessionId) => closeTerminal(machineId, sessionId)} />
              </div>
            )}

            {/* 用量层 */}
            {viewMode === 'usage' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <UsagePanel token={token} isAdmin={isAdmin} selfUsername={username} />
              </div>
            )}

            {/* Markdown 预览层 */}
            {viewMode === 'markdown' && mdPreview && (
              <div style={{ position: 'absolute', inset: 0, background: T.bgBase, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <MarkdownPreview
                  path={mdPreview.path}
                  content={mdPreview.content}
                  onClose={() => { setMdPreview(null); setViewMode('terminal'); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {showAddUser && <AddUser token={token} onClose={() => setShowAddUser(false)} />}
      {showMachines && <MachinesPanel token={token} onClose={() => setShowMachines(false)} />}
      <NoticeStack notices={notices} onDismiss={dismiss} />
      {showProfileModal && (
        <ProfileModal
          token={token}
          profile={profile || { username }}
          onClose={() => setShowProfileModal(false)}
          onSaved={setProfile}
        />
      )}
      {showPasswordModal && (
        <ChangePasswordModal
          onClose={() => setShowPasswordModal(false)}
          onSuccess={(renewedToken) => {
            setShowPasswordModal(false);
            // 改密码会让所有旧票作废；服务端给当前设备补发了新票，存下它，本设备不掉线。
            onTokenRenewed(renewedToken);
            notify('密码已修改，其他设备需要重新登录');
          }}
        />
      )}
    </>
  );
}
