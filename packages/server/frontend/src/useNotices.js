import { useCallback, useRef, useState } from 'react';

// 桌面版的行内提示（替掉 alert）。
//
// 为什么不用 alert：Dashboard 是开一整天的工具，alert 会把整个标签页**阻塞**到有人点确定 ——
// 终端还在出字、ws 还在收消息，而页面停在那儿；重命名撞名这种小事不该有这种代价。
// 多个错误连着来时 alert 还会排队，一个一个点。手机版早就改成行内提示了（useRelay 里
// 那条 actionError），桌面版一直留着 9 处 alert，这里把两端拉齐。
//
// 行为：成功类 3 秒自动消失，错误类留 8 秒（够看清为什么失败），都能点掉。
// 同一条文案短时间内重复推（重连时 relay 会把同一个 folder_error 反复推下来）
// 只留一条，并把它的计时重置。
//
// 实现上刻意**不在 setState 的 updater 里算 id**：那段代码的执行时机由 React 决定
// （它只对队列为空的首次更新做 eager 计算），依赖它会得到「有时去重、有时不去重」
// 这种看运气的行为。所以文案 → id 的映射单独放一个 ref，整条链路同步可预测。

const SUCCESS_MS = 3000;
const ERROR_MS = 8000;

const keyOf = (text, kind) => `${kind}:${text}`;

/**
 * @returns {{notices: Array, notify: Function, dismiss: Function}}
 *   notify(text, kind?, options?)
 *   kind: 'info' | 'error'
 *   options: { sticky?: boolean, actionLabel?: string, onAction?: Function }
 *     sticky 的提示不自动消失、带一个 ✕ 让用户自己关（「有新版本」这种不该几秒就溜走）
 */
export default function useNotices() {
  const [notices, setNotices] = useState([]);
  const timersRef = useRef(new Map());     // id → timeout
  const idByKeyRef = useRef(new Map());    // 'kind:text' → id（去重用）
  const seqRef = useRef(0);

  const dismiss = useCallback((id) => {
    if (!id) return;
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
    for (const [key, value] of idByKeyRef.current) {
      if (value === id) idByKeyRef.current.delete(key);
    }
    setNotices(prev => prev.filter(n => n.id !== id));
  }, []);

  const notify = useCallback((text, kind = 'info', options = {}) => {
    const message = String(text ?? '').trim();
    if (!message) return null;              // msg.error 为空时不该弹一个空框
    const { sticky = false, actionLabel, onAction } = options;
    const key = keyOf(message, kind);
    let id = idByKeyRef.current.get(key);
    if (!id) {
      id = `n${++seqRef.current}`;
      idByKeyRef.current.set(key, id);
      setNotices(prev => [...prev, { id, text: message, kind, sticky, actionLabel, onAction }]);
    }
    const prevTimer = timersRef.current.get(id);
    if (prevTimer) clearTimeout(prevTimer);
    // 常驻提示不排自动消失的定时器
    if (!sticky) {
      timersRef.current.set(id, setTimeout(() => dismiss(id), kind === 'error' ? ERROR_MS : SUCCESS_MS));
    }
    return id;
  }, [dismiss]);

  return { notices, notify, dismiss };
}

export { SUCCESS_MS, ERROR_MS };
