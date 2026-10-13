// packages/server/tests/relay.test.js
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const { RelayServer } = require('../relay');
const owners = require('../session-owners');

const ADMIN = { username: 'admin', role: 'admin' };
const ALICE = { username: 'alice', role: 'user' };
const BOB = { username: 'bob', role: 'user' };

// 台账是模块单例，每个用例前清空，避免互相污染
beforeEach(() => owners._resetForTest());

/** 建一个记录所有下行消息的假浏览器连接 */
function fakeBrowser(relay, user = ADMIN) {
  const messages = [];
  const raw = [];
  const ws = { readyState: 1, send: (payload) => { raw.push(payload); messages.push(JSON.parse(payload)); } };
  const id = relay._addBrowser(ws, user);
  return { id, ws, messages, raw };
}

function fakeMachine(relay, machineId = 'm1') {
  const sent = [];
  const ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  relay.registerMachine(machineId, ws);
  return { ws, sent };
}

test('machine registration', () => {
  const relay = new RelayServer();
  relay.registerMachine('dev-a', { send: () => {}, readyState: 1 });
  assert.ok(relay.getMachine('dev-a'));
  relay.unregisterMachine('dev-a');
  assert.equal(relay.getMachine('dev-a'), undefined);
});

test('session list update', () => {
  const relay = new RelayServer();
  relay.registerMachine('dev-a', { send: () => {}, readyState: 1 });
  relay.updateSessions('dev-a', [{ id: 'sess1', cwd: '/project' }]);
  const sessions = relay.getAllSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].machineId, 'dev-a');
});

test('handleMachineMessage session_list', () => {
  const relay = new RelayServer();
  relay.registerMachine('dev-a', { send: () => {}, readyState: 1 });
  relay.handleMachineMessage('dev-a', JSON.stringify({
    type: 'session_list',
    sessions: [{ id: 'abc', cwd: '/home' }]
  }));
  const sessions = relay.getAllSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'abc');
});

test('pty_attach only updates watching, no pty_open sent', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 's1', 'admin');
  const browser = fakeBrowser(relay);
  machine.sent.length = 0;
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 's1'
  }));
  assert.strictEqual(machine.sent.length, 0, 'should NOT send pty_open to machine');
  assert.ok(relay.browsers.get(browser.id).watching.has('m1:s1'));
});

test('split_terminal forwards pty_split to machine', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'sess-1', 'admin');
  const browser = fakeBrowser(relay);
  machine.sent.length = 0;

  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'split_terminal',
    machineId: 'm1',
    sessionId: 'sess-1',
    direction: 'left',
    cwd: '/workspace/app',
    command: ['claude'],
  }));

  assert.deepStrictEqual(machine.sent, [{
    type: 'pty_split',
    browserId: browser.id,
    sessionId: 'sess-1',
    direction: 'left',
    cwd: '/workspace/app',
    command: ['claude'],
  }]);
});

test('close_terminal forwards pty_close to machine', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 's1', 'admin');
  const browser = fakeBrowser(relay);
  machine.sent.length = 0;
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'close_terminal', machineId: 'm1', sessionId: 's1'
  }));
  assert.strictEqual(machine.sent.length, 1);
  assert.strictEqual(machine.sent[0].type, 'pty_close');
  assert.strictEqual(machine.sent[0].sessionId, 's1');
});

test('delete_session forwards to machine', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 's1', 'admin');
  const browser = fakeBrowser(relay);
  machine.sent.length = 0;
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'delete_session', machineId: 'm1', sessionId: 's1'
  }));
  assert.strictEqual(machine.sent.length, 1);
  assert.strictEqual(machine.sent[0].type, 'delete_session');
  assert.strictEqual(machine.sent[0].sessionId, 's1');
});

test('split_terminal forwards pty_split to machine without command metadata', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 's1', 'admin');
  const browser = fakeBrowser(relay);
  machine.sent.length = 0;

  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'split_terminal',
    machineId: 'm1',
    sessionId: 's1',
    direction: 'left',
    cwd: '/tmp/project'
  }));

  assert.strictEqual(machine.sent.length, 1);
  assert.deepStrictEqual(machine.sent[0], {
    type: 'pty_split',
    browserId: browser.id,
    sessionId: 's1',
    direction: 'left',
    cwd: '/tmp/project',
  });
});

