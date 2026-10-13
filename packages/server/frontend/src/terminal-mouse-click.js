// 桌面端鼠标「点击 vs 拖选」的纯函数部分（事件绑定在 TerminalPanel.jsx）。
//
// 背景：tmux(set -g mouse on) 开启鼠标上报后，xterm 把左键当应用事件上报 tmux ——
// 点击能切换 pane，但拖选会废（tmux 端不处理拖拽）。TerminalPanel 的做法是
// mousedown 先不决定，攒到「位移超过阈值」再判：动了 = 拖选（xterm 原生选区），
// 没动 = 点击（把左键合成 SGR 鼠标事件发进 PTY，tmux 据此切换 pane）。
// 这里只放可单测的纯计算。
export const CLICK_DRAG_THRESHOLD_PX = 5;

/** 位移是否达到「拖选」阈值。start/cur 为按下点与当前点的 clientX/Y。 */
export function shouldTreatAsDrag(startX, startY, curX, curY) {
  return Math.hypot(curX - startX, curY - startY) > CLICK_DRAG_THRESHOLD_PX;
}

/**
 * SGR 左键点击序列：按钮 0 = 左键按下/释放。col/row 为 1-based 单元格位置。
 * tmux 的 MouseDown1Pane 绑定点到即切 pane（08-23 实测有效）。
 */
export function buildClickSequence(col, row) {
  return `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`;
}

/**
 * 由浏览器 clientX/Y 换算成终端 1-based 单元格坐标（col/row 各自 clamp 到 [1, cols/rows]）。
 * rect 为终端容器 getBoundingClientRect()，cellW/cellH 为单元格像素（<=0 时用兜底值）。
 */
export function clientXYToCell(cx, cy, rect, cellW, cellH, cols, rows) {
  const w = cellW > 0 ? cellW : 8;
  const h = cellH > 0 ? cellH : 18;
  const col = Math.max(1, Math.min(cols, Math.floor((cx - rect.left - 4) / w) + 1));
  const row = Math.max(1, Math.min(rows, Math.floor((cy - rect.top - 4) / h) + 1));
  return { col, row };
}

/**
 * 点击 vs 拖选 的判定状态机（供桌面鼠标与手机 tap 共用，逻辑可单测）。
 * 调用序：down(x,y) → move(x,y)* → up(button)，任意时刻可 cancel()。
 *
 * 返回值：
 *  - down: 无
 *  - move: 'drag'（位移首次超过阈值，此时应把原始 mousedown 交给 xterm 原生选区）；
 *          'none'（还没到阈值，或已经在拖）
 *  - up:   'click'（纯点击，应合成 SGR 左键发给 tmux 切 pane）；
 *          'select'（拖选结束，取选区复制）；'cancel'（非左键松开）；'none'（没 down 过）
 */
export function createPointerTracker() {
  let _down = null;      // { x, y }
  let _dragging = false;
  return {
    down(x, y) {
      _down = { x, y };
      _dragging = false;
    },
    move(x, y) {
      if (!_down || _dragging) return 'none';
      if (shouldTreatAsDrag(_down.x, _down.y, x, y)) {
        _dragging = true;
        return 'drag';
      }
      return 'none';
    },
    up(button) {
      if (!_down) return 'none';
      const action = button === 0 ? (_dragging ? 'select' : 'click') : 'cancel';
      _down = null;
      _dragging = false;
      return action;
    },
    cancel() {
      _down = null;
      _dragging = false;
    },
  };
}
