// lib/usage-collector.js
// 用 ccusage 采集本机的 Claude Code / Codex 用量，归一化后上报给 Dashboard。
//
// 为什么要归一化：ccusage 两个子命令的 JSON schema 并不一致 ——
//   claude:  { daily: [{ ..., totalCost, modelBreakdowns: [{ modelName, cost, ... }] }] }
//   codex:   { daily: [{ ..., costUSD,  models: { "<name>": { ... } }, reasoningOutputTokens }] }
// 一个用数组一个用字典、成本字段名不同、codex 多一个 reasoning。台账要能把两边放在
// 一张表里比，就必须在采集端先摊平成同一种 record。

const { execFile } = require('node:child_process');
const os = require('node:os');

const DEFAULT_LOOKBACK_DAYS = 7;
const EXEC_TIMEOUT_MS = 180_000;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/** YYYYMMDD —— ccusage --since 要这个格式 */
function toCompactDate(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function sinceDaysAgo(days, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return toCompactDate(d);
}

/**
 * 跑一条 ccusage 命令并解析 JSON。
 * ccusage 会把进度/警告写到 stdout 之外，但真出问题时 stdout 可能夹杂非 JSON 前缀，
 * 所以从第一个 `{` 开始截。
 */
function runCcusage(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return reject(new Error(`${cmd} ${args.join(' ')} 失败: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
      }
      const start = stdout.indexOf('{');
      if (start < 0) return reject(new Error(`${cmd} ${args.join(' ')} 没有输出 JSON: ${stdout.slice(0, 200)}`));
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (e) {
        reject(new Error(`解析 ${cmd} 输出失败: ${e.message}`));
      }
    });
  });
}

const n = (v) => (Number.isFinite(v) ? v : 0);

function baseRecord(username, machineId, agent, date, model) {
  return {
    username, machineId, agent, date, model,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, costUSD: 0,
  };
}

/**
 * ccusage `claude daily` / `opencode daily` 共用的 schema（modelBreakdowns 数组，
 * 模型级有独立 cost）→ records。
 * 按 modelBreakdowns 逐模型摊平；没有 breakdown 的老格式退化成单条 unknown。
 */
function normalizeBreakdownDaily(json, { username, machineId, agent }) {
  const out = [];
  for (const day of json?.daily || []) {
    const breakdowns = day.modelBreakdowns?.length
      ? day.modelBreakdowns
      : [{ modelName: day.modelsUsed?.[0] || 'unknown', ...day, cost: day.totalCost }];
    for (const b of breakdowns) {
      const r = baseRecord(username, machineId, agent, day.date, b.modelName || 'unknown');
      r.inputTokens = n(b.inputTokens);
      r.outputTokens = n(b.outputTokens);
      r.cacheReadTokens = n(b.cacheReadTokens);
      r.cacheCreationTokens = n(b.cacheCreationTokens);
      r.totalTokens = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
      r.costUSD = n(b.cost);
      out.push(r);
    }
  }
  return out;
}

/** ccusage claude daily --json（Claude Code）→ records */
function normalizeClaudeDaily(json, ctx) {
  return normalizeBreakdownDaily(json, { ...ctx, agent: 'claude' });
}

/** ccusage opencode daily --json（OpenCode）→ records，schema 与 claude 一致 */
function normalizeOpenCodeDaily(json, ctx) {
  return normalizeBreakdownDaily(json, { ...ctx, agent: 'opencode' });
}

/**
 * ccusage codex daily --json → records
 * models 是字典而非数组；成本只在天级别给（costUSD），模型级没有单独成本字段，
 * 所以按该模型的 totalTokens 占比把当天成本分摊下去 —— 否则多模型的天会丢掉成本。
 */
function normalizeCodexDaily(json, { username, machineId }) {
  const out = [];
  for (const day of json?.daily || []) {
    const models = day.models && Object.keys(day.models).length
      ? day.models
      : { unknown: day };
    const dayTotal = Object.values(models).reduce((s, m) => s + n(m.totalTokens), 0);
    for (const [name, m] of Object.entries(models)) {
      const r = baseRecord(username, machineId, 'codex', day.date, name);
      r.inputTokens = n(m.inputTokens);
      r.outputTokens = n(m.outputTokens);
      r.cacheReadTokens = n(m.cacheReadTokens);
      r.cacheCreationTokens = n(m.cacheCreationTokens);
      r.reasoningTokens = n(m.reasoningOutputTokens);
      r.totalTokens = n(m.totalTokens);
      r.costUSD = dayTotal > 0 ? n(day.costUSD) * (r.totalTokens / dayTotal) : n(day.costUSD);
      out.push(r);
    }
  }
  return out;
}

/**
 * 采集本机用量。某一路 agent 挂掉不影响另一路 —— 机器上可能只装了其中一个 CLI。
 * @returns {Promise<{records:Array, errors:Array<{agent:string,message:string}>}>}
 */
async function collect({
  ccusageCmd = 'ccusage',
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  username = os.userInfo().username,
  machineId = os.hostname(),
  codexHome,
  now = new Date(),
} = {}) {
  const since = sinceDaysAgo(lookbackDays, now);
  const records = [];
  const errors = [];

  // ccusage 20 起，裸 `daily` 变成「所有 agent 合并」，Claude 专用挪到了 `claude daily`；
  // 19 及以前没有 `claude` 子命令，裸 `daily` 才是 Claude。两种写法依次试，谁先成功用谁，
  // 这样同一份采集器在新旧版本的机器上都能跑。两代的 JSON schema 实测一致。
  const jobs = [
    {
      agent: 'claude',
      attempts: [['claude', 'daily'], ['daily']],
      normalize: normalizeClaudeDaily,
    },
    {
      agent: 'codex',
      attempts: [['codex', 'daily']],
      normalize: normalizeCodexDaily,
    },
    {
      agent: 'opencode',
      attempts: [['opencode', 'daily']],
      normalize: normalizeOpenCodeDaily,
    },
  ];

  for (const job of jobs) {
    const env = job.agent === 'codex' && codexHome ? { CODEX_HOME: codexHome } : {};
    let lastErr = null;
    let done = false;
    for (const prefix of job.attempts) {
      try {
        const json = await runCcusage(ccusageCmd, [...prefix, '--json', '--since', since], env);
        records.push(...job.normalize(json, { username, machineId }));
        done = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!done) errors.push({ agent: job.agent, message: lastErr?.message || '未知错误' });
  }
  return { records, errors };
}

/** ws://host:3000/ws → http://host:3000/api/usage/report */
function reportUrlFrom(centralServerUrl) {
  const u = new URL(centralServerUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/api/usage/report';
  u.search = '';
  return u.toString();
}

async function report(records, { url, machineToken }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-machine-token': machineToken },
    body: JSON.stringify({ records }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上报失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

/**
 * 采集 + 上报一条龙，给 CLI / cron 用。
 * @param {object} config ~/.vibeanything/config.json 的内容
 */
async function collectAndReport(config, opts = {}) {
  const central = config?.centralServer;
  if (!central?.url || !central?.machineToken) {
    throw new Error('config.centralServer.url / machineToken 未配置，先跑 `vibeanything` 安装向导');
  }
  const usageCfg = config.usage || {};
  const { records, errors } = await collect({
    ccusageCmd: usageCfg.ccusageCmd || 'ccusage',
    lookbackDays: usageCfg.lookbackDays || DEFAULT_LOOKBACK_DAYS,
    username: usageCfg.username || central.machineId || os.userInfo().username,
    machineId: central.machineId || os.hostname(),
    codexHome: usageCfg.codexHome,
    ...opts,
  });

  if (errors.length && !records.length) {
    throw new Error(`采集全部失败: ${errors.map(e => `${e.agent}: ${e.message}`).join(' | ')}`);
  }
  const url = usageCfg.reportUrl || reportUrlFrom(central.url);
  const result = records.length
    ? await report(records, { url, machineToken: central.machineToken })
    : { ok: true, written: 0 };
  return { ...result, collected: records.length, errors, url };
}

module.exports = {
  collect, collectAndReport, report, reportUrlFrom,
  normalizeClaudeDaily, normalizeCodexDaily, normalizeOpenCodeDaily, sinceDaysAgo,
};
