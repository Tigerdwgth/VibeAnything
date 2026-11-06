// packages/server/tests/relay-security.test.js
// relay 安全边界的端到端行为：真 HTTP 服务、真 WebSocket 握手（浏览器 JWT / 开发机 token）、
// 真 sql.js 临时库，没有 mock。开发机一端由测试自己扮演 —— 它就是一条带 x-machine-token 的 WS 连接，
// 收到什么、回什么都走线上同一套协议。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-relay-security-'));
// auth.js / relay.js 在模块顶层读这几个变量，必须在 require 之前设好
process.env.DB_PATH = path.join(TMP, 'users.db');
process.env.JWT_SECRET = 'relay-security-test-secret';
process.env.MACHINE_TOKENS = 'legacy-token';

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

let server, port, relay, owners, machineTokens;
let tokens = {};          // username → JWT
let boundToken;           // 台账机器 bound1 的 token
const sockets = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到 list 里出现满足 pred 的消息；超时报错而不是挂死。 */
async function waitFor(list, pred, what, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = list.find(pred);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error(`超时：${what}`);
}

/** 等连接关闭并返回关闭码；该断没断时报错而不是让整个测试文件挂死。 */
function closedWithin(ws, what, ms = 2000) {
  return Promise.race([ws.closed, sleep(ms).then(() => { throw new Error(`超时：${what}`); })]);
}

function track(ws) {
  ws.msgs = [];
  ws.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  ws.on('error', () => {});
  sockets.push(ws);
  return ws;
}

