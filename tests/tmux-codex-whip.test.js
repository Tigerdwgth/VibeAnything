// tests/tmux-codex-whip.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createTmuxCodexWhip, hashText } = require('../lib/tmux-codex-whip');

// 注入式 tmux 执行器：按参数分别返回假输出，send-keys 记录到 calls。
function makeEnv({ panes, captureText }) {
  const sends = [];
  let captureCall = 0;
  const exec = (args) => {
    if (args[0] === 'list-panes') {
      return panes.map(p => `${p}\t${p.startsWith('codex') ? 'codex' : 'zsh'}`).join('\n');
    }
    if (args[0] === 'capture-pane') {
      return typeof captureText === 'function' ? captureText(captureCall++) : captureText;
    }
    if (args[0] === 'send-keys') {
      sends.push(args); // ['send-keys','-t',target,'continue','Enter']
      return '';
    }
    return '';
  };
  return { exec, sends };
}

function nowStub(start = 0) {
  const t = { value: start };
  return { now: () => t.value, t };
}

test('listCodexPanes 只返回当前命令为 codex 的 pane', () => {
  const { exec } = makeEnv({ panes: ['sess:0.0', 'codex:0.1', 'sess:1.0'] });
  const whip = createTmuxCodexWhip({ exec });
  assert.deepStrictEqual(whip.listCodexPanes().map(p => p.target), ['codex:0.1']);
});

test('捕获到 "model at capacity" → 对该 pane send-keys continue Enter', () => {
  const { exec, sends } = makeEnv({ panes: ['codex:0.1'], captureText: 'ERROR: model at capacity, try again\n' });
  const whip = createTmuxCodexWhip({ exec });
  whip.poll();
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(sends[0], ['send-keys', '-t', 'codex:0.1', 'continue', 'Enter']);
});

test('捕获到 429 "exceeded retry limit" → 触发', () => {
  const { exec, sends } = makeEnv({
    panes: ['codex:0.1'],
    captureText: 'exceeded retry limit, last status: 429 Too Many Requests, request id: abc\n',
  });
  const whip = createTmuxCodexWhip({ exec });
  whip.poll();
  assert.strictEqual(sends.length, 1);
});

test('屏幕没变时重复 poll 不重复抽（同一错误停在屏幕上）', () => {
  const { exec, sends } = makeEnv({
    panes: ['codex:0.1'],
    captureText: () => 'ERROR: model at capacity\nprompt> ',
  });
  const whip = createTmuxCodexWhip({ exec });
  whip.poll();
  whip.poll();
  whip.poll();
  assert.strictEqual(sends.length, 1, '同一屏错误只应触发一次');
});

test('错误消失又出现（屏幕指纹变化）→ 可以再次触发', () => {
  const texts = ['ERROR: model at capacity\n', 'prompt> normal output\n', 'ERROR: model at capacity again\n'];
  const { exec, sends } = makeEnv({ panes: ['codex:0.1'], captureText: () => texts.shift() || '' });
  const { now, t } = nowStub(0);
  const whip = createTmuxCodexWhip({ exec, now, cooldownMs: 30000 });
  whip.poll(); // t=0 命中
  t.value += 5000;
  whip.poll(); // 屏幕变化但无错误，且冷却期 → 不触发
  assert.strictEqual(sends.length, 1);
  t.value += 40000; // 已过冷却，错误再现 → 再次命中
  whip.poll();
  assert.strictEqual(sends.length, 2);
});

test('冷却期内即使屏幕变化也不重复触发；冷却过后恢复', () => {
  let n = 0;
  const { exec, sends } = makeEnv({
    panes: ['codex:0.1'],
    captureText: () => `ERROR: model at capacity [${n++}]\n`,
  });
  const { now, t } = nowStub(0);
  const whip = createTmuxCodexWhip({ exec, now, cooldownMs: 30000 });
  whip.poll(); // t=0 命中
  assert.strictEqual(sends.length, 1);
  t.value += 5000;
  whip.poll(); // t=5s 冷却期，屏幕已变 → 不触发
  assert.strictEqual(sends.length, 1);
  t.value += 40000; // t=45s 超过冷却，屏幕变 → 触发
  whip.poll();
  assert.strictEqual(sends.length, 2);
});

test('非 codex pane（zsh/bash）即使输出错误也不处理', () => {
  const { exec, sends } = makeEnv({
    panes: ['sess:0.0'],
    captureText: 'ERROR: model at capacity\n',
  });
  const whip = createTmuxCodexWhip({ exec });
  whip.poll();
  assert.strictEqual(sends.length, 0);
});

test('enabled=false 时 poll 不做任何事', () => {
  const { exec, sends } = makeEnv({ panes: ['codex:0.1'], captureText: 'ERROR: model at capacity\n' });
  const whip = createTmuxCodexWhip({ exec, enabled: false });
  whip.poll();
  assert.strictEqual(sends.length, 0);
});

test('codex pane 消失后状态被清理（不再为它保存）', () => {
  const panes = ['codex:0.1'];
  const { exec } = makeEnv({ panes, captureText: '' });
  const whip = createTmuxCodexWhip({ exec });
  whip.poll();
  assert.strictEqual(whip.listCodexPanes().length, 1);
  // 模拟该 pane 退出（原地改数组，闭包引用同一数组）
  panes.length = 0;
  panes.push('sess:0.0');
  whip.poll();
  assert.strictEqual(whip.listCodexPanes().length, 0);
});

test('hashText 忽略 ANSI 控制序列', () => {
  assert.strictEqual(hashText('\x1b[31mERROR\x1b[0m: model at capacity'), hashText('ERROR: model at capacity'));
});
