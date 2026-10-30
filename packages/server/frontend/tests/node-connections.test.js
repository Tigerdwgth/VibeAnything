import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectNode } from '../src/nodes/node-connection';
import { exportNodes, importNodes, loadNodes, NODES_KEY, normalizeNodeUrl, sessionKey } from '../src/nodes/node-store';

class Socket {
  static instances = [];
  readyState = 1;
  sent = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const handles = [];
const state = {};
function open(url, token) {
  const onToken = vi.fn();
  const onExpired = vi.fn();
  const handle = connectNode({ url, token, onToken, onExpired, onChange: value => { state[url] = value; } });
  handles.push(handle);
  const ws = Socket.instances.at(-1);
  ws.receive({ type: 'whoami', username: 'alice', role: 'admin' });
  return { handle, ws, onToken, onExpired };
}
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
});
afterEach(() => { handles.splice(0).forEach(h => h.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('两个节点上的同名机器和会话分别保存，机器掉线只删除自己的会话', () => {
  const a = open('http://a:3000', 'token-a');
  const b = open('http://b:3000', 'token-b');
  for (const { ws } of [a, b]) {
    ws.receive({ type: 'machine_list', machines: [{ machineId: 'work' }] });
    ws.receive({ type: 'active_sessions', machineId: 'work', sessions: [{ sessionId: 'main', isRunning: true }] });
  }
  expect(state['http://a:3000'].sessions).toHaveLength(1);
  expect(sessionKey('http://a:3000', state['http://a:3000'].sessions[0])).not.toBe(sessionKey('http://b:3000', state['http://b:3000'].sessions[0]));
  a.ws.receive({ type: 'machine_list', machines: [] });
  expect(state['http://a:3000'].sessions).toEqual([]);
  expect(state['http://b:3000'].sessions).toHaveLength(1);
});

test('节点断线保留快照；重连使用已续期的新票，并清空上一次快照', async () => {
  fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'fresh-a' }) });
  const a = open('http://a:3000/base', 'token-a');
  a.ws.receive({ type: 'active_sessions', machineId: 'work', sessions: [{ sessionId: 'main' }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(a.onToken).toHaveBeenCalledWith('fresh-a');
  expect(fetch.mock.calls[0][0]).toBe('http://a:3000/base/api/session/refresh');
  a.ws.receive({ type: 'pty_error', sessionId: 'main', machineId: 'work', error: '机器不在线' });
  a.ws.close();
  expect(state['http://a:3000/base'].status).toBe('offline');
  expect(state['http://a:3000/base'].sessions).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.instances.at(-1).url).toContain('/base/ws?token=fresh-a');
  Socket.instances.at(-1).receive({ type: 'whoami', username: 'alice', role: 'admin' });
  expect(state['http://a:3000/base'].sessions).toEqual([]);
  expect(state['http://a:3000/base'].deniedSession).toBeNull();
});

test('401 只清除对应节点；其他节点的连接和凭据不受影响', async () => {
  fetch.mockImplementation(async url => ({ ok: false, status: url.includes('//a:') ? 401 : 503 }));
  const a = open('http://a:3000', 'token-a');
  const b = open('http://b:3000', 'token-b');
  await vi.advanceTimersByTimeAsync(0);
  expect(a.onExpired).toHaveBeenCalledOnce();
  expect(state['http://a:3000'].status).toBe('auth');
  expect(state['http://b:3000'].status).toBe('online');
  expect(b.onExpired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(Socket.instances).toHaveLength(2);
});

test('移除节点释放重连、续期、可见性监听及未完成的请求', async () => {
  let signal;
  fetch.mockImplementation((_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const a = open('http://a:3000', 'token-a');
  a.ws.close();
  a.handle.dispose();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(7 * 3600_000);
  expect(Socket.instances).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
});

test('管理员的范围选择沿用到重连；hook 仅更新指定机器的同名会话', async () => {
  const a = open('http://a:3000', 'token-a');
  a.handle.setOwnOnly(false);
  expect(a.ws.sent.at(-1)).toEqual({ type: 'set_visibility_scope', ownOnly: false });
  for (const machineId of ['one', 'two']) a.ws.receive({ type: 'active_sessions', machineId, sessions: [{ sessionId: 'main', isRunning: false }] });
  a.ws.receive({ type: 'hook_event', machineId: 'two', tmuxSession: 'main', hookState: 'running' });
  expect(state['http://a:3000'].sessions.map(s => s.isRunning)).toEqual([false, true]);
  a.ws.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.instances.at(-1).url).toContain('ownOnly=0');
});

test('导出的节点配置不带凭据；导入使用独立登录', () => {
  const exported = exportNodes([{ name: 'work', url: 'http://work:3000', token: 'secret', username: 'alice' }]);
  expect(JSON.parse(exported)).toEqual([{ name: 'work', url: 'http://work:3000' }]);
  expect(importNodes(exported)[0].token).toBe('');
  expect(normalizeNodeUrl('https://node.example/base/nodes/')).toBe('https://node.example/base');
  expect(() => normalizeNodeUrl('https://name:secret@node.example')).toThrow();
});


test('原看板改密码或退出后，总览重开时沿用同源登录的当前票据', () => {
  const saved = new Map([[NODES_KEY, JSON.stringify([{ url: 'http://a:3000', token: 'old' }, { url: 'http://b:3000', token: 'remote' }])], ['token', 'renewed']]);
  const storage = { getItem: key => saved.get(key) || null };
  expect(loadNodes(storage, 'http://a:3000').map(n => n.token)).toEqual(['renewed', 'remote']);
  saved.delete('token');
  expect(loadNodes(storage, 'http://a:3000').map(n => n.token)).toEqual(['', 'remote']);
});
