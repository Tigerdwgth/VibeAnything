// packages/server/tests/session-refresh.test.js
// 滑动续期 + 可撤销（users.token_version）的真实行为：真 sql.js 临时库、真 jsonwebtoken、
// 真 HTTP 服务、真 WebSocket 握手，没有 mock。
//
// 起点是一个**老库**（只有 id/username/password_hash/created_at 四列）：线上库就是这么长大的，
// 上线时当场跑列迁移；空库走的是 CREATE TABLE 一次成型，测不到 ALTER TABLE 那条路。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-session-refresh-'));
// auth.js 在模块顶层把这两个读成常量，必须在 require 之前设好。
process.env.DB_PATH = path.join(TMP, 'users.db');
process.env.JWT_SECRET = 'session-refresh-test-secret';

const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

const DAY = 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

let server;
let port;
let relay;
const sockets = [];

function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function login(username, password) {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.strictEqual(res.status, 200, `登录失败：${res.raw}`);
  return res.body.token;
}

/** 造「token_version 上线之前」的库：连 role 都没有。 */
async function seedLegacyDb(users) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  for (const { username, password } of users) {
    db.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
      [username, await bcrypt.hash(password, 4), 1700000000000]);
  }
  fs.writeFileSync(process.env.DB_PATH, Buffer.from(db.export()));
  db.close();
}

/** 直接读磁盘上的库文件（不经过 auth.js 的缓存）。 */
async function readUsersFromDisk() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(process.env.DB_PATH));
  const cols = db.exec('PRAGMA table_info(users)')[0].values.map(r => r[1]);
  const rows = db.exec('SELECT username, created_at, token_version FROM users ORDER BY id')[0].values;
  db.close();
  return { cols, rows };
}

/** 连 /ws，返回 { socket, closed }；closed 在连接关闭时 resolve 关闭码。 */
function openWs(token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&ownOnly=0`);
  sockets.push(socket);
  const opened = new Promise((resolve) => socket.once('message', () => resolve(true)));
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.on('error', () => {});
  return { socket, opened, closed };
}

const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时：${what}`)), ms)),
]);

