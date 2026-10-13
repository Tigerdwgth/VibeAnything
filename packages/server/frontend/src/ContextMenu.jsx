import { useEffect } from 'react';
import { useTheme } from './theme';

// 轻量受控浮层菜单（不引第三方）。固定定位在 (x, y)。
// items: 数组，元素为 { label, onClick, danger } 或 null（渲染为分隔线）。
// 任意 mousedown / 滚动 / Esc / 选中项后关闭（onClose）。
export default function ContextMenu({ x, y, items, onClose }) {
  const T = useTheme();

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 防止超出视口右/下边缘
  const style = {
    position: 'fixed',
    top: Math.min(y, window.innerHeight - 8 - items.length * 30),
    left: Math.min(x, window.innerWidth - 180),
    zIndex: 3000,
    background: T.bgCard,
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    padding: '4px',
    minWidth: '170px',
    maxHeight: '60vh',
    overflowY: 'auto',
    boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
    fontSize: '0.78rem',
  };

  return (
    <div onMouseDown={e => e.stopPropagation()} style={style}>
      {items.map((it, i) => it === null ? (
        <div key={`sep-${i}`} style={{ height: 1, background: T.border, margin: '4px 2px' }} />
      ) : (
        <div
          key={i}
          onClick={() => { it.onClick(); onClose(); }}
          style={{
            padding: '6px 10px', borderRadius: '4px', cursor: 'pointer',
            color: it.danger ? T.danger : T.textSecondary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = T.bgHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >{it.label}</div>
      ))}
    </div>
  );
}
