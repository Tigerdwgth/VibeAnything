// tests/terminal-touch-scroll.test.js
// 手机端终端触摸滚动的换算：手指位移 → SGR 滚轮事件。
// 覆盖 2026-08-23 修的两个 bug：① 滚动幅度放大 5~6 倍（一划就跳到很上面）；
// ② 向下滚时 repeat(负数) 抛 RangeError（滚上去回不到最底部）。
// 2026-08-24 再修方向：自然滚动（内容跟手）—— 手指下滑 = 看更早内容（滚轮上），
// 手指上滑 = 回到最新（滚轮下）。方向换算在 fingerDeltaToAccum，加了锁方向链的测试。
const assert = require('node:assert');
const { test, before } = require('node:test');

const CELL_H = 18;          // 14px 字号下 xterm 的典型行高
let mod;

before(async () => {
  mod = await import('../packages/server/frontend/src/terminal-touch-scroll.js');
});

// 一个滚轮步对应的手指/内容像素。全部断言都从常量推导，改 N 时不用回来改数字。
const step = () => mod.TMUX_LINES_PER_WHEEL * CELL_H;

test('每个滚轮事件滚几行必须和开发机 tmux 的绑定一致', () => {
  // 这是跨系统耦合：前端按这个值把手指位移换算成滚轮事件，tmux 按自己的绑定
  // 决定一个事件滚几行。两边不一致，内容就不跟手（写 2 而 tmux 是 5 → 快 2.5 倍）。
  // 三台开发机的 ~/.tmux.conf 已统一绑成 -N 2，新增机器必须一起配。
  assert.strictEqual(mod.TMUX_LINES_PER_WHEEL, 2);
});

test('手指与内容 1:1：滑一屏的距离就滚一屏，不放大', () => {
  const { takeWheelSteps, TMUX_LINES_PER_WHEEL } = mod;
  // 一个滚轮事件滚 N 行 → N*18px 内容位移，手指也该走同样多
  const { steps, accum } = takeWheelSteps(step(), CELL_H);
  assert.strictEqual(steps, 1);
  assert.strictEqual(accum, 0);

  // 换算回内容位移，应与手指位移相当（1:1，允许不足一步的余量）
  const fingerPx = step() * 3;
  const r = takeWheelSteps(fingerPx, CELL_H);
  const contentPx = r.steps * TMUX_LINES_PER_WHEEL * CELL_H;
  assert.strictEqual(contentPx, fingerPx, '滑多远就滚多远');
});

test('回归见证：旧的「每 16px 一个滚轮事件」把幅度放大了', () => {
  const { TMUX_LINES_PER_WHEEL, pixelsPerWheelStep } = mod;
  const OLD_PX_PER_STEP = 16;                                       // 旧实现写死的
  const fingerPx = step() * 6;
  const oldContentPx = Math.trunc(fingerPx / OLD_PX_PER_STEP) * TMUX_LINES_PER_WHEEL * CELL_H;
  // 放大倍数就是「正确步长 / 旧的 16px」，与 N 取值无关
  assert.strictEqual(pixelsPerWheelStep(CELL_H) / OLD_PX_PER_STEP > 1, true);
  assert.ok(oldContentPx > fingerPx,
    '旧实现手指划一点点就滚掉一大片 —— 这就是「一下跳到非常上边」');
});

test('滚轮下（向最新）：步数为负不再抛异常，方向用 SGR 65', () => {
  const { takeWheelSteps, buildWheelSequence } = mod;
  const { steps } = takeWheelSteps(-step() * 2, CELL_H);
  assert.strictEqual(steps, -2, '向最新方向应得到负步数');

  const seq = buildWheelSequence(steps, 3, 4);   // 旧代码在这里 RangeError
  assert.strictEqual(seq, '\x1b[<65;3;4M\x1b[<65;3;4m'.repeat(2));
});

test('向上滚用 SGR 64，按下+释放成对发出', () => {
  const { buildWheelSequence } = mod;
  assert.strictEqual(buildWheelSequence(1, 10, 20), '\x1b[<64;10;20M\x1b[<64;10;20m');
  assert.strictEqual(buildWheelSequence(0, 10, 20), '');
});

test('不足一步的位移留在累计里，不丢也不提前触发', () => {
  const { takeWheelSteps } = mod;
  const small = step() - 1;
  const r = takeWheelSteps(small, CELL_H);
  assert.strictEqual(r.steps, 0);
  assert.strictEqual(r.accum, small, '没发出去的位移必须原样留着，下一帧接着攒');
});

