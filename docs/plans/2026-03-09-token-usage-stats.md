# Token 用量统计功能实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 vibeanything 项目增加 token 用量统计功能，支持多维度统计 Claude Code 的 token 使用情况

**Architecture:** 使用 PostgreSQL 存储 token 数据，扫描历史 transcript 文件并实时追踪新数据，提供 REST API 供 Web Dashboard 和飞书查询

**Tech Stack:** PostgreSQL, pg (node-postgres), Node.js, Express

---

## 前置准备

### Task 0: 安装 PostgreSQL 和创建数据库

**Files:**
- 无需修改代码文件

**Step 1: 安装 PostgreSQL**

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib

# 启动服务
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**Step 2: 创建数据库和用户**

```bash
sudo -u postgres psql << 'EOF'
CREATE DATABASE vibeanything;
CREATE USER vibeanything WITH PASSWORD '<DB_PASSWORD>';
GRANT ALL PRIVILEGES ON DATABASE vibeanything TO vibeanything;
\c vibeanything
GRANT ALL ON SCHEMA public TO vibeanything;
EOF
```

**Step 3: 验证连接**

```bash
psql -h localhost -U vibeanything -d vibeanything -c "SELECT version();"
```

Expected: 显示 PostgreSQL 版本信息

---

## 阶段 1: 数据访问层

### Task 1: 实现 PostgreSQL 数据访问层

**Files:**
- Create: `lib/token-storage.js`
- Modify: `package.json`
- Test: `tests/token-storage.test.js`

**Step 1: 添加 pg 依赖**

```bash
npm install pg
```

**Step 2: 创建 token-storage.js 骨架**

Create `lib/token-storage.js`:

```javascript
const { Pool } = require('pg');
const { getConfig } = require('./config');

let pool = null;

async function getPool() {
  if (pool) return pool;

  const config = getConfig();
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

  const result = await pool.query(query, values);
  return result.rowCount > 0;
}

async function batchInsertTokenUsage(dataArray) {
  if (!dataArray || dataArray.length === 0) return 0;

  const pool = await getPool();
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
  closePool,
  getPool
};
```

**Step 3: 编写测试**

Create `tests/token-storage.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { initDatabase, insertTokenUsage, batchInsertTokenUsage, closePool, getPool } = require('../lib/token-storage');

describe('token-storage', () => {
  before(async () => {
    await initDatabase();
  });

  after(async () => {
    // 清理测试数据
    const pool = await getPool();
    await pool.query('DELETE FROM token_usage WHERE message_id LIKE \'test-%\'');
    await closePool();
  });

  it('should insert token usage', async () => {
    const data = {
      machine_id: 'test-machine',
      session_id: 'test-session',
      project_path: '/test/project',
      message_id: 'test-msg-1',
      model: 'claude-sonnet-4-6',
      timestamp: Date.now(),
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 10,
      cache_read_tokens: 20
    };

    const success = await insertTokenUsage(data);
    assert.strictEqual(success, true);
  });

  it('should handle duplicate message_id', async () => {
    const data = {
      machine_id: 'test-machine',
      session_id: 'test-session',
      project_path: '/test/project',
      message_id: 'test-msg-2',
      model: 'claude-sonnet-4-6',
      timestamp: Date.now(),
      input_tokens: 100,
      output_tokens: 50
    };

    const success1 = await insertTokenUsage(data);
    assert.strictEqual(success1, true);

    const success2 = await insertTokenUsage(data);
    assert.strictEqual(success2, false); // 重复插入应该被忽略
  });

  it('should batch insert token usage', async () => {
    const dataArray = [
      {
        machine_id: 'test-machine',
        session_id: 'test-session',
        project_path: '/test/project',
        message_id: 'test-msg-3',
        model: 'claude-sonnet-4-6',
        timestamp: Date.now(),
        input_tokens: 100,
        output_tokens: 50
      },
      {
        machine_id: 'test-machine',
        session_id: 'test-session',
        project_path: '/test/project',
        message_id: 'test-msg-4',
        model: 'claude-sonnet-4-6',
        timestamp: Date.now(),
        input_tokens: 200,
        output_tokens: 100
      }
    ];

    const inserted = await batchInsertTokenUsage(dataArray);
    assert.strictEqual(inserted, 2);
  });
});
```

**Step 4: 运行测试**

```bash
node --test tests/token-storage.test.js
```

Expected: 所有测试通过

**Step 5: Commit**

