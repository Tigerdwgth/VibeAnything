// tests/join.test.js
// 装机客户端：地址解析、换 token 后写进配置、失败时的说法，以及管理员签发邀请码。
//
// fetch 是注入进去的替身（宿主 API），配置写的是临时目录里的真文件 ——
// 「装完机配置到底长什么样」是这条链路唯一真正要保证的事。

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-join-'));
let joinLib;
let config;

before(() => {
  process.env.VIBEANYTHING_HOME = TMP;
  joinLib = require('../lib/join');
  config = require('../lib/config');
});

after(() => {
  delete process.env.VIBEANYTHING_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'config.json'), { force: true });
});

/** 记录调用、按脚本回响应的 fetch 替身。 */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = queue.shift();
    if (!next) throw new Error(`没有为 ${url} 准备响应`);
    if (next.throws) throw new Error(next.throws);
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status || 200,
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

// ── 地址解析 ──────────────────────────────────────────────────

test('各种写法都解析成同一对 (HTTP 接口前缀, WS 地址)', () => {
  const expected = { httpBase: 'http://dash:3000', wsUrl: 'ws://dash:3000/ws' };
  for (const input of ['ws://dash:3000/ws', 'http://dash:3000', 'dash:3000', 'http://dash:3000/', 'ws://dash:3000/ws/']) {
    assert.deepStrictEqual(joinLib.resolveServerUrls(input), expected, `输入: ${input}`);
  }
});

test('https / wss 推出来的是 wss，不会把加密连接降级成明文', () => {
  assert.deepStrictEqual(joinLib.resolveServerUrls('https://dash.example.com'), {
    httpBase: 'https://dash.example.com', wsUrl: 'wss://dash.example.com/ws',
  });
  assert.deepStrictEqual(joinLib.resolveServerUrls('wss://dash.example.com/ws'), {
    httpBase: 'https://dash.example.com', wsUrl: 'wss://dash.example.com/ws',
  });
});

test('反代前缀要保留（relay 认的是「路径以 /ws 结尾」）', () => {
  assert.deepStrictEqual(joinLib.resolveServerUrls('https://host/proxy/3000/ws'), {
    httpBase: 'https://host/proxy/3000', wsUrl: 'wss://host/proxy/3000/ws',
  });
});

test('空地址和没法解析的地址直接报错，不去猜', () => {
  assert.throws(() => joinLib.resolveServerUrls(''), /不能为空/);
  assert.throws(() => joinLib.resolveServerUrls('ftp://host'), /不支持的协议/);
});

test('默认 machineId 取主机名第一段（完整主机名常带一长串域名）', () => {
  const id = joinLib.defaultMachineId();
  assert.ok(id && !id.includes('.'), `machineId 不该带域: ${id}`);
});

// ── join ──────────────────────────────────────────────────────

test('装机成功：只写 machineId + centralServer 三个字段，其余吃默认值', async () => {
  const fetchImpl = fakeFetch([{ body: { machineToken: 'vamt_abc', machineId: 'gpu-05' } }]);
  const result = await joinLib.join({ server: 'http://dash:3000', code: 'vai_CODE', machineId: 'gpu-05', fetchImpl });

  assert.deepStrictEqual(result, {
    machineId: 'gpu-05', wsUrl: 'ws://dash:3000/ws', configPath: path.join(TMP, 'config.json'),
  });
  assert.strictEqual(fetchImpl.calls[0].url, 'http://dash:3000/api/machines/join');
  assert.deepStrictEqual(fetchImpl.calls[0].body, { code: 'vai_CODE', machineId: 'gpu-05', label: null });

  const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
  assert.deepStrictEqual(raw, {
    machineId: 'gpu-05',
    centralServer: { enabled: true, url: 'ws://dash:3000/ws', machineToken: 'vamt_abc' },
  });
  // 合并后 daemon 要能直接起：enabled + url + machineToken 三个判据都得在
  const cfg = config.loadConfig();
  assert.ok(cfg.centralServer.enabled && cfg.centralServer.url && cfg.centralServer.machineToken);
});

test('服务端认定的 machineId 为准（指名码会改名），配置里写的是它回的那个', async () => {
  const fetchImpl = fakeFetch([{ body: { machineToken: 'vamt_x', machineId: 'canonical-name' } }]);
  const result = await joinLib.join({ server: 'dash:3000', code: 'c', machineId: 'i-said-this', fetchImpl });
  assert.strictEqual(result.machineId, 'canonical-name');
  assert.strictEqual(config.readRawConfig().machineId, 'canonical-name');
});

