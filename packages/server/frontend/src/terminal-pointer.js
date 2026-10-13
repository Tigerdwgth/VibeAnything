// 终端鼠标与链接的事件接线（从 TerminalPanel.jsx 抽出，便于在真 DOM 上回归测试）。
//
// ── 背景：为什么这块特别容易坏 ──
// tmux `set -g mouse on` 会让终端进入「应用鼠标上报」模式，此后左键归应用（tmux）所有：
// xterm 把左键编码成 SGR 序列发给 tmux（于是能点击切 pane），并且**主动 disable 自己的
// 选区服务**（xterm 6.0.0 源码：areMouseEventsActive ? _selectionService.disable() : enable()）。
//
// 这看起来像「选中/点链接」和「点击切 pane」只能二选一，其实不是 ——
// iTerm2 / VS Code / Windows Terminal / xterm 的通行解法是**修饰键豁免**，xterm.js 原生就实现了：
//
//   shouldForceSelection(e) { return isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey }
//   mousedown: 上报激活时，若 shouldForceSelection 为真 → 不上报给应用，走本地选中
//
// 即「裸左键 = 切 pane，Option(mac)/Shift(其他) + 左键 = 选中」。左键不止一个，修饰键就是第二个。
//
// ── 08-25 回归的教训（这就是本模块存在的理由）──
// 上一版把判定写在 container 的 capture 阶段 mousedown 里，无差别 `stopPropagation()` 吞掉所有
// 左键，把 xterm 上面那条正确的路整个短路了，于是：
//   ① Option/Shift 拖选失效（xterm 的豁免路径根本收不到事件）
//   ② 链接点不动（Linkifier 靠 element 上的 mousedown 记 _mouseDownLink，mouseup 才 activate）
//   ③ 补交给 selectionService.handleMouseDown 的是**裸**左键事件，而上报模式下
//      handleMouseDown 内部 `if (!this._enabled && !shouldForceSelection(e)) return` —— 空操作，
//      一次都没生效过。纯函数单测全绿也照样漏，因为错的是接线不是算法。
//
// 所以本模块的三条铁律（对应 tests/terminal-pointer.test.js 的回归用例）：
//   1. 修饰键事件必须原样放行给 xterm；
//   2. 鼠标停在链接上时必须原样放行给 xterm；
//   3. 裸左键拖选补交给 handleMouseDown 的事件必须带上强制选中修饰键。

import { WebLinksAddon } from '@xterm/addon-web-links';
import { createPointerTracker, buildClickSequence, clientXYToCell } from './terminal-mouse-click';

/**
 * 探测本平台上「强制本地选中」用哪个修饰键 —— 直接问 xterm 自己，而不是重新判定平台。
 * xterm 的语义是 mac → Option(alt)，其他 → Shift；从它的实现探测可保证永远一致，
 * 即使 xterm 升级改了规则也自动跟随。
 * @returns {'alt'|'shift'|null}
 */
export function detectForceSelectionModifier(selectionService) {
  const fn = selectionService?.shouldForceSelection;
  if (typeof fn !== 'function') return null;
  const probe = (ev) => {
    try { return fn.call(selectionService, ev) === true; } catch { return false; }
  };
  if (probe({ altKey: true, shiftKey: false })) return 'alt';
  if (probe({ altKey: false, shiftKey: true })) return 'shift';
  return null;
}

/**
 * 包一层原事件，令 xterm 的 shouldForceSelection 判定为真。
 * 上报模式下 selectionService 已被 disable，只有「强制选中」的事件才会被 handleMouseDown 受理，
 * 所以裸左键拖选必须借这层壳才能真正选中（上一版直接补交裸事件 = 空操作）。
 */
