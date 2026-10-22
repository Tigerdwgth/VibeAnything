// 登录态滑动续期的调度：启动续、定时续、切回前台续、401 才登出、断网/5xx 不登出。
//
// 网络层沿用本项目的做法（见 build-watch.test.jsx）：按脚本回应的 fetch 替身；
// 被测的 createSessionRefresher / useSessionRefresh 全是真的，定时器用 vitest 假时钟。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createSessionRefresher, useSessionRefresh,
  REFRESH_INTERVAL_MS, VISIBLE_REFRESH_MIN_GAP_MS,
} from '../src/session-refresh.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 按脚本依次回应的 fetch。步骤：
 *   { token } → 200 + 新票；'401' → 401；'502' → 反代 502；'offline' → 抛网络错误。
 * 记录每次请求带的 Authorization，用来断言「拿哪张票去续」。
 */
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === 'offline') throw new TypeError('Failed to fetch');
    if (step === '401') return { ok: false, status: 401, json: async () => ({ error: 'Invalid token' }) };
    if (step === '502') return { ok: false, status: 502, json: async () => { throw new Error('html'); } };
    return { ok: true, status: 200, json: async () => ({ token: step.token, username: 'u' }) };
  };
  impl.calls = calls;
  return impl;
}

describe('createSessionRefresher', () => {
  let current;
  let expired;
  const make = (fetchImpl) => createSessionRefresher({
    getToken: () => current,
    onToken: (t) => { current = t; },
    onExpired: () => { expired += 1; },
    fetchImpl,
  });

  beforeEach(() => { current = 'old'; expired = 0; });

  test('成功：POST /api/session/refresh 带当前票，新票交给 onToken', async () => {
    const f = scriptedFetch([{ token: 'new' }]);
    expect(await make(f).refresh()).toBe('new');
    expect(current).toBe('new');
    expect(f.calls).toEqual([{ url: '/api/session/refresh', method: 'POST', auth: 'Bearer old' }]);
    expect(expired).toBe(0);
  });

  test('401 → 才算登录失效：调 onExpired，票原样不动', async () => {
    expect(await make(scriptedFetch(['401'])).refresh()).toBeNull();
    expect(expired).toBe(1);
    expect(current).toBe('old');
  });

  test('断网不登出，票保留，下一次还能续上', async () => {
    const f = scriptedFetch(['offline', { token: 'new' }]);
    const r = make(f);
    expect(await r.refresh()).toBeNull();
    expect(expired).toBe(0);
    expect(current).toBe('old');
    expect(await r.refresh()).toBe('new');
    expect(f.calls[1].auth).toBe('Bearer old');
  });

  test('5xx（服务重启时反代回 502）不登出', async () => {
    expect(await make(scriptedFetch(['502'])).refresh()).toBeNull();
    expect(expired).toBe(0);
    expect(current).toBe('old');
  });

  test('没有票时什么都不发', async () => {
    current = null;
    const f = scriptedFetch([{ token: 'new' }]);
    expect(await make(f).refresh()).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test('并发调用共用同一个请求', async () => {
    const f = scriptedFetch([{ token: 'new' }]);
    const r = make(f);
    const [a, b] = await Promise.all([r.refresh(), r.refresh()]);
    expect([a, b]).toEqual(['new', 'new']);
    expect(f.calls).toHaveLength(1);
  });

  test('请求在路上时票被换掉（如改密码拿到新票）：旧票的 401 不能把人登出，结果作废', async () => {
    const r = make(async () => {
      current = 'changed-password-token';          // 请求期间另一路径换了票
      return { ok: false, status: 401, json: async () => ({}) };
    });
    expect(await r.refresh()).toBe('changed-password-token');
    expect(expired).toBe(0);
    expect(current).toBe('changed-password-token');
  });

  test('请求在路上时票被换掉：旧票换回的新票不能覆盖较新的票', async () => {
    const r = make(async () => {
      current = 'newer';
      return { ok: true, status: 200, json: async () => ({ token: 'stale-result' }) };
    });
    await r.refresh();
    expect(current).toBe('newer');
  });
});

describe('useSessionRefresh 的时机', () => {
  let host;
  let root;
  let tokens;      // onToken 收到的票
  let expired;
  let visibility;

  function Harness({ token, fetchImpl }) {
    useSessionRefresh(token, (t) => tokens.push(t), () => { expired += 1; }, { fetchImpl });
    return null;
  }
  const mount = (token, fetchImpl) => act(() => { root.render(<Harness token={token} fetchImpl={fetchImpl} />); });

  /** 推进假时钟并把 fetch 的 microtask 跑完。 */
  const advance = async (ms) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  const setVisibility = async (state) => {
    visibility = state;
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    tokens = [];
    expired = 0;
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete document.visibilityState;
    vi.useRealTimers();
  });

  test('启动时立刻续一次', async () => {
    const f = scriptedFetch([{ token: 'n1' }]);
    mount('t0', f);
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(tokens).toEqual(['n1']);
  });

  test('没登录（token 为空）时不续，登录后才开始', async () => {
    const f = scriptedFetch([{ token: 'n1' }]);
    mount(null, f);
    await advance(REFRESH_INTERVAL_MS * 2);
    expect(f.calls).toHaveLength(0);
    mount('t0', f);
    await flush();
    expect(f.calls).toHaveLength(1);
  });

  test('页面开着时每 6 小时续一次，且每次拿上一次换到的票去续', async () => {
    const f = scriptedFetch([{ token: 'n1' }, { token: 'n2' }, { token: 'n3' }]);
    mount('t0', f);
    await flush();
    expect(f.calls).toHaveLength(1);

    await advance(REFRESH_INTERVAL_MS - 1000);
    expect(f.calls).toHaveLength(1);
    await advance(1000);
    expect(f.calls).toHaveLength(2);
    await advance(REFRESH_INTERVAL_MS);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.map(c => c.auth)).toEqual(['Bearer t0', 'Bearer n1', 'Bearer n2']);
    expect(tokens).toEqual(['n1', 'n2', 'n3']);
  });

  test('切回前台：距上次成功不足阈值不续，超过阈值才续；隐藏时不续', async () => {
    const f = scriptedFetch([{ token: 'n1' }, { token: 'n2' }]);
    mount('t0', f);
    await flush();
    expect(f.calls).toHaveLength(1);

    await advance(VISIBLE_REFRESH_MIN_GAP_MS - 60_000);
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(f.calls).toHaveLength(1);            // 才过 59 分钟

    await advance(120_000);
    await setVisibility('hidden');
    expect(f.calls).toHaveLength(1);            // 切到后台不触发
    await setVisibility('visible');
    expect(f.calls).toHaveLength(2);            // 超过 1 小时，切回来续
    expect(f.calls[1].auth).toBe('Bearer n1');
  });

  test('启动那次断网没续成：不登出；之后切回前台立刻再试', async () => {
    const f = scriptedFetch(['offline', { token: 'n1' }]);
    mount('t0', f);
    await flush();
    expect(expired).toBe(0);
    expect(tokens).toEqual([]);

    await setVisibility('hidden');
    await setVisibility('visible');
    expect(f.calls).toHaveLength(2);
    expect(tokens).toEqual(['n1']);
  });

  test('401 → 登出一次，不写入新票', async () => {
    const f = scriptedFetch(['401']);
    mount('t0', f);
    await flush();
    expect(expired).toBe(1);
    expect(tokens).toEqual([]);
  });

  test('卸载后定时器与可见性监听都清掉', async () => {
    const f = scriptedFetch([{ token: 'n1' }]);
    mount('t0', f);
    await flush();
    act(() => root.unmount());
    root = createRoot(host);                    // 让 afterEach 的 unmount 仍然成立
    await advance(REFRESH_INTERVAL_MS * 3);
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(f.calls).toHaveLength(1);
  });
});
