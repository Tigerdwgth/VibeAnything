// tests/profile-api.test.js
// 个人信息接口的真实 HTTP 行为：GET /api/me 与 PATCH /api/profile。
//
// 起点故意是一个**老库**（只有 id/username/password_hash/created_at 四列，连 role 都没有）——
// 线上那台 aliyun-derper 上的 users.db 就是这么长起来的，上线时会当场跑列迁移。
// 拿空库测等于没测：空库是 CREATE TABLE 一次成型，根本走不到 ALTER TABLE 那条路。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '../packages/server');
const req = (name) => require(require.resolve(name, { paths: [SERVER_DIR] }));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-profile-api-'));
// auth.js 在模块顶层就把 DB_PATH 读成常量，必须在 require 之前指到临时目录。
process.env.DB_PATH = path.join(TMP, 'users.db');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let port;

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
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应（如 SPA fallback）交给调用方判断 */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 造一个「个人信息功能上线之前」的 users.db：没有 role、没有 nickname、没有 avatar。 */
async function seedLegacyDb(users) {
  const initSqlJs = req('sql.js');
  const bcrypt = req('bcryptjs');
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
      [username, await bcrypt.hash(password, 4), Date.now()]);
  }
  fs.writeFileSync(process.env.DB_PATH, Buffer.from(db.export()));
  db.close();
}

async function login(username, password) {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.strictEqual(res.status, 200, `登录失败：${res.raw}`);
  return res.body.token;
}

let tokenA;
let tokenB;

before(async () => {
  await seedLegacyDb([
    { username: 'laoyonghu', password: 'secret123' },
    { username: 'tongshi', password: 'secret456' },
  ]);
  const { app } = require('../packages/server/index.js');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  tokenA = await login('laoyonghu', 'secret123');
  tokenB = await login('tongshi', 'secret456');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 迁移 ──────────────────────────────────────────────────────

test('老库自动补出 nickname / avatar 两列，存量用户读出来是「没设过」', async () => {
  const res = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    username: 'laoyonghu', role: 'admin', nickname: null, avatar: null,
  });
});

test('列迁移可重复执行：再开一次库不会因 ADD COLUMN 重复而炸', async () => {
  // getDb 有模块级缓存，绕过它直接再跑一遍迁移路径
  delete require.cache[require.resolve('../packages/server/auth.js')];
  const fresh = require('../packages/server/auth.js');
  const profile = await fresh.getProfile('laoyonghu');
  assert.strictEqual(profile.username, 'laoyonghu');
  assert.strictEqual(profile.nickname, null);
});

// ── 鉴权 ──────────────────────────────────────────────────────

test('没有 token 时 /api/me 与 /api/profile 都是 401，不会掉进 SPA fallback', async () => {
  assert.strictEqual((await request('GET', '/api/me')).status, 401);
  assert.strictEqual((await request('PATCH', '/api/profile', { body: { nickname: 'x' } })).status, 401);
});

// ── 正常修改 ──────────────────────────────────────────────────

test('改昵称：立刻生效，不用等 token 过期重签', async () => {
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: '  老用户  ' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.nickname, '老用户');   // 两端空白被裁掉

  // 关键：用的还是改之前签发的那张 token
  const me = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(me.body.nickname, '老用户');
});

test('换头像：data URI 原样落库、原样读回（中途不能被截断）', async () => {
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { avatar: PNG } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.avatar, PNG);

  const me = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(me.body.avatar, PNG);
  assert.strictEqual(me.body.nickname, '老用户', '换头像不该动昵称');
});

test('只传一个字段时不碰另一个 —— 「没传」与「传了空」必须是两件事', async () => {
  // 只改昵称，头像应当原封不动
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: '阿杰' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.nickname, '阿杰');
  assert.strictEqual(res.body.avatar, PNG, '只改昵称把头像抹掉了');
});

test('传 null 才是清空：昵称回落用户名、头像回落默认图', async () => {
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: null, avatar: null } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.nickname, null);
  assert.strictEqual(res.body.avatar, null);
});

test('空字符串等同清空（前端把输入框删空就是这个意思）', async () => {
  await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: '临时' } });
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: '' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.nickname, null);
});

// ── 拒绝路径 ──────────────────────────────────────────────────

test('昵称超长被拒，且库里的旧值不受影响', async () => {
  await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: '保留我' } });
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { nickname: 'x'.repeat(50) } });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /昵称/);

  const me = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(me.body.nickname, '保留我');
});

test('截断的头像被拒 —— 这种图存进去是个灰方块，不能让它落库', async () => {
  const truncated = PNG.slice(0, PNG.length - 12);
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { avatar: truncated } });
  assert.strictEqual(res.status, 400);

  const me = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(me.body.avatar, null, '被拒的头像不该留下半截数据');
});

test('外链头像被拒：库里不能存一个内容会变的地址', async () => {
  const res = await request('PATCH', '/api/profile', {
    token: tokenA, body: { avatar: 'https://example.com/evil.png' },
  });
  assert.strictEqual(res.status, 400);
});

test('一个可改字段都没有时给 400，而不是静默返回成功', async () => {
  const res = await request('PATCH', '/api/profile', { token: tokenA, body: { role: 'admin' } });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /nickname/);
});

test('不能借 body 里的 username 改别人 —— 改谁只由 token 决定', async () => {
  const res = await request('PATCH', '/api/profile', {
    token: tokenB, body: { username: 'laoyonghu', nickname: '同事的昵称' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'tongshi');

  const victim = await request('GET', '/api/me', { token: tokenA });
  assert.strictEqual(victim.body.nickname, '保留我', 'B 的请求改到了 A 的昵称');
});

test('提权也没用：role 只认 token，PATCH 里写什么都不影响', async () => {
  const res = await request('PATCH', '/api/profile', {
    token: tokenB, body: { nickname: '同事', role: 'admin' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.role, 'user');
});
