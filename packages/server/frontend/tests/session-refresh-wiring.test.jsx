// 续期在桌面版 / 手机版两个入口上的整条接线：App → useSessionRefresh → localStorage →
// Dashboard / MobileShell → WebSocket 重连。
//
// 这里要证明的是「换票之后、断线重连之后，连接用的是最新那张票」——
// 连接的 effect 只在登录态变化时重建，如果重连处闭包住了首次渲染的 token，
// 续期成功的设备掉一次线就会拿着旧票被 relay 以 4001 踢出登录。
//
// 替身只有宿主 API：WebSocket 构造器（jsdom 的会真去连网）和 fetch（按脚本回应），
// App / MobileApp / Dashboard / MobileShell / useRelay 全是真组件。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App.jsx';
import MobileApp from '../src/mobile/MobileApp.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket extends window.EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

/** /api/session/refresh 按脚本回应；其余接口（/api/me 等）一律 404，这些测试不关心。 */
function installFetch(steps) {
  const refreshAuths = [];
  globalThis.fetch = async (url, init) => {
    if (url !== '/api/session/refresh') return { ok: false, status: 404, json: async () => ({}) };
    refreshAuths.push(init.headers.Authorization);
    const step = steps[Math.min(refreshAuths.length - 1, steps.length - 1)];
    if (step === 'offline') throw new TypeError('Failed to fetch');
    if (step === '401') return { ok: false, status: 401, json: async () => ({ error: 'Invalid token' }) };
    return { ok: true, status: 200, json: async () => ({ token: step, username: 'u' }) };
  };
  return refreshAuths;
}

let host;
let root;
let origWebSocket;
let origFetch;

const tokenOf = (ws) => new URL(ws.url).searchParams.get('token');
const urls = () => FakeWebSocket.instances.map(tokenOf);
const loginFormShown = () => Boolean(host.querySelector('input[type="password"]'));

/** 推进假时钟并让 fetch / Promise 链跑完。 */
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  localStorage.setItem('token', 'tok0');
  FakeWebSocket.instances = [];
  origWebSocket = globalThis.WebSocket;
  origFetch = globalThis.fetch;
  globalThis.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.WebSocket = origWebSocket;
  window.WebSocket = origWebSocket;
  globalThis.fetch = origFetch;
  vi.useRealTimers();
});

describe.each([
  ['桌面版 App', App],
  ['手机版 MobileApp', MobileApp],
])('%s', (_name, Entry) => {
  const mount = async () => {
    await act(async () => { root.render(<Entry />); });
    await advance(0);
  };

  test('启动续期：新票写进 localStorage，连接不因换票而重建', async () => {
    const auths = installFetch(['tok1']);
    await mount();
    expect(auths).toEqual(['Bearer tok0']);
    expect(localStorage.getItem('token')).toBe('tok1');
    expect(urls()).toEqual(['tok0']);            // 只有首次那一条连接
  });

  test('换票之后掉线重连，用的是最新票而不是首次渲染时的旧票', async () => {
    installFetch(['tok1']);
    await mount();
    act(() => { FakeWebSocket.instances[0].onclose({ code: 1006, reason: '' }); });
    await advance(1000);
    expect(urls()).toEqual(['tok0', 'tok1']);
  });

  test('4001：续期换到新票 → 用新票重连，不登出', async () => {
    installFetch(['tok1', 'tok2']);
    await mount();
    act(() => { FakeWebSocket.instances[0].onclose({ code: 4001, reason: 'Unauthorized' }); });
    await advance(1000);
    expect(urls()).toEqual(['tok0', 'tok2']);
    expect(localStorage.getItem('token')).toBe('tok2');
    expect(loginFormShown()).toBe(false);
  });

  test('4001：续期被 401 拒绝 → 退出登录，清掉票，不再重连', async () => {
    installFetch(['tok1', '401']);
    await mount();
    act(() => { FakeWebSocket.instances[0].onclose({ code: 4001, reason: 'Unauthorized' }); });
    await advance(0);                            // 续期结果落地 → 登出 → 组件卸载（真实浏览器里是几毫秒内的事）
    await advance(60_000);
    expect(localStorage.getItem('token')).toBeNull();
    expect(loginFormShown()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('4001：续期时断网 → 不登出，按退避重连，票原样保留', async () => {
    installFetch(['tok1', 'offline']);
    await mount();
    act(() => { FakeWebSocket.instances[0].onclose({ code: 4001, reason: 'Unauthorized' }); });
    await advance(1000);
    expect(loginFormShown()).toBe(false);
    expect(localStorage.getItem('token')).toBe('tok1');
    expect(urls()).toEqual(['tok0', 'tok1']);
  });

  test('启动续期被 401（票已被撤销）→ 直接退出登录', async () => {
    installFetch(['401']);
    await mount();
    expect(localStorage.getItem('token')).toBeNull();
    expect(loginFormShown()).toBe(true);
  });

  test('启动续期断网 → 不登出，仍用现有票连接', async () => {
    installFetch(['offline']);
    await mount();
    expect(localStorage.getItem('token')).toBe('tok0');
    expect(loginFormShown()).toBe(false);
    expect(urls()).toEqual(['tok0']);
  });
});
