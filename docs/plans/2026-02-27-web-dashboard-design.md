# Web Dashboard 设计文档

**日期：** 2026-02-27
**状态：** 已批准，待实施

## 目标

为 vibeanything 添加 Web Dashboard，支持：
- 多台开发机的多个 Claude Code session 统一管理
- 浏览器内完整 PTY 终端（可输入）
- 用户名+密码登录保护
- 保留现有飞书通知与双向交互功能

## 整体架构

```
┌──────────────────────────────────────────────────────┐
│                  中央 Web Server (新)                  │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Auth    │  │  WS Relay    │  │  React SPA     │  │
│  │  (JWT)   │  │  (消息路由)   │  │  (xterm.js)    │  │
│  └──────────┘  └──────────────┘  └────────────────┘  │
└───────────────────────┬──────────────────────────────┘
                        │ WebSocket (machine token 认证)
           ┌────────────┴────────────┐
           │                         │
  ┌────────▼───────┐       ┌─────────▼──────┐
  │   开发机 A      │       │   开发机 B      │
  │   daemon (改)   │       │   daemon (改)   │
  │   ├─ PTY 管理   │       │   ├─ PTY 管理   │
  │   ├─ 飞书通信   │       │   ├─ 飞书通信   │
  │   └─ ws-client  │       │   └─ ws-client  │
  └────────────────┘       └────────────────┘
```

## 新增组件

### 1. `packages/server/` — 中央 Web Server

独立 Node.js 应用，部署在公网服务器。

**文件结构：**
```
packages/server/
├── index.js          # 入口，Express + WS server
├── auth.js           # JWT 认证、用户管理
├── relay.js          # WebSocket 中继（浏览器 ↔ 开发机）
├── users.db          # SQLite 用户数据库（gitignore）
├── package.json
└── frontend/         # React SPA（构建产物）
    └── dist/
```

**依赖：** express, ws, jsonwebtoken, bcryptjs, better-sqlite3

### 2. `lib/pty-manager.js` — PTY 管理（开发机）

- 用 `node-pty` spawn `/bin/bash`
- 维护 PTY 实例映射 `Map<sessionId, pty>`
- 提供 `create(sessionId)`, `write(sessionId, data)`, `resize(sessionId, cols, rows)`, `destroy(sessionId)` 接口

### 3. `lib/ws-client.js` — WebSocket 客户端（开发机）

- daemon 启动时连接中央服务器
- 携带 `machineToken` 认证
- 转发 PTY stdout → 中央服务器
- 接收中央服务器的 stdin 输入 → PTY

### 4. 前端 SPA (`packages/server/frontend/`)

**技术栈：** React + Vite + xterm.js + xterm-addon-fit

**页面：**
- `/login` — 用户名+密码登录
- `/` — Dashboard（需登录）

**Dashboard 布局：**
```
┌─────────────────────────────────────────────────────┐
│  Claude Code Dashboard          [用户名] [退出]      │
├──────────────┬──────────────────────────────────────┤
│ Sessions     │  开发机A / session-abc  [×]           │
│              │  ┌────────────────────────────────┐  │
│ 开发机A  ●   │  │                                │  │
│  session-abc │  │   xterm.js PTY terminal        │  │
│  session-xyz │  │                                │  │
│              │  └────────────────────────────────┘  │
│ 开发机B  ●   │                                      │
│  session-123 │  [飞书通知状态: ✅]                   │
└──────────────┴──────────────────────────────────────┘
```

## 认证与安全

### 用户认证（浏览器）
- SQLite `users` 表：`id, username, password_hash, created_at`
- 密码 bcrypt 哈希（cost=12）
- 登录返回 JWT（24h 有效），存 localStorage
- 所有 API 和 WebSocket 连接验证 JWT

### 机器认证（开发机 daemon）
- 每台开发机配置唯一 `machineToken`（UUID）
- daemon 连接中央服务器时在 WebSocket 握手 header 携带 token
- 中央服务器验证 token 后建立机器连接

### 初始用户
- 首次启动中央服务器时，通过 CLI 创建管理员账号：
  ```bash
  node packages/server/index.js --create-user admin
  ```

## PTY 终端流

```
浏览器键盘输入
    │
    ▼ WebSocket (JWT)
中央 server relay.js
    │
    ▼ WebSocket (machineToken)
开发机 daemon ws-client.js
    │
    ▼ node-pty stdin
PTY (/bin/bash)
    │
    ▼ node-pty stdout
开发机 daemon ws-client.js
    │
    ▼ WebSocket
中央 server relay.js
    │
    ▼ WebSocket
浏览器 xterm.js 渲染
```

**启动方式：**
```bash
# 开发机：启动带 PTY 的 daemon
npx vibeanything --daemon start
# daemon 自动连接中央服务器，等待浏览器打开终端
```

浏览器点击 session 时，中央服务器通知开发机 daemon 创建 PTY，返回终端流。

## WebSocket 消息协议

```jsonc
// 开发机 → 中央服务器
{ "type": "register", "machineId": "dev-a", "machineToken": "xxx" }
{ "type": "session_list", "sessions": [{ "id": "abc", "cwd": "/project" }] }
{ "type": "pty_data", "sessionId": "abc", "data": "<base64 terminal output>" }

// 中央服务器 → 开发机
{ "type": "pty_open", "sessionId": "abc", "cols": 220, "rows": 50 }
{ "type": "pty_input", "sessionId": "abc", "data": "<base64 keystrokes>" }
{ "type": "pty_resize", "sessionId": "abc", "cols": 220, "rows": 50 }
{ "type": "pty_close", "sessionId": "abc" }

// 浏览器 → 中央服务器
{ "type": "open_terminal", "machineId": "dev-a", "sessionId": "abc" }
{ "type": "terminal_input", "machineId": "dev-a", "sessionId": "abc", "data": "..." }
{ "type": "terminal_resize", "machineId": "dev-a", "sessionId": "abc", "cols": 220, "rows": 50 }
```

## 现有功能保留

- 飞书通知（notify.js）：不变
- 飞书双向交互（interactive.js）：不变
- 危险命令拦截（guard.js）：不变
- IPC 文件通信：不变
- session-registry、message-queue：不变

daemon 新增 ws-client 和 pty-manager，与现有逻辑并行运行，互不干扰。

## 部署方式

```bash
# 中央服务器
cd packages/server
npm install
node index.js --create-user admin   # 首次创建管理员
node index.js --port 3000           # 启动（反代到 nginx）

# 开发机（现有流程不变，新增 centralServerUrl 配置）
npx vibeanything        # 重新配置，填入中央服务器地址和 machineToken
npx vibeanything --daemon start
```

## 待实现（不在本期范围）

- 按用户授权访问特定机器
- 录制/回放终端会话
- 移动端适配
