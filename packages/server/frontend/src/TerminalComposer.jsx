import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FULL_VIEWPORT_HEIGHT, TERMINAL_INPUT_FONT_SIZE } from './mobile-layout-config';
import { formatTextBlock } from './terminal-io';
import { isMacPlatform } from './terminal-clipboard-keys';

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
// 提交进 input.value 之后，**文字 + '\r' 一起发**；同时在 IME_ENTER_ECHO_MS 内吞掉 Android
// 在组合提交后可能补发的那一次 Enter keydown（否则整行会发两遍）。
// 只吞这一小段时间窗：Mac Chrome / iOS 不补发，旧实现的「吞下一次」会一直挂着，
// 把用户下一条消息的真回车吃掉，表现为「每条要按两次回车」（2026-11-06 复现）。
//
// ── 空框时的后门 ──
// 框里有字 = 在编辑，退格/方向/删除走浏览器默认，Tab 插制表符；
// 框为空 = 这些键原样透传给终端（TUI 里要靠它们操作，否则打开 composer 就等于没法操作终端了）。
//
// ── 文字不能丢 ──
// 往上滚过历史时 tmux 停在 copy-mode，这时写进 PTY 的文字全被 copy-mode 当按键吃掉，回车只
// 退出 copy-mode，程序什么也收不到。所以整行发送前先调 onBeforeSendLine 让调用方退出它。
// 连接断开时 onSendText 返回 false：文字留在框里，连上后再按一次回车即可。
//
// ── 长文字：框向上长，不挤终端 ──
// 文字自动换行，框随内容长高，到上限后在框内上下滚动。框盖在终端底部而不是把终端往上推：
// 终端区一变矮就要改 PTY 尺寸，打字每多一行 TUI 就整屏重绘一次，还会连累同一会话的其他观众。
// 外层占位只保留单行高度，所以框多高都不影响布局。
//
// ── 多行 ──
// Enter 发送，Shift+Enter 换行（手机软键盘没有 Shift，工具条上有换行键，走 insertNewline）。
//
// ── Esc 永远给终端 ──
// 不管框里有没有字，Esc 都发给程序（打断 Claude Code 等），框里的字原样保留。
// 以前框里有字时 Esc 是清空，长文字一按就没了。输入法组合中的 Esc 归输入法（取消候选）。含换行的内容按粘贴发（见 terminal-io.js 的 formatTextBlock），
// 否则每个换行都等于按一次回车，一段话会被拆成好几条消息提交。

const BASE_INPUT_STYLE = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  width: '100%',
  display: 'block',
  resize: 'none',
  overflowY: 'auto',
  overflowWrap: 'anywhere',
  overscrollBehavior: 'contain',
  // 盖在终端上，必须不透明。视觉上等于 #0d1117 上叠 6% 白
  background: '#1b1f25',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#e6edf3',
  borderRadius: '6px',
  padding: '8px 12px',
  // 16px 是 iOS Safari 不自动放大页面的下限，低于它每次聚焦输入框整页都会被缩放
  fontSize: `${TERMINAL_INPUT_FONT_SIZE}px`,
  fontFamily: '"JetBrains Mono", monospace',
  lineHeight: '20px',
  outline: 'none',
  minHeight: '38px',   // 单行的真实高度：20 行高 + 16 内边距 + 2 边框
  maxHeight: `calc(${FULL_VIEWPORT_HEIGHT} * 0.4)`,
};

// 组合提交后补发的 Enter 只会紧跟着到达；超过这个时长的回车一定是用户自己按的
const IME_ENTER_ECHO_MS = 300;

// 非 Mac 上 Ctrl+V 是浏览器粘贴，空框时也要留给浏览器 —— 往框里第一次粘贴时框必然是空的，
// 从前这一下被当成 ^V 发给了终端。只放行 V：空框没有东西可复制/剪切/全选，
// Ctrl+C 在空框里必须照旧是打断，Ctrl+A/X 照旧是终端里的行首/编辑键。Mac 上粘贴是 Cmd+V。

const FOCUS_BORDER = '#58a6ff';
const BLUR_BORDER = 'rgba(255,255,255,0.15)';

/**
 * @param {object} props
 * @param {(text: string) => boolean} props.onSendText 把文本发进 PTY（调用方负责编码与 ws 发送），连接断开时返回 false
 * @param {() => void} props.onBeforeSendLine 发送非空整行之前调用：退出 tmux copy-mode
 * @param {() => boolean} props.isBracketedPaste 程序此刻是否开了 bracketed paste，决定多行内容怎么发
 * @param {object} [props.inputStyle]   叠加在默认样式上（手机版调大内边距/换主题色）
 * @param {string} [props.placeholder]
 * @param {string} [props.focusBorderColor]
 * @param {string} [props.blurBorderColor]
 * @param {React.Ref} ref 暴露 { sendLine, insertNewline, focus, clear }，供外部「⏎」按钮调用
 */
