import { useCallback, useEffect, useRef } from 'react';

// 登录态的滑动续期：设备只要在 30 天内打开过，就永远不用重新输密码。
//
// 服务端 POST /api/session/refresh 用一张仍有效的票换一张新的 30 天票。这里负责「什么时候换」：
//   · 启动时换一次（页面刚打开 = 人正要用）；
//   · 页面开着时每 6 小时换一次；
//   · 页面从后台切回前台且距上次成功超过 1 小时，再换一次 —— 后台标签页的定时器会被浏览器
//     节流甚至冻结，电脑睡眠一夜醒来，切回前台这一刻比任何定时器都可靠。
//
// 只有服务端明确回 401（票过期 / 被撤销 / 用户已不存在）才算登录失效；断网、5xx
// （服务正在重启时反代回 502）都只是「这次没换成」，不登出，等下一个时机再试。

export const REFRESH_INTERVAL_MS = 6 * 3600_000;
export const VISIBLE_REFRESH_MIN_GAP_MS = 3600_000;

/** @returns {Promise<{status: 'ok', token: string} | {status: 'revoked'} | {status: 'failed'}>} */
async function requestRefresh(token, doFetch) {
  let res;
  try {
    res = await doFetch('/api/session/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    return { status: 'failed' };
  }
  if (res.status === 401) return { status: 'revoked' };
  if (!res.ok) return { status: 'failed' };
  const body = await res.json().catch(() => null);
  return body?.token ? { status: 'ok', token: body.token } : { status: 'failed' };
}

/**
 * 续期器：不碰 React，定时与可见性的接线在 useSessionRefresh。
 * @param {object} deps
 * @param {() => string|null} deps.getToken  当前最新的票（每次现读，不闭包旧值）
 * @param {(token: string) => void} deps.onToken  换到新票：调用方负责写 localStorage 与状态
 * @param {() => void} deps.onExpired  服务端明确判定登录失效
 * @param {Function} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export function createSessionRefresher({ getToken, onToken, onExpired, fetchImpl, now = Date.now }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let lastOkAt = 0;
  let inflight = null;

  async function run() {
    const sent = getToken();
    if (!sent) return null;
    const result = await requestRefresh(sent, doFetch);
    // 请求在路上时票被换掉了（改密码拿到新票、别的路径先续上了）：这次的结果基于旧票，
    // 用它覆盖新票会把设备打回旧版本，用它的 401 去登出更是冤枉，一律作废，以现在的票为准。
    const latest = getToken();
    if (latest !== sent) return latest;
    if (result.status === 'ok') {
      lastOkAt = now();
      onToken(result.token);
      return result.token;
    }
    if (result.status === 'revoked') onExpired();
    return null;
  }

  return {
    /** 续一次；并发调用共用同一个请求。resolve 新票（或此刻最新的票），没换成 / 已登出则 null。 */
    refresh() {
      if (!inflight) inflight = run().finally(() => { inflight = null; });
      return inflight;
    },
    /** 切回前台时是否该续：距上次成功超过阈值（从没成功过也算）。 */
    dueOnVisible() {
      return now() - lastOkAt >= VISIBLE_REFRESH_MIN_GAP_MS;
    },
  };
}

/**
 * 在登录态存续期间按上述时机续期。
 * @param {string|null} token 当前票
 * @param {(token: string) => void} onToken 换到新票（与登录成功同一个处理：写 localStorage + 置状态）
 * @param {() => void} onExpired 登录失效 → 退出登录
 * @param {{fetchImpl?: Function, intervalMs?: number}} [options] 注入点，单测用
 * @returns {() => Promise<string|null>} 立即续一次（WS 被 4001 断开时用它判断是真失效还是该换票了）；
 *          没登录时恒 resolve null
 */
export function useSessionRefresh(token, onToken, onExpired, { fetchImpl, intervalMs = REFRESH_INTERVAL_MS } = {}) {
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  // 回调每次渲染都是新函数，放 ref 让续期器和定时器只建一次
  const callbacksRef = useRef({ onToken, onExpired });
  useEffect(() => { callbacksRef.current = { onToken, onExpired }; });

  const refreshRef = useRef(null);
  const active = Boolean(token);
  useEffect(() => {
    if (!active) return undefined;
    const refresher = createSessionRefresher({
      getToken: () => tokenRef.current,
      // 先同步改 ref：状态要等下一次渲染才到，期间的 getToken 已经得是新票
      onToken: (t) => { tokenRef.current = t; callbacksRef.current.onToken(t); },
      onExpired: () => callbacksRef.current.onExpired(),
      fetchImpl,
    });
    refreshRef.current = refresher.refresh;
    refresher.refresh();
    const timer = setInterval(refresher.refresh, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && refresher.dueOnVisible()) refresher.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      refreshRef.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, intervalMs, fetchImpl]);

  return useCallback(() => (refreshRef.current ? refreshRef.current() : Promise.resolve(null)), []);
}
