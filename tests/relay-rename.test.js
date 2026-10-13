// 会话改名在 relay 这一环的行为：台账迁移 + 下发给浏览器 + 失败回执的可见性。
//
// 为什么改名必须下发：sessionId 就是开发机上的 tmux 名，改完之后浏览器那边开着的
// 标签还指着旧名。手机一切后台就重连，重连时那个标签会照旧名发 open_terminal，
// 开发机找不到同名 tmux 就**新建**一个空会话（用户看到的是「会话变两个、进去是空的」）。
//
// relay.js 顶部 require('./auth') 会拉起 bcryptjs/sql.js（与本测无关），
// 按 relay-machine.test.js 的既有做法先把它预置成最小 stub。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const authPath = require.resolve('../packages/server/auth.js');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: { verifyToken: () => null },
};

const { RelayServer } = require('../packages/server/relay.js');
const owners = require('../packages/server/session-owners.js');

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

/** 一台在线开发机 + 两个登录用户的浏览器；会话 old-name 归 gsj。 */
function setup() {
  const relay = new RelayServer();
  relay.registerMachine('macmini', fakeWs());
  const mine = fakeWs();
  const other = fakeWs();
  relay._addBrowser(mine, { username: 'gsj', role: 'user' });
  relay._addBrowser(other, { username: 'yijun', role: 'user' });
  owners.setOwner('macmini', 'old-name', 'gsj');
  mine.sent.length = 0;
  other.sent.length = 0;
  return { relay, mine, other };
}

const renamed = (extra = {}) => JSON.stringify({
  type: 'session_renamed', oldSessionId: 'old-name', newSessionId: 'new-name', ...extra,
});

beforeEach(() => { owners._resetForTest(); });

test('改名先迁台账：新名归原主，旧名不再留在账上（否则会话变无主，普通用户列表里直接消失）', () => {
  const { relay } = setup();
  relay.handleMachineMessage('macmini', renamed());

  assert.strictEqual(owners.getOwner('macmini', 'new-name'), 'gsj');
  assert.ok(!owners.getOwner('macmini', 'old-name'), '旧名必须从台账上摘掉');
});

test('改名下发给会话的主人，新旧名都带着（前端据此把开着的标签换名）', () => {
  const { relay, mine } = setup();
  relay.handleMachineMessage('macmini', renamed());

  const msgs = mine.sent.filter(m => m.type === 'session_renamed');
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual(
    { ...msgs[0] },
    { type: 'session_renamed', machineId: 'macmini', oldSessionId: 'old-name', newSessionId: 'new-name' }
  );
});

test('别人的会话改名不下发 —— 判的是新名的归属（台账已在广播前迁移过去）', () => {
  const { relay, other } = setup();
  relay.handleMachineMessage('macmini', renamed());

  assert.deepStrictEqual(other.sent.filter(m => m.type === 'session_renamed'), []);
});

test('改名失败的回执只给看得见这个会话的人，不再无差别广播', () => {
  const { relay, mine, other } = setup();
  relay.handleMachineMessage('macmini', JSON.stringify({
    type: 'rename_error', sessionId: 'old-name', error: '已存在同名会话: new-name',
  }));

  assert.strictEqual(mine.sent.filter(m => m.type === 'rename_error').length, 1);
  assert.deepStrictEqual(other.sent.filter(m => m.type === 'rename_error'), []);
});