test('split pty_error is sent only to requesting browser', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  const browser1 = fakeBrowser(relay);
  const browser2 = fakeBrowser(relay);

  browser1.messages.length = 0;
  browser2.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'pty_error',
    browserId: browser1.id,
    action: 'split',
    sessionId: 'sess-1',
    error: 'split failed'
  }));

  assert.strictEqual(browser1.messages.length, 1);
  assert.strictEqual(browser1.messages[0].type, 'pty_error');
  assert.strictEqual(browser2.messages.length, 0);
});

// ── 会话归属隔离 ────────────────────────────────────────────

test('session_list 按归属过滤：各人只看到自己的会话', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  owners.setOwner('m1', 'b-sess', 'bob');

  const alice = fakeBrowser(relay, ALICE);
  const bob = fakeBrowser(relay, BOB);
  alice.messages.length = 0;
  bob.messages.length = 0;

  relay.updateSessions('m1', [{ id: 'a-sess' }, { id: 'b-sess' }]);

  const aliceList = alice.messages.find(m => m.type === 'session_list');
  const bobList = bob.messages.find(m => m.type === 'session_list');
  assert.deepStrictEqual(aliceList.sessions.map(s => s.id), ['a-sess']);
  assert.deepStrictEqual(bobList.sessions.map(s => s.id), ['b-sess']);
});

test('admin 看到全部会话，含无主会话', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');

  const admin = fakeBrowser(relay, ADMIN);
  admin.messages.length = 0;
  relay.updateSessions('m1', [{ id: 'a-sess' }, { id: 'orphan' }]);

  const list = admin.messages.find(m => m.type === 'session_list');
  assert.deepStrictEqual(list.sessions.map(s => s.id).sort(), ['a-sess', 'orphan']);
});

test('无主会话对普通用户不可见', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  const alice = fakeBrowser(relay, ALICE);
  relay.updateSessions('m1', [{ id: 'orphan' }]);

  // 列表内容没变时会被逐连接的 diff 去重跳过，所以断言「发出去的每一份都不含无主会话」
  const lists = alice.messages.filter(m => m.type === 'session_list');
  assert.ok(lists.length, '至少收到过一份会话列表');
  for (const list of lists) assert.deepStrictEqual(list.sessions, []);
});

test('active_sessions 逐浏览器过滤', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  owners.setOwner('m1', 'b-sess', 'bob');

  const alice = fakeBrowser(relay, ALICE);
  const bob = fakeBrowser(relay, BOB);
  alice.messages.length = 0;
  bob.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [{ sessionId: 'a-sess', cwd: '/a' }, { sessionId: 'b-sess', cwd: '/b' }],
  }));

  const aliceMsg = alice.messages.find(m => m.type === 'active_sessions');
  const bobMsg = bob.messages.find(m => m.type === 'active_sessions');
  assert.deepStrictEqual(aliceMsg.sessions.map(s => s.sessionId), ['a-sess']);
  assert.deepStrictEqual(bobMsg.sessions.map(s => s.sessionId), ['b-sess']);
});

test('越权 terminal_input 被拦截，不下发给开发机', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;
  bob.messages.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'terminal_input', machineId: 'm1', sessionId: 'a-sess', data: 'cm0gLXJmIC8=',
  }));

  assert.strictEqual(machine.sent.length, 0, '越权输入不能到达开发机');
  assert.strictEqual(bob.messages[0]?.type, 'pty_error');
});

test('越权 pty_attach 无法加入 watching（否则能偷看 pty_data）', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  const bob = fakeBrowser(relay, BOB);

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 'a-sess',
  }));

  assert.strictEqual(relay.browsers.get(bob.id).watching.has('m1:a-sess'), false);
});

test('越权 open_terminal（attach 他人已有会话）被拒绝且不改归属', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;
  bob.messages.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'open_terminal', machineId: 'm1', sessionId: 'a-sess', cols: 80, rows: 24,
  }));

  assert.strictEqual(machine.sent.length, 0);
  assert.strictEqual(owners.getOwner('m1', 'a-sess'), 'alice');
  assert.strictEqual(bob.messages[0]?.type, 'pty_error');
});

test('open_terminal 新建会话自动认领给创建者', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'open_terminal', machineId: 'm1', sessionId: 'brand-new', cols: 80, rows: 24,
  }));

  assert.strictEqual(owners.getOwner('m1', 'brand-new'), 'bob');
  assert.strictEqual(machine.sent[0]?.type, 'pty_open');
});

test('owner 本人 open_terminal 已有会话可通过', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  machine.sent.length = 0;

  relay.handleBrowserMessage(alice.id, JSON.stringify({
    type: 'open_terminal', machineId: 'm1', sessionId: 'a-sess', cols: 80, rows: 24,
  }));

  assert.strictEqual(machine.sent[0]?.type, 'pty_open');
});

