// packages/server/tests/session-pins.test.js
// 会话置顶：存储语义（session-pins.js）+ relay 上的鉴权、按人投影、跨连接同步 + 真库落盘。
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pins-'));
process.env.DB_PATH = path.join(tempDir, 'users.db');
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const pins = require('../session-pins');
const owners = require('../session-owners');
const { RelayServer } = require('../relay');

const ADMIN = { username: 'admin', role: 'admin' };
const ALICE = { username: 'alice', role: 'user' };
const BOB = { username: 'bob', role: 'user' };

beforeEach(() => { pins._resetForTest(); owners._resetForTest(); });

function fakeBrowser(relay, user) {
  const messages = [];
  const ws = { readyState: 1, send: (payload) => messages.push(JSON.parse(payload)) };
  const id = relay._addBrowser(ws, user);
  return { id, messages, send: (msg) => relay.handleBrowserMessage(id, JSON.stringify(msg)) };
}

function fakeMachine(relay, machineId, sessions) {
  const sent = [];
  relay.registerMachine(machineId, { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) });
  relay.handleMachineMessage(machineId, JSON.stringify({ type: 'active_sessions', sessions }));
  return { sent };
}

/** 这个浏览器最近一次收到的某台机器的会话列表。 */
const lastActive = (browser, machineId) =>
  browser.messages.filter(m => m.type === 'active_sessions' && m.machineId === machineId).at(-1);
const pinnedIds = (browser, machineId) =>
  lastActive(browser, machineId).sessions.filter(s => s.pinnedAt).map(s => s.sessionId);

// ── 存储 ────────────────────────────────────────────────────

test('置顶 / 取消置顶往返，置顶时间就是置顶那一刻', () => {
  assert.equal(pins.pinnedAt('alice', 'm1', 's1'), null);
  assert.equal(pins.pin('alice', 'm1', 's1', 1000), true);
  assert.equal(pins.pinnedAt('alice', 'm1', 's1'), 1000);
  assert.equal(pins.unpin('alice', 'm1', 's1'), true);
  assert.equal(pins.pinnedAt('alice', 'm1', 's1'), null);
});

test('重复置顶不改置顶时间 —— 置顶组按它排序，多点一下不该让会话换位置', () => {
  pins.pin('alice', 'm1', 's1', 1000);
  assert.equal(pins.pin('alice', 'm1', 's1', 2000), false);
  assert.equal(pins.pinnedAt('alice', 'm1', 's1'), 1000);
});

test('取消一个没置顶的会话什么都不发生', () => {
  assert.equal(pins.unpin('alice', 'm1', 's1'), false);
});

test('置顶是各人自己的，且按机器区分同名会话', () => {
  pins.pin('alice', 'm1', 'main', 1000);
  assert.equal(pins.pinnedAt('bob', 'm1', 'main'), null);
  assert.equal(pins.pinnedAt('alice', 'm2', 'main'), null);
});

test('会话名带冒号也认得准', () => {
  pins.pin('alice', 'm1', 'a:b', 1000);
  assert.equal(pins.pinnedAt('alice', 'm1', 'a:b'), 1000);
  assert.equal(pins.pinnedAt('alice', 'm1:a', 'b'), null);
});

test('空参数不登记', () => {
  assert.equal(pins.pin('', 'm1', 's1'), false);
  assert.equal(pins.pin('alice', '', 's1'), false);
  assert.equal(pins.pin('alice', 'm1', ''), false);
});

test('会话改名：所有人的置顶跟到新名字上，置顶时间不变', () => {
  pins.pin('alice', 'm1', 'old', 1000);
  pins.pin('bob', 'm1', 'old', 2000);
  pins.pin('bob', 'm2', 'old', 3000);
  assert.deepEqual(pins.renameSession('m1', 'old', 'new').sort(), ['alice', 'bob']);
  assert.equal(pins.pinnedAt('alice', 'm1', 'new'), 1000);
  assert.equal(pins.pinnedAt('bob', 'm1', 'new'), 2000);
  assert.equal(pins.pinnedAt('alice', 'm1', 'old'), null);
  assert.equal(pins.pinnedAt('bob', 'm2', 'old'), 3000);   // 另一台机器上的同名会话不受影响
});

