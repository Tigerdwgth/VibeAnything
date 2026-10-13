// tests/daemon-pid.test.js
// daemon 的 pid 文件判活与日志转存。
//
// 为什么这层要有测试：2026-07-30 的事故是「pid 文件被一个**不是 daemon** 的进程占住」，
// launchd 每次拉起新实例都判「已在运行」直接退出，真正的 ws-client 从没启动过，
// 而 `--daemon status` 还显示运行中。判活只看 `kill(pid, 0)`
// 是不够的 —— PID 会被系统复用。
//
// 这里不起真 daemon：用「当前测试进程」当「活着但不是 daemon 的 PID」，
// 它的命令行是 `node --test ...`，正是那次事故里的形态。

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-daemon-pid-'));
let daemon;

before(() => {
  process.env.VIBEANYTHING_HOME = TMP;
  daemon = require('../lib/daemon');
});

after(() => {
  delete process.env.VIBEANYTHING_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'daemon.pid'), { force: true });
  fs.rmSync(path.join(TMP, 'daemon.log'), { force: true });
  fs.rmSync(path.join(TMP, 'daemon.log.1'), { force: true });
});

const writePidFile = (content) => fs.writeFileSync(daemon.getPidPath(), content, 'utf-8');

/** 一个肯定不存在的 PID（取一个极大值，系统不会分配到）。 */
const DEAD_PID = 4194304;

test('读 pid 文件：新格式是 JSON，老格式的裸数字也必须认（现网三台写的都是裸数字）', () => {
  writePidFile(JSON.stringify({ pid: 4242, cmd: 'vibeanything-daemon', startedAt: 1 }));
  assert.deepStrictEqual(daemon.readPidFile(), { pid: 4242, cmd: 'vibeanything-daemon', startedAt: 1 });

  writePidFile('4242\n');
  assert.deepStrictEqual(daemon.readPidFile(), { pid: 4242, cmd: null, startedAt: null });
});

test('pid 文件不存在 / 是空的 / 是垃圾 → 读成 null，不抛', () => {
  assert.strictEqual(daemon.readPidFile(), null);
  writePidFile('');
  assert.strictEqual(daemon.readPidFile(), null);
  writePidFile('这不是 pid');
  assert.strictEqual(daemon.readPidFile(), null);
});

test('进程已经没了 → 不算在跑，并把陈旧的 pid 文件清掉', () => {
  writePidFile(String(DEAD_PID));
  assert.strictEqual(daemon.isRunning(), false);
  assert.strictEqual(fs.existsSync(daemon.getPidPath()), false, '陈旧 pid 文件必须清掉，否则托管者永远不敢拉起');
});

test('PID 活着但不是 daemon（被复用 / 被别的进程占住）→ 不算在跑，pid 文件也清掉', () => {
  // 当前测试进程的命令行是 `node --test ...`，没有 cli.js / --daemon
  assert.strictEqual(daemon.processLooksLikeDaemon(process.pid), false);
  writePidFile(String(process.pid));
  assert.strictEqual(daemon.isRunning(), false, '这正是 2026-07-30 那次「假运行中」');
  assert.strictEqual(fs.existsSync(daemon.getPidPath()), false);
});

test('真 daemon 的命令行形态会被认出来', () => {
  // 起一个长命的 node，命令行里带 cli.js 和 --daemon（不真跑 daemon 逻辑）
  const { spawn } = require('node:child_process');
  const fakeCli = path.join(TMP, 'cli.js');
  fs.writeFileSync(fakeCli, 'setTimeout(() => {}, 60000);', 'utf-8');
  const child = spawn(process.execPath, [fakeCli, '--daemon', 'start', '--foreground'], { stdio: 'ignore' });
  try {
    // 等它真的被 exec 出来（ps 才看得到命令行）
    const deadline = Date.now() + 5000;
    let ok = false;
    while (Date.now() < deadline) {
      if (daemon.processLooksLikeDaemon(child.pid)) { ok = true; break; }
    }
    assert.strictEqual(ok, true, 'ps 里带 cli.js + --daemon 的进程应判为 daemon');

    writePidFile(JSON.stringify({ pid: child.pid, cmd: 'vibeanything-daemon', startedAt: Date.now() }));
    assert.strictEqual(daemon.isRunning(), true);
    assert.strictEqual(fs.existsSync(daemon.getPidPath()), true, '真在跑时不能删 pid 文件');
  } finally {
    child.kill('SIGKILL');
  }
});

test('被 launchd / systemd 拉起时留在前台 —— 哪怕 unit 里没写 --foreground', () => {
  // 老机器上装的还是不带 --foreground 的 unit。如果这时按「默认脱离」执行，
  // 主进程 fork 完就退，托管者会当它崩了、原地刷屏重启。
  assert.strictEqual(daemon.shouldRunForeground({ env: { XPC_SERVICE_NAME: 'com.vibeanything.daemon' }, ppid: 1 }), true);
  assert.strictEqual(daemon.shouldRunForeground({ env: { INVOCATION_ID: 'abc' }, ppid: 1 }), true);
  assert.strictEqual(daemon.shouldRunForeground({ env: { JOURNAL_STREAM: '8:123' }, ppid: 1 }), true);
  assert.strictEqual(daemon.shouldRunForeground({ env: {}, ppid: 1 }), true, 'PPID=1 说明已被 init 收养');
});

test('人在 shell 里敲 start 时脱离到后台（XPC_SERVICE_NAME 在 shell 里是 "0"）', () => {
  assert.strictEqual(daemon.shouldRunForeground({ env: { XPC_SERVICE_NAME: '0' }, ppid: 4321 }), false);
  assert.strictEqual(daemon.shouldRunForeground({ env: {}, ppid: 4321 }), false);
  // 显式参数始终优先
  assert.strictEqual(daemon.shouldRunForeground({ foreground: true, env: {}, ppid: 4321 }), true);
});

test('日志超限才转存，且只留一份备份', () => {
  const logPath = daemon.getLogPath();
  fs.writeFileSync(logPath, 'x'.repeat(100), 'utf-8');
  assert.strictEqual(daemon.rotateLogIfBig(1024), false, '没超限不该动');
  assert.strictEqual(fs.existsSync(`${logPath}.1`), false);

  assert.strictEqual(daemon.rotateLogIfBig(50), true);
  assert.strictEqual(fs.existsSync(logPath), false, '转存后当前日志文件让位给新进程');
  assert.strictEqual(fs.readFileSync(`${logPath}.1`, 'utf-8').length, 100);
});

test('没有日志文件时转存是无害的空操作（新机器第一次启动）', () => {
  assert.strictEqual(daemon.rotateLogIfBig(1), false);
});
