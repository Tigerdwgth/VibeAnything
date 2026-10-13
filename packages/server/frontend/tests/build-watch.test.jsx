// 「线上换了前端产物」的发现机制。
//
// 本项目部署前端只 rsync 一份新 dist（express.static 直接生效、不重启服务），
// 所以开着的标签页手里是旧 index.html、跑着旧 bundle，而这个页面是开一整天甚至几天的。
// 这里断言的就是那条链路：第一次拿到的版本号当基线 → 变了只提示一次 →
// 接口不存在/断网时安静跳过（老版本服务端上线前不能满屏报错）。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import useBuildWatch from '../src/useBuildWatch.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let seen;        // onNewBuild 的回调参数
let fetchCalls;

/** 按脚本依次回 buildId 的 fetch 替身；'fail' = 网络错误，'404' = 接口不存在。 */
function scriptedFetch(sequence) {
  fetchCalls = 0;
  return async () => {
    const step = sequence[Math.min(fetchCalls, sequence.length - 1)];
    fetchCalls += 1;
    if (step === 'fail') throw new Error('offline');
    if (step === '404') return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ buildId: step }) };
  };
}

function Harness({ fetchImpl, pollMs, onReady }) {
  useBuildWatch((id) => seen.push(id), { fetchImpl, pollMs });
  useEffect(() => { onReady?.(); });
  return null;
}

const mount = (fetchImpl, pollMs = 1000) => act(() => {
  root.render(<Harness fetchImpl={fetchImpl} pollMs={pollMs} />);
});

/** 推进定时器并把 fetch 的 microtask 跑完。 */
const advance = async (ms) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('发现新版本', () => {
  test('第一次拿到的版本号只当基线，不提示（否则一进页面就说有新版）', async () => {
    mount(scriptedFetch(['100']));
    await advance(0);
    expect(fetchCalls).toBe(1);
    expect(seen).toEqual([]);
  });

  test('版本号变了 → 提示一次，并带上新版本号', async () => {
    mount(scriptedFetch(['100', '200']));
    await advance(0);          // 基线
    await advance(1000);       // 第二轮：变了
    expect(seen).toEqual(['200']);
  });

  test('提示只发一次 —— 之后每轮轮询不再刷屏', async () => {
    mount(scriptedFetch(['100', '200', '300']));
    await advance(0);
    await advance(1000);
    await advance(1000);
    await advance(1000);
    expect(seen).toEqual(['200']);
  });

  test('版本号没变就一直不提示', async () => {
    mount(scriptedFetch(['100']));
    await advance(0);
    await advance(3000);
    expect(seen).toEqual([]);
  });
});

describe('不该添乱的情形', () => {
  test('接口不存在（服务端还是老版本）→ 安静跳过，不当成「变了」', async () => {
    mount(scriptedFetch(['404']));
    await advance(0);
    await advance(2000);
    expect(seen).toEqual([]);
  });

  test('断网 / 服务端重启中 → 安静跳过，下一轮再查', async () => {
    mount(scriptedFetch(['fail', '100', '100']));
    await advance(0);
    await advance(1000);       // 这一轮才拿到基线
    await advance(1000);
    expect(seen).toEqual([]);
  });

  test('buildId 取不到（dist 还没构建）→ 不作为基线也不提示', async () => {
    mount(scriptedFetch(['unknown', 'unknown', '500']));
    await advance(0);
    await advance(1000);
    await advance(1000);       // 这一轮 500 成为基线
    await advance(1000);
    expect(seen).toEqual([]);
  });

  test('卸载后不再轮询（切走视图/退出登录都会卸载）', async () => {
    mount(scriptedFetch(['100', '200']));
    await advance(0);
    const before = fetchCalls;
    act(() => root.unmount());
    await advance(5000);
    expect(fetchCalls).toBe(before);
    expect(seen).toEqual([]);
  });
});

describe('页面重新可见时立刻查一次', () => {
  test('切回这个标签页 = 人正要开始用，这一刻比定时器更该查', async () => {
    mount(scriptedFetch(['100', '200']), 60_000);   // 轮询间隔故意调得很长
    await advance(0);
    expect(seen).toEqual([]);

    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(seen).toEqual(['200']);
  });
});
