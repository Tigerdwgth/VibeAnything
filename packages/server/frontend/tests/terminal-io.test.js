// 终端字节搬运层：编码 / 解码 / 尺寸判据 / 写入合批。
// 这四件事桌面版与手机版共用同一份实现，且每一件都有过对应的线上故障，
// 所以这里断言的是行为本身（真 TextEncoder、真 rAF、真 xterm 那样的 write 契约）。

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeInput, decodePtyData, measureTerminalSize, createPtyWriteBatcher,
  remeasureCharSize, installWebFontRefit,
  MIN_COLS, MIN_ROWS,
} from '../src/terminal-io.js';

describe('encodeInput / decodePtyData', () => {
  test('ASCII 往返', () => {
    expect(Array.from(decodePtyData(encodeInput('ls -la\r')))).toEqual(
      Array.from(new TextEncoder().encode('ls -la\r'))
    );
  });

  test('中文按 UTF-8 编码后再 base64（直接 btoa 会抛 InvalidCharacterError）', () => {
    const b64 = encodeInput('继续\r');
    expect(() => btoa('继续')).toThrow();          // 前提：裸 btoa 真的不行
    expect(new TextDecoder().decode(decodePtyData(b64))).toBe('继续\r');
  });

  test('转义序列原样过（方向键 / Ctrl-C 全靠它）', () => {
    for (const seq of ['\x1b[A', '\x1b[B', '\x03', '\x1b', '\x7f']) {
      expect(new TextDecoder().decode(decodePtyData(encodeInput(seq)))).toBe(seq);
    }
  });

  test('emoji 这类四字节字符也完整往返', () => {
    expect(new TextDecoder().decode(decodePtyData(encodeInput('🐰ok')))).toBe('🐰ok');
  });

  test('解码出来的是 Uint8Array —— term.write 认字节，不认字符串', () => {
    expect(decodePtyData(encodeInput('x'))).toBeInstanceOf(Uint8Array);
  });
});