test('会话没了：所有人对它的置顶一起清掉，别的会话不动', () => {
  pins.pin('alice', 'm1', 'gone', 1000);
  pins.pin('bob', 'm1', 'gone', 2000);
  pins.pin('bob', 'm1', 'kept', 3000);
  assert.deepEqual(pins.removeSession('m1', 'gone').sort(), ['alice', 'bob']);
  assert.equal(pins.pinnedAt('alice', 'm1', 'gone'), null);
  assert.equal(pins.pinnedAt('bob', 'm1', 'gone'), null);
  assert.equal(pins.pinnedAt('bob', 'm1', 'kept'), 3000);
});

// ── relay ───────────────────────────────────────────────────

test('置顶后，这个人的会话列表里那一条带上 pinnedAt；不同开发机上的会话可以一起置顶', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'web', 'alice');
  owners.setOwner('mac', 'api', 'alice');
  owners.setOwner('gpu', 'train', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'web' }, { sessionId: 'api' }]);
  fakeMachine(relay, 'gpu', [{ sessionId: 'train' }]);
  const alice = fakeBrowser(relay, ALICE);

  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: true });
  alice.send({ type: 'pin_session', machineId: 'gpu', sessionId: 'train', pinned: true });

  assert.deepEqual(pinnedIds(alice, 'mac'), ['web']);
  assert.deepEqual(pinnedIds(alice, 'gpu'), ['train']);
  // 没置顶的那条不带这个字段（不是 null）—— 前端按「有没有」判断
  assert.equal('pinnedAt' in lastActive(alice, 'mac').sessions.find(s => s.sessionId === 'api'), false);
});

test('取消置顶后字段消失', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'web', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'web' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: true });
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: false });
  assert.deepEqual(pinnedIds(alice, 'mac'), []);
});

test('同一个人的另一个页面（手机版）立刻收到同一份置顶；别人的页面不受打扰', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'web', 'alice');
  owners.setOwner('mac', 'bobs', 'bob');
  fakeMachine(relay, 'mac', [{ sessionId: 'web' }, { sessionId: 'bobs' }]);
  const desktop = fakeBrowser(relay, ALICE);
  const phone = fakeBrowser(relay, ALICE);
  const bob = fakeBrowser(relay, BOB);
  const bobBefore = bob.messages.length;
  const phoneBefore = phone.messages.length;

  desktop.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: true });

  assert.equal(phone.messages.length, phoneBefore + 1);
  assert.deepEqual(pinnedIds(phone, 'mac'), ['web']);
  assert.equal(bob.messages.length, bobBefore);
});

test('管理员置顶别人的会话，只进管理员自己的置顶组，会话主人那边不变', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'web', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'web' }]);
  const admin = fakeBrowser(relay, ADMIN);
  const alice = fakeBrowser(relay, ALICE);
  admin.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: true });
  assert.deepEqual(pinnedIds(admin, 'mac'), ['web']);
  // 开发机下一轮扫描推过来的列表，alice 收到的仍然没有置顶
  relay.handleMachineMessage('mac', JSON.stringify({ type: 'active_sessions', sessions: [{ sessionId: 'web' }] }));
  assert.deepEqual(pinnedIds(alice, 'mac'), []);
  assert.deepEqual(pinnedIds(admin, 'mac'), ['web']);
});

test('不能置顶看不见的会话：不登记，回一条拒绝', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'bobs', 'bob');
  fakeMachine(relay, 'mac', [{ sessionId: 'bobs' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'bobs', pinned: true });
  assert.equal(pins.pinnedAt('alice', 'mac', 'bobs'), null);
  assert.equal(alice.messages.at(-1).type, 'pty_error');
});

