import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';

// 手机版的底部动作面板（bottom sheet），替代桌面版的右键菜单。
//
// 为什么不用右键菜单那一套：触屏没有右键，桌面版 ContextMenu 是按鼠标坐标定位的弹层，
// 在手机上会飘到屏幕外、还会被软键盘顶掉。底部面板是触屏的通用解法——从下边缘升起、
// 手指够得到、每行都是大目标。
//
// 为什么不用拖拽做「把会话拖进文件夹」：拖拽库的 sensor 会和列表的滚动手势抢同一串
// touch 事件（2026-08-23 的「会话列表滑不动」就是这么来的）。手机上把「移动到哪」
// 做成显式的选择面板，既不抢手势，也比拖一段距离更准。

const BACKDROP_Z = 60;

function Shell({ title, subtitle, onClose, children }) {
  const T = useTheme();
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: BACKDROP_Z,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
    >
      {/* 面板自身吃掉点击，否则点在面板上会穿到遮罩的 onClose */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.bgPanel,
          borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
          borderTop: `1px solid ${T.border}`,
          // 底部横条区域要让位，否则最后一行按钮被系统手势条压住
          paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
          maxHeight: '72vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '10px 0 6px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: T.border }} />
        </div>
        {title && (
          <div style={{ padding: '2px 16px 10px', flexShrink: 0 }}>
            <div style={{
              color: T.textPrimary, fontSize: '0.9rem', fontWeight: 600, fontFamily: T.fontSans,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{title}</div>
            {subtitle && (
              <div style={{
                color: T.textMuted, fontSize: '0.72rem', fontFamily: T.fontMono, marginTop: '2px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{subtitle}</div>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * 动作列表面板。
 * @param {{key:string,label:string,hint?:string,danger?:boolean,checked?:boolean,indent?:number,onSelect:()=>void}[]} items
 */
export function MobileActionSheet({ title, subtitle, items, onClose }) {
  const T = useTheme();
  return (
    <Shell title={title} subtitle={subtitle} onClose={onClose}>
      <div style={{ overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => { item.onSelect(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              width: '100%', minHeight: '50px',
              padding: `12px 16px 12px ${16 + (item.indent || 0) * 16}px`,
              background: 'none', border: 'none',
              borderTop: `1px solid ${T.border}`,
              color: item.danger ? T.danger : T.textPrimary,
              fontSize: '0.88rem', fontFamily: T.fontSans, textAlign: 'left',
            }}
          >
            <span style={{
              flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{item.label}</span>
            {item.hint && (
              <span style={{ color: T.textMuted, fontSize: '0.72rem', flexShrink: 0 }}>{item.hint}</span>
            )}
            {item.checked && <span style={{ color: T.accent, flexShrink: 0 }}>✓</span>}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onClose}
        style={{
          margin: '8px 16px 0', minHeight: '46px', borderRadius: T.radiusSm,
          border: `1px solid ${T.border}`, background: 'transparent',
          color: T.textSecondary, fontSize: '0.88rem', fontFamily: T.fontSans, flexShrink: 0,
        }}
      >取消</button>
    </Shell>
  );
}

/**
 * 输入面板（新建 / 重命名文件夹）。
 * 不用 window.prompt：iOS 上它是系统弹窗，会打断页面、样式也不受控。
 */
export function MobilePromptSheet({ title, subtitle, initial = '', placeholder, confirmLabel = '确定', onConfirm, onClose }) {
  const T = useTheme();
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);

  // 升起就聚焦并弹键盘：少让用户多点一下
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const name = value.trim();
    if (!name) return;
    onConfirm(name);
  };

  return (
    <Shell title={title} subtitle={subtitle} onClose={onClose}>
      <div style={{ padding: '0 16px 8px' }}>
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          placeholder={placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            width: '100%', padding: '11px 12px', minHeight: '46px',
            borderRadius: T.radiusSm, border: `1px solid ${T.border}`,
            background: T.bgInput, color: T.textPrimary,
            // 16px 以下 iOS Safari 一聚焦就整页放大
            fontSize: '16px', fontFamily: T.fontSans, outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              flex: 1, minHeight: '46px', borderRadius: T.radiusSm,
              border: `1px solid ${T.border}`, background: 'transparent',
              color: T.textSecondary, fontSize: '0.88rem', fontFamily: T.fontSans,
            }}
          >取消</button>
          <button
            type="button"
            disabled={!value.trim()}
            onClick={submit}
            style={{
              flex: 2, minHeight: '46px', borderRadius: T.radiusSm, border: 'none',
              background: value.trim() ? T.accent : T.bgHover,
              color: value.trim() ? '#fff' : T.textMuted,
              fontSize: '0.88rem', fontWeight: 600, fontFamily: T.fontSans,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </Shell>
  );
}