test('不传 machineId 时报主机名第一段上去', async () => {
  const fetchImpl = fakeFetch([{ body: { machineToken: 't', machineId: 'whatever' } }]);
  await joinLib.join({ server: 'dash:3000', code: 'c', fetchImpl });
  assert.strictEqual(fetchImpl.calls[0].body.machineId, joinLib.defaultMachineId());
});

test('label 带上去（管理员机器列表里用它认人）', async () => {
  const fetchImpl = fakeFetch([{ body: { machineToken: 't', machineId: 'm' } }]);
  await joinLib.join({ server: 'dash:3000', code: 'c', machineId: 'm', label: '实验室 4090', fetchImpl });
  assert.strictEqual(fetchImpl.calls[0].body.label, '实验室 4090');
});

test('服务端的错误文案原样透出（码过期/机器已登记要怎么办得让人看见），且不写配置', async () => {
  const fetchImpl = fakeFetch([{ status: 409, body: { error: '机器 m 已登记，请让管理员为它单独签发邀请码或先撤销', code: 'machine_exists' } }]);
  await assert.rejects(
    joinLib.join({ server: 'dash:3000', code: 'c', machineId: 'm', fetchImpl }),
    /已登记/
  );
  assert.strictEqual(fs.existsSync(path.join(TMP, 'config.json')), false, '失败不能留下半份配置');
});

test('连不上服务器时说清是连不上谁', async () => {
  const fetchImpl = fakeFetch([{ throws: 'ECONNREFUSED' }]);
  await assert.rejects(joinLib.join({ server: 'dash:3000', code: 'c', machineId: 'm', fetchImpl }), /连不上 http:\/\/dash:3000/);
});

test('缺邀请码时不发请求', async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(joinLib.join({ server: 'dash:3000', fetchImpl }), /缺少邀请码/);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('老版本服务端（没有这个接口）回 200 但没有 token —— 提示它需要升级，而不是写出一份残配置', async () => {
  const fetchImpl = fakeFetch([{ body: { ok: true } }]);
  await assert.rejects(joinLib.join({ server: 'dash:3000', code: 'c', machineId: 'm', fetchImpl }), /升级/);
  assert.strictEqual(fs.existsSync(path.join(TMP, 'config.json')), false);
});

// ── requestInvite ─────────────────────────────────────────────

test('签发邀请码：先登录拿 JWT，再带着它调签发接口', async () => {
  const fetchImpl = fakeFetch([
    { body: { token: 'jwt-admin' } },
    { body: { code: 'vai_NEWCODE', expiresAt: 123, machineId: null } },
  ]);
  const invite = await joinLib.requestInvite({
    server: 'http://dash:3000', username: 'admin', password: 'pw', label: '备注', fetchImpl,
  });

  assert.strictEqual(fetchImpl.calls[0].url, 'http://dash:3000/api/login');
  assert.strictEqual(fetchImpl.calls[1].url, 'http://dash:3000/api/machines/invite');
  assert.strictEqual(fetchImpl.calls[1].options.headers.Authorization, 'Bearer jwt-admin');
  // ttlMinutes 没给就不出现在请求体里（JSON.stringify 丢掉 undefined），由服务端定默认有效期
  assert.deepStrictEqual(fetchImpl.calls[1].body, { machineId: null, label: '备注' });
  // 回执里带上两个地址，调用方直接拼出「在新机器上执行」那条命令
  assert.strictEqual(invite.code, 'vai_NEWCODE');
  assert.strictEqual(invite.httpBase, 'http://dash:3000');
  assert.strictEqual(invite.wsUrl, 'ws://dash:3000/ws');
});

test('登录失败就停下，不去调签发接口', async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: 'Invalid credentials' } }]);
  await assert.rejects(
    joinLib.requestInvite({ server: 'dash:3000', username: 'admin', password: 'bad', fetchImpl }),
    /Invalid credentials/
  );
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test('没给用户名密码时不发请求', async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(joinLib.requestInvite({ server: 'dash:3000', fetchImpl }), /用户名和密码/);
  assert.strictEqual(fetchImpl.calls.length, 0);
});
