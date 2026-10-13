// tests/dnd-activation.test.js
// 手机端「会话列表滑不动」的回归测试。
//
// 这里跑的是 dnd-kit 真实的 TouchSensor（不是自己写一遍它的判定逻辑）：node 没有 DOM，
// 所以只搭一个最小的 DOM 宿主（window / document / 元素 / TouchEvent），让真 sensor
// 在上面跑，然后断言它对我们那套 activationConstraint 的真实反应：
//   - 用 TOUCH_DRAG_ACTIVATION（延时激活）→ 手指划动时拖拽被取消、不 preventDefault
//     → 浏览器照常滚动（这正是修复的目标）；
//   - 用原来的 { distance: 5 }（PointerSensor 的配置）→ 划 8px 就激活拖拽并对后续
//     touchmove 调 preventDefault → 滚动被吃掉（这正是原来的 bug）。
const assert = require('node:assert');
const { test, before, beforeEach, after } = require('node:test');

const DND_CORE = '../packages/server/frontend/node_modules/@dnd-kit/core/dist/core.esm.js';

// ── 最小 DOM 宿主 ────────────────────────────────────────────────
// dnd-kit 的 getWindow/getOwnerDocument 对「没有 nodeType 的对象」一律回落到全局
// window/document，所以这里给全局塞两个替身即可；元素只需是 window.EventTarget 的实例
// （getEventListenerTarget 用 instanceof 判定要不要把监听挂在元素上）。
class FakeEventTarget {
  constructor() { this._handlers = new Map(); }
  addEventListener(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
  }
  removeEventListener(name, fn) { this._handlers.get(name)?.delete(fn); }
  dispatch(name, event) {
    for (const fn of [...(this._handlers.get(name) || [])]) fn(event);
  }
  listenerCount(name) { return this._handlers.get(name)?.size || 0; }
}

class FakeTouchEvent {
  constructor(x, y) {
    this.type = 'touchmove';
    this.cancelable = true;
    this.defaultPrevented = false;
    this.touches = [{ clientX: x, clientY: y }];
    this.changedTouches = this.touches;
    this.target = null;
  }
  preventDefault() { this.defaultPrevented = true; }
}

let core;
let element;

before(async () => {
  const fakeDocument = new FakeEventTarget();
  fakeDocument.getSelection = () => ({ removeAllRanges() {} });
  const fakeWindow = new FakeEventTarget();
  fakeWindow.EventTarget = FakeEventTarget;
  fakeWindow.TouchEvent = FakeTouchEvent;
  fakeWindow.document = fakeDocument;
  global.window = fakeWindow;
  global.document = fakeDocument;
  core = await import(DND_CORE);
});

after(() => { delete global.window; delete global.document; });

beforeEach(() => { element = new FakeEventTarget(); });

/** 造一个真 TouchSensor，返回 sensor + 事件记账。 */
function makeSensor(activationConstraint) {
  const calls = { start: 0, move: 0, cancel: 0, abort: 0, end: 0, pending: 0 };
  const startEvent = new FakeTouchEvent(100, 100);
  startEvent.type = 'touchstart';
  startEvent.target = element;
  const sensor = new core.TouchSensor({
    event: startEvent,
    active: 'session-1',
    activeNode: { id: 'session-1' },
    options: { activationConstraint },
    onStart: () => { calls.start++; },
    onMove: () => { calls.move++; },
    onEnd: () => { calls.end++; },
    onCancel: () => { calls.cancel++; },
    onAbort: () => { calls.abort++; },
    onPending: () => { calls.pending++; },
  });
  // 手指从 (100,100) 竖直划到 (100, 100 - dy)：模拟「向上滑列表」
  const swipe = (dy) => {
    const ev = new FakeTouchEvent(100, 100 - dy);
    ev.target = element;
    element.dispatch('touchmove', ev);
    return ev;
  };
  return { sensor, calls, swipe };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('触屏延时激活：长按未满就划动 → 拖拽取消、不吃掉滚动（手机能滑列表）', async () => {
  const { TOUCH_DRAG_ACTIVATION } = await import('../packages/server/frontend/src/dnd-activation.js');
  const { calls, swipe } = makeSensor(TOUCH_DRAG_ACTIVATION);

  const ev = swipe(8); // 8px > tolerance 5，且远未到 250ms

  assert.strictEqual(calls.start, 0, '不应激活拖拽');
  assert.strictEqual(calls.cancel, 1, '应取消这次拖拽尝试');
  assert.strictEqual(ev.defaultPrevented, false,
    '不能 preventDefault，否则浏览器的滚动手势被吃掉 —— 这就是手机滑不动的症状');
});

test('触屏延时激活：长按满 250ms 才开始拖，拖动期间才接管手势', async () => {
  const { TOUCH_DRAG_ACTIVATION } = await import('../packages/server/frontend/src/dnd-activation.js');
  const { calls, swipe } = makeSensor(TOUCH_DRAG_ACTIVATION);

  await sleep(TOUCH_DRAG_ACTIVATION.delay + 60);
  assert.strictEqual(calls.start, 1, '长按满时长应激活拖拽（拖动功能不能丢）');

  const ev = swipe(20);
  assert.strictEqual(calls.move, 1, '激活后手指移动应驱动拖拽');
  assert.strictEqual(ev.defaultPrevented, true, '拖拽中理应接管手势，阻止页面跟着滚');
});

test('回归见证：原来的 { distance: 5 } 配置会把滚动手势变成拖拽（手机滑不动）', async () => {
  const { calls, swipe } = makeSensor({ distance: 5 });

  swipe(8);
  assert.strictEqual(calls.start, 1, '距离型约束下，划 8px 立刻变成拖会话');

  const second = swipe(16);
  assert.strictEqual(second.defaultPrevented, true,
    '后续每次 touchmove 都被 preventDefault —— 列表因此完全滚不动');
});

test('鼠标仍是距离激活，桌面手感不变', async () => {
  const { MOUSE_DRAG_ACTIVATION } = await import('../packages/server/frontend/src/dnd-activation.js');
  assert.ok('distance' in MOUSE_DRAG_ACTIVATION, '鼠标必须是距离型激活');
  assert.ok(!('delay' in MOUSE_DRAG_ACTIVATION), '鼠标不该要求长按');
  assert.strictEqual(MOUSE_DRAG_ACTIVATION.distance, 5, '保持原有的 5px 阈值');
});

test('SessionTabs 必须用 Mouse+Touch 两个 sensor，不能退回 PointerSensor', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../packages/server/frontend/src/SessionTabs.jsx'), 'utf8');

  assert.ok(!/PointerSensor/.test(src),
    'PointerSensor 在触屏上必须靠 touch-action:none 才能拖，等于关掉列表滚动');
  assert.ok(/useSensor\(MouseSensor,\s*{\s*activationConstraint:\s*MOUSE_DRAG_ACTIVATION/.test(src),
    '鼠标 sensor 应使用 MOUSE_DRAG_ACTIVATION');
  assert.ok(/useSensor\(TouchSensor,\s*{\s*activationConstraint:\s*TOUCH_DRAG_ACTIVATION/.test(src),
    '触屏 sensor 应使用 TOUCH_DRAG_ACTIVATION');
});
