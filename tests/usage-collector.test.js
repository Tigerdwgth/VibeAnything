// tests/usage-collector.test.js
// 样本是从 mac-mini 上实跑 `ccusage daily --json` / `ccusage codex daily --json`
// 截下来的真实结构（数值有裁剪），用来锁住两种 schema 的归一化。

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeClaudeDaily, normalizeCodexDaily, normalizeOpenCodeDaily,
  reportUrlFrom, sinceDaysAgo,
} = require('../lib/usage-collector');

const WHO = { username: 'gsj', machineId: 'macmini' };

const CLAUDE_SAMPLE = {
  daily: [{
    date: '2026-08-16',
    inputTokens: 7227, outputTokens: 741424,
    cacheCreationTokens: 11369036, cacheReadTokens: 624231041,
    totalTokens: 636348728, totalCost: 403.57437974999965,
    modelsUsed: ['claude-opus-5', 'claude-fable-5'],
    modelBreakdowns: [
      {
        modelName: 'claude-opus-5', inputTokens: 7222, outputTokens: 733309,
        cacheCreationTokens: 11143377, cacheReadTokens: 623796280, cost: 399.9130812499995,
      },
      {
        modelName: 'claude-fable-5', inputTokens: 5, outputTokens: 8115,
        cacheCreationTokens: 225659, cacheReadTokens: 434761, cost: 3.6612985000000005,
      },
    ],
  }],
};

const CODEX_SAMPLE = {
  daily: [{
    date: '2026-08-16',
    inputTokens: 7467439, outputTokens: 653934,
    cacheCreationTokens: 0, cacheReadTokens: 159794176,
    reasoningOutputTokens: 168145, totalTokens: 167915549, costUSD: 273.704606,
    models: {
      'gpt-5.6-sol': {
        inputTokens: 7467439, outputTokens: 653934, cacheCreationTokens: 0,
        cacheReadTokens: 159794176, reasoningOutputTokens: 168145,
        totalTokens: 167915549, isFallback: false,
      },
    },
  }],
};

const OPENCODE_SAMPLE = {
  daily: [{
    date: '2026-08-21',
    inputTokens: 424293, outputTokens: 543,
    cacheCreationTokens: 0, cacheReadTokens: 854016,
    totalTokens: 1279118, totalCost: 0.062018784800000004,
    // 注：ccusage 的 totalTokens 与可摊平字段之和有微小差（含未摊平的杂项），
    // 归一化口径与其他 agent 一致，用 input+output+cache 之和（1278852）。
    modelsUsed: ['deepseek-v4-flash'],
    modelBreakdowns: [
      {
        modelName: 'deepseek-v4-flash', inputTokens: 424293, outputTokens: 543,
        cacheCreationTokens: 0, cacheReadTokens: 854016,
        cost: 0.062018784800000004,
      },
    ],
  }],
};

test('claude: 按 modelBreakdowns 逐模型摊平', () => {
  const rs = normalizeClaudeDaily(CLAUDE_SAMPLE, WHO);
  assert.strictEqual(rs.length, 2);
  const opus = rs.find(r => r.model === 'claude-opus-5');
  assert.strictEqual(opus.agent, 'claude');
  assert.strictEqual(opus.date, '2026-08-16');
  assert.strictEqual(opus.username, 'gsj');
  assert.strictEqual(opus.inputTokens, 7222);
  assert.strictEqual(opus.cacheReadTokens, 623796280);
  assert.ok(Math.abs(opus.costUSD - 399.9130812499995) < 1e-9);
  // claude 没有 reasoning 概念，必须落 0 而不是 undefined，否则入库会变 NULL
  assert.strictEqual(opus.reasoningTokens, 0);
});

test('claude: 各模型成本之和等于当天总成本', () => {
  const rs = normalizeClaudeDaily(CLAUDE_SAMPLE, WHO);
  const sum = rs.reduce((s, r) => s + r.costUSD, 0);
  assert.ok(Math.abs(sum - CLAUDE_SAMPLE.daily[0].totalCost) < 1e-6);
});

test('claude: 缺 modelBreakdowns 的老格式退化成单条', () => {
  const rs = normalizeClaudeDaily({
    daily: [{ date: '2026-08-01', inputTokens: 10, outputTokens: 20, totalCost: 1.5, modelsUsed: ['claude-opus-5'] }],
  }, WHO);
  assert.strictEqual(rs.length, 1);
  assert.strictEqual(rs[0].model, 'claude-opus-5');
  assert.strictEqual(rs[0].costUSD, 1.5);
});

