// 中文/日文等输入法（IME）在终端里的定位修复。
//
// ── 问题 ──
// xterm 用一个隐藏的 helper textarea 接收键盘与 IME 输入，CSS 初始把它丢到屏幕外：
//   .xterm .xterm-helper-textarea { position: absolute; left: -9999em; top: 0; width: 0; height: 0 }
// 系统输入法的候选框是画在「文本插入点」——也就是这个 textarea——的位置上的，
// 所以只要它还在 -9999em，候选框就画到屏幕外，用户看到的现象就是
// 「打拼音不跳出输入法、也切不动中英文」。
//
// xterm 自己有 _syncTextArea() 把 textarea 挪到光标处，但它**只挂在 onCursorMove 上**
// （xterm 6.0.0 CoreBrowserTerminal.ts:506 是唯一调用点）。这对普通 shell 够用（每敲一下光标就动），
// 对 codex / claude 这类全屏 TUI 不够：切到一个已经在等输入的会话时画面是静态的，
// 光标一次都不动，于是 textarea 从头到尾停在屏幕外。
//
// ── 解法 ──
// 自己在「IME 真正要用到位置」的时机补同步：textarea 获得焦点时、以及每次 keydown
// （按下拼音第一个字母时 compositionstart 还没发生，此刻挪好位置正合适）。
// 计算方式与 xterm 的 _syncTextArea 完全一致，只是触发时机更早、更全。

/** 从终端读出光标处的像素位置与单元格尺寸；拿不到（未渲染/光标不在可视区）时返回 null。 */
export function computeCursorBox(term) {
  const cell = term?._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return null;
  const buffer = term.buffer?.active;
  if (!buffer) return null;
  const { cursorX, cursorY } = buffer;
  // 光标不在可视区时不动它：此时 xterm 自己也会跳过同步，硬挪反而把 IME 定到错误的行上
  if (cursorY < 0 || cursorY >= term.rows) return null;
  const col = Math.min(Math.max(cursorX, 0), term.cols - 1);
  return {
    left: col * cell.width,
    top: cursorY * cell.height,
    width: cell.width,
    height: cell.height,
  };
}

/** 把 helper textarea 挪到光标处。返回是否真的挪了（供测试与调试断言）。 */
export function syncTextAreaToCursor(term, textarea) {
  if (!textarea) return false;
  const box = computeCursorBox(term);
  if (!box) return false;
  textarea.style.left = `${box.left}px`;
  textarea.style.top = `${box.top}px`;
  textarea.style.width = `${box.width}px`;
  textarea.style.height = `${box.height}px`;
  textarea.style.lineHeight = `${box.height}px`;
  return true;
}

/**
 * 给终端接上 IME 定位同步。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {HTMLElement} container  term.open() 的宿主元素
 * @returns {{ sync: () => boolean, dispose: () => void }}
 */
export function attachImeCursorSync(term, container) {
  const textarea = container?.querySelector('.xterm-helper-textarea')
    || term?._core?.textarea
    || container?.querySelector('textarea');

  const sync = () => syncTextAreaToCursor(term, textarea);

  // focus：切会话/点终端后第一次输入之前就位
  // keydown（capture，早于 xterm 自己的处理）：按下拼音首字母时 compositionstart 还没发生，
  //   此刻挪好，候选框才会开在光标下方而不是屏幕外
  textarea?.addEventListener('focus', sync);
  textarea?.addEventListener('keydown', sync, true);

  // 首次挂载时先摆一次，省得「切过去还没点就打字」那一下落在 -9999em
  sync();

  return {
    sync,
    dispose() {
      textarea?.removeEventListener('focus', sync);
      textarea?.removeEventListener('keydown', sync, true);
    },
  };
}

// ── 输入法直接上屏的字符（豆包输入法 Shift+= 打不出 +）──
//
// 输入法开着时，按键的 keydown 是 keyCode 229（key='Process'）。不经候选框、直接上屏的字符
// （中文标点、Shift+符号、英文模式下的字母）随后以一次 insertText 的 input 事件写进 textarea。
// xterm 6.0.0 对这种按键的处理（CompositionHelper.keydown → _handleAnyTextareaChanges）是：
// keydown 时记下 textarea 的值，**setTimeout(0)** 后比对差异发出去。字符写入晚于这个定时器
// 就比对不出差异；而那次 input 事件到达时按键还没松开（_keyDownSeen 为真），
// _inputEvent 也不处理 —— 两条路都错过，字符丢失。微软拼音写得快所以没事，豆包写得晚就丢。
//
// 解法：229 按键不再交给 xterm 的定时比对（自定义按键处理返回 false，见 isImeProcessKeydown），
// 改为等输入法真正写入时的 input 事件，拿到什么发什么。监听挂在容器的 capture 阶段，
// 早于 xterm 挂在 textarea 上的 input 处理，处理完 stopPropagation —— 同一个字只发一次，
// 与输入法写入快慢、写在 keyup 之前还是之后都无关。
// 候选框组合（打拼音选字）走 composition 事件，xterm 自己处理，这里不碰（isComposing 时跳过）。

/** 输入法接管的按键（keydown 的 keyCode 229）。供 attachCustomKeyEventHandler 用：返回 true 时交给 attachImeCommitInput。 */
export function isImeProcessKeydown(e) {
  return e.type === 'keydown' && e.keyCode === 229;
}

/**
 * 接上「输入法直接上屏」的输入通道。必须与自定义按键处理里的 isImeProcessKeydown 配套使用。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {HTMLElement} container  term.open() 的宿主元素
 * @returns {{ dispose: () => void }}
 */
export function attachImeCommitInput(term, container) {
  if (!container) return { dispose() {} };
  // 只认紧跟在 229 按键之后的那次写入；其它来源的 input（表情面板等）照旧交给 xterm
  let pending = false;
  const onKeyDown = (e) => { pending = e.keyCode === 229 && !e.isComposing; };
  const onCompositionStart = () => { pending = false; };
  const onInput = (e) => {
    if (!pending || e.isComposing) return;
    if (e.inputType === 'insertText' && e.data) {
      pending = false;
      e.stopPropagation();
      term.input(e.data);
    } else if (e.inputType === 'deleteContentBackward') {
      pending = false;
      e.stopPropagation();
      term.input('\x7f');
    }
  };
  container.addEventListener('keydown', onKeyDown, true);
  container.addEventListener('compositionstart', onCompositionStart, true);
  container.addEventListener('input', onInput, true);
  return {
    dispose() {
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('compositionstart', onCompositionStart, true);
      container.removeEventListener('input', onInput, true);
    },
  };
}