test('pty_data 只发给有权且在 watching 的浏览器', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);

  const alice = fakeBrowser(relay, ALICE);
  const bob = fakeBrowser(relay, BOB);
  relay.handleBrowserMessage(alice.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 'a-sess',
  }));
  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 'a-sess',
  }));
  alice.messages.length = 0;
  bob.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'pty_data', sessionId: 'a-sess', data: 'aGVsbG8=',
  }));

  assert.strictEqual(alice.messages.length, 1);
  assert.strictEqual(alice.messages[0].type, 'pty_data');
  assert.strictEqual(bob.messages.length, 0, 'bob 无权，不应收到任何 pty_data');
});

test('session_renamed 迁移归属台账', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'old-name', 'alice');

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'session_renamed', oldSessionId: 'old-name', newSessionId: 'new-name',
  }));

  assert.strictEqual(owners.getOwner('m1', 'new-name'), 'alice');
  assert.strictEqual(owners.getOwner('m1', 'old-name'), null);
});

test('session_deleted 清理归属台账', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 's1', 'alice');

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'session_deleted', sessionId: 's1',
  }));

  assert.strictEqual(owners.getOwner('m1', 's1'), null);
});

test('refreshSessionLists 绕过 diff 缓存强制重推', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  alice.messages.length = 0;

  relay.refreshSessionLists();

  assert.ok(alice.messages.some(m => m.type === 'session_list'));
});

test('active_sessions 同时填充 m.sessions（归属管理 API 的数据源）', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [{ sessionId: 's1', cwd: '/a' }, { sessionId: 's2', cwd: '/b' }],
  }));
  const all = relay.getAllSessions();
  assert.deepStrictEqual(all.map(s => s.sessionId).sort(), ['s1', 's2']);
  assert.strictEqual(all[0].machineId, 'm1');
});

// ── 文件夹隔离 ──────────────────────────────────────────────

test('folders 按内含可见会话过滤：看不到他人分组', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  owners.setOwner('m1', 'b-sess', 'bob');
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [
      { sessionId: 'a-sess', folderId: 'fa' },
      { sessionId: 'b-sess', folderId: 'fb' },
    ],
  }));

  const alice = fakeBrowser(relay, ALICE);
  alice.messages.length = 0;
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders',
    folders: [
      { id: 'fa', name: 'alice的', parentId: null },
      { id: 'fb', name: 'bob的', parentId: null },
      { id: 'fc', name: '空文件夹', parentId: null },
    ],
  }));

  const msg = alice.messages.find(m => m.type === 'folders');
  assert.deepStrictEqual(msg.folders.map(f => f.id), ['fa']);
});

test('folders 过滤保留祖先链，子文件夹不会挂空', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [{ sessionId: 'a-sess', folderId: 'child' }],
  }));

  const alice = fakeBrowser(relay, ALICE);
  alice.messages.length = 0;
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders',
    folders: [
      { id: 'root', name: '根', parentId: null },
      { id: 'child', name: '子', parentId: 'root' },
      { id: 'other', name: '别人的', parentId: null },
    ],
  }));

  const ids = alice.messages.find(m => m.type === 'folders').folders.map(f => f.id).sort();
  assert.deepStrictEqual(ids, ['child', 'root']);
});

test('admin 看到全部文件夹，含空文件夹', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  const admin = fakeBrowser(relay, ADMIN);
  admin.messages.length = 0;
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders',
    folders: [{ id: 'f1', name: 'x', parentId: null }, { id: 'f2', name: 'y', parentId: null }],
  }));
  const ids = admin.messages.find(m => m.type === 'folders').folders.map(f => f.id);
  assert.deepStrictEqual(ids, ['f1', 'f2']);
});

// ── 管理员「隐藏他人会话」（ownOnly 视图范围）────────────────

/** 让 admin 浏览器进入隐藏模式，返回切换过程中收到的消息 */
function hideOthers(relay, browser, ownOnly = true) {
  browser.messages.length = 0;
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'set_visibility_scope', ownOnly,
  }));
  return browser.messages;
}

test('浏览器连上即下发 whoami，前端据此判断是否显示管理员开关', () => {
  const relay = new RelayServer();
  const admin = fakeBrowser(relay, ADMIN);
  const who = admin.messages.find(m => m.type === 'whoami');
  assert.strictEqual(who.username, 'admin');
  assert.strictEqual(who.role, 'admin');
});

