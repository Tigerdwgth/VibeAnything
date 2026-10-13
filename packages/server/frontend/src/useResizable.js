import { useState, useCallback, useEffect } from 'react';

export default function useResizable({
  min = 160, max = 400, defaultWidth = 240,
  collapseThreshold = 120, collapsedWidth = 48
} = {}) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width');
    return saved ? Number(saved) : defaultWidth;
  });
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    if (!dragging) return;
    let latestWidth = width;
    let latestCollapsed = collapsed;
    const onMove = (e) => {
      const newWidth = Math.min(max, Math.max(min, e.clientX));
      if (newWidth < collapseThreshold) {
        latestCollapsed = true;
        setCollapsed(true);
      } else {
        latestCollapsed = false;
        latestWidth = newWidth;
        setCollapsed(false);
        setWidth(newWidth);
      }
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('sidebar-width', String(latestWidth));
      localStorage.setItem('sidebar-collapsed', String(latestCollapsed));
    };
    // 用 Pointer Events 统一鼠标与触屏：平板/触摸屏也能拖拽调宽
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  const onDoubleClick = useCallback(() => {
    setCollapsed(false);
    setWidth(defaultWidth);
    localStorage.setItem('sidebar-width', String(defaultWidth));
    localStorage.setItem('sidebar-collapsed', 'false');
  }, [defaultWidth]);

  const toggle = useCallback(() => {
    setCollapsed(c => {
      localStorage.setItem('sidebar-collapsed', String(!c));
      return !c;
    });
  }, []);

  return {
    width: collapsed ? collapsedWidth : width,
    collapsed, dragging, onPointerDown, onDoubleClick, toggle,
  };
}
