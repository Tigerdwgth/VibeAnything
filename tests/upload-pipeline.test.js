// 「粘贴图片 / 拖入文件」整条链路的服务端两端测试：
//   浏览器 --upload_file--> relay（鉴权+转发）--> 开发机 ws-client（落盘）--file_uploaded--> 浏览器
// 前端那一半在 packages/server/frontend/tests/terminal-upload.test.js。
//
// relay.js 顶部 require('./auth') 会拉起 bcryptjs/sql.js（与本测无关），
// 按 relay-machine.test.js 的既有做法先把它预置成最小 stub。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const authPath = require.resolve('../packages/server/auth.js');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: { verifyToken: () => null },
};

const { RelayServer, BROWSER_POLICY } = require('../packages/server/relay.js');
const owners = require('../packages/server/session-owners.js');
const { WsClient } = require('../lib/ws-client');

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    ping() {},
    on() {},
  };
}

/** 一台在线开发机 + 一个已登录浏览器，会话归属登记给 owner。 */
function setup({ owner = 'gsj', role = 'user' } = {}) {
  const relay = new RelayServer();
  const machineWs = fakeWs();
  relay.registerMachine('macmini', machineWs);
  const browserWs = fakeWs();
  const browserId = relay._addBrowser(browserWs, { username: 'gsj', role });
  owners.setOwner('macmini', 'sess1', owner);
  machineWs.sent.length = 0;      // 清掉握手时的 scan_active / scan_history
  browserWs.sent.length = 0;
  return { relay, machineWs, browserWs, browserId };
}

const upload = (extra = {}) => JSON.stringify({
  type: 'upload_file', machineId: 'macmini', sessionId: 'sess1',
  uploadId: 'u1', name: 'shot.png', data: Buffer.from('PNG').toString('base64'),
  ...extra,
});

// ── relay：鉴权 ───────────────────────────────────────────────

test('upload_file 走会话归属校验，不是开放通道', () => {
  const policy = BROWSER_POLICY.upload_file;
  assert.ok(policy, 'upload_file 必须登记，否则 relay 一律拒绝');
  assert.ok(!policy.open, '往别人机器上写文件不能是开放通道');
  assert.strictEqual(typeof policy.session, 'function');
  assert.strictEqual(policy.session({ sessionId: 'abc' }), 'abc');
  assert.ok(!policy.claimSession, '上传不该顺带把会话认成自己的');
});

test('自己的会话：转发给开发机，并带上 browserId 供回执定向', () => {
  const { relay, machineWs, browserId } = setup({ owner: 'gsj' });
  relay.handleBrowserMessage(browserId, upload());

  assert.strictEqual(machineWs.sent.length, 1);
  const fwd = machineWs.sent[0];
  assert.strictEqual(fwd.type, 'upload_file');
  assert.strictEqual(fwd.sessionId, 'sess1');
  assert.strictEqual(fwd.uploadId, 'u1');
  assert.strictEqual(fwd.name, 'shot.png');
  assert.strictEqual(fwd.data, Buffer.from('PNG').toString('base64'));
  assert.strictEqual(fwd.browserId, browserId, '没有 browserId 回执就不知道发给谁');
});

test('别人的会话：不转发，回越权提示', () => {
  const { relay, machineWs, browserWs, browserId } = setup({ owner: 'someone-else' });
  relay.handleBrowserMessage(browserId, upload());

  assert.strictEqual(machineWs.sent.length, 0, '越权的上传绝不能到达开发机');
  assert.strictEqual(browserWs.sent[0]?.type, 'pty_error');
});

test('管理员对他人会话可上传（与其它终端操作同一套可见性规则）', () => {
  const { relay, machineWs, browserId } = setup({ owner: 'someone-else', role: 'admin' });
  relay.handleBrowserMessage(browserId, upload());
  assert.strictEqual(machineWs.sent.length, 1);
});

