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