test('隐藏后 session_list 去掉他人会话，保留自己的与无主的', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  owners.setOwner('m1', 'admin-sess', 'admin');
  relay.updateSessions('m1', [{ id: 'alice-sess' }, { id: 'admin-sess' }, { id: 'orphan' }]);
  const admin = fakeBrowser(relay, ADMIN);

  const msgs = hideOthers(relay, admin);

  const list = msgs.filter(m => m.type === 'session_list').pop();
  assert.deepStrictEqual(list.sessions.map(s => s.id).sort(), ['admin-sess', 'orphan']);
});

test('隐藏后 active_sessions 只推自己的与无主的', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  owners.setOwner('m1', 'admin-sess', 'admin');
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);
  admin.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [{ sessionId: 'alice-sess' }, { sessionId: 'admin-sess' }, { sessionId: 'orphan' }],
  }));

  const act = admin.messages.find(m => m.type === 'active_sessions');
  assert.deepStrictEqual(act.sessions.map(s => s.sessionId).sort(), ['admin-sess', 'orphan']);
});

test('切到隐藏时摘掉他人会话的 watching，并回 pty_error 让前端关掉窗口', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'alice-sess' }]);
  const admin = fakeBrowser(relay, ADMIN);
  relay.handleBrowserMessage(admin.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 'alice-sess',
  }));

  const msgs = hideOthers(relay, admin);

  assert.ok(msgs.some(m => m.type === 'pty_error' && m.sessionId === 'alice-sess' && m.action === 'scope'));
  admin.messages.length = 0;
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'pty_data', sessionId: 'alice-sess', data: 'aGk=',
  }));
  assert.strictEqual(admin.messages.length, 0, '隐藏后不应再收到他人会话的 PTY 数据');
});

test('取消隐藏后恢复全量可见', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'alice-sess' }]);
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);

  const msgs = hideOthers(relay, admin, false);

  const list = msgs.filter(m => m.type === 'session_list').pop();
  assert.deepStrictEqual(list.sessions.map(s => s.id), ['alice-sess']);
});

test('隐藏后 hook_event 不再被他人会话触发（红绿灯与提示音）', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  owners.setOwner('m1', 'admin-sess', 'admin');
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);
  admin.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'hook_event', hookEvent: 'Stop', hookState: 'done', sessionId: 'alice-sess',
  }));
  assert.strictEqual(admin.messages.filter(m => m.type === 'hook_event').length, 0);

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'hook_event', hookEvent: 'Stop', hookState: 'done', sessionId: 'admin-sess',
  }));
  assert.strictEqual(admin.messages.filter(m => m.type === 'hook_event').length, 1);
});

test('hook_event 用 tmuxSession 兜底匹配归属', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'cc-admin', 'admin');
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);
  admin.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'hook_event', hookEvent: 'Stop', sessionId: 'uuid-未登记', tmuxSession: 'cc-admin',
  }));

  assert.strictEqual(admin.messages.filter(m => m.type === 'hook_event').length, 1);
});

test('hook_event 对普通用户同样按归属过滤', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  const bob = fakeBrowser(relay, BOB);
  bob.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'hook_event', hookEvent: 'Stop', sessionId: 'alice-sess',
  }));

  assert.strictEqual(bob.messages.filter(m => m.type === 'hook_event').length, 0);
});

test('隐藏后 folders 藏掉他人分组，但保留自己的空文件夹', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  owners.setOwner('m1', 'admin-sess', 'admin');
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions',
    sessions: [
      { sessionId: 'alice-sess', folderId: 'fa' },
      { sessionId: 'admin-sess', folderId: 'fb' },
    ],
  }));
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);
  admin.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders',
    folders: [
      { id: 'fa', name: 'alice的', parentId: null },
      { id: 'fb', name: 'admin的', parentId: null },
      { id: 'fc', name: '刚建的空文件夹', parentId: null },
    ],
  }));

  const ids = admin.messages.find(m => m.type === 'folders').folders.map(f => f.id).sort();
  assert.deepStrictEqual(ids, ['fb', 'fc']);
});

test('open_terminal 回推的 session_list 也过滤（不绕过隔离）', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'alice-sess' }]);
  const bob = fakeBrowser(relay, BOB);
  bob.messages.length = 0;
  machine.sent.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'open_terminal', machineId: 'm1', sessionId: 'bob-new', cols: 80, rows: 24,
  }));

  // 内容与上一份相同的列表会被去重跳过，所以断言「发给 bob 的每一份都不含 alice 的会话」
  for (const list of bob.messages.filter(m => m.type === 'session_list')) {
    assert.deepStrictEqual(list.sessions.map(s => s.id), [], 'bob 不应在回推列表里看到 alice 的会话');
  }
});

