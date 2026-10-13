// tests/terminal-mouse-click.test.js
// 桌面端终端「点击 vs 拖选」的换算：位移阈值判定 + SGR 左键点击序列 + 坐标换算。
// 覆盖 2026-08-23 修复：tmux 分屏后鼠标点击切换 pane（原先把左键全当选中，tmux 收不到点击）。
const assert = require('node:assert');
const { test, before } = require('node:test');

let mod;

before(async () => {
  mod = await import('../packages/server/frontend/src/terminal-mouse-click.js');
});

test('位移在阈值内（含边界）算点击，超过阈值才算拖选', () => {
  const { shouldTreatAsDrag, CLICK_DRAG_THRESHOLD_PX } = mod;
  assert.strictEqual(shouldTreatAsDrag(0, 0, 0, 0), false, '没动 = 点击');
  assert.strictEqual(shouldTreatAsDrag(0, 0, 5, 0), false, '恰好 5px 边界仍算点击');
  assert.strictEqual(shouldTreatAsDrag(0, 0, 0, 5), false, '恰好 5px 边界仍算点击');
  assert.strictEqual(shouldTreatAsDrag(0, 0, 5, 5), true, '对角 5px+ 算拖选');
  assert.strictEqual(shouldTreatAsDrag(0, 0, 6, 0), true, '超过 5px 算拖选');
  assert.strictEqual(shouldTreatAsDrag(0, 0, -8, 3), true, '任意方向超过阈值都算拖选');
});

test('SGR 左键序列：按钮 0，按下+释放，位置 1-based', () => {
  const { buildClickSequence } = mod;
  assert.strictEqual(buildClickSequence(3, 7), '\x1b[<0;3;7M\x1b[<0;3;7m');
  assert.strictEqual(buildClickSequence(1, 1), '\x1b[<0;1;1M\x1b[<0;1;1m');
});

test('clientXYToCell：换算到 1-based 单元格并 clamp 边界', () => {
  const { clientXYToCell } = mod;
  const rect = { left: 10, top: 20 };
  // 80x24 终端，单元格 8x18，padding 4px
  assert.deepStrictEqual(clientXYToCell(10 + 4, 20 + 4, rect, 8, 18, 80, 24), { col: 1, row: 1 });
  assert.deepStrictEqual(clientXYToCell(10 + 4 + 8 * 4, 20 + 4 + 18 * 10, rect, 8, 18, 80, 24), { col: 5, row: 11 });
  // 越界 clamp：点右下角之外也不会超出终端尺寸
  assert.deepStrictEqual(clientXYToCell(99999, 99999, rect, 8, 18, 80, 24), { col: 80, row: 24 });
  assert.deepStrictEqual(clientXYToCell(-50, -50, rect, 8, 18, 80, 24), { col: 1, row: 1 });
  // cell 尺寸未知时用兜底（8x18），不至于除零
  assert.deepStrictEqual(clientXYToCell(10 + 4, 20 + 4, rect, 0, 0, 80, 24), { col: 1, row: 1 });
});

// ── createPointerTracker：点击 vs 拖选 状态机（2026-08-24 抽出来单测，防止又退化）──

test('tracker：不动/小抖动松开 = click（应合成 SGR 左键发 tmux 切 pane）', () => {
  const { createPointerTracker } = mod;
  const t = createPointerTracker();
  t.down(100, 50);
  t.move(101, 51);           // 1px 抖动，未到 5px 阈值
  assert.strictEqual(t.up(0), 'click');
});

test('tracker：位移超过阈值 = 先 drag 再 select', () => {
  const { createPointerTracker } = mod;
  const t = createPointerTracker();
  t.down(100, 50);
  assert.strictEqual(t.move(100, 60), 'drag', '位移超 5px 首帧返回 drag');
  assert.strictEqual(t.move(100, 90), 'none', '拖选中后续 move 不再重复返回 drag');
  assert.strictEqual(t.up(0), 'select');
});

test('tracker：没 down 过 up 返回 none；非左键松开返回 cancel', () => {
  const { createPointerTracker } = mod;
  const t = createPointerTracker();
  assert.strictEqual(t.up(0), 'none');
  t.down(0, 0);
  assert.strictEqual(t.up(2), 'cancel', '右键松开不应触发点击');
  assert.strictEqual(t.up(0), 'none', 'cancel 后已复位');
});

test('tracker：cancel 复位后不再消费后续事件', () => {
  const { createPointerTracker } = mod;
  const t = createPointerTracker();
  t.down(0, 0);
  t.cancel();
  assert.strictEqual(t.up(0), 'none');
});