```bash
git add lib/token-storage.js tests/token-storage.test.js package.json package-lock.json
git commit -m "feat(storage): add PostgreSQL token storage layer

- 实现 initDatabase() 初始化表结构
- 实现 insertTokenUsage() 插入单条记录
- 实现 batchInsertTokenUsage() 批量插入
- 使用 message_id 去重
- 添加单元测试

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## 阶段 2: 历史数据扫描

### Task 2: 实现 transcript 文件扫描器

**Files:**
- Create: `lib/token-scanner.js`
- Test: `tests/token-scanner.test.js`

**实现要点:**
- 扫描 `~/.claude/projects/**/*.jsonl` 文件
- 解析每行 JSON，提取 usage 数据
- 批量插入数据库（每 100 条一批）
- 记录扫描进度到 `~/.vibeanything/scan-progress.json`
- 支持断点续传

详细实现代码请参考设计文档中的 token-scanner.js 部分。

**Step 1: 创建 token-scanner.js**

**Step 2: 编写测试**

**Step 3: 运行测试并验证**

**Step 4: Commit**

---

### Task 3: 实现统计查询 API

**Files:**
- Create: `lib/token-stats.js`
- Create: `packages/server/routes/stats.js`
- Modify: `packages/server/index.js`
- Test: `tests/token-stats.test.js`

**实现要点:**
- 实现多维度聚合查询（按机器/项目/session/时间）
- 支持时间范围过滤
- 支持分页和排序
- 返回统一的 JSON 格式

**Step 1: 创建 token-stats.js 查询逻辑**

**Step 2: 创建 stats.js API 路由**

**Step 3: 在 index.js 中注册路由**

**Step 4: 编写测试**

**Step 5: Commit**

---

## 阶段 3: 实时追踪

### Task 4: 实现 PostToolUse hook

**Files:**
- Create: `hooks/token-tracker.js`
- Modify: `~/.claude/settings.json` (手动配置)
- Test: 手动测试

**实现要点:**
- 读取 conversation context
- 提取最新 assistant message 的 usage 数据
- 异步写入数据库
- 错误不影响主流程

**Step 1: 创建 token-tracker.js**

**Step 2: 配置 hook 到 settings.json**

**Step 3: 手动测试 hook 触发**

**Step 4: Commit**

---

## 阶段 4: 数据库迁移

### Task 5: 实现 SQLite 到 PostgreSQL 迁移

**Files:**
- Create: `packages/server/db-migration.js`
- Modify: `packages/server/auth.js`

**实现要点:**
- 读取 SQLite users.db
- 导出用户数据
- 写入 PostgreSQL
- 更新 auth.js 使用 PostgreSQL

**Step 1: 创建迁移脚本**

**Step 2: 更新 auth.js**

**Step 3: 运行迁移并验证**

**Step 4: Commit**

---

## 阶段 5: Daemon 集成

### Task 6: 在 daemon 中集成 token 扫描

**Files:**
- Modify: `lib/daemon.js`

**实现要点:**
- daemon 启动时初始化数据库
- 后台启动 token-scanner
- 不阻塞 daemon 主流程

**Step 1: 修改 daemon.js**

**Step 2: 测试 daemon 启动**

**Step 3: Commit**

---

## 阶段 6: 飞书推送

### Task 7: 实现飞书定时推送

**Files:**
- Create: `lib/token-report.js`
- Modify: `lib/daemon.js`

**实现要点:**
- 使用 node-cron 定时任务
- 查询昨日/上周统计数据
- 构建飞书卡片
- 推送到飞书群

**Step 1: 创建 token-report.js**

**Step 2: 在 daemon 中注册定时任务**

**Step 3: 测试推送**

**Step 4: Commit**

---

## 阶段 7: Web Dashboard 前端

### Task 8: 实现统计页面

**Files:**
- Create: `packages/server/frontend/src/Stats.jsx`
- Create: `packages/server/frontend/src/components/TokenChart.jsx`
- Modify: `packages/server/frontend/src/App.jsx`

**实现要点:**
- 添加统计页面路由
- 实现图表展示（使用 recharts）
- 支持多维度切换
- 支持时间范围选择

**Step 1: 创建 Stats.jsx**

**Step 2: 创建 TokenChart.jsx**

**Step 3: 更新 App.jsx 路由**

**Step 4: 构建前端**

**Step 5: Commit**

---

## 阶段 8: 配置和文档

### Task 9: 更新配置和文档

**Files:**
- Modify: `lib/config.js`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**实现要点:**
- 添加数据库配置项
- 添加 token 统计配置项
- 更新 README 说明
- 更新 CLAUDE.md 常用命令

**Step 1: 更新 config.js**

**Step 2: 更新 README.md**

**Step 3: 更新 CLAUDE.md**

**Step 4: Commit**

---

## 阶段 9: 集成测试

### Task 10: 端到端测试

**Files:**
- Create: `tests/integration/token-stats-e2e.test.js`

**实现要点:**
- 测试完整流程：扫描 → 存储 → 查询 → 展示
- 测试 hook 实时追踪
- 测试飞书推送
- 测试 API 查询

**Step 1: 创建集成测试**

**Step 2: 运行测试**

**Step 3: 修复发现的问题**

**Step 4: Commit**

---

## 阶段 10: 部署和验证

### Task 11: 生产部署

**Files:**
- 无需修改代码

**Step 1: 在生产环境安装 PostgreSQL**

**Step 2: 更新配置文件**

**Step 3: 运行迁移脚本**

**Step 4: 重启 daemon 和 server**

**Step 5: 验证功能正常**

**Step 6: 更新 LESSONS_LEARNED.md**

---

## 总结

本实现计划包含 11 个主要任务，涵盖：
1. 数据访问层（PostgreSQL）
2. 历史数据扫描
3. 统计查询 API
4. 实时追踪 hook
5. 数据库迁移
6. Daemon 集成
7. 飞书推送
8. Web Dashboard 前端
9. 配置和文档
10. 集成测试
11. 生产部署

每个任务都遵循 TDD 原则：先写测试，再实现功能，最后提交代码。

**预计工作量:** 2-3 天（每个任务 2-4 小时）

**关键依赖:**
- PostgreSQL 12+
- Node.js 18+
- pg (node-postgres)
- node-cron (定时任务)
- recharts (图表库)

**风险点:**
1. PostgreSQL 连接配置可能需要调试
2. 历史数据扫描可能耗时较长（取决于 transcript 文件数量）
3. 前端图表库集成可能需要额外调试

**缓解措施:**
1. 提供详细的配置示例和错误提示
2. 扫描进度可视化，支持断点续传
3. 使用成熟的图表库（recharts）减少开发成本
