// tests/machines-api.test.js
// 装机接口的真实 HTTP 行为：签发邀请码 → 换 token → 台账/撤销，以及 token 真能握手。
//
// 走真 express + 真 sql.js（临时 users.db），因为这条链路的价值恰恰在**跨进程持久化**：
// 装机完成后 dashboard 重启，机器必须还能连上。纯内存单测验不到这一层
// （台账本身的语义在 tests/machine-tokens.test.js）。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-machines-api-'));
// auth.js 在模块顶层把 DB_PATH 读成常量，必须在 require 它之前指到临时目录
process.env.DB_PATH = path.join(TMP, 'users.db');
process.env.JWT_SECRET = 'machines-api-test-secret';

let server;
let port;
let adminToken;
let userToken;

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
        try { json = JSON.parse(raw); } catch { /* SPA fallback 不是 JSON */ }
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

before(async () => {
  const { createUser } = require('../packages/server/auth.js');
  await createUser('admin', 'secret123');            // 首个用户自动是 admin
  await createUser('tongshi', 'secret456');
  const machineTokens = require('../packages/server/machine-tokens.js');
  await machineTokens.init();

  const { app } = require('../packages/server/index.js');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  adminToken = await login('admin', 'secret123');
  userToken = await login('tongshi', 'secret456');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 鉴权边界 ──────────────────────────────────────────────────

test('签发邀请码仅管理员；普通用户 403、无 token 401', async () => {
  assert.strictEqual((await request('POST', '/api/machines/invite', { body: {} })).status, 401);
  assert.strictEqual((await request('POST', '/api/machines/invite', { token: userToken, body: {} })).status, 403);
  assert.strictEqual((await request('GET', '/api/machines', { token: userToken })).status, 403);
  assert.strictEqual((await request('DELETE', '/api/machines/x', { token: userToken })).status, 403);
});

test('换 token 的接口**不要 JWT** —— 新机器上还没有任何账号凭据，码本身是凭据', async () => {
  const bad = await request('POST', '/api/machines/join', { body: { code: 'vai_NOPE', machineId: 'x' } });
  assert.strictEqual(bad.status, 401, '码不对要 401，而不是掉进 SPA fallback 返回 200 HTML');
  assert.strictEqual(bad.body.code, 'invalid_code');
});

// ── 装机主路径 ────────────────────────────────────────────────

test('签发 → 换取 → token 能握手，且台账里看得到这台机器', async () => {
  const invite = await request('POST', '/api/machines/invite', {
    token: adminToken, body: { label: '新买的 4090' },
  });
  assert.strictEqual(invite.status, 200);
  assert.ok(invite.body.code.startsWith('vai_'));
  assert.ok(invite.body.expiresAt > Date.now());

  const join = await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'gpu-4090-05' },
  });
  assert.strictEqual(join.status, 200);
  assert.strictEqual(join.body.machineId, 'gpu-4090-05');
  assert.ok(join.body.machineToken.startsWith('vamt_'));

  // 这把 token 必须能过 relay 的握手鉴权，且 machineId 由台账决定
  const { authenticateMachine } = require('../packages/server/relay.js');
  assert.deepStrictEqual(
    authenticateMachine(join.body.machineToken, 'gpu-4090-05'),
    { machineId: 'gpu-4090-05', bound: true, claimed: undefined }
  );

  const list = await request('GET', '/api/machines', { token: adminToken });
  const row = list.body.machines.find(m => m.machineId === 'gpu-4090-05');
  assert.ok(row, '台账里要有这台机器');
  assert.strictEqual(row.label, '新买的 4090');
  assert.strictEqual(row.createdBy, 'admin');
  assert.strictEqual(row.online, false, 'relay 里没有它的连接，就不该显示在线');
  assert.ok(!list.raw.includes(join.body.machineToken), '台账接口不能把 token 带出去');
});

test('台账 token 冒充别的 machineId 不作数：按台账为准，并标出它报了什么', async () => {
  const invite = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  const join = await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'honest-box' },
  });
  const { authenticateMachine } = require('../packages/server/relay.js');
  assert.deepStrictEqual(
    authenticateMachine(join.body.machineToken, 'macmini'),
    { machineId: 'honest-box', bound: true, claimed: 'macmini' }
  );
});

test('一个码只能换一次；第二次 401', async () => {
  const invite = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  assert.strictEqual((await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'once-a' },
  })).status, 200);
  const second = await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'once-b' },
  });
  assert.strictEqual(second.status, 401);
  assert.strictEqual(second.body.code, 'code_used');
});

test('通用码撞上已登记的机器回 409，并给出下一步怎么做', async () => {
  const first = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  await request('POST', '/api/machines/join', { body: { code: first.body.code, machineId: 'dup-box' } });
  const second = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  const res = await request('POST', '/api/machines/join', {
    body: { code: second.body.code, machineId: 'dup-box' },
  });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /已登记/);
});

test('指名机器的码可以给它换新 token，旧 token 当场失效（换装/泄露都走这条）', async () => {
  const { authenticateMachine } = require('../packages/server/relay.js');
  const i1 = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  const old = (await request('POST', '/api/machines/join', {
    body: { code: i1.body.code, machineId: 'rotate-box' },
  })).body;

  const i2 = await request('POST', '/api/machines/invite', {
    token: adminToken, body: { machineId: 'rotate-box' },
  });
  const fresh = (await request('POST', '/api/machines/join', {
    body: { code: i2.body.code, machineId: '随便报的名字' },
  })).body;

  assert.strictEqual(fresh.machineId, 'rotate-box');
  assert.strictEqual(authenticateMachine(old.machineToken, 'rotate-box'), null);
  assert.strictEqual(authenticateMachine(fresh.machineToken, 'rotate-box').machineId, 'rotate-box');
});

test('缺 machineId 的通用码换取回 400（而不是登记出一台没名字的机器）', async () => {
  const invite = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  const res = await request('POST', '/api/machines/join', { body: { code: invite.body.code } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'missing_machine_id');
});

// ── 撤销与持久化 ──────────────────────────────────────────────

test('撤销后 token 立刻不认，重复撤销 404', async () => {
  const { authenticateMachine } = require('../packages/server/relay.js');
  const invite = await request('POST', '/api/machines/invite', { token: adminToken, body: {} });
  const join = (await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'doomed' },
  })).body;

  const del = await request('DELETE', '/api/machines/doomed', { token: adminToken });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(authenticateMachine(join.machineToken, 'doomed'), null);
  assert.strictEqual((await request('DELETE', '/api/machines/doomed', { token: adminToken })).status, 404);
});

test('装机信息真落盘：另开一份台账从同一个 users.db 读，token 照样认', async () => {
  const invite = await request('POST', '/api/machines/invite', { token: adminToken, body: { label: '持久化' } });
  const join = (await request('POST', '/api/machines/join', {
    body: { code: invite.body.code, machineId: 'persisted-box' },
  })).body;

  // 模拟 dashboard 重启：清掉模块缓存后重新 init，走的是 SELECT 而不是内存
  const ledgerPath = require.resolve('../packages/server/machine-tokens.js');
  const authPath = require.resolve('../packages/server/auth.js');
  delete require.cache[ledgerPath];
  delete require.cache[authPath];
  const fresh = require(ledgerPath);
  await fresh.init();

  assert.strictEqual(fresh.resolveToken(join.machineToken), 'persisted-box');
  assert.strictEqual(fresh.listMachines().find(m => m.machineId === 'persisted-box').label, '持久化');
});
