import { forwardRef, useImperativeHandle, useRef } from 'react';
import { TERMINAL_INPUT_FONT_SIZE } from './mobile-layout-config';

// 终端输入框（composer）。桌面版 TerminalPanel 与手机版 MobileTerminal 共用同一份。
//
// 它不是 xterm 的隐藏 textarea 的替身，而是一条独立的输入通道：
// 手机上 xterm 的 helper textarea 被设成 inputMode="none" + readonly（否则一获焦就弹键盘、
// 还压不住），因此必须有一个看得见的框来打字。
//
// ── 为什么是「整行发送」而不是逐字符透传 ──
// 用户要的是聊天框语义：先把内容拼好，回车整条发出去。逐字即发时中文输入法一确认
// 就整段冲进终端，且回车的时机不可控。
//
// ── Android 中文输入法的回车竞态（2026-08-17 实测）──
// 按「发送/回车」时 `keydown Enter` **先于** `compositionend` 到达，此刻输入法还没提交文字。
// 那一刻直接发 '\r' 会把回车丢掉（旧实现在组合期间 return），用户必须再按一次才发得出去。
// 正解：组合中按 Enter 只记 `enterPending` 并 preventDefault；等 compositionend 把文字
// 提交进 input.value 之后，**文字 + '\r' 一起发**；同时置 `ignoreNextEnter` 吞掉 Android
// 在组合提交后可能补发的那一次 Enter keydown（否则整行会发两遍）。
//
// ── 空框时的后门 ──
// 框里有字 = 在编辑，退格/方向/删除走浏览器默认，Esc 清空，Tab 插制表符；
// 框为空 = 这些键原样透传给终端（TUI 里要靠它们操作，否则打开 composer 就等于没法操作终端了）。

const BASE_INPUT_STYLE = {
  flex: 1,
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#e6edf3',
  borderRadius: '6px',
  padding: '8px 12px',
  // 16px 是 iOS Safari 不自动放大页面的下限，低于它每次聚焦输入框整页都会被缩放
  fontSize: `${TERMINAL_INPUT_FONT_SIZE}px`,
  fontFamily: '"JetBrains Mono", monospace',
  outline: 'none',
  minHeight: '36px',
};

const FOCUS_BORDER = '#58a6ff';
const BLUR_BORDER = 'rgba(255,255,255,0.15)';

/**
 * @param {object} props
 * @param {(text: string) => void} props.onSendText 把文本发进 PTY（调用方负责编码与 ws 发送）
 * @param {object} [props.inputStyle]   叠加在默认样式上（手机版调大内边距/换主题色）
 * @param {string} [props.placeholder]
 * @param {string} [props.focusBorderColor]
 * @param {string} [props.blurBorderColor]
 * @param {React.Ref} ref 暴露 { sendLine, focus, clear }，供外部「⏎」按钮调用
 */
const TerminalComposer = forwardRef(function TerminalComposer({
  onSendText,
  inputStyle,
  placeholder = '输入内容，回车发送',
  focusBorderColor = FOCUS_BORDER,
  blurBorderColor = BLUR_BORDER,
}, ref) {
  const inputRef = useRef(null);
  const composingRef = useRef(false);
  // IME 组合中按下的回车：见文件头「Android 回车竞态」
  const enterPendingRef = useRef(false);
  // Android 组合提交后可能再补发一次 Enter keydown，吞掉它避免整行发送两次
  const ignoreNextEnterRef = useRef(false);

  // 把框里的内容 + 回车一次发出。空框回车 = 只发回车（等同在终端按一次 Enter）。
  function sendLine() {
    const el = inputRef.current;
    if (!el) return;
    const val = el.value;
    el.value = '';
    if (val) onSendText(val);
    onSendText('\r');
  }

  // 在输入框光标处插入字符（组合模式下 Tab 当作普通字符编辑）
  function insertAtCursor(text) {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    try { el.setSelectionRange(start + text.length, start + text.length); } catch { /* 输入框类型不支持选区，忽略 */ }
  }

  useImperativeHandle(ref, () => ({
    sendLine,
    focus: () => inputRef.current?.focus(),
    clear: () => { if (inputRef.current) inputRef.current.value = ''; },
    get value() { return inputRef.current?.value ?? ''; },
  }));

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      // 输入法还在组合：回车先记下来，等 compositionend 一起发，避免这一下回车丢失
      if (composingRef.current) {
        enterPendingRef.current = true;
        e.preventDefault();
        return;
      }
      if (ignoreNextEnterRef.current) { ignoreNextEnterRef.current = false; e.preventDefault(); return; }
      e.preventDefault();
      sendLine();
      return;
    }
    const el = inputRef.current;
    const hasText = !!el && el.value.length > 0;
    if (hasText) {
      // 框里有字：编辑键走浏览器默认（退格/方向/删除），Esc 清空，Tab 插入
      if (e.key === 'Escape') { e.preventDefault(); el.value = ''; }
      else if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('\t'); }
      return;
    }
    // 空框：工具键透传给终端
    const key = e.key;
    if (key === 'Tab') { e.preventDefault(); onSendText('\t'); }
    else if (key === 'Escape') { e.preventDefault(); onSendText('\x1b'); }
    else if (key === 'ArrowUp') { e.preventDefault(); onSendText('\x1b[A'); }
    else if (key === 'ArrowDown') { e.preventDefault(); onSendText('\x1b[B'); }
    else if (key === 'ArrowLeft') { e.preventDefault(); onSendText('\x1b[D'); }
    else if (key === 'ArrowRight') { e.preventDefault(); onSendText('\x1b[C'); }
    else if (key === 'Backspace') { e.preventDefault(); onSendText('\x7f'); }
    else if (key === 'Delete') { e.preventDefault(); onSendText('\x1b[3~'); }
    else if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const ch = key.toLowerCase();
      if (ch >= 'a' && ch <= 'z') {
        e.preventDefault();
        onSendText(String.fromCharCode(ch.charCodeAt(0) - 96));
      }
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      placeholder={placeholder}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="send"
      style={{ ...BASE_INPUT_STYLE, ...inputStyle }}
      onFocus={(e) => { e.target.style.borderColor = focusBorderColor; }}
      onBlur={(e) => { e.target.style.borderColor = blurBorderColor; }}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => {
        composingRef.current = false;
        // 组合中按下的回车在这里兑现：把提交的整段文字 + 回车一次发出
        if (enterPendingRef.current) {
          enterPendingRef.current = false;
          ignoreNextEnterRef.current = true;   // 吞掉组合提交后可能重复的 Enter keydown
          sendLine();
        }
      }}
      onKeyDown={onKeyDown}
    />
  );
});

export default TerminalComposer;