test('codex: models 字典摊平并带上 reasoning', () => {
  const rs = normalizeCodexDaily(CODEX_SAMPLE, WHO);
  assert.strictEqual(rs.length, 1);
  assert.strictEqual(rs[0].agent, 'codex');
  assert.strictEqual(rs[0].model, 'gpt-5.6-sol');
  assert.strictEqual(rs[0].reasoningTokens, 168145);
  assert.strictEqual(rs[0].totalTokens, 167915549);
  assert.ok(Math.abs(rs[0].costUSD - 273.704606) < 1e-9);
});

test('codex: 多模型时按 token 占比分摊当天成本，总和不丢', () => {
  const rs = normalizeCodexDaily({
    daily: [{
      date: '2026-08-15', costUSD: 100,
      models: {
        a: { totalTokens: 300, inputTokens: 300 },
        b: { totalTokens: 100, inputTokens: 100 },
      },
    }],
  }, WHO);
  const byModel = Object.fromEntries(rs.map(r => [r.model, r.costUSD]));
  assert.ok(Math.abs(byModel.a - 75) < 1e-9);
  assert.ok(Math.abs(byModel.b - 25) < 1e-9);
  assert.ok(Math.abs(rs.reduce((s, r) => s + r.costUSD, 0) - 100) < 1e-9);
});

test('codex: 当天 token 为 0 时成本不产生 NaN', () => {
  const rs = normalizeCodexDaily({
    daily: [{ date: '2026-08-15', costUSD: 0, models: { a: { totalTokens: 0 } } }],
  }, WHO);
  assert.strictEqual(rs[0].costUSD, 0);
  assert.ok(Number.isFinite(rs[0].costUSD));
});

test('opencode: 与 claude 同 schema，按 modelBreakdowns 摊平且 agent 为 opencode', () => {
  const rs = normalizeOpenCodeDaily(OPENCODE_SAMPLE, WHO);
  assert.strictEqual(rs.length, 1);
  const r = rs[0];
  assert.strictEqual(r.agent, 'opencode');
  assert.strictEqual(r.date, '2026-08-21');
  assert.strictEqual(r.model, 'deepseek-v4-flash');
  assert.strictEqual(r.inputTokens, 424293);
  assert.strictEqual(r.outputTokens, 543);
  assert.strictEqual(r.cacheReadTokens, 854016);
  assert.strictEqual(r.totalTokens, 1278852);
  assert.ok(Math.abs(r.costUSD - 0.062018784800000004) < 1e-12);
  // opencode 没有 reasoning 概念，必须落 0
  assert.strictEqual(r.reasoningTokens, 0);
});

test('opencode: 缺 modelBreakdowns 的老格式退化成单条', () => {
  const rs = normalizeOpenCodeDaily({
    daily: [{ date: '2026-08-21', inputTokens: 10, outputTokens: 20, totalCost: 0.5, modelsUsed: ['deepseek-v4-flash'] }],
  }, WHO);
  assert.strictEqual(rs.length, 1);
  assert.strictEqual(rs[0].model, 'deepseek-v4-flash');
  assert.strictEqual(rs[0].costUSD, 0.5);
});

test('归一化后的字段集合三种 agent 完全一致', () => {
  const a = Object.keys(normalizeClaudeDaily(CLAUDE_SAMPLE, WHO)[0]).sort();
  const b = Object.keys(normalizeCodexDaily(CODEX_SAMPLE, WHO)[0]).sort();
  const c = Object.keys(normalizeOpenCodeDaily(OPENCODE_SAMPLE, WHO)[0]).sort();
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
});

test('空输入不报错', () => {
  assert.deepStrictEqual(normalizeClaudeDaily({}, WHO), []);
  assert.deepStrictEqual(normalizeCodexDaily(null, WHO), []);
  assert.deepStrictEqual(normalizeOpenCodeDaily(null, WHO), []);
});

test('reportUrlFrom: ws/wss → http/https 并换成上报路径', () => {
  assert.strictEqual(reportUrlFrom('ws://100.64.0.10:3000/ws'), 'http://100.64.0.10:3000/api/usage/report');
  assert.strictEqual(reportUrlFrom('wss://example.com/ws'), 'https://example.com/api/usage/report');
});

test('sinceDaysAgo 输出 YYYYMMDD 且跨月正确', () => {
  assert.strictEqual(sinceDaysAgo(7, new Date(2026, 7, 16)), '20260809');
  assert.strictEqual(sinceDaysAgo(20, new Date(2026, 7, 16)), '20260727');
  assert.match(sinceDaysAgo(1), /^\d{8}$/);
});
