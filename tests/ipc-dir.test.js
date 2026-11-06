// tests/ipc-dir.test.js
// IPC 目录默认按用户隔离：hook 写 evt 的目录与 daemon 读的目录必须是同一个算法算出来的同一个目录。
// 真跑 hooks/status.js（私有 tmux socket 里），真读写文件，不替身。
// 本文件改了 TMPDIR / HOME / VIBEANYTHING_HOME，所以单独成文件（node --test 每个文件一个进程）。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'va-ipcdir-'));
const VIBE_HOME = path.join(ROOT, 'vibe');
let ipc;
let daemon;
let WsClient;

before(() => {
  // 旧默认目录跟着 os.tmpdir() 走，指到临时目录里，碰不到本机真实的 /tmp 目录
  process.env.TMPDIR = path.join(ROOT, 'tmp');
  fs.mkdirSync(process.env.TMPDIR);
  process.env.VIBEANYTHING_HOME = VIBE_HOME;
  // ws-client 载入时按 HOME 定 ~/.claude/projects，指到空目录，不去扫真实会话
  process.env.HOME = path.join(ROOT, 'home');
  fs.mkdirSync(process.env.HOME);
  delete process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  ipc = require('../lib/ipc');
  daemon = require('../lib/daemon');
  ({ WsClient } = require('../lib/ws-client'));
});

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  delete process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  fs.rmSync(VIBE_HOME, { recursive: true, force: true });
});

test('默认目录在本用户的配置根目录下，新建时权限 0700', () => {
  assert.strictEqual(ipc.getIpcDir(), path.join(VIBE_HOME, 'ipc'));
  const dir = ipc.ensureIpcDir();
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(!dir.startsWith(path.join(process.env.TMPDIR, 'claude-hooks-feishu')), '不能再落到共用的临时目录');
});

test('显式配置行为不变：环境变量优先，其次 config.json 的 ipcDir', () => {
  fs.mkdirSync(VIBE_HOME, { recursive: true });
  const fromConfig = path.join(ROOT, 'cfg-ipc');
  fs.writeFileSync(path.join(VIBE_HOME, 'config.json'), JSON.stringify({ ipcDir: fromConfig }));
  assert.strictEqual(ipc.getIpcDir(), fromConfig);
  process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = path.join(ROOT, 'env-ipc');
  assert.strictEqual(ipc.getIpcDir(), path.join(ROOT, 'env-ipc'));
});

test('hook（status.js 子进程）写 evt 的目录就是 daemon 读的目录，daemon 收到后点亮该会话', async () => {
  const SOCKET = `vaipc${process.pid}`;
  const tmux = (...args) => spawnSync('tmux', ['-f', '/dev/null', '-L', SOCKET, ...args], { encoding: 'utf8' }).stdout.trim();
  tmux('new-session', '-d', '-s', 'probe', 'sleep 60');
  try {
    const env = { ...process.env,
      TMUX: `${tmux('display-message', '-p', '#{socket_path}')},0,0`,
      TMUX_PANE: tmux('display-message', '-p', '#{pane_id}'),
    };
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'status.js')], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-ipc', cwd: '/w' }));
    await new Promise(r => child.once('exit', r));

    const dir = ipc.getIpcDir();            // daemon 侧的算法
    const deadline = Date.now() + 3000;
    const evts = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^evt-.*\.json$/.test(f)) : []);
    while (evts().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(evts().length, 1, `hook 没写到 ${dir}`);
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);

    const client = new WsClient({ url: 'ws://127.0.0.1:1/ws', machineToken: 't', machineId: 'm', ptyManager: null });
    daemon.drainHookEvents(dir, client);
    assert.deepStrictEqual(evts(), [], 'daemon 读完要删掉');
    assert.strictEqual(client._hookStates.get('sess-ipc').state, 'running');
    assert.strictEqual(client._hookStates.get('probe').state, 'running', 'tmux 会话名也要登记');
  } finally {
    tmux('kill-server');
  }
});

test('旧默认目录：是自己的才接着收（兼容旧版复制出去的 hook），显式配置时不收', () => {
  assert.strictEqual(ipc.getLegacyIpcDir(), null, '不存在时不收');
  fs.mkdirSync(ipc.LEGACY_IPC_DIR);
  try {
    assert.strictEqual(ipc.getLegacyIpcDir(), ipc.LEGACY_IPC_DIR);
    process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = path.join(ROOT, 'env-ipc');
    assert.strictEqual(ipc.getLegacyIpcDir(), null);
  } finally {
    fs.rmSync(ipc.LEGACY_IPC_DIR, { recursive: true, force: true });
  }
});
