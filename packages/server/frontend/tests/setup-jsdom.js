// jsdom 缺几样 xterm 挂载时必用的浏览器 API，这里补最小可用实现。
// 目的只是让 xterm 能在 jsdom 里真实挂载并接收真实 DOM 事件 ——
// 「能选中 / 能点链接」这类基本特性必须在真事件流上验，纯函数单测测不出接线错误。

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    });
  }

  // jsdom 在本项目的 vitest 配置下把 localStorage 给成了一个空对象
  // （启动时那句 `--localstorage-file was provided without a valid path` 的后果），
  // getItem / setItem 全是 undefined，一调就 TypeError。前端偏好（machine-prefs、
  // sound、已打开的会话列表）全靠它，这里按 Storage 规范补一个内存实现 ——
  // 补的是宿主环境的缺口，不是替换被测对象。
  if (typeof window.localStorage !== 'object' || typeof window.localStorage.getItem !== 'function') {
    const map = new Map();
    const storage = {
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => { map.set(String(k), String(v)); },
      removeItem: (k) => { map.delete(String(k)); },
      clear: () => map.clear(),
      key: (i) => Array.from(map.keys())[i] ?? null,
      get length() { return map.size; },
    };
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // xterm 用 canvas 量字符宽高（CharSizeService）。jsdom 不实现 getContext，
  // 这里给一个只够测量用的假 2d context：每个字符按固定 8px 宽算。
  const CHAR_W = 8;
  const CHAR_H = 17;
  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = function getContext(type) {
      if (type !== '2d') return null;
      return {
        canvas: this,
        font: '',
        textBaseline: '',
        fillStyle: '',
        measureText: (text) => ({
          width: (text ? text.length : 0) * CHAR_W,
          actualBoundingBoxAscent: CHAR_H * 0.8,
          actualBoundingBoxDescent: CHAR_H * 0.2,
        }),
        fillText() {},
        clearRect() {},
        fillRect() {},
        save() {},
        restore() {},
        scale() {},
        translate() {},
        setTransform() {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {},
      };
    };
  }
}

/**
 * jsdom 里所有元素的布局尺寸恒为 0，xterm 的坐标换算（选区、链接命中）会全部落在 (0,0)。
 * 这里给终端容器与其后代打上稳定的假布局：每格 8x17，容器 80x24 格。
 * 返回还原函数。
 */
export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 17;

export function stubTerminalLayout(term, { cols = 80, rows = 24 } = {}) {
  const core = term._core;
  // 直接把渲染服务的尺寸钉住 —— 这是 xterm 内部做坐标换算的唯一来源。
  const dims = core?._renderService?.dimensions;
  if (dims) {
    dims.css = dims.css || {};
    dims.css.cell = { width: CELL_WIDTH, height: CELL_HEIGHT };
    dims.css.canvas = { width: CELL_WIDTH * cols, height: CELL_HEIGHT * rows };
    dims.device = dims.device || {};
    dims.device.cell = { width: CELL_WIDTH, height: CELL_HEIGHT };
    dims.device.canvas = { width: CELL_WIDTH * cols, height: CELL_HEIGHT * rows };
  }
  const rect = {
    left: 0, top: 0, right: CELL_WIDTH * cols, bottom: CELL_HEIGHT * rows,
    width: CELL_WIDTH * cols, height: CELL_HEIGHT * rows, x: 0, y: 0,
    toJSON() { return this; },
  };
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { return rect; };
  return () => { Element.prototype.getBoundingClientRect = orig; };
}

/** 把数据写进终端并等它真正被解析（term.write 是异步的，不等会读到空屏）。 */
export function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * 让 xterm 进入「应用鼠标上报」状态，等价于 tmux `set -g mouse on`。
 * 这是本项目所有鼠标 bug 的前提条件：上报一开，左键就归应用（tmux）所有。
 */
export function enableMouseReporting(term) {
  // SGR + 任意事件上报，正是 tmux mouse on 时终端收到的序列
  return write(term, '\x1b[?1000h\x1b[?1006h');
}

/** 派发一个真实的 MouseEvent。 */
export function fireMouse(target, type, { x = 0, y = 0, button = 0, altKey = false, shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
  const ev = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button,
    buttons: button === 0 ? 1 : 0,
    altKey, shiftKey, ctrlKey, metaKey,
    detail: 1,
  });
  target.dispatchEvent(ev);
  return ev;
}

/** 派发一个真实的 KeyboardEvent（IME 相关用例要的是真事件流，不是手调回调）。 */
export function fireKey(target, type, { key = 'a', code, isComposing = false, ...rest } = {}) {
  const ev = new window.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
    code: code || `Key${key.toUpperCase()}`,
    isComposing,
    ...rest,
  });
  target.dispatchEvent(ev);
  return ev;
}
