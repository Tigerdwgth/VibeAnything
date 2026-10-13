# Token 用量统计功能设计文档

## 概述

为 vibeanything 项目增加 token 用量统计功能，支持多维度统计 Claude Code 的 token 使用情况，并在 Web Dashboard 和飞书中展示。

## 需求

### 功能需求

1. **统计维度**
   - 按开发机统计（每台机器的总用量）
   - 按项目统计（每个项目目录的用量）
   - 按 session 统计（每个对话会话的用量）
   - 按时间段统计（每天/每周/每月的用量）

2. **展示位置**
   - Web Dashboard 显示统计图表和详细数据
   - 飞书定期推送统计报告（每天/每周）

3. **数据来源**
   - 扫描并统计所有历史 transcript 文件（`~/.claude/projects/**/*.jsonl`）
   - 实时追踪新的 token 使用（通过 hook）

4. **扩展性**
   - 当前只支持 Claude，但架构设计支持未来扩展 Codex/Gemini

### 非功能需求

1. **性能**
   - 历史数据扫描不阻塞 daemon 启动
   - 实时追踪不影响 Claude Code 主流程
   - 查询响应时间 < 1 秒

2. **可靠性**
   - 数据持久化存储
   - 支持断点续传（扫描中断后可继续）
   - 错误不影响主流程

## 技术方案

### 数据库选型：PostgreSQL

**迁移策略：**
- 将现有的用户认证系统从 SQLite 迁移到 PostgreSQL
- 统一使用 PostgreSQL 管理所有持久化数据

**优势：**
- 支持复杂的聚合查询和多维度统计
- 更好的并发性能，适合多机器场景
- 生产级可靠性和备份能力
- 便于统一管理和维护

### 数据库 Schema

```sql
-- 用户表（迁移现有的 SQLite）
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- token 统计表（新增）
CREATE TABLE token_usage (
  id SERIAL PRIMARY KEY,
  machine_id VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  project_path TEXT NOT NULL,
  message_id VARCHAR(255) UNIQUE NOT NULL,  -- 用于去重
  model VARCHAR(50) NOT NULL,  -- 'claude-sonnet-4-6' 等
  timestamp BIGINT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS (
    input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens
  ) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化查询
CREATE INDEX idx_token_machine ON token_usage(machine_id);
CREATE INDEX idx_token_project ON token_usage(project_path);
CREATE INDEX idx_token_session ON token_usage(session_id);
CREATE INDEX idx_token_timestamp ON token_usage(timestamp);
CREATE INDEX idx_token_model ON token_usage(model);
CREATE INDEX idx_token_message ON token_usage(message_id);
```

## 架构设计

### 新增组件

```
lib/
├── token-scanner.js      # 扫描 transcript 文件，解析 token 数据
├── token-storage.js      # PostgreSQL 数据访问层（token + users）
└── token-stats.js        # 统计查询和聚合逻辑

packages/server/
├── db-migration.js       # 数据库迁移脚本（SQLite → PostgreSQL）
└── routes/
    └── stats.js          # 统计 API 路由

hooks/
└── token-tracker.js      # PostToolUse hook，实时记录 token
```

### 数据流

#### 初始化流程

1. daemon 启动 → 连接 PostgreSQL
2. 后台任务启动 → token-scanner 扫描历史文件
3. 解析 `.jsonl` → 提取 token 数据 → 批量插入数据库（去重）

#### 实时追踪流程

1. Claude Code 执行工具 → PostToolUse hook 触发
2. token-tracker 读取当前 message 的 usage 数据
3. 写入数据库（异步，不阻塞 hook）

#### 查询流程

1. Web Dashboard / 飞书定时任务 → 调用 token-stats API
2. 执行 SQL 聚合查询（按机器/项目/session/时间）
3. 返回统计结果

## 核心组件设计

### 1. token-storage.js（数据访问层）

**核心功能：**
```javascript
- initDatabase()           // 初始化 PostgreSQL 连接和表结构
- migrateFromSqlite()      // 从 SQLite 迁移用户数据
- insertTokenUsage(data)   // 插入单条 token 记录
- batchInsertTokenUsage(dataArray)  // 批量插入（用于历史扫描）
- queryTokenStats(filters) // 查询统计数据
  // filters: { machineId?, projectPath?, sessionId?, startTime?, endTime?, groupBy? }
```

