// tests/tmux-pane-click.test.js
// 端到端行为测试：把 terminal-mouse-click 生成的 SGR 左键点击序列发进**真实 tmux**
//（通过 node-pty attach，与应用同一套路径），断言 active pane 真的被切换。
//
// 为什么要有这个测试：分屏后「鼠标/tap 点击切换 pane」退回过多次（08-17 全走选中导致
// tmux 收不到点击；08-23 修好后又有人说用不了）。纯函数单测只能保证「序列拼对了」，
// 保证不了「tmux 真的切了」——这个测试用真实 tmux 把最后一段也锁死。
//
// 依赖：本机有 tmux 与 node-pty。没有时自动 skip（CI 等环境不因缺环境而红）。
const assert = require('node:assert');
const { test, before } = require('node:test');
const { execSync } = require('node:child_process');

let pty;
let mod;

const tmuxAvailable = () => {
  try { execSync('tmux -V', { stdio: 'ignore' }); return true; } catch { return false; }
};
const ptyAvailable = () => {
  try { require.resolve('node-pty'); return true; } catch { return false; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mod = await import('../packages/server/frontend/src/terminal-mouse-click.js');
  pty = require('node-pty');
});

test('tmux 左右分屏：SGR 左键点击右 pane 切过去、点左 pane 切回来', { skip: !tmuxAvailable() || !ptyAvailable() }, async () => {
  const session = 'paneclick_' + Date.now();
  const activeIndex = () =>
    execSync(`tmux display-message -p -t ${session} '#{pane_index}'`).toString().trim();

  try {
    // 80x24 窗口，左右分屏：pane 0 在左（~40 列），pane 1 在右
    execSync(`tmux new-session -d -s ${session} -x 80 -y 24 'bash -l -c "sleep 300"'`);
    execSync(`tmux split-window -h -t ${session} 'bash -l -c "sleep 300"'`);
    execSync(`tmux set-option -g mouse on`);

    const p = pty.spawn('tmux', ['attach-session', '-t', session], { cols: 80, rows: 24 });
    await sleep(800);   // 等 attach + mouse 上报建立

    // 强制焦点到左 pane，再点右 pane 中部（col 70, row 12）
    execSync(`tmux select-pane -t ${session}.0`);
    await sleep(100);
    assert.strictEqual(activeIndex(), '0', '前置：焦点在左 pane');

    const { buildClickSequence } = mod;
    p.write(buildClickSequence(70, 12));
    await sleep(400);
    assert.strictEqual(activeIndex(), '1', '点击右 pane 中部应切换到右 pane');

    // 点回左 pane 中部
    p.write(buildClickSequence(10, 12));
    await sleep(400);
    assert.strictEqual(activeIndex(), '0', '点击左 pane 中部应切回左 pane');

    p.kill();
  } finally {
    try { execSync(`tmux kill-session -t ${session} 2>/dev/null`); } catch {}
  }
});
