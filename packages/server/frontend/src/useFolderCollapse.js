import { useState, useCallback } from 'react';

// 文件夹折叠状态（纯前端 UI state），按 machineId 存一份 { folderId: true } 到 localStorage。
// 默认展开（无记录 = 未折叠）。风格与 useResizable.js 的 localStorage 用法一致。
export default function useFolderCollapse(machineId) {
  const key = `folderCollapsed:${machineId || 'local'}`;
  const [map, setMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  });

  const toggle = useCallback((folderId) => {
    setMap(prev => {
      const next = { ...prev };
      if (next[folderId]) delete next[folderId];
      else next[folderId] = true;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);

  const isCollapsed = useCallback((folderId) => !!map[folderId], [map]);

  return { isCollapsed, toggle };
}
