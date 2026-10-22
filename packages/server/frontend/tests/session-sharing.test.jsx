import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import SessionSharing from '../src/SessionSharing.jsx';
import SessionTabs from '../src/SessionTabs.jsx';
import MobileSessionList from '../src/mobile/MobileSessionList.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root;
const session = { machineId: 'macmini', sessionId: '梁文峰', cwd: '/work', canShare: true };
const state = { ...session, owner: 'alice', users: [], availableUsers: ['alice', 'bob'] };
const response = (data, ok = true) => Promise.resolve({ ok, json: async () => data });
const click = async el => { await act(async () => el.click()); };
const byText = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(() => response(state)));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

test('选择用户共享、显示共享名单、取消共享，发送准确的窗口和账号', async () => {
  await act(async () => root.render(<SessionSharing token="token" session={session} onClose={() => {}} />));
  const select = host.querySelector('select');
  expect([...select.options].map(o => o.value)).toEqual(['', 'bob']);
  await act(async () => { select.value = 'bob'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  fetch.mockImplementationOnce(() => response({ ...state, users: ['bob'] }));
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const [url, options] = fetch.mock.calls.at(-1);
  expect(url).toBe('/api/session-shares');
  expect(options.method).toBe('POST');
  expect(options.headers.Authorization).toBe('Bearer token');
  expect(JSON.parse(options.body)).toEqual({ machineId: 'macmini', sessionId: '梁文峰', username: 'bob' });
  expect(host.querySelector('li').textContent).toContain('bob');
  fetch.mockImplementationOnce(() => response(state));
  await click(byText('取消共享'));
  expect(fetch.mock.calls.at(-1)[1].method).toBe('DELETE');
  expect(host.textContent).toContain('尚未共享');
});

test('共享失败保留界面并显示原因', async () => {
  fetch.mockImplementationOnce(() => response({ error: '只有窗口所有者或管理员可以管理共享' }, false));
  await act(async () => root.render(<SessionSharing token="token" session={session} onClose={() => {}} />));
  expect(host.querySelector('[role="alert"]').textContent).toContain('所有者或管理员');
  expect(host.querySelector('form')).toBeNull();
});

test('桌面右键菜单连接共享面板', async () => {
  await act(async () => root.render(<SessionTabs token="desktop-token" activeSessions={[session]} historySessions={[]} openTerminals={[]} />));
  await act(async () => host.querySelector('.sess-item').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
  await click([...host.querySelectorAll('div')].find(el => el.textContent === '共享窗口…'));
  expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  const [url, options] = fetch.mock.calls.at(-1);
  expect(new URL(url, 'http://localhost').searchParams.get('sessionId')).toBe('梁文峰');
  expect(options.headers.Authorization).toBe('Bearer desktop-token');
});

test('手机会话菜单连接共享面板，收件人看不到管理入口', async () => {
  const props = { token: 'mobile-token', machines: [{ machineId: 'macmini' }], selectedMachine: 'macmini', openSessionIds: new Set(), sessions: [session] };
  await act(async () => root.render(<MobileSessionList {...props} />));
  await click(host.querySelector('[aria-label="会话操作"]'));
  await click(byText('共享窗口…'));
  expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer mobile-token');
  await click(host.querySelector('[aria-label="关闭共享设置"]'));
  await act(async () => root.render(<MobileSessionList {...props} sessions={[{ ...session, canShare: false, sharedBy: 'alice' }]} />));
  await click(host.querySelector('[aria-label="会话操作"]'));
  expect(byText('共享窗口…')).toBeUndefined();
  expect(host.textContent).toContain('共享');
});
