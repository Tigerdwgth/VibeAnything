// 终端「能选中 / 能点链接」的回归测试 —— 基本特性，必须常测。
//
// 这些用例在真 jsdom 里挂载真 xterm、派发真 MouseEvent，验的是**事件接线**：
// 该放行给 xterm 的事件有没有被我们吞掉、补交给 xterm 的事件是不是它认的形状。
// 08-25 的回归（选不中 + 点不了链接）纯函数单测全绿却没测出来，就是因为
// 算法全对、接线错了 —— 所以这一层测试不可省。
//
// 不在这里断言像素级选区结果：jsdom 没有真实布局，xterm 的坐标换算不可用，
// 那也本就是 xterm 自己的测试职责。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  stubTerminalLayout, enableMouseReporting, fireMouse, write, CELL_WIDTH, CELL_HEIGHT,
} from './setup-jsdom.js';
import {
  attachTerminalPointer, detectForceSelectionModifier, withForcedSelection,
} from '../src/terminal-pointer.js';

let term, container, restoreLayout, attached, sent, copied, opened;
let linkProviders = [];

async function setup({ mouseReporting = true, text = 'hello world https://example.com tail' } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  linkProviders = [];
  const origRegister = Terminal.prototype.registerLinkProvider;
  vi.spyOn(Terminal.prototype, 'registerLinkProvider').mockImplementation(function (provider) {
    linkProviders.push(provider);
    return origRegister.call(this, provider);
  });
  term = new Terminal({ cols: 80, rows: 24, macOptionClickForcesSelection: true });
  term.open(container);
  restoreLayout = stubTerminalLayout(term);
  const cs = term._core?._charSizeService;
  if (cs) { cs.width = CELL_WIDTH; cs.height = CELL_HEIGHT; }
  await write(term, text);
  if (mouseReporting) await enableMouseReporting(term);

  sent = [];
  copied = [];
  opened = [];
  attached = attachTerminalPointer(term, container, {
    sendInput: (t) => sent.push(t),
    onCopy: (t) => copied.push(t),
    openLink: (uri) => opened.push(uri),
  });
  return { term, container };
}

/** xterm 内部真正接收 mousedown 的元素（.xterm 根节点），选区服务就挂在它上面。 */
function screenEl() {
  return container.querySelector('.xterm-screen') || term.element;
}

beforeEach(() => { sent = []; copied = []; opened = []; linkProviders = []; });

afterEach(() => {
  // 上报模式下 xterm 会在 mousedown 时把临时 mouseup 监听挂到 document，收到 mouseup 才自行摘除，
  // 且这个监听**不随 term.dispose() 移除**。所以这里：
  //  ① 补一次 mouseup，让 xterm 摘掉本用例留下的监听；
  //  ② 故意不 dispose 终端 —— 已销毁的终端再收到 mouseup 会读到空的 renderService 而抛异常，
  //     污染后续用例（vitest 会判为 unhandled error）。留着它反而更接近线上（页面里终端长期存活），
  //     测试进程结束即回收。
  try { attached?.dispose(); } catch {}
  try { if (term) fireMouse(document, 'mouseup', { x: 0, y: 0 }); } catch {}
  try { restoreLayout?.(); } catch {}
  container?.remove();
  term = container = restoreLayout = attached = null;
  vi.restoreAllMocks();
});

describe('前提：tmux 鼠标上报会关掉 xterm 自己的选区服务', () => {
  it('这是所有「选不中」问题的根因，也是 xterm 私有 API 的契约锚点', async () => {
    await setup({ mouseReporting: false });
    expect(term._core._selectionService._enabled).toBe(true);

    await enableMouseReporting(term);
    expect(term._core.coreMouseService.areMouseEventsActive).toBe(true);
    // 上报一开，xterm 主动 disable 选区服务：此后只有「强制选中」事件才被受理
    expect(term._core._selectionService._enabled).toBe(false);
  });

  it('xterm 的强制选中修饰键语义未变（升级 xterm 时这条会先红）', async () => {
    await setup();
    const modifier = detectForceSelectionModifier(term._core._selectionService);
    // mac → Option(alt)，其他平台 → Shift；不该是 null，否则拖选补交必然失效
    expect(['alt', 'shift']).toContain(modifier);

    const ss = term._core._selectionService;
    if (modifier === 'alt') {
      expect(ss.shouldForceSelection({ altKey: true })).toBe(true);
      expect(ss.shouldForceSelection({ altKey: false, shiftKey: false })).toBe(false);
    } else {
      expect(ss.shouldForceSelection({ shiftKey: true })).toBe(true);
      expect(ss.shouldForceSelection({ altKey: false, shiftKey: false })).toBe(false);
    }
  });
});