before(async () => {
  await seedLegacyDb([
    { username: 'laoyonghu', password: 'secret123' },
    { username: 'tongshi', password: 'secret456' },
  ]);
  const { app } = require('../index.js');
  const { RelayServer } = require('../relay.js');
  const { getDb } = require('../auth.js');
  await getDb();   // 与 startServer 一致：握手之前先把 token_version 载入内存
  server = http.createServer(app);
  relay = new RelayServer();
  global.relayServer = relay;
  relay.attachToHttpServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  for (const s of sockets) s.terminate();
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 迁移 ──────────────────────────────────────────────────────

test('老库补出 token_version 列，存量用户数据原样保留', async () => {
  const { cols, rows } = await readUsersFromDisk();
  assert.ok(cols.includes('token_version'));
  assert.deepStrictEqual(rows, [
    ['laoyonghu', 1700000000000, 0],
    ['tongshi', 1700000000000, 0],
  ]);
  // 旧密码哈希没动：老用户照常登录
  assert.ok(await login('laoyonghu', 'secret123'));
});

test('迁移可重复执行：第二个 auth 实例再开同一个库不会因 ADD COLUMN 重复而炸', async () => {
  const fresh = (() => {
    const key = require.resolve('../auth.js');
    const saved = require.cache[key];
    delete require.cache[key];
    const mod = require('../auth.js');
    require.cache[key] = saved;
    return mod;
  })();
  const profile = await fresh.getProfile('tongshi');
  assert.strictEqual(profile.username, 'tongshi');
});

// ── 签发 ──────────────────────────────────────────────────────

test('登录签出的 token 带 tv=0，有效期 30 天', async () => {
  const payload = jwt.decode(await login('laoyonghu', 'secret123'));
  assert.strictEqual(payload.tv, 0);
  assert.strictEqual(payload.exp - payload.iat, 30 * DAY);
  assert.deepStrictEqual(
    { username: payload.username, role: payload.role },
    { username: 'laoyonghu', role: 'admin' },
  );
});

// ── 续期 ──────────────────────────────────────────────────────

test('续期：用旧票换出一张新的 30 天票，载荷与登录一致', async () => {
  // 两天前签的票，剩一小时过期
  const old = jwt.sign(
    { id: 1, username: 'laoyonghu', role: 'admin', tv: 0, iat: nowSec() - 2 * DAY, exp: nowSec() + 3600 },
    process.env.JWT_SECRET,
  );
  const res = await request('POST', '/api/session/refresh', { token: old });
  assert.strictEqual(res.status, 200, res.raw);
  assert.strictEqual(res.body.username, 'laoyonghu');
  const fresh = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.deepStrictEqual(
    { id: fresh.id, username: fresh.username, role: fresh.role, tv: fresh.tv },
    { id: 1, username: 'laoyonghu', role: 'admin', tv: 0 },
  );
  assert.strictEqual(fresh.exp - fresh.iat, 30 * DAY);
  assert.ok(fresh.exp > nowSec() + 29 * DAY);
});

test('续期：没有 tv 字段的存量 token 按 0 处理，能续期且换成带 tv 的新票', async () => {
  const legacy = jwt.sign({ id: 2, username: 'tongshi', role: 'user' }, process.env.JWT_SECRET, { expiresIn: '24h' });
  assert.strictEqual(jwt.decode(legacy).tv, undefined);

  // 部署后存量票照旧能用（连 WS 也行）
  const ws = openWs(legacy);
  assert.strictEqual(await withTimeout(ws.opened, 3000, '存量票握手'), true);
  ws.socket.close();

  const res = await request('POST', '/api/session/refresh', { token: legacy });
  assert.strictEqual(res.status, 200, res.raw);
  assert.strictEqual(jwt.decode(res.body.token).tv, 0);
});

test('续期：过期 token 被拒（401），没带 token 也是 401', async () => {
  const expired = jwt.sign(
    { id: 1, username: 'laoyonghu', role: 'admin', tv: 0, iat: nowSec() - 40 * DAY, exp: nowSec() - 10 * DAY },
    process.env.JWT_SECRET,
  );
  assert.strictEqual((await request('POST', '/api/session/refresh', { token: expired })).status, 401);
  assert.strictEqual((await request('POST', '/api/session/refresh')).status, 401);
  // 签名不对（别的密钥）同样被拒
  const forged = jwt.sign({ id: 1, username: 'laoyonghu', tv: 0 }, 'another-secret', { expiresIn: '1h' });
  assert.strictEqual((await request('POST', '/api/session/refresh', { token: forged })).status, 401);
});

test('续期：库里已不存在的用户拿着有效签名的票也是 401', async () => {
  const ghost = jwt.sign({ id: 99, username: 'ghost', role: 'user', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.strictEqual((await request('POST', '/api/session/refresh', { token: ghost })).status, 401);
});

// ── 撤销 ──────────────────────────────────────────────────────

test('改密码：旧票全部失效（HTTP 与 WS 握手），返回的新票可用，别的用户不受影响', async () => {
  const oldA = await login('laoyonghu', 'secret123');
  const oldA2 = await login('laoyonghu', 'secret123');   // 同一用户的另一台设备
  const tokenB = await login('tongshi', 'secret456');

  const changed = await request('POST', '/api/change-password', {
    token: oldA, body: { oldPassword: 'secret123', newPassword: 'newsecret789' },
  });
  assert.strictEqual(changed.status, 200, changed.raw);
  const newA = changed.body.token;
  assert.ok(newA);
  assert.strictEqual(jwt.decode(newA).tv, 1);

  // 旧票：包括改密码的那一张自己、以及另一台设备的
  assert.strictEqual((await request('POST', '/api/session/refresh', { token: oldA })).status, 401);
  assert.strictEqual((await request('GET', '/api/me', { token: oldA2 })).status, 401);
  assert.strictEqual(await withTimeout(openWs(oldA2).closed, 3000, '旧票握手'), 4001);

  // 新票：HTTP、续期、WS 都通；续期后的票沿用新版本
  assert.strictEqual((await request('GET', '/api/me', { token: newA })).status, 200);
  const renewed = await request('POST', '/api/session/refresh', { token: newA });
  assert.strictEqual(renewed.status, 200);
  assert.strictEqual(jwt.decode(renewed.body.token).tv, 1);
  const ws = openWs(newA);
  assert.strictEqual(await withTimeout(ws.opened, 3000, '新票握手'), true);
  ws.socket.close();

  // 另一个用户的票照常
  assert.strictEqual((await request('POST', '/api/session/refresh', { token: tokenB })).status, 200);

  // 新密码生效、旧密码作废
  assert.strictEqual((await request('POST', '/api/login', { body: { username: 'laoyonghu', password: 'secret123' } })).status, 401);
  assert.ok(await login('laoyonghu', 'newsecret789'));
});

test('改密码落盘：token_version 写进库文件，重新载入后旧票仍然作废', async () => {
  const { rows } = await readUsersFromDisk();
  assert.deepStrictEqual(rows.map(r => [r[0], r[2]]), [['laoyonghu', 1], ['tongshi', 0]]);

  // 模拟重启：全新的 auth 实例只靠磁盘上的库重建内存版本表
  const key = require.resolve('../auth.js');
  const saved = require.cache[key];
  delete require.cache[key];
  const restarted = require('../auth.js');
  require.cache[key] = saved;
  await restarted.getDb();
  const oldTv0 = jwt.sign({ id: 1, username: 'laoyonghu', role: 'admin', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const noTv = jwt.sign({ id: 1, username: 'laoyonghu', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const tv1 = jwt.sign({ id: 1, username: 'laoyonghu', role: 'admin', tv: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.strictEqual(restarted.verifyToken(oldTv0), null);
  assert.strictEqual(restarted.verifyToken(noTv), null);
  assert.strictEqual(restarted.verifyToken(tv1).username, 'laoyonghu');
});

// ── 已建立的 WS ───────────────────────────────────────────────

test('版本变化后已建立的 WS 连接被以 4001 断开，其他用户的连接不动', async () => {
  const token = await login('tongshi', 'secret456');
  const mine = openWs(token);
  const other = openWs(await login('laoyonghu', 'newsecret789'));
  await withTimeout(mine.opened, 3000, '连接建立');
  await withTimeout(other.opened, 3000, '连接建立');

  const changed = await request('POST', '/api/change-password', {
    token, body: { oldPassword: 'secret456', newPassword: 'newsecret000' },
  });
  assert.strictEqual(changed.status, 200, changed.raw);

  assert.strictEqual(await withTimeout(mine.closed, 3000, '被踢断开'), 4001);
  assert.strictEqual(other.socket.readyState, WebSocket.OPEN);

  // 带着改密码返回的新票立刻能重连
  const again = openWs(changed.body.token);
  assert.strictEqual(await withTimeout(again.opened, 3000, '新票重连'), true);
});

test('握手：无效 / 乱码 / 缺失的 token 都以 4001 关闭', async () => {
  assert.strictEqual(await withTimeout(openWs('not-a-jwt').closed, 3000, '乱码'), 4001);
  assert.strictEqual(await withTimeout(openWs('').closed, 3000, '缺失'), 4001);
  const expired = jwt.sign(
    { id: 1, username: 'laoyonghu', role: 'admin', tv: 1, iat: nowSec() - 40 * DAY, exp: nowSec() - 10 * DAY },
    process.env.JWT_SECRET,
  );
  assert.strictEqual(await withTimeout(openWs(expired).closed, 3000, '过期'), 4001);
});