// ── 分组文件夹互相独立 ──────────────────────────────────────

/** 让某浏览器新建一个文件夹，返回 relay 下发给开发机的那条 create_folder */
function createFolder(relay, browser, machine, { name = '新文件夹', parentId = null, machineId = 'm1' } = {}) {
  machine.sent.length = 0;
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'create_folder', machineId, name, parentId,
  }));
  return machine.sent.find(m => m.type === 'create_folder') || null;
}

test('create_folder 由 relay 生成 folderId 并当场登记归属', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  const alice = fakeBrowser(relay, ALICE);

  const sent = createFolder(relay, alice, machine, { name: 'alice的项目' });

  assert.ok(sent.folderId, 'folderId 必须由服务端下发，开发机不能自己生成');
  assert.strictEqual(sent.name, 'alice的项目');
  assert.strictEqual(owners.getFolderOwner('m1', sent.folderId), 'alice');
});

test('新建的空文件夹对创建者可见，对他人不可见', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  const alice = fakeBrowser(relay, ALICE);
  const bob = fakeBrowser(relay, BOB);
  const sent = createFolder(relay, alice, machine);
  alice.messages.length = 0;
  bob.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders', folders: [{ id: sent.folderId, name: '新文件夹', parentId: null }],
  }));

  assert.deepStrictEqual(
    alice.messages.find(m => m.type === 'folders').folders.map(f => f.id), [sent.folderId]);
  assert.deepStrictEqual(
    bob.messages.find(m => m.type === 'folders').folders, []);
});

test('不能改名/删除/移动别人的文件夹', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  const bob = fakeBrowser(relay, BOB);

  for (const msg of [
    { type: 'rename_folder', machineId: 'm1', folderId: 'alice-f', newName: 'x' },
    { type: 'delete_folder', machineId: 'm1', folderId: 'alice-f' },
    { type: 'move_folder', machineId: 'm1', folderId: 'alice-f', parentId: null },
  ]) {
    machine.sent.length = 0;
    bob.messages.length = 0;
    relay.handleBrowserMessage(bob.id, JSON.stringify(msg));
    assert.strictEqual(machine.sent.length, 0, `${msg.type} 不该透传到开发机`);
    assert.ok(bob.messages.some(m => m.type === 'folder_error'), `${msg.type} 应回 folder_error`);
  }
  assert.strictEqual(owners.getFolderOwner('m1', 'alice-f'), 'alice');
});

test('不能把自己的文件夹挂到别人的文件夹下', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setFolderOwner('m1', 'bob-f', 'bob');
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'move_folder', machineId: 'm1', folderId: 'bob-f', parentId: 'alice-f',
  }));

  assert.strictEqual(machine.sent.length, 0);
  assert.ok(bob.messages.some(m => m.type === 'folder_error'));
});

test('不能在别人的文件夹下新建子文件夹', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  const bob = fakeBrowser(relay, BOB);

  const sent = createFolder(relay, bob, machine, { parentId: 'alice-f' });

  assert.strictEqual(sent, null);
  assert.ok(bob.messages.some(m => m.type === 'folder_error'));
});

test('不能把自己的会话塞进别人的文件夹', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'bob-sess', 'bob');
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'move_session', machineId: 'm1', sessionId: 'bob-sess', folderId: 'alice-f',
  }));

  assert.strictEqual(machine.sent.length, 0);
  assert.ok(bob.messages.some(m => m.type === 'folder_error'));
});

test('移动自己的会话到自己的文件夹 / 根级正常放行', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'bob-sess', 'bob');
  owners.setFolderOwner('m1', 'bob-f', 'bob');
  const bob = fakeBrowser(relay, BOB);

  machine.sent.length = 0;
  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'move_session', machineId: 'm1', sessionId: 'bob-sess', folderId: 'bob-f',
  }));
  assert.strictEqual(machine.sent.filter(m => m.type === 'move_session').length, 1);

  machine.sent.length = 0;
  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'move_session', machineId: 'm1', sessionId: 'bob-sess', folderId: null,
  }));
  assert.strictEqual(machine.sent.filter(m => m.type === 'move_session').length, 1);
});