describe('基本特性：能选中', () => {
  it('修饰键 + 左键必须原样放行给 xterm（不得被拦截）', async () => {
    await setup();
    const modifier = detectForceSelectionModifier(term._core._selectionService);
    const spy = vi.spyOn(term._core._selectionService, 'handleMouseDown');

    const ev = fireMouse(screenEl(), 'mousedown', {
      x: 2 * CELL_WIDTH, y: 0,
      altKey: modifier === 'alt',
      shiftKey: modifier === 'shift',
    });

    // 事件必须活着到达 xterm 的选区服务：这正是上一版被 stopPropagation 吞掉的那条路
    expect(spy).toHaveBeenCalledTimes(1);
    expect(term._core._selectionService.shouldForceSelection(spy.mock.calls[0][0])).toBe(true);
    // 放行意味着我们不碰它，更不该合成 SGR 序列发给 tmux。
    // 注意：不能用 defaultPrevented 判断「有没有被我们拦」—— xterm 自己的 mousedown
    // handler 第一句就是 preventDefault()，放行后它必然为 true。
    // 「事件真的到达 xterm」的唯一可靠证据就是 handleMouseDown 被调用。
    expect(sent).toEqual([]);
    void ev;

    fireMouse(document, 'mouseup', { x: 2 * CELL_WIDTH, y: 0 });
  });

  it('裸左键拖选补交给 xterm 的事件必须带强制选中修饰键，否则是空操作', async () => {
    await setup();
    const ss = term._core._selectionService;
    const spy = vi.spyOn(ss, 'handleMouseDown');

    fireMouse(screenEl(), 'mousedown', { x: 0, y: 0 });
    fireMouse(document, 'mousemove', { x: 20 * CELL_WIDTH, y: 0 });

    expect(spy).toHaveBeenCalledTimes(1);
    const forwarded = spy.mock.calls[0][0];
    // 关键断言：上报模式下选区服务已 disable，只有 shouldForceSelection 为真的事件才被受理。
    // 上一版补交的是裸事件 → handleMouseDown 内部直接 return → 拖选从未生效过。
    expect(ss.shouldForceSelection(forwarded)).toBe(true);
    // 代理不能破坏事件本体
    expect(forwarded.clientX).toBe(0);
    expect(forwarded.type).toBe('mousedown');
    expect(() => forwarded.preventDefault()).not.toThrow();

    fireMouse(document, 'mouseup', { x: 20 * CELL_WIDTH, y: 0 });
  });

  it('拖选松手即复制（copy-on-select）', async () => {
    await setup();
    vi.spyOn(term, 'getSelection').mockReturnValue('selected text');

    fireMouse(screenEl(), 'mousedown', { x: 0, y: 0 });
    fireMouse(document, 'mousemove', { x: 20 * CELL_WIDTH, y: 0 });
    fireMouse(document, 'mouseup', { x: 20 * CELL_WIDTH, y: 0 });

    expect(copied).toEqual(['selected text']);
    // 拖选不是点击，不该给 tmux 发切 pane 序列
    expect(sent).toEqual([]);
  });

  it('没开鼠标上报时完全不插手，xterm 原生选中照常', async () => {
    await setup({ mouseReporting: false });
    const spy = vi.spyOn(term._core._selectionService, 'handleMouseDown');
    fireMouse(screenEl(), 'mousedown', { x: 0, y: 0 });

    expect(spy).toHaveBeenCalledTimes(1);   // 走的是 xterm 自己绑的 listener
    expect(sent).toEqual([]);

    fireMouse(document, 'mouseup', { x: 0, y: 0 });
  });
});

describe('withForcedSelection 代理', () => {
  it('只改修饰键，其余一切透传', async () => {
    await setup();
    const ev = new window.MouseEvent('mousedown', { clientX: 42, clientY: 7, button: 0 });
    const alt = withForcedSelection(ev, 'alt');
    expect(alt.altKey).toBe(true);
    expect(alt.clientX).toBe(42);
    expect(alt.button).toBe(0);

    const shift = withForcedSelection(ev, 'shift');
    expect(shift.shiftKey).toBe(true);
    expect(shift.clientY).toBe(7);

    // 探测不到修饰键时原样返回，不该塞一个坏代理进 xterm
    expect(withForcedSelection(ev, null)).toBe(ev);
  });
});

