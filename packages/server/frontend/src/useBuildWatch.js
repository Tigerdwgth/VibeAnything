import { useEffect, useRef } from 'react';

// 「前端更新了么」—— 这个页面自己回答。
//
// 本项目部署前端就是 rsync 一份新 dist（express.static 直接生效，不重启服务）。
// 代价是**开着的标签页永远不知道**：它手里的 index.html 是几天前拿的，里面钉死了旧
// bundle 的文件名，不手动刷新就一直跑旧代码 —— 而这个页面是开一整天、甚至好几天的。
// 以前判断「线上是不是新版」只能去比对 bundle 文件名。
//
// 做法：服务端 /api/build 回 dist/index.html 的 mtime，这里记下首次拿到的值，
// 之后在「页面重新可见」和每 10 分钟各查一次，变了就提示。
// 为什么挂 visibilitychange：真实用法是「切到别的窗口干活，过一阵切回来」，
// 这一刻比任何定时器都更接近「人正要开始用」。

const POLL_MS = 10 * 60 * 1000;

/**
 * @param {(buildId: string) => void} onNewBuild 发现线上版本变了（只会在变化的那一刻调一次）
 * @param {{fetchImpl?: Function, pollMs?: number}} [options] 注入点，单测用
 */
export default function useBuildWatch(onNewBuild, { fetchImpl, pollMs = POLL_MS } = {}) {
  const baselineRef = useRef(null);
  const notifiedRef = useRef(false);
  const onNewBuildRef = useRef(onNewBuild);
  useEffect(() => { onNewBuildRef.current = onNewBuild; });

  useEffect(() => {
    const doFetch = fetchImpl || globalThis.fetch;
    if (!doFetch) return undefined;
    let disposed = false;

    async function check() {
      if (disposed || notifiedRef.current) return;
      let buildId;
      try {
        const res = await doFetch('/api/build', { cache: 'no-store' });
        if (!res.ok) return;                       // 老版本服务端没这个接口：静默跳过
        ({ buildId } = await res.json());
      } catch {
        return;                                    // 断网/重启中，下一轮再说
      }
      if (disposed || !buildId || buildId === 'unknown') return;
      if (baselineRef.current === null) { baselineRef.current = buildId; return; }
      if (buildId !== baselineRef.current) {
        notifiedRef.current = true;                // 只提示一次，别每轮刷屏
        onNewBuildRef.current?.(buildId);
      }
    }

    check();
    const timer = setInterval(check, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchImpl, pollMs]);
}

export { POLL_MS };