test('被共享的会话也能置顶', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'bobs', 'bob');
  owners.addShare('mac', 'bobs', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'bobs' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'bobs', pinned: true });
  assert.deepEqual(pinnedIds(alice, 'mac'), ['bobs']);
});

test('会话改名后仍在置顶组里（sessionId 就是 tmux 名，改名后它会变）', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'old', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'old' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'old', pinned: true });
  const at = pins.pinnedAt('alice', 'mac', 'old');

  relay.handleMachineMessage('mac', JSON.stringify({ type: 'session_renamed', oldSessionId: 'old', newSessionId: 'new' }));
  relay.handleMachineMessage('mac', JSON.stringify({ type: 'active_sessions', sessions: [{ sessionId: 'new' }] }));

  assert.deepEqual(pinnedIds(alice, 'mac'), ['new']);
  assert.equal(pins.pinnedAt('alice', 'mac', 'new'), at);
});

test('停掉会话会清掉置顶：以后再建同名会话不会一出现就挂在置顶组里', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'main', 'alice');
  fakeMachine(relay, 'mac', [{ sessionId: 'main' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'main', pinned: true });
  alice.send({ type: 'stop_terminal', machineId: 'mac', sessionId: 'main' });
  assert.equal(pins.pinnedAt('alice', 'mac', 'main'), null);
  relay.handleMachineMessage('mac', JSON.stringify({ type: 'active_sessions', sessions: [{ sessionId: 'main' }] }));
  assert.deepEqual(pinnedIds(alice, 'mac'), []);
});

test('开发机不在线时置顶照样记下，机器回来后列表里就是置顶的', () => {
  const relay = new RelayServer();
  owners.setOwner('mac', 'web', 'alice');
  const alice = fakeBrowser(relay, ALICE);
  alice.send({ type: 'pin_session', machineId: 'mac', sessionId: 'web', pinned: true });
  assert.ok(pins.pinnedAt('alice', 'mac', 'web'));
  fakeMachine(relay, 'mac', [{ sessionId: 'web' }]);
  assert.deepEqual(pinnedIds(alice, 'mac'), ['web']);
});

// ── 落盘 ────────────────────────────────────────────────────

test('置顶记录写进 users.db：重启（重新 init）后还在；改名、取消、删除都同步到库里', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  /** 从磁盘上的库文件直接读，不经过任何内存缓存。 */
  const rowsOnDisk = () => {
    const db = new SQL.Database(fs.readFileSync(process.env.DB_PATH));
    const res = db.exec('SELECT username, machine_id, session_id, pinned_at FROM session_pins ORDER BY pinned_at');
    db.close();
    return res[0]?.values || [];
  };

  assert.equal(await pins.init(), 0);
  pins.pin('alice', 'mac', 'web', 1000);
  pins.pin('alice', 'gpu', 'train', 2000);
  pins.pin('bob', 'mac', 'web', 3000);
  assert.deepEqual(rowsOnDisk(), [
    ['alice', 'mac', 'web', 1000], ['alice', 'gpu', 'train', 2000], ['bob', 'mac', 'web', 3000],
  ]);

  pins._resetForTest();
  assert.equal(pins.pinnedAt('alice', 'mac', 'web'), null);
  assert.equal(await pins.init(), 3);
  assert.equal(pins.pinnedAt('alice', 'mac', 'web'), 1000);
  assert.equal(pins.pinnedAt('alice', 'gpu', 'train'), 2000);

  pins.renameSession('mac', 'web', 'site');
  assert.deepEqual(rowsOnDisk(), [
    ['alice', 'mac', 'site', 1000], ['alice', 'gpu', 'train', 2000], ['bob', 'mac', 'site', 3000],
  ]);

  pins.unpin('alice', 'gpu', 'train');
  pins.removeSession('mac', 'site');
  assert.deepEqual(rowsOnDisk(), []);
});