describe('基本特性：能点链接', () => {
  it('WebLinksAddon 已加载并注册了 link provider（不装它终端里的 URL 根本不是链接）', async () => {
    await setup();
    expect(linkProviders.length).toBeGreaterThan(0);
  });

  it('终端里的 URL 被识别成链接', async () => {
    await setup();
    const link = await findFirstLink();
    expect(link?.text).toBe('https://example.com');
  });

  it('指针停在链接上时 mousedown 必须放行，否则 Linkifier 记不到 mouseDownLink', async () => {
    await setup();
    const ss = term._core._selectionService;
    const spy = vi.spyOn(ss, 'handleMouseDown');

    // 走 WebLinksAddon 的公开 hover 回调，与线上运行时是同一个函数
    const link = await findFirstLink();
    link.hover(new window.MouseEvent('mousemove'), link.text, link.range);

    fireMouse(screenEl(), 'mousedown', { x: 12 * CELL_WIDTH, y: 0 });

    // 放行 = 不发 SGR 切 pane，且事件能继续到 xterm（Linkifier 与选区服务都在其上）
    expect(sent).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    fireMouse(document, 'mouseup', { x: 12 * CELL_WIDTH, y: 0 });
  });

  it('离开链接后恢复常规判定（点击照旧切 pane）', async () => {
    await setup();
    const link = await findFirstLink();
    link.hover(new window.MouseEvent('mousemove'), link.text, link.range);
    link.leave(new window.MouseEvent('mousemove'), link.text);

    fireMouse(screenEl(), 'mousedown', { x: 12 * CELL_WIDTH, y: 0 });
    fireMouse(document, 'mouseup', { x: 12 * CELL_WIDTH, y: 0 });

    expect(sent).toHaveLength(1);
  });

  it('链接激活时调用 openLink 而不是把点击当成切 pane', async () => {
    await setup();
    const link = await findFirstLink();
    link.activate(new window.MouseEvent('click'), link.text);
    expect(opened).toEqual(['https://example.com']);
    expect(sent).toEqual([]);
  });
});

describe('基本特性：点击仍能切 pane（不能为了选中把它修没）', () => {
  it('裸左键点击（无位移）合成 SGR 左键发给 tmux', async () => {
    await setup();
    fireMouse(screenEl(), 'mousedown', { x: 3 * CELL_WIDTH, y: 2 * CELL_HEIGHT });
    fireMouse(document, 'mouseup', { x: 3 * CELL_WIDTH, y: 2 * CELL_HEIGHT });

    expect(sent).toHaveLength(1);
    // SGR 左键按下+释放，1-based 单元格坐标（ESC 是这段协议的一部分，故豁免 no-control-regex）
    // eslint-disable-next-line no-control-regex
    expect(sent[0]).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/);
    expect(copied).toEqual([]);
  });

  it('右键不参与这套判定', async () => {
    await setup();
    fireMouse(screenEl(), 'mousedown', { x: 0, y: 0, button: 2 });
    fireMouse(document, 'mouseup', { x: 0, y: 0, button: 2 });
    expect(sent).toEqual([]);
    expect(copied).toEqual([]);
  });
});

describe('基本特性：能打中文（焦点必须在 mousedown 当下就给）', () => {
  // 拦截分支里的 stopPropagation 会把 xterm 自己那条 `ev.preventDefault(); this.focus();`
  // 一起掐掉。mousedown 被 preventDefault 后浏览器不会再自行转移焦点，若拖到 mouseup 才 focus，
  // 中间这段没有文本插入点，系统输入法上下文建立不起来 ——
  // 现象就是「点完终端打拼音不跳输入法、也切不了中英文」。
  it('mousedown 当下 helper textarea 就已聚焦，不能等到 mouseup', async () => {
    await setup();
    const ta = container.querySelector('.xterm-helper-textarea');
    ta.blur();
    expect(document.activeElement).not.toBe(ta);

    fireMouse(screenEl(), 'mousedown', { x: 3 * CELL_WIDTH, y: 2 * CELL_HEIGHT });

    // 关键：此刻还没有 mouseup
    expect(document.activeElement).toBe(ta);

    fireMouse(document, 'mouseup', { x: 3 * CELL_WIDTH, y: 2 * CELL_HEIGHT });
  });

  it('修饰键选中这条放行路径同样能聚焦（走的是 xterm 原生 focus）', async () => {
    await setup();
    const ta = container.querySelector('.xterm-helper-textarea');
    ta.blur();

    fireMouse(screenEl(), 'mousedown', { x: 2 * CELL_WIDTH, y: CELL_HEIGHT, altKey: true, shiftKey: true });

    expect(document.activeElement).toBe(ta);
    fireMouse(document, 'mouseup', { x: 2 * CELL_WIDTH, y: CELL_HEIGHT, altKey: true, shiftKey: true });
  });
});

describe('dispose 后不再有残留监听', () => {
  it('卸载后拖选与点击都不再产生副作用', async () => {
    await setup();
    attached.dispose();
    attached = null;
    fireMouse(screenEl(), 'mousedown', { x: 0, y: 0 });
    fireMouse(document, 'mouseup', { x: 0, y: 0 });
    expect(sent).toEqual([]);
    expect(copied).toEqual([]);
  });
});

// ── 测试辅助 ──

/**
 * 通过公开 API registerLinkProvider 捕获 WebLinksAddon 注册的 provider，
 * 不去摸 Linkifier 的私有字段（那会随 xterm 版本漂移）。
 */
function findFirstLink() {
  const provider = linkProviders[linkProviders.length - 1];
  if (!provider) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // 第 1 行就是我们写进去的那行文本（provideLinks 的行号是 1-based）
    provider.provideLinks(1, (links) => resolve(links && links[0]));
  });
}
