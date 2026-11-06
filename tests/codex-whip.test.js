// tests/codex-whip.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { createCodexWhip } = require('../lib/codex-whip');

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

function makeWhip(overrides = {}) {
  const writes = [];
  const t = { value: 1000 };
  const whip = createCodexWhip({ write: (d) => writes.push(d), now: () => t.value, ...overrides });
  return { whip, writes, t };
}

test('命中 "model at capacity" → write 收到 continue\\r', () => {
  const { whip, writes } = makeWhip();
  whip.onData('ERROR: model at capacity, please try again later');
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('"model at capacity" 大小写变体也能命中', () => {
  const { whip, writes } = makeWhip();
  whip.onData('The Model At Capacity right now');
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('命中 "exceeded retry limit, last status: 429 ... request id: xxx" → write 收到 continue\\r', () => {
  const { whip, writes } = makeWhip();
  whip.onData('Error: exceeded retry limit, last status: 429 Too Many Requests, request id: req_abc123xyz');
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('429 错误 request id 每次不同仍命中（正则泛化、不区分大小写）', () => {
  const { whip, writes } = makeWhip();
  whip.onData('exceeded retry limit, last status: 429 TOO MANY REQUESTS, request id: another-999');
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('冷却期内再次命中同模式 → 不再触发；冷却过后恢复', () => {
  const { whip, writes, t } = makeWhip({ cooldownMs: 30000 });
  whip.onData('model at capacity');
  assert.strictEqual(writes.length, 1, '首次命中应触发');

  t.value += 10000; // 冷却期内（距上次 10s）
  whip.onData('model at capacity');
  assert.strictEqual(writes.length, 1, '冷却期内不能重复触发');

  t.value += 30000; // 距上次 40s，超过 30s 冷却
  whip.onData('model at capacity');
  assert.strictEqual(writes.length, 2, '冷却过后应恢复触发');
});

test('无关输出（普通日志 / 其它错误）→ 不触发', () => {
  const { whip, writes } = makeWhip();
  whip.onData('hello world\n');
  whip.onData('Error: some other random failure');
  whip.onData('HTTP 500 Internal Server Error');
  whip.onData('RateLimitError: 429 on GET /api/responses');
  assert.deepStrictEqual(writes, []);
});

test('跨 chunk：错误文本拆两段分次喂 → 仍命中（尾部缓冲）', () => {
  const { whip, writes } = makeWhip();
  const text = 'Error: exceeded retry limit, last status: 429 Too Many Requests, request id: chunked-42';
  const mid = Math.floor(text.length / 2);
  whip.onData(text.slice(0, mid));
  assert.strictEqual(writes.length, 0, '前半段不应触发');
  whip.onData(text.slice(mid));
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('跨多个 chunk 且中间夹其它输出 → 尾部缓冲仍命中', () => {
  const { whip, writes } = makeWhip();
  whip.onData('some noise ');
  whip.onData('Error: exceeded retry ');
  whip.onData('limit, last status: 429 Too Many ');
  whip.onData('Requests, request id: noisy-7');
  assert.deepStrictEqual(writes, ['continue\r']);
});

test('enabled=false 时不触发', () => {
  const { whip, writes } = makeWhip({ enabled: false });
  whip.onData('model at capacity');
  whip.onData('exceeded retry limit, last status: 429 Too Many Requests, request id: x');
  assert.deepStrictEqual(writes, []);
});

test('命中后清空缓冲：冷却过后一点无关输出不能让旧错误再命中', () => {
  const { whip, writes, t } = makeWhip({ cooldownMs: 30000 });
  whip.onData('model at capacity');
  assert.strictEqual(writes.length, 1);
  t.value += 60000;
  whip.onData('x');
  assert.strictEqual(writes.length, 1, '旧错误文本还留在缓冲里，又敲了一次 continue');
});

test('write 返回 false（核对后不是新错误）不占冷却，紧接着的真错误照常触发', () => {
  const calls = [];
  let answer = false;
  const whip = createCodexWhip({ write: (d) => { calls.push(d); return answer; }, cooldownMs: 30000, now: () => 1000 });
  whip.onData('model at capacity');      // 例如重新 attach 的整屏重绘
  answer = true;
  whip.onData('model at capacity');      // 同一时刻真打印出来的新错误
  assert.strictEqual(calls.length, 2, '第一次没发，不该进冷却');
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(80);
  }
  return false;
}

const paneText = (name) =>
  spawnSync('tmux', ['capture-pane', '-t', name, '-p'], { encoding: 'utf8' }).stdout || '';

// 集成：codex 会话经 PTY 输出限流错误 → 自动写 continue\r（tmux 把输入转给 shell 执行）
test('pty-manager 集成：codex 会话命中错误后 PTY 收到 continue', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const { PtyManager } = require('../lib/pty-manager');
  const id = `whip-${process.pid}`;
  const name = `cc-${id}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  const mgr = new PtyManager({ codexWhip: { enabled: true, cooldownMs: 30000 } });
  try {
    mgr.create(id, { cols: 100, rows: 30, command: ['codex', '--help'], onData: () => {} });
    // 等 codex 命令退出落到登录 shell 后，模拟输出一段限流错误
    await sleep(600);
    spawnSync('tmux', ['send-keys', '-t', name, "echo 'exceeded retry limit, last status: 429 Too Many Requests, request id: integ-1'", 'Enter']);
    // shell 收到 whip 写的 continue\r 会执行 continue 并报错（输出里出现 continue）
    const hit = await waitFor(() => paneText(name).includes('continue'));
    assert.ok(hit, `5s 内 PTY 未出现 continue，capture-pane:\n${paneText(name)}`);
  } finally {
    mgr.destroyAll();
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

// 集成：非 codex 会话输出同样的错误 → 不写 continue（只对 codex 生效）
test('pty-manager 集成：非 codex 会话不触发自动 continue', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const { PtyManager } = require('../lib/pty-manager');
  const id = `whipneg-${process.pid}`;
  const name = `cc-${id}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  const mgr = new PtyManager({ codexWhip: { enabled: true, cooldownMs: 30000 } });
  try {
    mgr.create(id, { cols: 100, rows: 30, command: ['bash'], onData: () => {} });
    await sleep(600);
    spawnSync('tmux', ['send-keys', '-t', name, "echo 'model at capacity'", 'Enter']);
    // 等 echo 输出渲染完，再确认没有 continue 被执行（shell 不会凭空打出 continue 报错）
    await sleep(800);
    const out = paneText(name);
    assert.ok(out.includes('model at capacity'), '错误文本应已出现在终端');
    assert.ok(!out.includes('continue:'), `非 codex 会话不应执行 continue，capture-pane:\n${out}`);
  } finally {
    mgr.destroyAll();
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

// 集成：错误留在屏幕上时，之后每次有观众打开（换 attach 客户端 → 整屏重绘）都不能再敲 continue；
// 分屏后焦点在别的 pane 时，continue 必须进出错的那个 pane。
// 不跑真 codex：预先建好会话跑一个假 agent（读一行就回显，读到 emit 就打印限流错误），
// 再以 codex 命令打开它，PtyManager 就会挂上抽鞭子。
test('pty-manager 集成：重绘不重复触发，continue 发到出错的 pane 而不是活动 pane', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { PtyManager } = require('../lib/pty-manager');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-whip-'));
  const agent = path.join(dir, 'agent.sh');
  fs.writeFileSync(agent, [
    '#!/bin/sh',
    'while IFS= read -r line; do',
    '  if [ "$line" = emit ]; then echo "stream error: exceeded retry limit, last status: 429 Too Many Requests"',
    '  else echo "got:[$line]"; fi',
    'done',
  ].join('\n'), { mode: 0o755 });
  const id = `whipredraw-${process.pid}`;
  const name = `cc-${id}`;
  const exact = (...a) => spawnSync('tmux', a, { encoding: 'utf8' });
  exact('kill-session', '-t', `=${name}`);
  exact('new-session', '-d', '-s', name, '-x', '120', '-y', '30', `sh ${agent}`);
  const agentPane = exact('display', '-p', '-t', `=${name}:`, '#{pane_id}').stdout.trim();
  const capture = (pane) => exact('capture-pane', '-p', '-t', pane).stdout;
  const continues = (pane) => (capture(pane).match(/got:\[continue\]/g) || []).length;
  // 冷却设 0：只靠「是不是新错误」挡重绘，冷却帮不上忙
  const mgr = new PtyManager({ codexWhip: { enabled: true, cooldownMs: 0 } });
  const open = () => mgr.create(id, { cols: 120, rows: 30, command: ['codex'], onData: () => {} });
  try {
    open();
    await sleep(300);
    exact('send-keys', '-t', agentPane, 'emit', 'Enter');
    assert.ok(await waitFor(() => continues(agentPane) === 1), `首次错误应触发一次 continue:\n${capture(agentPane)}`);

    // 错误文本还在屏幕上，再换两次 attach 客户端
    open();
    await sleep(500);
    open();
    await sleep(500);
    assert.strictEqual(continues(agentPane), 1, `重新 attach 的重绘又敲了 continue:\n${capture(agentPane)}`);

    // 分屏：新 pane 跑同一个回显脚本并成为活动 pane
    exact('split-window', '-t', `=${name}:`, `sh ${agent}`);
    const otherPane = exact('display', '-p', '-t', `=${name}:`, '#{pane_id}').stdout.trim();
    assert.notStrictEqual(otherPane, agentPane);
    await sleep(300);
    exact('send-keys', '-t', agentPane, 'emit', 'Enter');
    assert.ok(await waitFor(() => continues(agentPane) === 2), `第二次错误应在出错的 pane 触发:\n${capture(agentPane)}`);
    await sleep(300);
    assert.strictEqual(continues(otherPane), 0, `continue 敲进了活动 pane:\n${capture(otherPane)}`);
  } finally {
    mgr.destroyAll();
    exact('kill-session', '-t', `=${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
