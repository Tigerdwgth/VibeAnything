// packages/server/usage-store.js
// Claude Code / Codex 的用量台账。
//
// 与 users / session_owners 同库（复用 auth.js 的 getDb），理由和 session_owners
// 一样：不开第二个 SQLite 文件、不引入第二套备份路径。
//
// 幂等模型：采集器每小时上报「当天累计值」，同一 (username, machine_id, agent,
// date, model) 反复覆盖。所以主键就是这五元组，写入用 INSERT OR REPLACE —— 重复
// 上报不会把当天的量翻倍，漏报一轮下轮也能自动补齐。

const { getDb, saveDb } = require('./auth');

const AGENTS = new Set(['claude', 'codex', 'opencode']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function initUsageTable() {
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS usage_records (
    username TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (username, machine_id, agent, date, model)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_records (date)`);
  return db;
}

/**
 * 校验单条上报记录。返回 null 表示合法，否则返回错误说明。
 * 之所以逐条校验而不是信任采集器：这个接口用 machineToken 鉴权，
 * token 一旦泄漏，脏数据会直接污染所有人的统计。
 */
function validateRecord(r) {
  if (!r || typeof r !== 'object') return '记录必须是对象';
  if (!r.username) return 'username 不能为空';
  if (!r.machineId) return 'machineId 不能为空';
  if (!AGENTS.has(r.agent)) return `agent 必须是 claude、codex 或 opencode，收到 ${r.agent}`;
  if (!DATE_RE.test(r.date || '')) return `date 必须是 YYYY-MM-DD，收到 ${r.date}`;
  if (!r.model) return 'model 不能为空';
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens',
    'cacheCreationTokens', 'reasoningTokens', 'totalTokens']) {
    const v = r[k];
    if (v != null && (!Number.isFinite(v) || v < 0)) return `${k} 必须是非负数，收到 ${v}`;
  }
  if (r.costUSD != null && (!Number.isFinite(r.costUSD) || r.costUSD < 0)) {
    return `costUSD 必须是非负数，收到 ${r.costUSD}`;
  }
  return null;
}

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * 幂等写入一批记录。整批只 saveDb 一次 —— 单条落盘 = 一次全库 export + 写文件，
 * 一次上报几十条的话逐条存会把磁盘打满。
 * @returns {{written:number}}
 */
async function upsertRecords(records, now = Date.now()) {
  const db = await initUsageTable();
  for (const r of records) {
    db.run(
      `INSERT OR REPLACE INTO usage_records
       (username, machine_id, agent, date, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
        cost_usd, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.username, r.machineId, r.agent, r.date, r.model,
        num(r.inputTokens), num(r.outputTokens), num(r.cacheReadTokens),
        num(r.cacheCreationTokens), num(r.reasoningTokens), num(r.totalTokens),
        num(r.costUSD), now]
    );
  }
  if (records.length) saveDb(db);
  return { written: records.length };
}

function rowsOf(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/**
 * 聚合查询。三个视角一次给全，前端不用来回打接口：
 *   byUser  —— 谁花得多（这就是「统计大家的用量」）
 *   byDate  —— 每天的走势，agent 分开
 *   byModel —— 钱花在哪个模型上
 * @param {{since?:string, until?:string, username?:string}} opts
 *   username 传了就只看这个人；普通用户由路由层强制传自己，避免越权看到别人。
 */
async function querySummary({ since, until, username } = {}) {
  const db = await initUsageTable();
  const where = [];
  const params = [];
  if (since) { where.push('date >= ?'); params.push(since); }
  if (until) { where.push('date <= ?'); params.push(until); }
  if (username) { where.push('username = ?'); params.push(username); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const agg = `SUM(input_tokens) AS inputTokens,
               SUM(output_tokens) AS outputTokens,
               SUM(cache_read_tokens) AS cacheReadTokens,
               SUM(cache_creation_tokens) AS cacheCreationTokens,
               SUM(reasoning_tokens) AS reasoningTokens,
               SUM(total_tokens) AS totalTokens,
               SUM(cost_usd) AS costUSD`;

  return {
    byUser: rowsOf(db.exec(
      `SELECT username, agent, ${agg} FROM usage_records ${clause}
       GROUP BY username, agent ORDER BY costUSD DESC`, params)),
    byDate: rowsOf(db.exec(
      `SELECT date, agent, ${agg} FROM usage_records ${clause}
       GROUP BY date, agent ORDER BY date ASC`, params)),
    byModel: rowsOf(db.exec(
      `SELECT model, agent, ${agg} FROM usage_records ${clause}
       GROUP BY model, agent ORDER BY costUSD DESC`, params)),
    totals: rowsOf(db.exec(
      `SELECT ${agg} FROM usage_records ${clause}`, params))[0] || null,
  };
}

module.exports = { initUsageTable, upsertRecords, querySummary, validateRecord };