test('开发机不在线：立刻回错，不让前端干等', () => {
  const { relay, browserWs, browserId } = setup({ owner: 'gsj' });
  relay.machines.delete('macmini');
  relay.handleBrowserMessage(browserId, upload());

  const reply = browserWs.sent.find(m => m.type === 'file_uploaded');
  assert.ok(reply, '必须有回执');
  assert.strictEqual(reply.uploadId, 'u1');
  assert.match(reply.error, /unavailable/i);
});

// ── relay：回执定向 ───────────────────────────────────────────

test('回执只回给发起的浏览器，不广播给同会话的其他观众', () => {
  const { relay, browserWs, browserId } = setup({ owner: 'gsj' });
  const otherWs = fakeWs();
  relay._addBrowser(otherWs, { username: 'gsj', role: 'user' });
  otherWs.sent.length = 0;
  browserWs.sent.length = 0;

  relay.handleMachineMessage('macmini', JSON.stringify({
    type: 'file_uploaded', browserId, uploadId: 'u1',
    sessionId: 'sess1', name: 'shot.png', path: '/tmp/x/030405-shot.png',
  }));

  const mine = browserWs.sent.filter(m => m.type === 'file_uploaded');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].path, '/tmp/x/030405-shot.png');
  assert.strictEqual(mine[0].machineId, 'macmini', '前端要靠 machineId 分辨是哪台机器的路径');
  assert.strictEqual(otherWs.sent.filter(m => m.type === 'file_uploaded').length, 0);
});

// ── 开发机侧：真落盘 + 回执 ───────────────────────────────────

function createClient() {
  const client = new WsClient({
    url: 'ws://example.test/ws',
    machineToken: 'test-token',
    machineId: 'test-machine',
    ptyManager: { create() {}, write() {}, resize() {}, destroy() {} },
  });
  const sent = [];
  // _send 只在 readyState === OPEN 时发；WebSocket.OPEN 是 1
  client._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  return { client, sent };
}

/** 把 VIBEANYTHING_HOME 指到临时目录，上传就落在那儿，不碰真实 home。 */
function withTempHome(fn) {
  const prev = process.env.VIBEANYTHING_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'va-home-'));
  process.env.VIBEANYTHING_HOME = home;
  try { return fn(home); } finally {
    if (prev === undefined) delete process.env.VIBEANYTHING_HOME;
    else process.env.VIBEANYTHING_HOME = prev;
  }
}

test('ws-client 收到 upload_file：真写盘，回执带绝对路径', () => {
  withTempHome((home) => {
    const { client, sent } = createClient();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    client._handleMessage(JSON.stringify({
      type: 'upload_file', browserId: 7, uploadId: 'u9',
      sessionId: 'sess1', name: 'shot.png', data: png.toString('base64'),
    }));

    const reply = sent.find(m => m.type === 'file_uploaded');
    assert.ok(reply, '必须回执，否则前端永远停在「上传中」');
    assert.strictEqual(reply.browserId, 7);
    assert.strictEqual(reply.uploadId, 'u9');
    assert.strictEqual(reply.error, undefined);
    assert.ok(reply.path.startsWith(path.join(home, 'uploads')), `落盘位置不对：${reply.path}`);
    assert.deepStrictEqual(fs.readFileSync(reply.path), png, '写进去的必须是原始字节');
  });
});

test('ws-client 上传失败：回执带 error，不抛出去打断 ws', () => {
  withTempHome(() => {
    const { client, sent } = createClient();
    assert.doesNotThrow(() => {
      client._handleMessage(JSON.stringify({
        type: 'upload_file', browserId: 7, uploadId: 'u9', sessionId: 'sess1',
        name: 'empty.png', data: '',
      }));
    });
    const reply = sent.find(m => m.type === 'file_uploaded');
    assert.ok(reply?.error, '失败也要回执');
    assert.strictEqual(reply.path, undefined);
  });
});