**连接池配置：**
- 使用 `pg.Pool` 管理连接
- 配置从 `~/.vibeanything/config.json` 读取
- 支持环境变量覆盖（`DATABASE_URL`）

**配置示例：**
```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "vibeanything",
    "user": "vibeanything",
    "password": "your-password",
    "max": 20,
    "idleTimeoutMillis": 30000
  }
}
```

### 2. token-scanner.js（历史扫描）

**核心功能：**
```javascript
- scanAllTranscripts()     // 扫描所有 .jsonl 文件
- parseTranscriptFile(filePath)  // 解析单个文件
- extractTokenData(message)      // 从 message 提取 token 数据
- deduplicateByMessageId()       // 使用 message_id 去重
```

**扫描策略：**
- 启动时在后台运行，不阻塞 daemon
- 使用游标批量插入（每 100 条一批）
- 记录扫描进度到 `~/.vibeanything/scan-progress.json`
- 支持断点续传（daemon 重启后继续扫描）

**进度文件格式：**
```json
{
  "lastScannedFile": "/root/.claude/projects/.../xxx.jsonl",
  "lastScannedLine": 1234,
  "totalFiles": 50,
  "scannedFiles": 25,
  "totalMessages": 10000,
  "insertedMessages": 5000,
  "startTime": 1234567890,
  "lastUpdateTime": 1234567890
}
```

### 3. token-tracker.js（实时追踪 hook）

**PostToolUse hook：**
- 触发时机：每次 Claude Code 执行工具后
- 功能：
  - 读取当前 conversation context
  - 提取最新 assistant message 的 usage 数据
  - 异步写入数据库（不阻塞 hook 返回）
  - 错误处理：失败时记录日志，不影响主流程

**数据提取逻辑：**
```javascript
// 从 transcript message 提取
{
  machine_id: getMachineId(),
  session_id: context.sessionId,
  project_path: context.cwd,
  message_id: message.uuid,
  model: message.message.model,
  timestamp: Date.parse(message.timestamp),
  input_tokens: message.message.usage.input_tokens || 0,
  output_tokens: message.message.usage.output_tokens || 0,
  cache_creation_tokens: message.message.usage.cache_creation_input_tokens || 0,
  cache_read_tokens: message.message.usage.cache_read_input_tokens || 0
}
```

## API 设计

### Web Dashboard 统计 API

**新增路由：**

1. `GET /api/stats/overview` - 总览统计
   - 返回所有机器的汇总数据
   - 支持时间范围过滤

2. `GET /api/stats/by-machine` - 按机器统计
   - 返回每台机器的用量明细
   - 支持排序和分页

3. `GET /api/stats/by-project` - 按项目统计
   - 返回每个项目的用量明细
   - 支持按机器过滤

4. `GET /api/stats/by-session` - 按 session 统计
   - 返回每个 session 的用量明细
   - 支持按项目和机器过滤

5. `GET /api/stats/trend` - 时间趋势
   - 返回按天/周/月聚合的趋势数据
   - 支持多维度对比

**查询参数：**
```javascript
{
  machineId?: string,
  projectPath?: string,
  sessionId?: string,
  startTime?: number,  // Unix timestamp
  endTime?: number,
  groupBy?: 'day' | 'week' | 'month',
  limit?: number,
  offset?: number
}
```

**返回格式示例：**
```javascript
{
  total: {
    input_tokens: 1234567,
    output_tokens: 234567,
    cache_creation_tokens: 12345,
    cache_read_tokens: 567890,
    total_tokens: 2049369
  },
  breakdown: [
    {
      dimension: 'machine-1',  // 或 project path / session id
      input_tokens: 123456,
      output_tokens: 23456,
      cache_creation_tokens: 1234,
      cache_read_tokens: 56789,
      total_tokens: 204935,
      percentage: 10.0
    }
  ],
  pagination: {
    total: 100,
    limit: 20,
    offset: 0
  }
}
```

## 飞书推送设计

### 推送时机

- **每日报告**：每天早上 9:00 推送昨日统计
- **每周报告**：每周一早上 9:00 推送上周统计

### 卡片内容

**标题：** Token 用量统计报告（日报/周报）

**内容：**
1. 总用量概览
   - 总 token 数（按类型分类）
   - 与上期对比（增长/减少百分比）

2. Top 3 项目用量排行
   - 项目路径
   - token 数量
   - 占比