test('delete_folder 通过鉴权后清掉归属记录', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setFolderOwner('m1', 'bob-f', 'bob');
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: 'delete_folder', machineId: 'm1', folderId: 'bob-f',
  }));

  assert.strictEqual(machine.sent.filter(m => m.type === 'delete_folder').length, 1);
  assert.strictEqual(owners.getFolderOwner('m1', 'bob-f'), null);
});

test('存量文件夹按里面会话的归属自动补登，普通用户的分组不会消失', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions', sessions: [{ sessionId: 'a-sess', folderId: 'legacy-fa' }],
  }));
  const alice = fakeBrowser(relay, ALICE);
  alice.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders', folders: [
      { id: 'legacy-fa', name: '旧分组', parentId: null },
      { id: 'legacy-empty', name: '旧空分组', parentId: null },
    ],
  }));

  assert.strictEqual(owners.getFolderOwner('m1', 'legacy-fa'), 'alice');
  assert.strictEqual(owners.getFolderOwner('m1', 'legacy-empty'), null, '空文件夹判不出归属，留作无主');
  const ids = alice.messages.find(m => m.type === 'folders').folders.map(f => f.id);
  assert.deepStrictEqual(ids, ['legacy-fa']);
});

test('补登不覆盖已登记的归属', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  owners.setFolderOwner('m1', 'f', 'bob');   // 已是 bob 的，里面却有 alice 的会话
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'active_sessions', sessions: [{ sessionId: 'a-sess', folderId: 'f' }],
  }));
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders', folders: [{ id: 'f', name: 'x', parentId: null }],
  }));

  assert.strictEqual(owners.getFolderOwner('m1', 'f'), 'bob');
});

test('管理员隐藏他人会话时也看不到他人的文件夹', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  owners.setFolderOwner('m1', 'admin-f', 'admin');
  const admin = fakeBrowser(relay, ADMIN);
  hideOthers(relay, admin);
  admin.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders', folders: [
      { id: 'alice-f', name: 'alice的', parentId: null },
      { id: 'admin-f', name: '我的', parentId: null },
      { id: 'legacy', name: '无主的', parentId: null },
    ],
  }));

  const ids = admin.messages.find(m => m.type === 'folders').folders.map(f => f.id).sort();
  assert.deepStrictEqual(ids, ['admin-f', 'legacy']);
});

test('存量空子文件夹继承父文件夹已登记的归属（补登要看整棵树）', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setFolderOwner('m1', 'alice-root', 'alice');   // 已登记
  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'folders', folders: [
      { id: 'alice-root', name: 'alice的', parentId: null },
      { id: 'empty-child', name: '空子文件夹', parentId: 'alice-root' },
      { id: 'loose', name: '游离空文件夹', parentId: null },
    ],
  }));

  assert.strictEqual(owners.getFolderOwner('m1', 'empty-child'), 'alice');
  assert.strictEqual(owners.getFolderOwner('m1', 'loose'), null);
});

// ── 收口机制本身的防回归 ────────────────────────────────────

test('未在策略表登记的浏览器消息一律丢弃（默认拒绝，不是默认放行）', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  const bob = fakeBrowser(relay, BOB);
  machine.sent.length = 0;
  bob.messages.length = 0;

  relay.handleBrowserMessage(bob.id, JSON.stringify({
    type: '未来新增的消息类型', machineId: 'm1', sessionId: 'a-sess',
  }));

  assert.strictEqual(machine.sent.length, 0);
  assert.strictEqual(bob.messages.length, 0);
});

test('pty_data 原文转发，不重新序列化', () => {
  const relay = new RelayServer();
  fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  relay.handleBrowserMessage(alice.id, JSON.stringify({
    type: 'pty_attach', machineId: 'm1', sessionId: 'a-sess',
  }));
  alice.raw.length = 0;

  const raw = JSON.stringify({ type: 'pty_data', sessionId: 'a-sess', data: 'aGVsbG8=' });
  relay.handleMachineMessage('m1', raw);

  assert.deepStrictEqual(alice.raw, [raw]);
});

test('发往浏览器的数据只有 _sendTo 一个出口（漏过滤就是从分支里漏的）', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../relay.js'), 'utf-8');
  const start = src.indexOf('  _sendTo(browser');
  assert.ok(start > 0, '找不到 _sendTo 定义，本断言需要跟着改');
  const end = src.indexOf('\n  }\n', start);
  const outside = src.slice(0, start) + src.slice(end);
  assert.ok(!/browser\.ws\.send\(/.test(outside),
    '_sendTo 之外出现了直接发往浏览器的 ws.send —— 那里的投影/可见性一定会被漏掉');
});