const TerminalComposer = forwardRef(function TerminalComposer({
  onSendText,
  onBeforeSendLine,
  isBracketedPaste,
  inputStyle,
  placeholder = '输入内容，回车发送',
  focusBorderColor = FOCUS_BORDER,
  blurBorderColor = BLUR_BORDER,
}, ref) {
  const inputRef = useRef(null);
  const composingRef = useRef(false);
  // IME 组合中按下的回车：见文件头「Android 回车竞态」
  const enterPendingRef = useRef(false);
  // Android 组合提交后可能再补发一次 Enter keydown：这个时刻之前到达的 Enter 吞掉，避免整行发送两次
  const ignoreEnterUntilRef = useRef(0);

  // 框高跟内容走。隐藏的面板量不出高度（scrollHeight=0），等它显示时由下面的 ResizeObserver 补量。
  function fitHeight() {
    const el = inputRef.current;
    if (!el) return;
    if (!el.value) { el.style.height = ''; return; }
    const top = el.scrollTop;   // 超过上限时框内有滚动位置，height:auto 会把它打回去
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    el.scrollTop = top;
  }

  // 宽度变了（旋转屏幕、拖分栏、面板从隐藏切回来）折行就变了，要重量
  useEffect(() => {
    const el = inputRef.current;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fitHeight();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function setValue(text) {
    const el = inputRef.current;
    if (!el) return;
    el.value = text;
    fitHeight();
  }

  // 把框里的内容 + 回车一次发出。空框回车 = 只发回车（等同在终端按一次 Enter）。
  function sendLine() {
    const el = inputRef.current;
    if (!el) return;
    const val = el.value;
    if (val) {
      onBeforeSendLine();
      if (onSendText(formatTextBlock(val, isBracketedPaste())) === false) return;
      setValue('');
    }
    onSendText('\r');
  }

  // 在输入框光标处插入字符（组合模式下 Tab 当作普通字符编辑）
  function insertAtCursor(text) {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.setSelectionRange(start + text.length, start + text.length);
    fitHeight();
  }

  useImperativeHandle(ref, () => ({
    sendLine,
    focus: () => inputRef.current?.focus(),
    clear: () => setValue(''),
    // 工具条的换行键：在光标处插一个换行，焦点留在框里（键盘不收起）
    insertNewline: () => {
      const el = inputRef.current;
      el.focus();
      insertAtCursor('\n');
      if (el.selectionEnd === el.value.length) el.scrollTop = el.scrollHeight;   // 末尾换行要看得见新行
    },
    get value() { return inputRef.current?.value ?? ''; },
  }));

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      if (e.shiftKey) return;   // 换行走浏览器默认，组合中的 Shift+Enter 也归输入法处理
      // 输入法还在组合：回车先记下来，等 compositionend 一起发，避免这一下回车丢失
      if (composingRef.current) {
        enterPendingRef.current = true;
        e.preventDefault();
        return;
      }
      if (Date.now() < ignoreEnterUntilRef.current) { ignoreEnterUntilRef.current = 0; e.preventDefault(); return; }
      e.preventDefault();
      sendLine();
      return;
    }
    if (e.key === 'Escape') {
      if (composingRef.current || e.nativeEvent.isComposing) return;   // 输入法自己用 Esc 取消候选
      e.preventDefault();
      onSendText('\x1b');
      return;
    }
    const el = inputRef.current;
    const hasText = !!el && el.value.length > 0;
    if (hasText) {
      // 框里有字：编辑键走浏览器默认（退格/方向/删除），Tab 插入
      if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('\t'); }
      return;
    }
    // 空框：工具键透传给终端
    const key = e.key;
    if (key === 'Tab') { e.preventDefault(); onSendText('\t'); }
    else if (key === 'ArrowUp') { e.preventDefault(); onSendText('\x1b[A'); }
    else if (key === 'ArrowDown') { e.preventDefault(); onSendText('\x1b[B'); }
    else if (key === 'ArrowLeft') { e.preventDefault(); onSendText('\x1b[D'); }
    else if (key === 'ArrowRight') { e.preventDefault(); onSendText('\x1b[C'); }
    else if (key === 'Backspace') { e.preventDefault(); onSendText('\x7f'); }
    else if (key === 'Delete') { e.preventDefault(); onSendText('\x1b[3~'); }
    else if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const ch = key.toLowerCase();
      if (ch === 'v' && !isMacPlatform(navigator.platform)) return;
      if (ch >= 'a' && ch <= 'z') {
        e.preventDefault();
        onSendText(String.fromCharCode(ch.charCodeAt(0) - 96));
      }
    }
  }

  const mergedStyle = { ...BASE_INPUT_STYLE, ...inputStyle };

  return (
    // 占位层只占单行高度；zIndex 让长高的框压在 xterm 的画布上面
    <div style={{ position: 'relative', flex: 1, minWidth: 0, height: mergedStyle.minHeight, zIndex: 30 }}>
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="终端输入框"
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
        style={mergedStyle}
        onFocus={(e) => { e.target.style.borderColor = focusBorderColor; }}
        onBlur={(e) => { e.target.style.borderColor = blurBorderColor; }}
        onInput={fitHeight}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          composingRef.current = false;
          // 组合中按下的回车在这里兑现：把提交的整段文字 + 回车一次发出
          if (enterPendingRef.current) {
            enterPendingRef.current = false;
            ignoreEnterUntilRef.current = Date.now() + IME_ENTER_ECHO_MS;   // 吞掉紧随其后的重复 Enter keydown
            sendLine();
          }
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});

export default TerminalComposer;
