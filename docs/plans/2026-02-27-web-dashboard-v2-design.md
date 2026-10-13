# Web Dashboard v2 设计文档

日期：2026-02-27
分支：feat/web-dashboard

## 概述

在现有 Web Dashboard 基础上，新增 6 个功能模块：
1. PTY 默认命令可配置（默认 `claude`）+ 历史 session 列表
2. 文件浏览器（新建终端入口）
3. 连接已有 session（基于 JSONL mtime 发现）
4. Terminal input bug 修复（已完成）
5. Pixel Agents 像素可视化集成
6. 项目 monorepo 模块化拆分

---

## 模块1：PTY 默认命令 + 历史 Session 列表

### PTY 命令可配置

`pty_open` 消息增加可选 `command` 字段（字符串数组），ws-client 用该命令替代硬编码 bash：

```json
{ "type": "pty_open", "sessionId": "...", "cols": 220, "rows": 50,
  "command": ["claude"], "cwd": "/path/to/dir" }
```

默认值：`["claude"]`。支持：
- `["claude"]` — 新建 CC session
- `["claude", "--resume", "<sessionId>"]` — 恢复历史 session
- `["tmux", "attach-session", "-t", "<name>"]` — attach tmux
- `["bash"]` — 普通 shell

### 历史 Session 列表

后端新增 `scan_history` WS 消息，ws-client 扫描 `~/.claude/projects/**/*.jsonl`，
每个文件读取第一条含 `cwd`/`sessionId`/`timestamp`/`gitBranch` 的行，
返回去重后的 session 列表（按 timestamp 降序）。

前端左侧面板新增 **历史** tab，每条显示：
- sessionId 前8位
- cwd（取最后一段目录名）
- 日期
- git branch
- 第一条用户消息摘要（前60字）

hover 时右侧出现两个按钮：`[▶]`（新建，tooltip: 在此目录启动 claude）、`[↩]`（恢复，tooltip: claude --resume）

---

## 模块2：文件浏览器

左侧面板顶部 `[+]` 按钮，点击展开新建终端面板，三合一布局：

```
┌─────────────────────────────┐
│ 最近目录（从历史 session 取）  │
│  /share/user/hooks  [▶] │
│  /root/pixel-agents     [▶] │
├─────────────────────────────┤
│ 目录树  [当前路径]            │
│  ▶ vibeanything │
│  ▶ yoloworldSAM             │
├─────────────────────────────┤
│ 手动输入: [____________] [▶] │
└─────────────────────────────┘
```

后端新增 `list_dir` WS 消息，ws-client 返回指定路径的子目录列表（只列目录，不列文件）。
点击任意 `[▶]` 发送 `pty_open`，command=`["claude"]`，cwd=选定路径。

---

## 模块3：连接已有 Session（JSONL mtime 发现）

### 发现机制

参考 pixel-agents `feature/adopt-existing-sessions` 分支：
扫描 `~/.claude/projects/**/*.jsonl`，mtime < 30s 视为活跃 session。
不依赖 tmux/进程，bash/tmux/任何终端里的 CC 均可发现。

### 前端

左侧面板新增 **运行中** tab，ws-client 每 10s 推送一次活跃 session 列表。
每条显示 cwd、sessionId 前8位、最后活跃时间。
点击直接 `pty_open`，command=`["claude", "--resume", "<sessionId>"]`。

### WS 消息

```json
// 服务端 → 浏览器（每10s）
{ "type": "active_sessions", "machineId": "local-dev",
  "sessions": [{ "sessionId": "...", "cwd": "...", "mtime": 1234567890 }] }
```

---

## 模块5：Pixel Agents 像素可视化

### 数据源

ws-client 监听 hooks 事件（通过 IPC），实时推送 agent 状态：

```json
{ "type": "agent_status", "sessionId": "...", "status": "active|waiting|idle",
  "toolName": "Read", "toolStatus": "Reading config.js" }
```

同时扫描 JSONL mtime 发现活跃 session（复用模块3逻辑）。

### 前端

Dashboard 右上角切换按钮 `[终端] [像素]`。

像素视图：
- 复用 `georgetrad/pixel-agents` webview-ui React 组件（MIT）
- 将 VS Code `postMessage` API 替换为 WebSocket 消息
- 每个活跃 CC session 对应一个像素角色
- 角色动画：active=typing，waiting=speech bubble，idle=walking

Attribution（像素视图底部）：
> Pixel art inspired by [Pixel Agents](https://github.com/georgetrad/pixel-agents) by Pablo De Lucca — MIT License

---

## 模块6：Monorepo 模块化拆分

### 目标结构

```
packages/
  core/        # config, ipc, session-registry, message-queue
  feishu/      # feishu-app, feishu-webhook, card-builder, sender
  daemon/      # daemon.js, ws-client.js, pty-manager.js
  server/      # 中央服务器（现有，迁移）
  cli/         # bin/cli.js + 配置向导
hooks/         # 保持不动（CC hooks 入口，轻量）
```

### 依赖关系

```
cli → daemon → core
cli → feishu → core
server（独立，无内部依赖）
hooks → core（仅 ipc）
```

### 根 package.json

```json
{
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm test --workspaces"
  }
}
```

每个包有独立 `package.json`，只声明自己实际需要的依赖。

---

## 测试计划

每个模块配套单元测试：
- `tests/pty-command.test.js` — pty_open command 字段解析
- `tests/session-history.test.js` — JSONL 扫描与解析
- `tests/file-browser.test.js` — list_dir 消息处理
- `tests/active-sessions.test.js` — mtime 发现逻辑
- `tests/agent-status.test.js` — hooks → agent_status 事件

## README 更新

- 主 README 新增"Web Dashboard"章节图例
- 各 package 有独立 README