// ── 终端尺寸协商 + 观众引用计数 ──────────────────────────────

/** 让某浏览器成为会话观众并声明尺寸 */
function viewSession(relay, browser, { cols, rows, sessionId = 'a-sess', machineId = 'm1' }) {
  relay.handleBrowserMessage(browser.id, JSON.stringify({
    type: 'open_terminal', machineId, sessionId, cols, rows,
  }));
}

function resizes(machine) {
  return machine.sent.filter(m => m.type === 'pty_resize').map(m => `${m.cols}x${m.rows}`);
}

test('容器没布局好时算出的假尺寸被丢弃，不会把 tmux 窗口压小', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  viewSession(relay, alice, { cols: 180, rows: 45 });
  machine.sent.length = 0;

  relay.handleBrowserMessage(alice.id, JSON.stringify({
    type: 'terminal_resize', machineId: 'm1', sessionId: 'a-sess', cols: 10, rows: 6,
  }));

  assert.deepStrictEqual(resizes(machine), [], '10x6 这种假尺寸不该下发');
});

test('open_terminal 的假尺寸也不参与协商（退回默认，不压小别人）', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  machine.sent.length = 0;

  viewSession(relay, alice, { cols: 10, rows: 6 });

  const open = machine.sent.find(m => m.type === 'pty_open');
  assert.strictEqual(open.cols, 220);
  assert.strictEqual(open.rows, 50);
});

test('多个观众看同一会话时取最小尺寸，不再谁后发谁生效', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const phone = fakeBrowser(relay, ALICE);
  const desktop = fakeBrowser(relay, ALICE);

  viewSession(relay, phone, { cols: 60, rows: 20 });
  machine.sent.length = 0;
  viewSession(relay, desktop, { cols: 200, rows: 50 });

  const open = machine.sent.find(m => m.type === 'pty_open');
  assert.deepStrictEqual([open.cols, open.rows], [60, 20], '后来的大窗口不能把手机端顶掉');

  machine.sent.length = 0;
  relay.handleBrowserMessage(desktop.id, JSON.stringify({
    type: 'terminal_resize', machineId: 'm1', sessionId: 'a-sess', cols: 240, rows: 60,
  }));
  assert.deepStrictEqual(resizes(machine), [], '大的一方变化不影响最小值，不必打断排版');
});

test('小尺寸观众离开后，窗口长回剩下观众的尺寸', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const phone = fakeBrowser(relay, ALICE);
  const desktop = fakeBrowser(relay, ALICE);
  viewSession(relay, phone, { cols: 60, rows: 20 });
  viewSession(relay, desktop, { cols: 200, rows: 50 });
  machine.sent.length = 0;

  relay.handleBrowserMessage(phone.id, JSON.stringify({
    type: 'close_terminal', machineId: 'm1', sessionId: 'a-sess',
  }));

  assert.deepStrictEqual(resizes(machine), ['200x50']);
  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 0,
    '还有人在看，不能断 PTY');
});

test('切到后台的面板撤销尺寸声明后，窗口长回前台观众的尺寸', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const phone = fakeBrowser(relay, ALICE);
  const desktop = fakeBrowser(relay, ALICE);
  viewSession(relay, phone, { cols: 60, rows: 20 });
  viewSession(relay, desktop, { cols: 200, rows: 50 });
  machine.sent.length = 0;

  // 手机那边切到别的 tab：面板还挂着（仍是观众），但不该再拿旧尺寸当天花板
  relay.handleBrowserMessage(phone.id, JSON.stringify({
    type: 'release_size', machineId: 'm1', sessionId: 'a-sess',
  }));

  assert.deepStrictEqual(resizes(machine), ['200x50']);
  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 0,
    'release_size 不是关闭，PTY 不能断');
  assert.strictEqual(relay._viewerCount('m1', 'a-sess'), 2, '观众身份必须保留');
});

test('release_size 之后前台观众放大能生效（缩小容易放大难的棘轮被打断）', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const bg = fakeBrowser(relay, ALICE);
  const fg = fakeBrowser(relay, ALICE);
  viewSession(relay, bg, { cols: 120, rows: 40 });
  viewSession(relay, fg, { cols: 120, rows: 40 });
  relay.handleBrowserMessage(bg.id, JSON.stringify({
    type: 'release_size', machineId: 'm1', sessionId: 'a-sess',
  }));
  machine.sent.length = 0;

  relay.handleBrowserMessage(fg.id, JSON.stringify({
    type: 'terminal_resize', machineId: 'm1', sessionId: 'a-sess', cols: 200, rows: 50,
  }));

  assert.deepStrictEqual(resizes(machine), ['200x50'], '后台面板不该再压着前台放大');
});

