import { useState, useCallback } from 'react';

// 一个分组（开发机 / 归属人 / 置顶）的折叠状态：纯前端 UI 状态，存 localStorage，刷新保留。
// 默认展开。存储不可用（隐私模式、配额满）时仍可折叠，只是刷新后不记得。
// 文件夹的折叠是「一台机器一份、里面按 folderId 记」的另一种形状，见 useFolderCollapse.js。
export default function useStoredCollapse(storageKey) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
  });

  const change = useCallback((next) => {
    setCollapsed(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* 存储不可用仍可折叠 */ }
  }, [storageKey]);

  return [collapsed, change];
}
