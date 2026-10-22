const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-sharing-'));
process.env.DB_PATH = path.join(tempDir, 'users.db');
const { app } = require('../index');
const { getDb, generateToken } = require('../auth');
const owners = require('../session-owners');
const { RelayServer } = require('../relay');
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('共享 API 保留归属、只授权目标用户，持久化并即时撤销终端访问', async t => {
  const db = await getDb();
  for (const username of ['alice', 'bob', 'charlie']) {
    db.run('INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)', [username, 'unused', 1, 'user']);
  }
  await owners.init();
  owners.setOwner('m1', '梁文峰', 'alice');
  owners.setOwner('m1', 'private', 'alice');
  const relay = new RelayServer();
  global.relayServer = relay;
  const forwarded = [];
  relay.registerMachine('m1', { readyState: 1, send: raw => forwarded.push(JSON.parse(raw)) });
  relay.updateSessions('m1', [{ sessionId: '梁文峰' }, { sessionId: 'private' }]);
  const bobMessages = [];
  const bobId = relay._addBrowser({ readyState: 1, send: raw => bobMessages.push(JSON.parse(raw)) }, { username: 'bob', role: 'user' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/session-shares`;
  const target = { machineId: 'm1', sessionId: '梁文峰' };
  async function request(actor, method, fields = {}) {
    const payload = { ...target, ...fields };
    const res = await fetch(method === 'GET' ? `${base}?${new URLSearchParams(payload)}` : base, {
      method,
      headers: { Authorization: `Bearer ${generateToken({ username: actor, role: actor === 'admin' ? 'admin' : 'user' })}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json() };
  }
  assert.equal((await request('bob', 'GET')).status, 403);
  assert.equal((await request('alice', 'POST', { username: 'missing' })).status, 404);
  assert.equal((await request('admin', 'POST', { username: 'bob', sessionId: 'missing' })).status, 404);
  assert.equal((await request('alice', 'POST', { username: 'bob' })).status, 200);
  await request('alice', 'POST', { username: 'bob' }); // 重复共享不重复登记
  const state = await request('alice', 'GET');
  assert.deepEqual(state.body.users, ['bob']);
  assert.equal(state.body.owner, 'alice');
  assert.deepEqual(state.body.availableUsers, ['alice', 'bob', 'charlie']);
  assert.equal((await request('bob', 'POST', { username: 'charlie' })).status, 403);
  const active = bobMessages.filter(m => m.type === 'active_sessions').at(-1);
  assert.deepEqual(active.sessions.map(s => s.sessionId), ['梁文峰']);
  assert.equal(active.sessions[0].sharedBy, 'alice');
  assert.equal(active.sessions[0].canShare, false);
  assert.equal(owners.canAccess({ username: 'charlie' }, 'm1', '梁文峰'), false);
  const send = message => relay.handleBrowserMessage(bobId, JSON.stringify({ ...target, ...message }));
  send({ type: 'open_terminal', cols: 80, rows: 24 });
  assert.ok(forwarded.some(m => m.type === 'pty_open' && m.sessionId === '梁文峰'));
  send({ type: 'terminal_input', data: '\x1b[1;2D' });
  assert.ok(forwarded.some(m => m.type === 'pty_input' && m.data === '\x1b[1;2D'));
  relay.handleMachineMessage('m1', JSON.stringify({ type: 'pty_data', sessionId: '梁文峰', data: 'output' }));
  assert.ok(bobMessages.some(m => m.type === 'pty_data' && m.data === 'output'));

  const restored = execFileSync(process.execPath, ['-e', `const o=require('./session-owners'); o.init().then(()=>console.log(JSON.stringify({owner:o.getOwner('m1','梁文峰'),shares:o.getShares('m1','梁文峰')})))`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(restored), { owner: 'alice', shares: ['bob'] });

  assert.equal((await request('bob', 'DELETE', { username: 'bob' })).status, 403);
  assert.equal((await request('alice', 'DELETE', { username: 'bob' })).status, 200);
  assert.equal(relay.browsers.get(bobId).watching.size, 0);
  assert.equal(bobMessages.filter(m => m.type === 'active_sessions').at(-1).sessions.length, 0);
  assert.ok(bobMessages.some(m => m.type === 'pty_error' && m.error === '无权访问该会话'));
  forwarded.length = 0;
  bobMessages.length = 0;
  send({ type: 'terminal_input', data: 'forbidden' });
  relay.handleMachineMessage('m1', JSON.stringify({ type: 'pty_data', sessionId: '梁文峰', data: 'private' }));
  assert.equal(forwarded.some(m => m.type === 'pty_input'), false);
  assert.equal(bobMessages.some(m => m.type === 'pty_data'), false);
  await owners.init();
  assert.deepEqual(owners.getShares('m1', '梁文峰'), []);

  owners.addShare('m1', '梁文峰', 'bob');
  relay.handleMachineMessage('m1', JSON.stringify({ type: 'session_renamed', oldSessionId: '梁文峰', newSessionId: 'renamed' }));
  await owners.init();
  assert.deepEqual(owners.getShares('m1', '梁文峰'), []);
  assert.deepEqual(owners.getShares('m1', 'renamed'), ['bob']);
  assert.equal(owners.getOwner('m1', 'renamed'), 'alice');
  relay.handleMachineMessage('m1', JSON.stringify({ type: 'session_deleted', sessionId: 'renamed' }));
  await owners.init();
  assert.deepEqual(owners.getShares('m1', 'renamed'), []);
  assert.equal(owners.getOwner('m1', 'renamed'), null);
});