test('declare 重新宣告尺寸会穿透去重（切回 tab 一定把窗口拉正）', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  viewSession(relay, alice, { cols: 180, rows: 45 });
  machine.sent.length = 0;

  const same = { machineId: 'm1', sessionId: 'a-sess', cols: 180, rows: 45 };
  relay.handleBrowserMessage(alice.id, JSON.stringify({ type: 'terminal_resize', ...same }));
  assert.deepStrictEqual(resizes(machine), [], '尺寸没变的普通 resize 仍然去重');

  relay.handleBrowserMessage(alice.id, JSON.stringify({ type: 'terminal_resize', ...same, declare: true }));
  assert.deepStrictEqual(resizes(machine), ['180x45'],
    'relay 记的值未必等于 tmux 窗口的真实值，重新宣告必须能强制下发');
});

test('open_terminal 不带尺寸（面板还没显示出来）时不参与协商', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const desktop = fakeBrowser(relay, ALICE);
  const unmeasured = fakeBrowser(relay, ALICE);
  viewSession(relay, desktop, { cols: 200, rows: 50 });
  machine.sent.length = 0;

  relay.handleBrowserMessage(unmeasured.id, JSON.stringify({
    type: 'open_terminal', machineId: 'm1', sessionId: 'a-sess',
  }));

  const open = machine.sent.find(m => m.type === 'pty_open');
  assert.deepStrictEqual([open.cols, open.rows], [200, 50],
    '没量到尺寸的观众不能把窗口拽到默认值上');
  assert.deepStrictEqual(resizes(machine), []);
});

test('最后一个观众关 tab 才断 PTY', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const a = fakeBrowser(relay, ALICE);
  const b = fakeBrowser(relay, ALICE);
  viewSession(relay, a, { cols: 100, rows: 30 });
  viewSession(relay, b, { cols: 100, rows: 30 });
  machine.sent.length = 0;

  relay.handleBrowserMessage(a.id, JSON.stringify({ type: 'close_terminal', machineId: 'm1', sessionId: 'a-sess' }));
  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 0);

  relay.handleBrowserMessage(b.id, JSON.stringify({ type: 'close_terminal', machineId: 'm1', sessionId: 'a-sess' }));
  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 1);
});

test('浏览器断线自动释放观众，不再留下永远挂着的 attach 客户端', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const alice = fakeBrowser(relay, ALICE);
  viewSession(relay, alice, { cols: 120, rows: 40 });
  machine.sent.length = 0;

  relay._removeBrowser(alice.id);

  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 1);
  assert.strictEqual(relay.browsers.size, 0);
});

test('管理员切到隐藏时，他人会话的 PTY 也随之释放', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'alice-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'alice-sess' }]);
  const admin = fakeBrowser(relay, ADMIN);
  viewSession(relay, admin, { cols: 120, rows: 40, sessionId: 'alice-sess' });
  machine.sent.length = 0;

  hideOthers(relay, admin);

  assert.strictEqual(machine.sent.filter(m => m.type === 'pty_close').length, 1);
});

test('补屏快照定向回请求方，不插进其他观众正在渲染的画面', () => {
  const relay = new RelayServer();
  const machine = fakeMachine(relay);
  owners.setOwner('m1', 'a-sess', 'alice');
  relay.updateSessions('m1', [{ id: 'a-sess' }]);
  const first = fakeBrowser(relay, ALICE);
  const second = fakeBrowser(relay, ALICE);
  viewSession(relay, first, { cols: 120, rows: 40 });
  viewSession(relay, second, { cols: 120, rows: 40 });
  // 开发机在 pty_open 里收到了请求方的 browserId
  const open = machine.sent.filter(m => m.type === 'pty_open').pop();
  assert.strictEqual(open.browserId, second.id);
  first.messages.length = 0; second.messages.length = 0;

  relay.handleMachineMessage('m1', JSON.stringify({
    type: 'pty_data', sessionId: 'a-sess', browserId: second.id, data: 'aGlzdG9yeQ==',
  }));

  assert.strictEqual(second.messages.filter(m => m.type === 'pty_data').length, 1);
  assert.strictEqual(first.messages.filter(m => m.type === 'pty_data').length, 0);
});
