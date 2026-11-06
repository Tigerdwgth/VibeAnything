// tests/ws-message-guard.test.js
// relay 下发的消息字段来自浏览器，不可信。这里全部走真的 WebSocket 连接 + 真 PtyManager + 真 tmux：
// 坏消息要换来一条 pty_error，而不是让 daemon 进程退出（旧代码一条不带 data 的 pty_input 就崩）。
// 本文件改了 HOME / VIBEANYTHING_HOME / IPC 目录，所以单独成文件（node --test 每个文件一个进程）。
const assert = require('node:assert');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-wsguard-'));
process.env.HOME = path.join(root, 'home');
process.env.VIBEANYTHING_HOME = path.join(root, 'vibe');
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = path.join(root, 'ipc');
fs.mkdirSync(process.env.HOME, { recursive: true });

const WebSocket = require('ws');
const { WsClient } = require('../lib/ws-client');
const { PtyManager } = require('../lib/pty-manager');

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const killExact = (name) => spawnSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });

after(() => fs.rmSync(root, { recursive: true, force: true }));

/** 起一个本地 ws 服务端充当 relay，连上真 WsClient。返回发消息 / 等回执的工具。 */
async function connectRelay() {
  const wss = new WebSocket.Server({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const pty = new PtyManager();
  const client = new WsClient({
    url: `ws://127.0.0.1:${wss.address().port}`,
    machineToken: 't', machineId: 'm', ptyManager: pty,
  });
  const received = [];
  const waiters = [];
  const sock = await new Promise((resolve) => {
    wss.once('connection', (s) => {
      s.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        for (const w of [...waiters]) {
          if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
        }
      });
      resolve(s);
    });
    client.connect();
  });
  const waitFor = (match, ms = 5000) => {
    const hit = received.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('等回执超时')), ms).unref();
    });
  };
  const send = (msg) => sock.send(JSON.stringify(msg));
  const close = async () => {
    client.disconnect();
    pty.destroyAll();
    await new Promise((r) => wss.close(r));
  };
  return { send, waitFor, received, close };
}

test('坏字段的消息回 pty_error（带 sessionId），daemon 不退出，后续消息照常处理', async () => {
  const relay = await connectRelay();
  try {
    const bad = [
      { type: 'pty_input', sessionId: 'g1' },                                    // 缺 data
      { type: 'pty_open', sessionId: 'g2', cols: 'abc', rows: 24 },              // cols 是字符串
      { type: 'pty_open', sessionId: 'g3', command: 'claude' },                  // command 不是数组
      { type: 'pty_resize', sessionId: 'g4', cols: -1, rows: 10 },
      { type: 'create_folder', sessionId: 'g5', name: { toString: 1 } },         // String(name) 会抛
      { type: 'rename_session', sessionId: 'g6', newName: 42 },
    ];
    for (const msg of bad) {
      relay.send({ ...msg, browserId: 'b1' });
      const err = await relay.waitFor((m) => m.type === 'pty_error' && m.sessionId === msg.sessionId);
      assert.strictEqual(err.action, msg.type);
      assert.strictEqual(err.browserId, 'b1', '回执要定向回发起的浏览器');
      assert.match(err.error, /类型不合法/);
    }
    // 分屏 / 窗格操作沿用前端认识的 action 名（换名会被前端当成「会话被拒」关掉 tab）
    relay.send({ type: 'pty_split', sessionId: 'g7', direction: 5, browserId: 'b1' });
    assert.strictEqual((await relay.waitFor((m) => m.type === 'pty_error' && m.sessionId === 'g7')).action, 'split');
    relay.send({ type: 'pty_select_pane', sessionId: 'g8', direction: [], browserId: 'b1' });
    assert.strictEqual((await relay.waitFor((m) => m.type === 'pty_error' && m.sessionId === 'g8')).action, 'select_pane');
    // 进程还活着且消息循环没坏：再来一条正常请求能拿到回执
    relay.send({ type: 'list_dir', path: process.env.HOME });
    await relay.waitFor((m) => m.type === 'dir_entries' && m.path === process.env.HOME);
  } finally {
    await relay.close();
  }
});

