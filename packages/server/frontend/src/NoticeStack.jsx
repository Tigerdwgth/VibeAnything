import { useTheme } from './theme';

// 行内提示的容器：右下角自下往上堆，点哪条关哪条。
//
// 放右下角而不是屏幕正中：终端是这个页面的主体，提示不该盖住正在出字的区域；
// 也不拦截鼠标 —— 容器 pointerEvents:none，只有提示本身能点，否则它会把下面的
// 终端点击吃掉（终端右下角正是 tmux 状态栏和输入行）。

export default function NoticeStack({ notices, onDismiss }) {
  const T = useTheme();
  if (!notices?.length) return null;

  return (
    <div
      style={{
        position: 'fixed', right: '14px', bottom: '14px', zIndex: 90,
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end',
        pointerEvents: 'none', maxWidth: 'min(420px, 60vw)',
      }}
    >
      {notices.map(n => {
        const error = n.kind === 'error';
        // 常驻提示（如「有新版本」）不整块可点：它带一个动作按钮和一个 ✕，
        // 整块可点会让「我只是想读完」变成「手一抖就刷新了」
        const wholeBlockDismisses = !n.sticky;
        return (
          <div
            key={n.id}
            role="status"
            onClick={wholeBlockDismisses ? () => onDismiss(n.id) : undefined}
            title={wholeBlockDismisses ? '点一下关掉' : undefined}
            style={{
              pointerEvents: 'auto', cursor: wholeBlockDismisses ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 12px', borderRadius: T.radiusSm,
              background: error ? T.dangerDim : T.bgCard,
              border: `1px solid ${error ? T.danger : T.border}`,
              color: error ? T.danger : T.textPrimary,
              fontSize: '0.8rem', fontFamily: T.fontSans, lineHeight: 1.45,
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
              wordBreak: 'break-word',
            }}
          >
            <span>{n.text}</span>
            {n.onAction && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); n.onAction(); }}
                style={{
                  flexShrink: 0, padding: '3px 10px', borderRadius: T.radiusSm,
                  border: `1px solid ${T.borderAccent}`, background: 'transparent',
                  color: T.accent, fontSize: '0.76rem', cursor: 'pointer', fontFamily: T.fontSans,
                }}
              >{n.actionLabel || '确定'}</button>
            )}
            {n.sticky && (
              <button
                type="button"
                aria-label="关闭提示"
                title="关掉"
                onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
                style={{
                  flexShrink: 0, background: 'none', border: 'none',
                  color: T.textMuted, fontSize: '0.8rem', cursor: 'pointer', padding: '0 2px',
                }}
              >✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
