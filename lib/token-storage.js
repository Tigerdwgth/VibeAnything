// lib/token-storage.js
const { Pool } = require('pg');
const { loadConfig } = require('./config');

let pool = null;

async function getPool() {
  if (pool) return pool;

  const config = loadConfig();
  const dbConfig = config.database || {};

  pool = new Pool({
    host: process.env.DB_HOST || dbConfig.host || 'localhost',
    port: process.env.DB_PORT || dbConfig.port || 5432,
    database: process.env.DB_NAME || dbConfig.database || 'vibeanything',
    user: process.env.DB_USER || dbConfig.user || 'vibeanything',
    password: process.env.DB_PASSWORD || dbConfig.password,
    max: dbConfig.max || 20,
    idleTimeoutMillis: dbConfig.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[token-storage] Unexpected pool error:', err);
  });

  return pool;
}

async function initDatabase() {
  const pool = await getPool();

  // 创建 users 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  // 创建 token_usage 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      machine_id VARCHAR(255) NOT NULL,
      session_id VARCHAR(255) NOT NULL,
      project_path TEXT NOT NULL,
      message_id VARCHAR(255) UNIQUE NOT NULL,
      model VARCHAR(50) NOT NULL,
      timestamp BIGINT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER GENERATED ALWAYS AS (
        input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens
      ) STORED,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建索引
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_machine ON token_usage(machine_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_project ON token_usage(project_path)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_timestamp ON token_usage(timestamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_model ON token_usage(model)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_message ON token_usage(message_id)`);

  console.log('[token-storage] Database initialized');
}

async function insertTokenUsage(data) {
  const pool = await getPool();
  const query = `
    INSERT INTO token_usage (
      machine_id, session_id, project_path, message_id, model, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
  `;

  const values = [
    data.machine_id,
    data.session_id,
    data.project_path,
    data.message_id,
    data.model,
    data.timestamp,
    data.input_tokens || 0,
    data.output_tokens || 0,
    data.cache_creation_tokens || 0,
    data.cache_read_tokens || 0
  ];

  try {
    const result = await pool.query(query, values);
    return result.rowCount > 0;
  } catch (err) {
    if (err.code !== '23505') { // 忽略唯一约束冲突
      throw err;
    }
    return false;
  }
}

async function batchInsertTokenUsage(dataArray) {
  if (!dataArray || dataArray.length === 0) return 0;

  let inserted = 0;
  for (const data of dataArray) {
    try {
      const success = await insertTokenUsage(data);
      if (success) inserted++;
    } catch (err) {
      console.error('[token-storage] Insert failed:', err.message);
    }
  }

  return inserted;
}

async function queryTokenStats(filters = {}) {
  const pool = await getPool();
  const conditions = [];
  const values = [];
  let paramIndex = 1;

  if (filters.machineId) {
    conditions.push(`machine_id = $${paramIndex++}`);
    values.push(filters.machineId);
  }

  if (filters.projectPath) {
    conditions.push(`project_path = $${paramIndex++}`);
    values.push(filters.projectPath);
  }

  if (filters.sessionId) {
    conditions.push(`session_id = $${paramIndex++}`);
    values.push(filters.sessionId);
  }

  if (filters.startTime) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    values.push(filters.startTime);
  }

  if (filters.endTime) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    values.push(filters.endTime);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_tokens) as cache_creation_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(total_tokens) as total_tokens,
      COUNT(*) as message_count
    FROM token_usage
    ${whereClause}
  `;

  const result = await pool.query(query, values);
  return result.rows[0] || {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    message_count: 0
  };
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDatabase,
  insertTokenUsage,
  batchInsertTokenUsage,
  queryTokenStats,
  closePool,
  getPool
};
