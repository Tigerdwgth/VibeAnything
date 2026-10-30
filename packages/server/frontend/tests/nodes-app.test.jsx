import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import NodesApp from '../src/nodes/NodesApp';
import { NODES_KEY } from '../src/nodes/node-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class Socket extends window.EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  constructor(url) { super(); this.url = url; Socket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  emit(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
let host, root;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(NODES_KEY, JSON.stringify([
    { name: 'Node A', url: 'http://a:3000', token: 'a' },
    { name: 'Node B', url: 'http://b:3000', token: 'b' },
  ]));
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = el => act(() => el.click());
async function mount() {
  await act(async () => root.render(<NodesApp />));
  act(() => Socket.instances.forEach((ws, i) => {
    ws.emit({ type: 'whoami', username: 'alice', role: 'admin' });
    ws.emit({ type: 'machine_list', machines: [{ machineId: 'work' }] });
    ws.emit({ type: 'active_sessions', machineId: 'work', sessions: [
      { sessionId: 'main', owner: i ? 'bob' : 'alice', cwd: i ? '/work/beta' : '/work/alpha', tool: 'claude', isRunning: !i },
    ] });
  }));
}

test('按节点和用户分组；同名会话同时可见，运行筛选和跨节点搜索可用', async () => {
  await mount();
  expect(host.querySelectorAll('.nodes-session')).toHaveLength(2);
  const groups = [...host.querySelectorAll('.nodes-session-group h2')].map(el => el.textContent);
  expect(groups).toEqual(['Node A/ alice1', 'Node B/ bob1']);
  click([...host.querySelectorAll('.nodes-filters button')].find(el => el.textContent === '运行中'));
  expect(host.querySelectorAll('.nodes-session')).toHaveLength(1);
  expect(host.querySelector('.nodes-session').textContent).toContain('/work/alpha');
  click(host.querySelector('.nodes-filters button'));
  const input = host.querySelector('input[aria-label="搜索会话"]');
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'bob beta');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(host.querySelectorAll('.nodes-session')).toHaveLength(1);
  expect(host.querySelector('.nodes-session').textContent).toContain('/work/beta');
});

test('断线节点会话禁用并显示状态未知；另一个节点仍能打开终端', async () => {
  await mount();
  act(() => Socket.instances[0].close());
  const cards = [...host.querySelectorAll('.nodes-session')];
  expect(cards[0].disabled).toBe(true);
  expect(cards[0].textContent).toContain('状态未知');
  expect(cards[1].disabled).toBe(false);
  click(cards[1]);
  expect(host.querySelector('[aria-label="节点终端"]').textContent).toContain('Node B / work');
});

test('添加节点后呈现登录表单，移除节点关闭连接并清除其会话', async () => {
  await mount();
  click(host.querySelector('[aria-label="添加节点"]'));
  const form = host.querySelector('.nodes-dialog form');
  form.elements.name.value = 'Node C'; form.elements.url.value = 'http://c:3000';
  act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('[aria-label="Node C密码"]')).toBeTruthy();
  const remove = [...host.querySelectorAll('.node-card')][0].querySelector('.node-card-actions button:last-child');
  click(remove);
  expect(Socket.instances[0].readyState).toBe(3);
  expect(host.querySelectorAll('.nodes-session')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(NODES_KEY)).map(n => n.name)).toEqual(['Node B', 'Node C']);
});
