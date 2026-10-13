// 手机端终端触摸滚动：把「手指位移」换算成「SGR 滚轮事件」。
//
// 终端里跑的是 tmux attach，滚动历史的唯一通路是把滚轮事件发进 PTY 交给 tmux
// （见 TerminalPanel.jsx 的说明）。这里只做纯计算，方便单测。
//
// 滚动方向约定（自然滚动，内容跟手）：**手指下滑 = 看更早内容（滚轮上），
// 手指上滑 = 回到最新（滚轮下）**。也就是说要把「手指在屏幕上的位移」先转成
// 「滚轮语义的位移」——手指下滑产生的位移为正、对应滚轮上，再交给 tmux。
// 这个换算抽成 fingerDeltaToAccum，2026-08-24 之前方向反了（上滑=看历史），
// 与手机上浏览文档的习惯相反，专门加了单测锁住。
//
// 2026-08-23 修两个 bug：
//  ① 幅度错得离谱：原来固定「每 16px 手指位移 = 1 个滚轮事件」，而 tmux 的 copy-mode
//     绑定是 `send-keys -X -N 5 scroll-up`，**一个滚轮事件滚 5 行**（tmux 默认值，
//     本机 tmux list-keys 实测一致）。行高约 18px 时，16px 位移换来 ~90px 的内容位移，
//     放大 5~6 倍 —— 手指轻轻一划就跳到很上面。正确的换算是
//     「一个滚轮事件 = 5 行 × 行高」的手指位移，这样手指和内容大致 1:1。
//  ② 向下滚直接抛异常：steps 为负时原代码 `seq.repeat(steps)` 抛 RangeError
//     （'x'.repeat(-3) 是 RangeError），touchmove 处理器中断，一个字节都没发出去
//     —— 表现为「滚上去就回不到最底部」。方向要用符号判断，重复次数取绝对值。
const DEFAULT_CELL_HEIGHT = 18;

// tmux copy-mode 里一个滚轮事件滚多少行。
//
// **这个值必须和开发机 tmux 的实际绑定一致**，不一致的后果是手指和内容不同步
// （比如这里写 2、tmux 是 5，内容就走得比手指快 2.5 倍）。
//
// tmux 默认是 -N 5，5 行 × ~18px = 90px —— 意味着手指要划满 90px 内容才动一格，
// 一屏只有七八格，手感是「一跳一跳」的。2026-09-22 按用户要求统一改成 **2**：
// 格子细到 36px，跳得更密更连贯，同时保持「内容跟手」的 1:1 换算。
//
// 对应的 tmux 侧改动（copy-mode 与 copy-mode-vi 两张表都要，mode-keys vi 时用的是后者）：
//   bind-key -T copy-mode    WheelUpPane   select-pane \; send-keys -X -N 2 scroll-up
//   bind-key -T copy-mode    WheelDownPane select-pane \; send-keys -X -N 2 scroll-down
//   bind-key -T copy-mode-vi WheelUpPane   select-pane \; send-keys -X -N 2 scroll-up
//   bind-key -T copy-mode-vi WheelDownPane select-pane \; send-keys -X -N 2 scroll-down
// 已写进 macmini / gpuserver1-jdh / aliyun-derper 三台的 ~/.tmux.conf。
// **新增开发机记得一起配**，否则那台机器上的会话滚起来会快 2.5 倍。
export const TMUX_LINES_PER_WHEEL = 2;

// 单个 touchmove 最多合成几个滚轮事件，防止一帧刷屏。超出的位移**留在 accum 里**
// 下一帧接着用，不静默丢弃（丢了就会出现「划了很长却只滚一点」）。
export const MAX_WHEEL_STEPS_PER_MOVE = 8;

/**
 * 手势方向 → 滚动语义位移。自然滚动（内容跟手）：
 * 手指下滑（curY > startY）= 看更早内容 = 正向累积（滚轮上）。
 */
export function fingerDeltaToAccum(startY, curY) {
  return curY - startY;
}

/** 一个滚轮事件对应多少像素的手指位移。 */
export function pixelsPerWheelStep(cellHeight) {
  const h = cellHeight > 0 ? cellHeight : DEFAULT_CELL_HEIGHT;
  return TMUX_LINES_PER_WHEEL * h;
}

/**
 * 从累计位移里取出可以发出去的滚轮步数。
 * @param {number} accum 累计位移（>0 = 看更早内容，对应滚轮上）
 * @param {number} cellHeight 终端单元格行高（px）
 * @returns {{steps:number, accum:number}} steps 带符号（>0 滚轮上）；accum 是剩余未用位移
 */
export function takeWheelSteps(accum, cellHeight) {
  const px = pixelsPerWheelStep(cellHeight);
  const raw = Math.trunc(accum / px);
  if (raw === 0) return { steps: 0, accum };
  const steps = Math.max(-MAX_WHEEL_STEPS_PER_MOVE, Math.min(MAX_WHEEL_STEPS_PER_MOVE, raw));
  return { steps, accum: accum - steps * px };
}

/**
 * 合成 SGR 滚轮序列。SGR: 64 = 滚轮上，65 = 滚轮下；按下+释放各一条。
 * @param {number} steps 带符号步数，>0 滚轮上
 */
export function buildWheelSequence(steps, col, row) {
  const n = Math.abs(steps);
  if (n === 0) return '';
  const btn = steps > 0 ? 64 : 65;
  const one = `\x1b[<${btn};${col};${row}M\x1b[<${btn};${col};${row}m`;
  return one.repeat(n);
}
