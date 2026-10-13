// 开发机身份台账：一次性邀请码 → 绑定 machineId 的长期 token。
//
// 这里断言的是**装机那一刻的安全语义**：码只能用一次、过期即废、通用码不能顶掉
// 已在线的机器、换新 token 旧的当场失效。这些是以前那份「全局明文 token 名单」
// 根本没有的性质，错了不会有任何报错 —— 只会表现成「某台机器莫名被踢下线」。
//
// 不走 sql.js：未 init 时台账只用内存缓存，正是为了让这层逻辑能被单测直接验。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const ledger = require('../packages/server/machine-tokens.js');

beforeEach(() => ledger._resetForTest());

test('邀请码换 token：token 绑定到 machineId，能原路解析回来', () => {
  const { code } = ledger.createInvite({ createdBy: 'admin' });
  const result = ledger.redeemInvite(code, { machineId: 'gpu-new' });

  assert.strictEqual(result.machineId, 'gpu-new');
  assert.ok(result.machineToken.startsWith(ledger.TOKEN_PREFIX));
  assert.strictEqual(ledger.resolveToken(result.machineToken), 'gpu-new');
  assert.strictEqual(ledger.ledgerSize(), 1);
});

test('台账里存的是哈希：明文 token 不出现在任何可列出的地方', () => {
  const { code } = ledger.createInvite({});
  const { machineToken } = ledger.redeemInvite(code, { machineId: 'm1', label: '测试机' });

  const dump = JSON.stringify({ machines: ledger.listMachines(), invites: ledger.listPendingInvites() });
  assert.ok(!dump.includes(machineToken), '列表接口不能把 token 带出去');
  assert.ok(!dump.includes(code), '列表接口不能把邀请码带出去');
  assert.strictEqual(ledger.listMachines()[0].label, '测试机');
});

test('邀请码只能用一次', () => {
  const { code } = ledger.createInvite({});
  assert.ok(ledger.redeemInvite(code, { machineId: 'a' }).machineToken);
  const second = ledger.redeemInvite(code, { machineId: 'b' });
  assert.strictEqual(second.code, 'code_used');
  assert.strictEqual(ledger.resolveToken('whatever'), null);
  assert.strictEqual(ledger.ledgerSize(), 1);
});

test('过期的邀请码不能用', () => {
  const now = Date.now();
  const { code } = ledger.createInvite({ ttlMs: 60_000, now });
  const result = ledger.redeemInvite(code, { machineId: 'a', now: now + 61_000 });
  assert.strictEqual(result.code, 'code_expired');
});

test('乱码 / 空码直接拒，不会意外登记出一台机器', () => {
  assert.strictEqual(ledger.redeemInvite('vai_NOPE', { machineId: 'a' }).code, 'invalid_code');
  assert.strictEqual(ledger.redeemInvite('', { machineId: 'a' }).code, 'invalid_code');
  assert.strictEqual(ledger.ledgerSize(), 0);
});

test('复制粘贴带上空白/小写前缀也认', () => {
  const { code } = ledger.createInvite({});
  const messy = `  ${code.replace(/^vai_/, 'VAI_')}\n`;
  assert.strictEqual(ledger.redeemInvite(messy, { machineId: 'a' }).machineId, 'a');
});

test('通用码不能顶掉已登记的机器 —— 否则泄露一个码就能接走在线机器的身份', () => {
  const first = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'macmini' });
  const result = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'macmini' });

  assert.strictEqual(result.code, 'machine_exists');
  assert.strictEqual(ledger.resolveToken(first.machineToken), 'macmini', '原 token 必须还有效');
});

test('指名某台机器的码可以换新 token，旧 token 当场失效', () => {
  const old = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'macmini' });
  const { code } = ledger.createInvite({ machineId: 'macmini' });
  const fresh = ledger.redeemInvite(code, { machineId: '随便报一个' });

  assert.strictEqual(fresh.machineId, 'macmini', '码上指定的机器以码为准，不听客户端报的名字');
  assert.strictEqual(ledger.resolveToken(fresh.machineToken), 'macmini');
  assert.strictEqual(ledger.resolveToken(old.machineToken), null, '旧 token 必须立刻失效');
  assert.strictEqual(ledger.ledgerSize(), 1);
});

test('通用码装机时必须报 machineId', () => {
  const { code } = ledger.createInvite({});
  assert.strictEqual(ledger.redeemInvite(code, {}).code, 'missing_machine_id');
});

test('撤销：token 立刻失效，机器从台账消失', () => {
  const { machineToken } = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'm1' });
  assert.strictEqual(ledger.revokeMachine('m1'), true);
  assert.strictEqual(ledger.resolveToken(machineToken), null);
  assert.strictEqual(ledger.hasMachine('m1'), false);
  assert.strictEqual(ledger.revokeMachine('m1'), false, '重复撤销不算成功');
});

test('touch 一分钟内不重复落盘（握手路径上每次 export 整库太贵）', () => {
  const now = Date.now();
  ledger.redeemInvite(ledger.createInvite({ now }).code, { machineId: 'm1', now });
  assert.strictEqual(ledger.touch('m1', { now }), true);
  assert.strictEqual(ledger.touch('m1', { now: now + 1000 }), false);
  assert.strictEqual(ledger.touch('m1', { now: now + 61_000 }), true);
  assert.strictEqual(ledger.touch('不存在', { now }), false);
});

test('两个邀请码互不干扰，各自换出不同机器的 token', () => {
  const a = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'a' });
  const b = ledger.redeemInvite(ledger.createInvite({}).code, { machineId: 'b' });
  assert.notStrictEqual(a.machineToken, b.machineToken);
  assert.strictEqual(ledger.resolveToken(a.machineToken), 'a');
  assert.strictEqual(ledger.resolveToken(b.machineToken), 'b');
});

test('待用邀请码列表只含未用未过期的', () => {
  const now = Date.now();
  ledger.createInvite({ machineId: 'pending', now });
  const used = ledger.createInvite({ now });
  ledger.redeemInvite(used.code, { machineId: 'done', now });
  ledger.createInvite({ machineId: 'expired', ttlMs: 60_000, now: now - 120_000 });

  const pending = ledger.listPendingInvites({ now }).map(i => i.machineId);
  assert.deepStrictEqual(pending, ['pending']);
});

test('pruneInvites 只清过期未用的，不动待用的和用过的记录', () => {
  const now = Date.now();
  ledger.createInvite({ machineId: 'keep', now });
  ledger.createInvite({ machineId: 'gone', ttlMs: 60_000, now: now - 120_000 });
  assert.strictEqual(ledger.pruneInvites({ now }), 1);
  assert.strictEqual(ledger.pruneInvites({ now }), 0);
  assert.deepStrictEqual(ledger.listPendingInvites({ now }).map(i => i.machineId), ['keep']);
});