test('处理函数里抛出的异常（非字段问题）同样回 pty_error 而不是带走进程', async () => {
  const relay = await connectRelay();
  try {
    // 文件夹元数据文件被占成目录 → saveMeta 写文件 EISDIR，异常从 sessionMeta 里抛出来
    fs.mkdirSync(path.join(process.env.VIBEANYTHING_HOME, 'session-folders.json'), { recursive: true });
    relay.send({ type: 'create_folder', name: 'x', browserId: 'b2' });
    const err = await relay.waitFor((m) => m.type === 'pty_error' && m.action === 'create_folder');
    assert.match(err.error, /EISDIR/);
  } finally {
    fs.rmSync(path.join(process.env.VIBEANYTHING_HOME, 'session-folders.json'), { recursive: true, force: true });
    await relay.close();
  }
});

// node-pty 真的 spawn 失败（PTY / fd 耗尽，LESSONS_LEARNED 11-04 那次 daemon 就是这样崩了 9 次）。
// 只在本进程里把 fd 用光：openpty 拿不到 fd 就同步抛异常，影响不到系统里别的进程。
test('pty_open 时 node-pty spawn 失败：回 pty_error，fd 恢复后同一会话能正常打开', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const relay = await connectRelay();
  const id = `vibe-wsg-${process.pid}`;
  killExact(`cc-${id}`);
  const hogs = [];
  try {
    try {
      for (;;) hogs.push(fs.openSync('/dev/null', 'r'));
    } catch (e) {
      assert.strictEqual(e.code, 'EMFILE');
    }
    relay.send({ type: 'pty_open', sessionId: id, browserId: 'b3', cols: 80, rows: 24, command: ['sleep', '600'] });
    const err = await relay.waitFor((m) => m.type === 'pty_error' && m.sessionId === id);
    assert.strictEqual(err.action, 'pty_open');
    for (const fd of hogs.splice(0)) fs.closeSync(fd);

    relay.send({ type: 'pty_open', sessionId: id, browserId: 'b3', cols: 80, rows: 24, command: ['sleep', '600'] });
    await relay.waitFor((m) => m.type === 'pty_data' && m.sessionId === id && m.data);
  } finally {
    for (const fd of hogs) fs.closeSync(fd);
    await relay.close();
    killExact(`cc-${id}`);
  }
});

test('read_file 黑名单：软链接、大小写变体都挡住，普通文件照常读', async () => {
  const home = process.env.HOME;
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'SECRET');
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'proj', 'keys'));
  fs.writeFileSync(path.join(home, 'proj', 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(home, '.sshx'), 'not-ssh');   // 只是前缀相同，不在 .ssh 里
  const relay = await connectRelay();
  const read = async (p) => {
    relay.send({ type: 'read_file', path: p });
    return relay.waitFor((m) => m.type === 'file_content' && m.path === p);
  };
  try {
    for (const p of [
      path.join(home, '.ssh', 'id_rsa'),
      path.join(home, 'proj', 'keys', 'id_rsa'),
      path.join(home, '.SSH', 'id_rsa'),
    ]) {
      const r = await read(p);
      assert.strictEqual(r.content, undefined, `${p} 不该被读出来`);
      assert.ok(r.error);
    }
    if (fs.existsSync('/private/etc/passwd')) {
      const r = await read('/private/etc/passwd');
      assert.strictEqual(r.error, 'Access denied', '/etc 在 macOS 上是 /private/etc 的软链接');
    }
    assert.strictEqual((await read(path.join(home, 'proj', 'notes.txt'))).content, 'hello');
    assert.strictEqual((await read(path.join(home, '.sshx'))).content, 'not-ssh');
  } finally {
    await relay.close();
  }
});
