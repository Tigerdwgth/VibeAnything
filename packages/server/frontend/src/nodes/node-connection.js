import { createSessionRefresher, REFRESH_INTERVAL_MS } from '../session-refresh';
import { mergeActiveSessions } from '../session-merge';
import { parseWsMessage } from '../ws-message';
import { nodeEndpoint } from './node-store';

export const EMPTY_NODE = { status: 'auth', sessions: [], machines: [], username: '', role: '', lastSeen: null, ws: null, error: '' };

export async function loginNode(url, username, password, signal) {
  const response = await fetch(nodeEndpoint(url, 'api/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }), signal, credentials: 'omit',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? '用户名或密码错误' : (body?.error || `登录失败（${response.status}）`));
  if (!body?.token) throw new Error('该地址没有返回有效的 VibeAnything 登录信息');
  return body;
}

// 一个节点一条连接、一份续期状态。退出/移除该节点只释放它自己的资源。
export function connectNode({ url, token: initialToken, onChange, onToken, onExpired }) {
  let token = initialToken;
  let state = { ...EMPTY_NODE, status: 'connecting' };
  let socket = null;
  let disposed = false;
  let expired = false;
  let reconnectTimer;
  let handshakeTimer;
  let delay = 1000;
  const pending = new Set();
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  };
  const refresher = createSessionRefresher({
    getToken: () => disposed ? null : token,
    onToken: fresh => { token = fresh; onToken(fresh); },
    onExpired: () => {
      expired = true;
      token = '';
      clearTimeout(reconnectTimer);
      socket?.close();
      publish({ ...EMPTY_NODE, error: '登录已过期，请重新登录此节点' });
      onExpired();
    },
    fetchImpl: async (path, options) => {
      const controller = new AbortController();
      pending.add(controller);
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        return await fetch(nodeEndpoint(url, path), { ...options, signal: controller.signal, credentials: 'omit' });
      } finally {
        clearTimeout(timer);
        pending.delete(controller);
      }
    },
  });

  function scheduleReconnect() {
    if (disposed || expired) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      delay = Math.min(delay * 2, 30_000);
      connect();
    }, delay);
  }

  function connect() {
    if (disposed || expired) return;
    const endpoint = new URL(nodeEndpoint(url, 'ws'));
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('token', token);
    // 默认与主看板相同，仅看自己和共享给自己的会话；管理员可在节点卡片切换范围。
    endpoint.searchParams.set('ownOnly', state.ownOnly === false ? '0' : '1');
    publish({ status: 'connecting', ws: null, error: '' });
    try { socket = new WebSocket(endpoint.href); } catch {
      publish({ status: 'offline', error: '无法建立连接，请检查节点地址和 HTTPS 配置' });
      scheduleReconnect();
      return;
    }
    const current = socket;
    handshakeTimer = setTimeout(() => current.close(), 10_000);
    current.onmessage = event => {
      if (disposed || current !== socket) return;
      const msg = parseWsMessage(event);
      if (!msg || msg.type === 'pty_data') return;
      if (msg.type === 'whoami') {
        clearTimeout(handshakeTimer);
        delay = 1000;
        publish({ status: 'online', ws: current, sessions: [], machines: [], username: msg.username,
          role: msg.role, lastSeen: Date.now(), error: '', deniedSession: null, deniedMachine: null });
      } else if (msg.type === 'machine_list') {
        const machines = msg.machines || [];
        const ids = new Set(machines.map(m => m.machineId));
        publish({ machines, sessions: state.sessions.filter(s => ids.has(s.machineId)), lastSeen: Date.now() });
      } else if (msg.type === 'session_list') {
        publish({ sessions: (msg.sessions || []).map(s => ({ ...s, sessionId: s.sessionId || s.id })), lastSeen: Date.now() });
      } else if (msg.type === 'active_sessions') {
        publish({ sessions: mergeActiveSessions(state.sessions, msg.sessions, msg.machineId), lastSeen: Date.now() });
      } else if (msg.type === 'hook_event' && msg.hookState) {
        publish({ sessions: state.sessions.map(s => s.machineId === msg.machineId &&
          (s.sessionId === msg.sessionId || s.sessionId === msg.tmuxSession)
          ? { ...s, isRunning: msg.hookState === 'running' } : s), lastSeen: Date.now() });
      } else if (msg.type === 'pty_error') {
        publish({ error: msg.error || '终端操作失败', deniedSession: msg.sessionId, deniedMachine: msg.machineId });
      }
    };
    current.onclose = async event => {
      clearTimeout(handshakeTimer);
      if (disposed || expired || current !== socket) return;
      publish({ status: 'offline', ws: null, error: '连接中断，正在自动重连' });
      if (event.code === 4001) await refresher.refresh();
      scheduleReconnect();
    };
    current.onerror = () => {}; // close 负责重试；错误信息留在对应节点。
  }

  const refreshTimer = setInterval(() => refresher.refresh(), REFRESH_INTERVAL_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible' && refresher.dueOnVisible()) refresher.refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  // 在线连接不因换票重建；下一次握手读取最新 token。
  connect();
  refresher.refresh();
  return {
    setToken(next) { token = next; },
    setOwnOnly(ownOnly) {
      if (state.status !== 'online') return;
      publish({ ownOnly, sessions: [], error: '', deniedSession: null, deniedMachine: null });
      socket.send(JSON.stringify({ type: 'set_visibility_scope', ownOnly }));
    },
    dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(handshakeTimer);
      clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisible);
      for (const controller of pending) controller.abort();
      socket?.close();
    },
  };
}
