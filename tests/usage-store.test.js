// tests/usage-store.test.js
// 跑在真实 SQLite 上（sql.js），只是把 DB_PATH 指到临时文件。
// DB_PATH 必须在 require('../packages/server/auth') 之前设好 —— auth.js 在模块
// 顶层就把它读进常量了。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-usage-')), 'users.db');
process.env.DB_PATH = TMP_DB;

const store = require('../packages/server/usage-store');

function rec(over = {}) {
  return {
    username: 'gsj', machineId: 'macmini', agent: 'claude',
    date: '2026-08-16', model: 'claude-opus-5',
    inputTokens: 100, outputTokens: 200, cacheReadTokens: 300,
    cacheCreationTokens: 40, reasoningTokens: 0, totalTokens: 640, costUSD: 1.25,
    ...over,
  };
}

test('validateRecord 放行合法记录', () => {
  assert.strictEqual(store.validateRecord(rec()), null);
  assert.strictEqual(store.validateRecord(rec({ agent: 'opencode', model: 'deepseek-v4-flash' })), null);
});

test('validateRecord 拦下坏数据', () => {
  assert.match(store.validateRecord(rec({ agent: 'gemini' })), /agent/);
  assert.match(store.validateRecord(rec({ date: '2026/08/16' })), /date/);
  assert.match(store.validateRecord(rec({ username: '' })), /username/);
  assert.match(store.validateRecord(rec({ model: '' })), /model/);
  assert.match(store.validateRecord(rec({ inputTokens: -5 })), /inputTokens/);
  assert.match(store.validateRecord(rec({ costUSD: Number.NaN })), /costUSD/);
  assert.match(store.validateRecord(null), /对象/);
});

test('重复上报同一天同模型是覆盖而不是累加', async () => {
  await store.upsertRecords([rec({ costUSD: 1.25, totalTokens: 640 })]);
  await store.upsertRecords([rec({ costUSD: 1.25, totalTokens: 640 })]);
  const s1 = await store.querySummary({ username: 'gsj' });
  assert.strictEqual(s1.totals.costUSD, 1.25);
  assert.strictEqual(s1.totals.totalTokens, 640);

  // 当天量涨了再报一次，应当就地更新成新值
  await store.upsertRecords([rec({ costUSD: 3.5, totalTokens: 1000 })]);
  const s2 = await store.querySummary({ username: 'gsj' });
  assert.strictEqual(s2.totals.costUSD, 3.5);
  assert.strictEqual(s2.totals.totalTokens, 1000);
});

test('不同 agent / 模型 / 机器 各占一行，不互相覆盖', async () => {
  await store.upsertRecords([
    rec({ agent: 'codex', model: 'gpt-5.6-sol', costUSD: 2, totalTokens: 10, reasoningTokens: 7 }),
    rec({ model: 'claude-fable-5', costUSD: 0.5, totalTokens: 5 }),
    rec({ machineId: 'macair', costUSD: 1, totalTokens: 8 }),
  ]);
  const s = await store.querySummary({ username: 'gsj' });
  // 3.5(已有 opus@macmini) + 2 + 0.5 + 1
  assert.ok(Math.abs(s.totals.costUSD - 7) < 1e-9);
  const codex = s.byUser.find(r => r.agent === 'codex');
  assert.strictEqual(codex.reasoningTokens, 7);
});

test('byUser 能把不同用户分开统计', async () => {
  await store.upsertRecords([rec({ username: 'wudi', costUSD: 10, totalTokens: 99 })]);
  const all = await store.querySummary({});
  const names = all.byUser.map(r => r.username);
  assert.ok(names.includes('gsj') && names.includes('wudi'));
  const mine = await store.querySummary({ username: 'gsj' });
  assert.ok(mine.byUser.every(r => r.username === 'gsj'));
});

test('日期区间过滤生效', async () => {
  await store.upsertRecords([rec({ date: '2026-07-01', costUSD: 100, totalTokens: 1 })]);
  const inJuly = await store.querySummary({ since: '2026-07-01', until: '2026-07-31' });
  assert.strictEqual(inJuly.totals.costUSD, 100);
  const inAug = await store.querySummary({ since: '2026-08-01', until: '2026-08-31' });
  assert.ok(inAug.totals.costUSD > 0 && inAug.totals.costUSD < 100);
});

test('byDate 按日期升序并区分 agent', async () => {
  const s = await store.querySummary({ username: 'gsj' });
  const dates = s.byDate.map(r => r.date);
  assert.deepStrictEqual(dates, [...dates].sort());
  assert.ok(s.byDate.some(r => r.agent === 'codex'));
});

test('查无数据时 totals 不炸', async () => {
  const s = await store.querySummary({ username: '查无此人' });
  assert.deepStrictEqual(s.byUser, []);
  assert.ok(s.totals === null || s.totals.costUSD === null);
});

test.after(() => {
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});