3. Top 3 机器用量排行
   - 机器 ID
   - token 数量
   - 占比

4. 操作按钮
   - 查看详情（跳转到 Web Dashboard）

**卡片示例：**
```json
{
  "header": {
    "title": "Token 用量统计 - 日报",
    "template": "blue"
  },
  "elements": [
    {
      "tag": "div",
      "text": {
        "tag": "lark_md",
        "content": "**总用量：** 1,234,567 tokens\n**对比昨日：** ↑ 15.3%"
      }
    },
    {
      "tag": "hr"
    },
    {
      "tag": "div",
      "text": {
        "tag": "lark_md",
        "content": "**Top 3 项目：**\n1. /share/project-a: 456,789 tokens (37%)\n2. /share/project-b: 234,567 tokens (19%)\n3. /share/project-c: 123,456 tokens (10%)"
      }
    }
  ]
}
```

## 错误处理和容错

### 数据库连接失败

- daemon 启动时连接失败 → 记录错误日志，每 30 秒重试
- 运行时连接断开 → 自动重连，使用连接池的重连机制
- 查询超时 → 设置 30 秒超时，超时返回错误提示

### transcript 文件解析失败

- 文件格式错误 → 跳过该文件，记录到错误日志
- JSON 解析失败 → 跳过该行，继续处理下一行
- 缺少必要字段 → 使用默认值（0）填充

### hook 执行失败

- token-tracker hook 失败 → 不阻塞主流程，仅记录日志
- 数据库写入失败 → 缓存到本地文件（`~/.vibeanything/token-cache.jsonl`），下次重试

### 数据一致性

- 使用 `message_id` 作为唯一标识，避免重复插入
- 使用 `INSERT ... ON CONFLICT (message_id) DO NOTHING` 处理重复数据
- 扫描进度文件使用原子写入（写临时文件 + rename）

## 测试策略

### 单元测试

1. `tests/token-storage.test.js`
   - 测试数据库连接和初始化
   - 测试插入和查询操作
   - 测试去重逻辑

2. `tests/token-scanner.test.js`
   - 测试文件扫描和解析
   - 测试数据提取逻辑
   - 测试断点续传

3. `tests/token-stats.test.js`
   - 测试统计查询
   - 测试聚合逻辑
   - 测试时间范围过滤

### 集成测试

1. 模拟 transcript 文件，测试完整扫描流程
2. 测试 hook 触发和数据写入
3. 测试 API 查询和聚合
4. 测试飞书推送

### 性能测试

1. 测试大量历史数据的扫描性能（10000+ messages）
2. 测试并发查询性能（100 并发请求）
3. 测试数据库索引效果
4. 测试批量插入性能

## 部署和配置

### 环境要求

- PostgreSQL 12+
- Node.js 18+

### 配置步骤

1. 安装 PostgreSQL
2. 创建数据库和用户
3. 更新 `~/.vibeanything/config.json` 添加数据库配置
4. 运行迁移脚本：`node packages/server/db-migration.js`
5. 重启 daemon：`node bin/cli.js --daemon restart`

### 配置文件示例

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "vibeanything",
    "user": "vibeanything",
    "password": "your-password"
  },
  "tokenStats": {
    "enableScanning": true,
    "scanBatchSize": 100,
    "feishuReport": {
      "daily": true,
      "weekly": true,
      "time": "09:00"
    }
  }
}
```

## 未来扩展

### 支持 Codex 和 Gemini

- 在 `token-scanner.js` 中添加新的解析器
- 扫描 `~/.codex/` 和 `~/.gemini/` 目录
- 使用 `model` 字段区分不同的 AI 模型
- 统计 API 支持按 model 过滤

### 成本分析

- 根据不同模型的定价，计算实际成本
- 在统计报告中显示成本信息
- 支持预算预警

### 导出功能

- 支持导出统计数据为 CSV/Excel
- 支持自定义报表模板

## 总结

本设计文档描述了 token 用量统计功能的完整技术方案，包括：

1. 使用 PostgreSQL 统一管理持久化数据
2. 扫描历史 transcript 文件并实时追踪新数据
3. 提供多维度统计查询 API
4. 在 Web Dashboard 和飞书中展示统计结果
5. 完善的错误处理和测试策略

该方案具有良好的扩展性，未来可以轻松支持其他 AI 模型的统计。