async function openBrowser(username) {
  const ws = track(new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(tokens[username])}`));
  await waitFor(ws.msgs, (m) => m.type === 'whoami', `${username} 握手`);
  return ws;
}

/** 扮演开发机：握手后像 daemon 一样先报一轮 active_sessions。sessions = null 表示还没报。 */
async function openMachine(token, machineId, sessions = []) {
  const ws = track(new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { 'x-machine-token': token, 'x-machine-id': machineId },
  }));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('close', reject); });
  if (sessions) ws.send(JSON.stringify({ type: 'active_sessions', sessions }));
  await sleep(50);
  return ws;
}

const send = (ws, msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));

function request(method, pathname, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    // 处理器挂掉不回响应时要报错，而不是让测试文件一直等下去
    r.setTimeout(2000, () => r.destroy(new Error(`超时：${method} ${pathname} 无响应`)));
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const { app } = require('../index.js');
  const { RelayServer } = require('../relay.js');
  const auth = require('../auth.js');
  owners = require('../session-owners.js');
  machineTokens = require('../machine-tokens.js');
  await auth.createUser('admin', 'admin-pass', 'admin');
  await auth.createUser('alice', 'alice-pass');
  await auth.createUser('bob', 'bob-pass');
  await owners.init();
  await machineTokens.init();
  const invite = machineTokens.createInvite({ machineId: 'bound1' });
  boundToken = machineTokens.redeemInvite(invite.code).machineToken;

  server = http.createServer(app);
  relay = new RelayServer();
  global.relayServer = relay;
  relay.attachToHttpServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  for (const [u, p] of [['admin', 'admin-pass'], ['alice', 'alice-pass'], ['bob', 'bob-pass']]) {
    const res = await request('POST', '/api/login', { body: { username: u, password: p } });
    tokens[u] = res.body.token;
  }
});

after(() => {
  for (const s of sockets) s.terminate();
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 1. open_terminal 认领 ───────────────────────────────────

test('已有主人的会话：机器离线时别人 open_terminal 被拒绝，归属不变，机器回来后仍是原主', async () => {
  owners.setOwner('off1', 'bob-uuid-1', 'bob');
  const alice = await openBrowser('alice');
  send(alice, { type: 'open_terminal', machineId: 'off1', sessionId: 'bob-uuid-1', cols: 100, rows: 30 });
  await waitFor(alice.msgs, (m) => m.type === 'pty_error' && m.sessionId === 'bob-uuid-1', 'alice 被拒');
  assert.equal(owners.getOwner('off1', 'bob-uuid-1'), 'bob');

  const machine = await openMachine('legacy-token', 'off1', [{ sessionId: 'bob-uuid-1' }]);
  send(alice, { type: 'terminal_input', machineId: 'off1', sessionId: 'bob-uuid-1', data: 'eA==' });
  await sleep(100);
  assert.equal(machine.msgs.some((m) => m.type === 'pty_input'), false, 'alice 的输入不能到达 bob 的会话');
  alice.close(); machine.close();
});

test('机器刚连上、还没报 active_sessions 时不认领：普通用户被拒，台账不落', async () => {
  const machine = await openMachine('legacy-token', 'fresh1', null);
  const alice = await openBrowser('alice');
  send(alice, { type: 'open_terminal', machineId: 'fresh1', sessionId: 'main', cols: 100, rows: 30 });
  await waitFor(alice.msgs, (m) => m.type === 'pty_error' && m.sessionId === 'main', 'alice 被拒');
  assert.equal(owners.getOwner('fresh1', 'main'), null);
  assert.equal(machine.msgs.some((m) => m.type === 'pty_open'), false);

  // 报过列表之后，同一个 id 才按新建会话认领
  send(machine, { type: 'active_sessions', sessions: [] });
  await sleep(50);
  send(alice, { type: 'open_terminal', machineId: 'fresh1', sessionId: 'new-claude-1', cols: 100, rows: 30 });
  await waitFor(machine.msgs, (m) => m.type === 'pty_open' && m.sessionId === 'new-claude-1', '新建会话下发');
  assert.equal(owners.getOwner('fresh1', 'new-claude-1'), 'alice');
  alice.close(); machine.close();
});

test('会落到别人 tmux 窗口上的新 sessionId（cc- 前缀 / 清洗后会变的字符 / 超长）不认领', async () => {
  owners.setOwner('alias1', 'bob-uuid-2', 'bob');
  const machine = await openMachine('legacy-token', 'alias1', [{ sessionId: 'bob-uuid-2' }]);
  const alice = await openBrowser('alice');
  const aliases = ['cc-bob-uuid-2', 'bob-uuid-2.', 'bob-uuid-2 ', 'bob-uuid-2-', 'x'.repeat(49)];
  for (const sessionId of aliases) {
    send(alice, { type: 'open_terminal', machineId: 'alias1', sessionId, cols: 100, rows: 30 });
    await waitFor(alice.msgs, (m) => m.type === 'pty_error' && m.sessionId === sessionId, `拒绝 ${sessionId}`);
    assert.equal(owners.getOwner('alias1', sessionId), null);
  }
  assert.equal(machine.msgs.some((m) => m.type === 'pty_open'), false);
  alice.close(); machine.close();
});

test('认领新会话时清掉该 key 上残留的共享名单', async () => {
  owners.addShare('claim1', 'new-codex-9', 'bob');   // 管理员共享过一个后来消失的无主会话
  const machine = await openMachine('legacy-token', 'claim1', []);
  const alice = await openBrowser('alice');
  send(alice, { type: 'open_terminal', machineId: 'claim1', sessionId: 'new-codex-9', cols: 100, rows: 30 });
  await waitFor(machine.msgs, (m) => m.type === 'pty_open', '新建会话下发');
  assert.equal(owners.getOwner('claim1', 'new-codex-9'), 'alice');
  assert.deepEqual(owners.getShares('claim1', 'new-codex-9'), []);
  alice.close(); machine.close();
});

test('delete_session 校验归属：别人的会话被拒，自己的转发且回执只给自己', async () => {
  owners.setOwner('del1', 'bob-hist', 'bob');
  const machine = await openMachine('legacy-token', 'del1', []);
  const alice = await openBrowser('alice');
  const bob = await openBrowser('bob');
  send(alice, { type: 'delete_session', machineId: 'del1', sessionId: 'bob-hist' });
  await waitFor(alice.msgs, (m) => m.type === 'pty_error' && m.sessionId === 'bob-hist', 'alice 被拒');
  assert.equal(machine.msgs.some((m) => m.type === 'delete_session'), false);

  send(bob, { type: 'delete_session', machineId: 'del1', sessionId: 'bob-hist' });
  await waitFor(machine.msgs, (m) => m.type === 'delete_session', 'bob 的删除下发');
  send(machine, { type: 'session_deleted', sessionId: 'bob-hist' });
  await waitFor(bob.msgs, (m) => m.type === 'session_deleted', 'bob 收到回执');
  await sleep(50);
  assert.equal(alice.msgs.some((m) => m.type === 'session_deleted'), false);
  assert.equal(owners.getOwner('del1', 'bob-hist'), null);
  alice.close(); bob.close(); machine.close();
});

// ── 2. 文件浏览回执定向 + 历史会话按归属过滤 ─────────────────

test('read_file / list_dir 的回执只发给发起请求的浏览器', async () => {
  const machine = await openMachine('legacy-token', 'fs1', []);
  const alice = await openBrowser('alice');
  const bob = await openBrowser('bob');
  const admin = await openBrowser('admin');

  send(bob, { type: 'read_file', machineId: 'fs1', path: '/home/bob/notes.md' });
  send(bob, { type: 'list_dir', machineId: 'fs1', path: '/home/bob' });
  await waitFor(machine.msgs, (m) => m.type === 'list_dir', '请求下发');
  assert.deepEqual(machine.msgs.find((m) => m.type === 'read_file'), { type: 'read_file', path: '/home/bob/notes.md' });
  send(machine, { type: 'file_content', path: '/home/bob/notes.md', content: 'BOB-SECRET' });
  send(machine, { type: 'dir_entries', path: '/home/bob', entries: [{ name: 'private', path: '/home/bob/private' }] });

  await waitFor(bob.msgs, (m) => m.type === 'file_content' && m.content === 'BOB-SECRET', 'bob 收到文件');
  await waitFor(bob.msgs, (m) => m.type === 'dir_entries' && m.machineId === 'fs1', 'bob 收到目录');
  await sleep(50);
  for (const other of [alice, admin]) {
    assert.equal(other.msgs.some((m) => m.type === 'file_content' || m.type === 'dir_entries'), false);
  }
  // 没人在等的回执（重复的、或 HTTP 接口发起的）直接丢弃
  bob.msgs.length = 0;
  send(machine, { type: 'file_content', path: '/home/bob/notes.md', content: 'again' });
  await sleep(50);
  assert.equal(bob.msgs.some((m) => m.type === 'file_content'), false);
  alice.close(); bob.close(); admin.close(); machine.close();
});

test('session_history 按会话归属过滤，管理员看全部', async () => {
  owners.setOwner('hist1', 'uuid-alice', 'alice');
  owners.setOwner('hist1', 'uuid-bob', 'bob');
  const machine = await openMachine('legacy-token', 'hist1', []);
  const alice = await openBrowser('alice');
  const bob = await openBrowser('bob');
  const admin = await openBrowser('admin');
  for (const b of [alice, bob, admin]) b.msgs.length = 0;
  send(machine, {
    type: 'session_history',
    sessions: [
      { sessionId: 'uuid-alice', cwd: '/a', summary: 'alice 的第一句' },
      { sessionId: 'uuid-bob', cwd: '/b', summary: 'bob 的第一句' },
      { sessionId: 'uuid-nobody', cwd: '/c', summary: '无主' },
    ],
  });
  const ids = async (b, who) => (await waitFor(b.msgs, (m) => m.type === 'session_history', who)).sessions.map((s) => s.sessionId);
  assert.deepEqual(await ids(alice, 'alice'), ['uuid-alice']);
  assert.deepEqual(await ids(bob, 'bob'), ['uuid-bob']);
  assert.deepEqual(await ids(admin, 'admin'), ['uuid-alice', 'uuid-bob', 'uuid-nobody']);
  alice.close(); bob.close(); admin.close(); machine.close();
});

// ── 3. JWT 密钥 ─────────────────────────────────────────────

test('没设 JWT_SECRET：首次生成 0600 密钥文件并跨进程复用，旧的公开默认串签的票无效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-jwt-secret-'));
  try {
    const env = { ...process.env, DB_PATH: path.join(dir, 'users.db') };
    delete env.JWT_SECRET;
    const run = (code) => execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }).trim();
    const signed = run(`const a=require('./auth');a.getDb().then(()=>console.log(a.generateToken({id:1,username:'u',role:'admin'})))`);
    const secretFile = path.join(dir, 'jwt-secret');
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(secretFile, 'utf8').trim().length >= 64);

    const forged = jwt.sign({ id: 9, username: 'u', role: 'admin', tv: 0 }, 'change-me-in-production');
    const verdict = JSON.parse(run(`const a=require('./auth');a.getDb().then(()=>console.log(JSON.stringify({
      own: !!a.verifyToken(${JSON.stringify(signed)}), forged: !!a.verifyToken(${JSON.stringify(forged)}) })))`));
    assert.deepEqual(verdict, { own: true, forged: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. HTTP 字段类型 + async 异常兜底 ────────────────────────

test('登录等接口字段类型不对回 400，async 处理器抛错回 500，进程不退出', async () => {
  for (const body of [{ username: {}, password: 'x' }, { username: 'alice', password: 123 }, { username: ['alice'], password: 'alice-pass' }]) {
    assert.equal((await request('POST', '/api/login', { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await request('POST', '/api/change-password', { token: tokens.alice, body: { oldPassword: 1, newPassword: 'abcdefg' } })).status, 400);
  assert.equal((await request('POST', '/api/admin/users', { token: tokens.admin, body: { username: { $: 1 }, password: 'abcdefg' } })).status, 400);
  assert.equal((await request('POST', '/api/session-owners', { token: tokens.admin, body: { machineId: 'm', sessionId: ['s'], owner: 'bob' } })).status, 400);

  // 票是本服务签的、但载荷里 username 是对象：查库时 sql.js 绑定抛错
  const odd = jwt.sign({ id: 1, username: {}, role: 'user' }, process.env.JWT_SECRET);
  assert.equal((await request('GET', '/api/me', { token: odd })).status, 500);

  assert.equal((await request('POST', '/api/login', { body: { username: 'alice', password: 'alice-pass' } })).status, 200, '服务还活着');
});

// ── 5. WS 畸形消息 ──────────────────────────────────────────

test('畸形 WS 消息被丢弃：非对象、关键字段非字符串都不会打崩 relay，连接照常可用', async () => {
  const machine = await openMachine('legacy-token', 'junk1', []);
  const alice = await openBrowser('alice');
  for (const raw of ['null', '[]', '"x"', '7', '{"type":{}}', '{"type":"constructor","machineId":"junk1"}']) send(alice, raw);
  send(alice, { type: 'open_terminal', machineId: {}, sessionId: 'x' });
  send(alice, { type: 'open_terminal', machineId: 'junk1', sessionId: ['x'] });
  send(alice, { type: 'create_folder', machineId: ['junk1'], parentId: null, name: 'f' });
  send(alice, { type: 'create_folder', machineId: 'junk1', parentId: { a: 1 }, name: 'f' });
  send(machine, 'null');
  send(machine, '[1]');
  await sleep(100);
  assert.equal(machine.msgs.some((m) => m.type === 'pty_open' || m.type === 'create_folder'), false);

  send(alice, { type: 'open_terminal', machineId: 'junk1', sessionId: 'new-claude-2', cols: 100, rows: 30 });
  await waitFor(machine.msgs, (m) => m.type === 'pty_open' && m.sessionId === 'new-claude-2', '合法消息照常转发');
  send(alice, { type: 'terminal_input', machineId: 'junk1', sessionId: 'new-claude-2', data: { evil: true } });
  send(alice, { type: 'terminal_input', machineId: 'junk1', sessionId: 'new-claude-2', data: 'aGk=' });
  await waitFor(machine.msgs, (m) => m.type === 'pty_input', '合法输入到达');
  assert.deepEqual(machine.msgs.filter((m) => m.type === 'pty_input').map((m) => m.data), ['aGk=']);
  alice.close(); machine.close();
});

// ── 6. 旧全局 token 冒充已登记机器 ───────────────────────────

test('旧全局 token 报已登记机器的名字被拒绝，真机连接不受影响', async () => {
  const real = await openMachine(boundToken, 'whatever', []);
  const fake = track(new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { 'x-machine-token': 'legacy-token', 'x-machine-id': 'bound1' },
  }));
  assert.equal(await closedWithin(fake, '冒充连接被拒'), 4001);
  assert.equal(relay.getMachine('bound1')?.ws.readyState, 1);
  assert.equal(real.readyState, WebSocket.OPEN);

  const admin = await openBrowser('admin');
  send(admin, { type: 'open_terminal', machineId: 'bound1', sessionId: 'new-claude-3', cols: 100, rows: 30 });
  await waitFor(real.msgs, (m) => m.type === 'pty_open', '真机收到下发');
  admin.close(); real.close();
});

// ── 7. 换 token 后踢掉旧连接 ─────────────────────────────────

test('用邀请码给已登记机器换 token：旧凭据建立的连接被踢下线，旧 token 再也连不上', async () => {
  const old = await openMachine(boundToken, 'bound1', []);
  const invite = await request('POST', '/api/machines/invite', { token: tokens.admin, body: { machineId: 'bound1' } });
  const joined = await request('POST', '/api/machines/join', { body: { code: invite.body.code } });
  assert.equal(joined.status, 200);
  assert.equal(await closedWithin(old, '旧连接被踢'), 4003);

  const retry = track(new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-machine-token': boundToken } }));
  assert.equal(await closedWithin(retry, '旧 token 被拒'), 4001);
  const fresh = await openMachine(joined.body.machineToken, 'bound1', []);
  assert.equal(relay.getMachine('bound1')?.ws.readyState, 1);
  fresh.close();
});

// ── 8. 历史会话归属：由 hook_event 推断 UUID 的主人 ──────────

/** 机器推一份历史列表，返回某浏览器收到的那份里的 sessionId。 */
async function historyIds(machine, browser, sessions, who) {
  browser.msgs.length = 0;
  send(machine, { type: 'session_history', sessions });
  return (await waitFor(browser.msgs, (m) => m.type === 'session_history', who)).sessions.map((s) => s.sessionId);
}

test('新建会话 → 收到 hook_event → 该 UUID 的历史对主人可见、对他人不可见', async () => {
  const machine = await openMachine('legacy-token', 'hook1', []);
  const alice = await openBrowser('alice');
  const bob = await openBrowser('bob');
  send(alice, { type: 'open_terminal', machineId: 'hook1', sessionId: 'new-claude-100', cols: 100, rows: 30 });
  await waitFor(machine.msgs, (m) => m.type === 'pty_open', '新建会话下发');
  const history = [{ sessionId: 'aaaa-uuid-1', cwd: '/a', summary: 'alice 的第一句' }];
  assert.deepEqual(await historyIds(machine, alice, history, 'alice 推断前'), []);

  // claude 在 alice 的会话里跑起来，hook 报出 UUID 与它所在的 tmux 窗口（dashboard 建的带 cc- 前缀）
  send(machine, { type: 'hook_event', hookEvent: 'UserPromptSubmit', hookState: 'running', sessionId: 'aaaa-uuid-1', tmuxSession: 'cc-new-claude-100' });
  await waitFor(alice.msgs, (m) => m.type === 'hook_event', 'alice 收到 hook');
  assert.equal(owners.getOwner('hook1', 'aaaa-uuid-1'), 'alice');
  assert.deepEqual(await historyIds(machine, alice, history, 'alice'), ['aaaa-uuid-1']);
  assert.deepEqual(await historyIds(machine, bob, history, 'bob'), []);
  assert.equal(bob.msgs.some((m) => m.type === 'hook_event'), false);
  alice.close(); bob.close(); machine.close();
});

test('hook_event 推断不改已有归属、不凭空认领，手动建的 tmux 名（无 cc-）也能对上', async () => {
  owners.setOwner('hook2', 'main', 'bob');              // 手动建的 tmux 会话，sessionId 就是 tmux 名
  owners.setOwner('hook2', 'uuid-owned', 'admin');
  const machine = await openMachine('legacy-token', 'hook2', [{ sessionId: 'main' }]);
  send(machine, { type: 'hook_event', hookState: 'running', sessionId: 'uuid-main', tmuxSession: 'main' });
  send(machine, { type: 'hook_event', hookState: 'running', sessionId: 'uuid-owned', tmuxSession: 'main' });
  send(machine, { type: 'hook_event', hookState: 'running', sessionId: 'uuid-ghost', tmuxSession: 'cc-nobody-registered' });
  send(machine, { type: 'hook_event', hookState: 'running', sessionId: 'uuid-other-machine', tmuxSession: 'main', machineId: 'hook1' });
  await sleep(100);
  assert.equal(owners.getOwner('hook2', 'uuid-main'), 'bob');
  assert.equal(owners.getOwner('hook2', 'uuid-owned'), 'admin', '已有主的 UUID 不改归属');
  assert.equal(owners.getOwner('hook2', 'uuid-ghost'), null, 'tmux 对不上台账就不认领');
  // machineId 以连接为准，消息里自报的不作数：登记在 hook2，不会落到 hook1
  assert.equal(owners.getOwner('hook1', 'uuid-other-machine'), null);
  assert.equal(owners.getOwner('hook2', 'uuid-other-machine'), 'bob');
  machine.close();
});

test('浏览器发来的 hook_event 被丢弃，不能借它认领别人的 UUID', async () => {
  owners.setOwner('hook3', 'new-claude-7', 'alice');
  const machine = await openMachine('legacy-token', 'hook3', [{ sessionId: 'new-claude-7' }]);
  const bob = await openBrowser('bob');
  send(bob, { type: 'hook_event', machineId: 'hook3', sessionId: 'uuid-victim', tmuxSession: 'cc-new-claude-7' });
  owners.setOwner('hook3', 'new-bob-1', 'bob');
  send(bob, { type: 'hook_event', machineId: 'hook3', sessionId: 'uuid-victim', tmuxSession: 'cc-new-bob-1' });
  await sleep(100);
  assert.equal(owners.getOwner('hook3', 'uuid-victim'), null);
  assert.equal(machine.msgs.some((m) => m.type === 'hook_event'), false);
  bob.close(); machine.close();
});