export function withForcedSelection(ev, modifier) {
  if (!modifier) return ev;
  const overrides = modifier === 'alt' ? { altKey: true } : { shiftKey: true };
  return new Proxy(ev, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      // DOM 事件的方法必须绑回原事件，否则 preventDefault/stopPropagation 会因 this 不对而抛
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * 给终端接上鼠标（点击切 pane / 拖选复制）与可点链接。
 *
 * @param {import('@xterm/xterm').Terminal} term
 * @param {HTMLElement} container  term.open() 的宿主元素
 * @param {object} opts
 * @param {(text: string) => void} opts.sendInput   把数据送进 PTY
 * @param {(text: string) => void} opts.onCopy      复制入口（由调用方决定剪贴板策略）
 * @param {(uri: string, event: MouseEvent) => void} [opts.openLink]  链接激活，默认新标签打开
 * @returns {{ dispose: () => void }}
 */
export function attachTerminalPointer(term, container, { sendInput, onCopy, openLink } = {}) {
  const core = term._core;
  const selectionService = core?._selectionService;
  const forceModifier = detectForceSelectionModifier(selectionService);

  // tmux 是否开了鼠标上报（等价于「左键此刻归 tmux 所有」）
  const mouseActive = () => core?.coreMouseService?.activeProtocol !== 'NONE';

  // ── 链接 ──
  // 没有这个 addon，终端里的 URL 根本不会被识别成链接（本项目此前从未装过，
  // 所以「点不了链接」不是回归而是一直缺失）。hover/leave 是公开 API，
  // 用它维护「指针是否停在链接上」，避免去摸 Linkifier 私有字段。
  let overLink = false;
  const webLinks = new WebLinksAddon(
    (event, uri) => {
      if (openLink) openLink(uri, event);
      else window.open(uri, '_blank', 'noopener,noreferrer');
    },
    {
      hover: () => { overLink = true; },
      leave: () => { overLink = false; },
    },
  );
  term.loadAddon(webLinks);

  // ── 鼠标 ──
  const pointer = createPointerTracker();
  let downEvent = null;

  const cellOf = (clientX, clientY) => {
    const rect = container.getBoundingClientRect();
    const dim = core?._renderService?.dimensions?.css?.cell;
    return clientXYToCell(clientX, clientY, rect, dim?.width || 0, dim?.height || 0, term.cols, term.rows);
  };

  // capture 阶段拦截：只在「必须由我们接管」时才拦，其余一律放行给 xterm。
  // 放行的三种情况就是上面的铁律 1、2 与「根本没开鼠标上报」。
  const onMouseDownCapture = (ev) => {
    if (ev.button !== 0) return;
    // 没开上报：xterm 原生选中/链接一切正常，我们不插手
    if (!mouseActive()) return;
    // 修饰键强制选中（mac: Option，其他: Shift）—— 与 iTerm2 一致，交回 xterm 原生路径
    if (selectionService?.shouldForceSelection?.(ev)) return;
    // 指针停在链接上：放行，让 Linkifier 记下 _mouseDownLink，mouseup 才能 activate
    if (overLink) return;

    ev.preventDefault();
    ev.stopPropagation();   // 阻止 xterm 在 mousedown 就替我们决定（上报 tmux or 选中）
    // stopPropagation 顺带把 xterm 自己那条 `ev.preventDefault(); this.focus();`
    // （CoreBrowserTerminal.ts 的 el mousedown）也掐了，所以必须在这里原地补上 focus。
    // 时机很要紧：mousedown 被 preventDefault 后浏览器不会再自行转移焦点，
    // 若拖到 mouseup 才 focus，中间这段没有文本插入点，输入法上下文建立不起来 ——
    // 表现就是「点完终端打拼音不跳输入法、切不了中英文」。
    term.focus();
    pointer.down(ev.clientX, ev.clientY);
    downEvent = ev;
  };

  const onMouseMoveDoc = (ev) => {
    if (pointer.move(ev.clientX, ev.clientY) !== 'drag') return;
    // 位移过阈值 = 拖选。补交原始 mousedown 给 xterm 的选区服务，
    // **必须带上强制选中修饰键**：上报模式下选区服务已被 disable，裸事件会被直接丢弃。
    selectionService?.handleMouseDown?.(withForcedSelection(downEvent, forceModifier));
  };

  const onMouseUpDoc = (ev) => {
    const action = pointer.up(ev.button);
    downEvent = null;
    if (action === 'click') {
      // 纯点击：合成 SGR 左键发给 tmux → 切换 pane，随后聚焦终端以便继续输入
      const { col, row } = cellOf(ev.clientX, ev.clientY);
      sendInput?.(buildClickSequence(col, row));
      term.focus();   // 焦点在 mousedown 就给过了，这里只是兜底（放行分支下 xterm 未必 focus）
    } else if (action === 'select') {
      // 拖选松手：copy-on-select（保留高亮）
      const sel = term.getSelection();
      if (sel) onCopy?.(sel);
    }
  };

  // 兜「没开鼠标上报」的普通拖选：那条路径 mousedown 没被我们截，
  // 由 xterm 原生选中，这里只负责松手即复制。挂 document 上是因为拖到终端外松手时容器收不到 mouseup。
  let selDragFromTerm = false;
  const onSelectMouseDown = (ev) => {
    selDragFromTerm = ev.button === 0 && !!container?.contains(ev.target);
  };
  const onSelectMouseUp = (ev) => {
    if (ev.button !== 0 || !selDragFromTerm) return;
    selDragFromTerm = false;
    const sel = term.getSelection();
    if (sel) onCopy?.(sel);
  };

  container.addEventListener('mousedown', onMouseDownCapture, true);
  document.addEventListener('mousedown', onSelectMouseDown);
  document.addEventListener('mousemove', onMouseMoveDoc);
  document.addEventListener('mouseup', onMouseUpDoc);
  document.addEventListener('mouseup', onSelectMouseUp);

  return {
    dispose() {
      container.removeEventListener('mousedown', onMouseDownCapture, true);
      document.removeEventListener('mousedown', onSelectMouseDown);
      document.removeEventListener('mousemove', onMouseMoveDoc);
      document.removeEventListener('mouseup', onMouseUpDoc);
      document.removeEventListener('mouseup', onSelectMouseUp);
      try { webLinks.dispose(); } catch { /* 终端已销毁则无需再卸载 */ }
    },
  };
}