test('取走整步后余数进位到下一次', () => {
  const { takeWheelSteps } = mod;
  const r = takeWheelSteps(step() + 10, CELL_H);
  assert.strictEqual(r.steps, 1);
  assert.strictEqual(r.accum, 10);
});

test('单帧步数封顶，但超出部分留在累计里而不是静默丢弃', () => {
  const { takeWheelSteps, MAX_WHEEL_STEPS_PER_MOVE } = mod;
  const huge = step() * 20;                   // 相当于 20 步
  const r = takeWheelSteps(huge, CELL_H);
  assert.strictEqual(r.steps, MAX_WHEEL_STEPS_PER_MOVE);
  assert.strictEqual(r.accum, huge - MAX_WHEEL_STEPS_PER_MOVE * step(),
    '剩下的 12 步位移要留着，否则「划很长只滚一点」');

  const down = takeWheelSteps(-huge, CELL_H);
  assert.strictEqual(down.steps, -MAX_WHEEL_STEPS_PER_MOVE, '向下也要封顶');
});

test('拿不到行高时回落到默认 18px，不会除以 0', () => {
  const { pixelsPerWheelStep } = mod;
  const { TMUX_LINES_PER_WHEEL } = mod;
  assert.strictEqual(pixelsPerWheelStep(0), TMUX_LINES_PER_WHEEL * 18);
  assert.strictEqual(pixelsPerWheelStep(undefined), TMUX_LINES_PER_WHEEL * 18);
  assert.strictEqual(pixelsPerWheelStep(24), TMUX_LINES_PER_WHEEL * 24);
});

// ── 方向（2026-08-24）：自然滚动，内容跟手 ──
// 手指下滑 = 看更早内容（滚轮上）；手指上滑 = 回到最新（滚轮下）。

test('fingerDeltaToAccum：手指下滑 = 正向位移（看更早）', () => {
  const { fingerDeltaToAccum } = mod;
  assert.strictEqual(fingerDeltaToAccum(100, 180), 80, '下滑（y 增大）应为正');
  assert.strictEqual(fingerDeltaToAccum(180, 100), -80, '上滑（y 减小）应为负');
  assert.strictEqual(fingerDeltaToAccum(50, 50), 0);
});

test('方向链：手指下滑 → 滚轮上(64) 看更早；手指上滑 → 滚轮下(65) 回最新', () => {
  const { fingerDeltaToAccum, takeWheelSteps, buildWheelSequence } = mod;
  // 下滑一个滚轮步的距离
  const down = takeWheelSteps(fingerDeltaToAccum(0, step()), CELL_H);
  assert.strictEqual(down.steps, 1, '下滑应是滚轮上方向（正步数）');
  assert.ok(buildWheelSequence(down.steps, 5, 5).includes('\x1b[<64;5;5M'), '下滑 = SGR 64 滚轮上');

  // 上滑同样距离
  const up = takeWheelSteps(fingerDeltaToAccum(step(), 0), CELL_H);
  assert.strictEqual(up.steps, -1, '上滑应是滚轮下方向（负步数）');
  assert.ok(buildWheelSequence(up.steps, 5, 5).includes('\x1b[<65;5;5M'), '上滑 = SGR 65 滚轮下');
});

test('回归见证：旧方向（上滑=看更早）被锁死，不再出现', () => {
  // 旧实现是 dy = startY - curY，下滑得到负位移。现在下滑必须是正位移，
  // 若有人把 fingerDeltaToAccum 改回 startY - curY，这里就会失败。
  const { fingerDeltaToAccum } = mod;
  assert.ok(fingerDeltaToAccum(0, 90) > 0, '下滑必须为正，否则方向又反了');
});

test('TerminalPanel 必须走统一换算，不能再手搓 repeat/固定 16px', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../packages/server/frontend/src/TerminalPanel.jsx'), 'utf8');

  assert.ok(/takeWheelSteps\(/.test(src) && /buildWheelSequence\(/.test(src),
    '触摸滚动应复用 terminal-touch-scroll.js');
  assert.ok(/fingerDeltaToAccum\(/.test(src),
    '手势方向必须走 fingerDeltaToAccum，不能再手写 _touchY - clientY（会反转方向）');
  assert.ok(!/one\.repeat\(steps\)/.test(src),
    'repeat(负步数) 会抛 RangeError，向下滚会整段失效');
  assert.ok(!/_scrollAccum\s*\/\s*16/.test(src),
    '固定 16px 一步与 tmux 的 5 行/滚轮不匹配，会放大 5 倍');
});