describe('measureTerminalSize', () => {
  const fakeFit = () => ({ fit: vi.fn() });
  const el = (w, h) => ({ offsetWidth: w, offsetHeight: h });

  test('量到合法尺寸就返回它，并先 fit 一次', () => {
    const fit = fakeFit();
    const size = measureTerminalSize(el(800, 600), { cols: 100, rows: 30 }, fit);
    expect(size).toEqual({ cols: 100, rows: 30 });
    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  test('容器没布局好（宽高为 0，典型是 display:none 的后台面板）→ 不报尺寸', () => {
    const fit = fakeFit();
    expect(measureTerminalSize(el(0, 0), { cols: 100, rows: 30 }, fit)).toBeNull();
    // 连 fit 都不该调：对一个没布局的容器 fit，算出来的就是那个假尺寸
    expect(fit.fit).not.toHaveBeenCalled();
  });

  test('算出荒唐的小尺寸一律丢弃 —— 10x6 进了 tmux 会把窗口永久压成 10 列', () => {
    expect(measureTerminalSize(el(800, 600), { cols: 10, rows: 6 }, fakeFit())).toBeNull();
    expect(measureTerminalSize(el(800, 600), { cols: 100, rows: 2 }, fakeFit())).toBeNull();
  });

  test('下限取在边界上是放行的（判据是 >=，与 relay 的 sanitizeSize 同口径）', () => {
    const size = measureTerminalSize(el(800, 600), { cols: MIN_COLS, rows: MIN_ROWS }, fakeFit());
    expect(size).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  test('fit 抛异常（容器尚未布局）不往外炸，继续按当前 cols/rows 判定', () => {
    const fit = { fit: () => { throw new Error('not laid out'); } };
    expect(measureTerminalSize(el(800, 600), { cols: 80, rows: 24 }, fit)).toEqual({ cols: 80, rows: 24 });
  });

  test('终端还没建好 → null', () => {
    expect(measureTerminalSize(el(800, 600), null, fakeFit())).toBeNull();
    expect(measureTerminalSize(null, { cols: 80, rows: 24 }, fakeFit())).toBeNull();
  });
});

describe('createPtyWriteBatcher', () => {
  let rafQueue;
  let origRaf;
  let origCancel;

  beforeEach(() => {
    // 用可控的 rAF 才能断言「同一帧内合并成一次 write」；回调本身仍是被测代码
    rafQueue = new Map();
    let id = 0;
    origRaf = globalThis.requestAnimationFrame;
    origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => { rafQueue.set(++id, cb); return id; };
    globalThis.cancelAnimationFrame = (i) => { rafQueue.delete(i); };
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  });

  const runFrame = () => { const cbs = Array.from(rafQueue.values()); rafQueue.clear(); cbs.forEach(cb => cb()); };
  const fakeTerm = () => ({ writes: [], write(d) { this.writes.push(d); } });

  test('同一帧的多条消息合成一次 write（每条各写一次会让手机花屏）', () => {
    const term = fakeTerm();
    const w = createPtyWriteBatcher(() => term);
    w.push(new Uint8Array([1, 2]));
    w.push(new Uint8Array([3]));
    w.push(new Uint8Array([4, 5]));
    expect(term.writes).toHaveLength(0);       // 还没到帧边界，一个字节都不写
    runFrame();
    expect(term.writes).toHaveLength(1);
    expect(Array.from(term.writes[0])).toEqual([1, 2, 3, 4, 5]);
  });

  test('只排一个 rAF，不是每条消息排一个', () => {
    const w = createPtyWriteBatcher(() => fakeTerm());
    w.push(new Uint8Array([1]));
    w.push(new Uint8Array([2]));
    expect(rafQueue.size).toBe(1);
  });

  test('下一帧继续合批，缓冲已清空不会重复写', () => {
    const term = fakeTerm();
    const w = createPtyWriteBatcher(() => term);
    w.push(new Uint8Array([1]));
    runFrame();
    w.push(new Uint8Array([2]));
    runFrame();
    expect(term.writes.map(b => Array.from(b))).toEqual([[1], [2]]);
  });

  test('dispose 把残留数据写完 —— 否则最后一帧的输出会丢', () => {
    const term = fakeTerm();
    const w = createPtyWriteBatcher(() => term);
    w.push(new Uint8Array([9]));
    w.dispose();
    expect(term.writes.map(b => Array.from(b))).toEqual([[9]]);
    expect(rafQueue.size).toBe(0);             // 排队的 rAF 也要取消，否则组件卸载后还回调
  });

  test('终端还没建好时不写，数据留着等下一次', () => {
    let term = null;
    const w = createPtyWriteBatcher(() => term);
    w.push(new Uint8Array([7]));
    runFrame();                                 // 这一帧终端还是 null
    term = fakeTerm();
    w.flush();
    expect(term.writes.map(b => Array.from(b))).toEqual([[7]]);
  });
});

// 网页字体晚到 → 终端比例不对（2026-10-10）。
//
// 浏览器里实测的事实（Chrome + xterm 6.0.0，14px）：
//  · 回退字体 monospace 的格子 8.404x16，JetBrains Mono 的格子 8.397x18；
//  · xterm 只在 open() / dpr 变化 / cols·rows 真变时量格子，字体晚到不会重量 ——
//    50 行的网格留在只放得下 44 行的面板里，底部被切掉；
//  · fontFamily **同值赋值不触发重量**，值真的变了才触发，且赋值后同步可读到新格子；
//  · document.fonts.check('14px "JetBrains Mono"') 在字体的 CSS 还没到时返回 **true**
//    （规范：匹配不到 @font-face 的字体名算系统字体），所以它不能当判据。
// 下面断言的就是这几条事实对应的接线。
describe('remeasureCharSize', () => {
  const fakeTerm = (fontFamily) => ({ options: { fontFamily, fontSize: 14 } });

  test('改掉 fontFamily 的值（同值赋值 xterm 不会重量，这是唯一的公共入口）', () => {
    const term = fakeTerm('"JetBrains Mono", monospace');
    remeasureCharSize(term);
    expect(term.options.fontFamily).not.toBe('"JetBrains Mono", monospace');
  });

  test('改的只是「值」：原字体栈仍在最前面，实际选中的字体不变', () => {
    const term = fakeTerm('"JetBrains Mono", monospace');
    remeasureCharSize(term);
    expect(term.options.fontFamily.startsWith('"JetBrains Mono", monospace')).toBe(true);
    // 追加的必须是带引号的字体名，否则 ctx.font 这个简写整条解析失败，xterm 会量成默认字体
    expect(term.options.fontFamily.slice('"JetBrains Mono", monospace'.length)).toMatch(/^,\s*"[^"]+"$/);
  });

  test('来回切：第二次调用把哨兵摘掉，值照样是变的（重量可以反复触发）', () => {
    const term = fakeTerm('"JetBrains Mono", monospace');
    remeasureCharSize(term);
    const once = term.options.fontFamily;
    remeasureCharSize(term);
    expect(term.options.fontFamily).toBe('"JetBrains Mono", monospace');
    expect(term.options.fontFamily).not.toBe(once);
  });

  test('终端还没建好 / 没有 fontFamily 时不抛', () => {
    expect(() => remeasureCharSize(null)).not.toThrow();
    expect(() => remeasureCharSize({ options: {} })).not.toThrow();
  });
});

describe('installWebFontRefit', () => {
  /** 真 EventTarget 当 FontFaceSet：被测代码只用到 loadingdone 这一个事件。 */
  const fakeFonts = () => {
    const fonts = new EventTarget();
    fonts.done = () => fonts.dispatchEvent(new Event('loadingdone'));
    return fonts;
  };
  const fakeTerm = () => ({ options: { fontFamily: '"JetBrains Mono", monospace', fontSize: 14 } });

  test('字体加载完成 → 先重量，再回调（顺序反了的话调用方 fit 到的还是旧格子）', () => {
    const term = fakeTerm();
    const fonts = fakeFonts();
    const seen = [];
    installWebFontRefit(term, () => seen.push(term.options.fontFamily), { fonts });
    fonts.done();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('"JetBrains Mono", monospace');   // 回调里已经能读到新格子了
  });

  test('装上但字体没动静 → 一次都不回调（不能无故去 resize PTY）', () => {
    let calls = 0;
    installWebFontRefit(fakeTerm(), () => { calls++; }, { fonts: fakeFonts() });
    expect(calls).toBe(0);
  });

  test('字体分批到达（正文字体、等宽字体各一批）→ 每批都重量一次', () => {
    const fonts = fakeFonts();
    let calls = 0;
    installWebFontRefit(fakeTerm(), () => { calls++; }, { fonts });
    fonts.done();
    fonts.done();
    expect(calls).toBe(2);
  });

  test('卸载后不再回调 —— 面板关掉了还去 resize 别人的 tmux 窗口是真事故', () => {
    const fonts = fakeFonts();
    let calls = 0;
    const dispose = installWebFontRefit(fakeTerm(), () => { calls++; }, { fonts });
    dispose();
    fonts.done();
    expect(calls).toBe(0);
  });

  test('宿主没有 FontFaceSet（jsdom、老 Safari）→ 装不上也不抛，返回能调的卸载函数', () => {
    expect(() => installWebFontRefit(fakeTerm(), () => {}, { fonts: undefined })()).not.toThrow();
  });
});
