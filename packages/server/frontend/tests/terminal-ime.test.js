// 「终端里能打中文」的回归测试。
//
// 现象：在 codex 这类全屏 TUI 会话里打拼音不跳输入法、也切不了中英文。
// 机制：系统输入法的候选框画在「文本插入点」——xterm 的隐藏 helper textarea——所在位置，
//       而这个 textarea 的 CSS 初值是 left:-9999em（屏幕外）。xterm 只在 onCursorMove 时
//       调 _syncTextArea() 把它挪到光标处（xterm 6.0.0 里那是唯一调用点），
//       全屏 TUI 画面静态、光标一次不动，于是它从头到尾停在屏幕外。
//
// 所以这里验的是：在 IME 真正要用到位置的时机（focus / keydown），textarea 一定已经在光标处。

import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  attachImeCursorSync,
  computeCursorBox,
  syncTextAreaToCursor,
} from '../src/terminal-ime';
import {
  stubTerminalLayout, write, fireKey,
  CELL_WIDTH, CELL_HEIGHT,
} from './setup-jsdom.js';

let term, container, restoreLayout, handle;

// xterm CSS 把 textarea 丢到屏幕外，jsdom 不加载外部样式表，这里手动还原那个初值，
// 否则测试是在一个「本来就没问题」的起点上跑，等于什么都没验。
const OFFSCREEN = '-9999em';

const textareaOf = () => container.querySelector('.xterm-helper-textarea');

/** 把光标移到 1-based 的 (row, col)，并返回它应有的像素位置。 */
async function moveCursor(row, col) {
  await write(term, `\x1b[${row};${col}H`);
  return { left: `${(col - 1) * CELL_WIDTH}px`, top: `${(row - 1) * CELL_HEIGHT}px` };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = new Terminal({ cols: 80, rows: 24 });
  term.open(container);
  restoreLayout = stubTerminalLayout(term);
  textareaOf().style.left = OFFSCREEN;   // 复现 CSS 初值
  handle = null;
});

afterEach(() => {
  handle?.dispose();
  restoreLayout?.();
  container.remove();
});

describe('能打中文：helper textarea 必须在光标处', () => {
  test('挂载即就位 —— 切到一个画面静态的全屏 TUI，没点没敲也不能停在屏幕外', async () => {
    const want = await moveCursor(3, 6);
    // 注意：写入 CUP 会触发 onCursorMove，xterm 自己也会同步一次。
    // 为了单独验我们这条路径，先把位置弄脏，模拟「光标此后一直不动」。
    textareaOf().style.left = OFFSCREEN;

    handle = attachImeCursorSync(term, container);

    expect(textareaOf().style.left).toBe(want.left);
    expect(textareaOf().style.top).toBe(want.top);
  });

  test('focus 时同步 —— 切会话后第一次输入之前必须就位', async () => {
    handle = attachImeCursorSync(term, container);
    const want = await moveCursor(5, 11);
    textareaOf().style.left = OFFSCREEN;

    textareaOf().dispatchEvent(new window.FocusEvent('focus'));

    expect(textareaOf().style.left).toBe(want.left);
    expect(textareaOf().style.top).toBe(want.top);
  });

  test('keydown 时同步 —— 按下拼音首字母那一刻（compositionstart 之前）必须就位', async () => {
    handle = attachImeCursorSync(term, container);
    const want = await moveCursor(2, 4);
    textareaOf().style.left = OFFSCREEN;

    fireKey(textareaOf(), 'keydown', { key: 'n' });

    expect(textareaOf().style.left).toBe(want.left);
    expect(textareaOf().style.top).toBe(want.top);
  });

  test('候选框大小按单元格走，不能是 0（0 尺寸的插入点定位不可靠）', async () => {
    await moveCursor(1, 1);
    handle = attachImeCursorSync(term, container);

    expect(textareaOf().style.width).toBe(`${CELL_WIDTH}px`);
    expect(textareaOf().style.height).toBe(`${CELL_HEIGHT}px`);
    expect(textareaOf().style.lineHeight).toBe(`${CELL_HEIGHT}px`);
  });

  test('光标一路走到行尾也不越界（列 clamp 到 cols-1）', async () => {
    // CUP 超出屏宽时 xterm 自己会 clamp，这里额外确认换算不会算出屏幕外的 left
    await moveCursor(1, 200);
    handle = attachImeCursorSync(term, container);

    const left = parseFloat(textareaOf().style.left);
    expect(left).toBeLessThanOrEqual((term.cols - 1) * CELL_WIDTH);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  test('dispose 之后不再跟随（避免终端销毁后还去摸 DOM）', async () => {
    handle = attachImeCursorSync(term, container);
    handle.dispose();
    handle = null;

    await moveCursor(7, 3);
    textareaOf().style.left = OFFSCREEN;
    fireKey(textareaOf(), 'keydown', { key: 'n' });
    textareaOf().dispatchEvent(new window.FocusEvent('focus'));

    expect(textareaOf().style.left).toBe(OFFSCREEN);
  });
});

describe('computeCursorBox / syncTextAreaToCursor 的边界', () => {
  test('渲染尺寸还没量出来时返回 null，不去写 style（否则会算出 NaNpx）', () => {
    const bare = new Terminal({ cols: 80, rows: 24 });   // 没 open，没有 renderService
    expect(computeCursorBox(bare)).toBeNull();
    bare.dispose();
  });

  test('光标不在可视区时不动它 —— 与 xterm 的 isCursorInViewport 判定一致', () => {
    const ta = textareaOf();
    ta.style.left = OFFSCREEN;
    // 直接把光标推到可视区之外（滚动状态下会出现），此时挪 textarea 只会定错行
    const buffer = term.buffer.active;
    Object.defineProperty(buffer, 'cursorY', { get: () => term.rows + 5, configurable: true });

    expect(computeCursorBox(term)).toBeNull();
    expect(syncTextAreaToCursor(term, ta)).toBe(false);
    expect(ta.style.left).toBe(OFFSCREEN);
  });

  test('没有 textarea 时安静返回 false，不抛', () => {
    expect(syncTextAreaToCursor(term, null)).toBe(false);
  });
});
