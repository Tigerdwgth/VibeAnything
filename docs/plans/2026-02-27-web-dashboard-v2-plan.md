# Web Dashboard v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 Web Dashboard v2 的 6 个功能模块：PTY命令可配置+历史session、文件浏览器、运行中session发现、terminal input bug修复（已完成）、Pixel Agents集成、monorepo拆分。

**Architecture:** ws-client 在开发机扫描 JSONL 文件并通过 WebSocket 推送数据；relay 转发浏览器↔机器消息；前端 React SPA 新增三 tab 侧边栏 + 像素视图切换。

**Tech Stack:** Node.js, ws, node-pty, React, xterm.js, pixel-agents webview-ui (MIT)

---

### Task 1: PTY 命令可配置 + cwd 支持

**Files:**
- Modify: `lib/pty-manager.js`
- Modify: `lib/ws-client.js`
- Test: `tests/pty-command.test.js`

**Step 1: 写失败测试**

```js
// tests/pty-command.test.js
const { PtyManager } = require('../lib/pty-manager');
test('create with custom command', () => {
  const mgr = new PtyManager();
  // 验证 create 接受 command 和 cwd 参数不抛出
  expect(() => mgr.create('s1', { command: ['echo', 'hi'], cwd: '/tmp', cols: 80, rows: 24, onData: ()=>{}, onExit: ()=>{} })).not.toThrow();
  mgr.destroyAll();
});
test('create defaults to claude', () => {
  const mgr = new PtyManager();
  // 验证默认 command 是 claude（通过 _ptys 内部状态）
  const p = mgr.create('s2', { cols: 80, rows: 24, onData: ()=>{}, onExit: ()=>{} });
  expect(p).toBeTruthy();
  mgr.destroyAll();
});
```

**Step 2: 运行测试确认失败**

```bash
node --test tests/pty-command.test.js 2>&1 | head -20
```

**Step 3: 修改 lib/pty-manager.js**

将 `create(sessionId, { cols, rows, onData, onExit })` 改为：

```js
create(sessionId, { cols = 220, rows = 50, command, cwd, onData, onExit } = {}) {
  if (this._ptys.has(sessionId)) this.destroy(sessionId);
  const cmd = (command && command.length > 0) ? command[0] : 'claude';
  const args = (command && command.length > 1) ? command.slice(1) : [];
  const workdir = cwd || process.env.HOME || '/';
  const p = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: workdir,
    env: process.env
  });
  if (onData) p.onData(onData);
  if (onExit) p.onExit(onExit);
  this._ptys.set(sessionId, p);
  return p;
}
```

**Step 4: 修改 lib/ws-client.js**

在 `pty_open` 处理中传递 command 和 cwd：

```js
if (msg.type === 'pty_open') {
  this._pty.create(msg.sessionId, {
    cols: msg.cols, rows: msg.rows,
    command: msg.command,   // 新增
    cwd: msg.cwd,           // 新增
    onData: (data) => { ... },
    onExit: () => { ... }
  });
}
```

**Step 5: 运行测试确认通过**

```bash
node --test tests/pty-command.test.js
```

**Step 6: Commit**

```bash
git add lib/pty-manager.js lib/ws-client.js tests/pty-command.test.js
git commit -m "feat: pty_open 支持 command 和 cwd 字段，默认启动 claude"
```

---

### Task 2: 历史 Session 列表（后端）

**Files:**
- Modify: `lib/ws-client.js`
- Test: `tests/session-history.test.js`

**Step 1: 写失败测试**

```js
// tests/session-history.test.js
const { scanSessionHistory } = require('../lib/ws-client');
test('scanSessionHistory returns array', async () => {
  const result = await scanSessionHistory();
  expect(Array.isArray(result)).toBe(true);
});
test('session has required fields', async () => {
  const result = await scanSessionHistory();
  if (result.length > 0) {
    expect(result[0]).toHaveProperty('sessionId');
    expect(result[0]).toHaveProperty('cwd');
    expect(result[0]).toHaveProperty('timestamp');
  }
});
```

**Step 2: 运行测试确认失败**

```bash
node --test tests/session-history.test.js 2>&1 | head -10
```

**Step 3: 在 lib/ws-client.js 新增 scanSessionHistory 函数**

```js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { glob } = require('node:fs/promises'); // Node 22+，或用 fast-glob

async function scanSessionHistory() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const sessions = new Map(); // sessionId → entry
  let files = [];
  try {
    // 递归找所有 .jsonl 文件
    for await (const f of fs.readdirSync(base, { recursive: true })
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(base, f))) {
      files.push(f);
    }
  } catch { return []; }
  // 改用同步递归
  files = findJsonlFiles(base);
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.sessionId && d.cwd && !sessions.has(d.sessionId)) {
            // 读第一条 user message 作为摘要
            let summary = '';
            for (const l2 of content.split('\n')) {
              try {
                const d2 = JSON.parse(l2);
                if (d2.type === 'user' && d2.message?.content) {
                  const c = d2.message.content;
                  summary = Array.isArray(c)
                    ? (c.find(x => x.type === 'text')?.text || '').slice(0, 60)
                    : String(c).slice(0, 60);
                  break;
                }
              } catch {}
            }
            sessions.set(d.sessionId, {
              sessionId: d.sessionId,
              cwd: d.cwd,
              timestamp: d.timestamp || '',
              gitBranch: d.gitBranch || '',
              summary
            });
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return [...sessions.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function findJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findJsonlFiles(full));
      else if (entry.name.endsWith('.jsonl')) results.push(full);
    }
  } catch {}
  return results;
}

module.exports = { WsClient, scanSessionHistory };
```

**Step 4: 在 WsClient._handleMessage 中处理 scan_history**

```js
} else if (msg.type === 'scan_history') {
  scanSessionHistory().then(sessions => {
    this._send({ type: 'session_history', sessions });
  });
}
```

**Step 5: 运行测试**

```bash
node --test tests/session-history.test.js
```

**Step 6: Commit**

```bash
git add lib/ws-client.js tests/session-history.test.js
git commit -m "feat: ws-client 支持 scan_history，返回历史 session 列表"
```

---

### Task 3: 运行中 Session 发现（JSONL mtime）

**Files:**
- Modify: `lib/ws-client.js`
- Test: `tests/active-sessions.test.js`

**Step 1: 写失败测试**

```js
// tests/active-sessions.test.js
const { scanActiveSessions } = require('../lib/ws-client');
test('scanActiveSessions returns array', () => {
  const result = scanActiveSessions();
  expect(Array.isArray(result)).toBe(true);
});
test('active session has mtime', () => {
  const result = scanActiveSessions();
  for (const s of result) {
    expect(s).toHaveProperty('sessionId');
    expect(s).toHaveProperty('cwd');
    expect(typeof s.mtime).toBe('number');
  }
});
```

**Step 2: 运行测试确认失败**

```bash
node --test tests/active-sessions.test.js 2>&1 | head -10
```

**Step 3: 在 lib/ws-client.js 新增 scanActiveSessions**

```js
const ACTIVE_THRESHOLD_MS = 30_000;

function scanActiveSessions() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const files = findJsonlFiles(base);
  const now = Date.now();
  const active = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > ACTIVE_THRESHOLD_MS) continue;
      // 读 sessionId 和 cwd
      const content = fs.readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.sessionId && d.cwd) {
            active.push({ sessionId: d.sessionId, cwd: d.cwd, mtime: stat.mtimeMs });
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return active;
}
module.exports = { WsClient, scanSessionHistory, scanActiveSessions };
```

**Step 4: WsClient 连接后每 10s 推送活跃 session**

在 `ws.on('open', ...)` 中启动定时器：

```js
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', machineId: this._machineId }));
  this._sendSessionList();
  this._startActiveSessionPoller();
});

_startActiveSessionPoller() {
  if (this._activePoller) clearInterval(this._activePoller);
  this._activePoller = setInterval(() => {
    const sessions = scanActiveSessions();
    this._send({ type: 'active_sessions', sessions });
  }, 10_000);
}
```

在 `disconnect()` 中清理：`if (this._activePoller) clearInterval(this._activePoller);`

**Step 5: relay.js 转发 active_sessions 到浏览器**

在 `handleMachineMessage` 中新增：

```js
if (msg.type === 'active_sessions') {
  for (const browser of this.browsers.values()) {
    if (browser.ws.readyState === 1) {
      browser.ws.send(JSON.stringify({ ...msg, machineId }));
    }
  }
}
```

**Step 6: 运行测试**

```bash
node --test tests/active-sessions.test.js
```

**Step 7: Commit**

```bash
git add lib/ws-client.js packages/server/relay.js tests/active-sessions.test.js
git commit -m "feat: 每10s扫描活跃CC session（JSONL mtime），推送到浏览器"
```

---

### Task 4: 文件浏览器后端（list_dir）

**Files:**
- Modify: `lib/ws-client.js`
- Test: `tests/file-browser.test.js`

**Step 1: 写失败测试**

```js
// tests/file-browser.test.js
const { listDir } = require('../lib/ws-client');
test('listDir returns dirs only', () => {
  const result = listDir('/tmp');
  expect(Array.isArray(result)).toBe(true);
  for (const entry of result) {
    expect(entry).toHaveProperty('name');
    expect(entry).toHaveProperty('path');
  }
});
test('listDir handles missing path', () => {
  const result = listDir('/nonexistent/path/xyz');
  expect(result).toEqual([]);
});
```

**Step 2: 运行测试确认失败**

```bash
node --test tests/file-browser.test.js 2>&1 | head -10
```

**Step 3: 新增 listDir 函数**

```js
function listDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
module.exports = { WsClient, scanSessionHistory, scanActiveSessions, listDir };
```

**Step 4: WsClient 处理 list_dir 消息**

```js
} else if (msg.type === 'list_dir') {
  const entries = listDir(msg.path || os.homedir());
  this._send({ type: 'dir_entries', path: msg.path, entries });
}
```

**Step 5: relay.js 转发 list_dir 请求和 dir_entries 响应**

handleBrowserMessage 新增：
```js
if (msg.type === 'list_dir') {
  const machine = this.machines.get(msg.machineId);
  if (machine?.ws.readyState === 1) machine.ws.send(JSON.stringify(msg));
}
```

handleMachineMessage 新增：
```js
if (msg.type === 'dir_entries') {
  for (const b of this.browsers.values()) {
    if (b.ws.readyState === 1) b.ws.send(JSON.stringify(msg));
  }
}
```

**Step 6: 运行测试**

```bash
node --test tests/file-browser.test.js
```

**Step 7: Commit**

```bash
git add lib/ws-client.js packages/server/relay.js tests/file-browser.test.js
git commit -m "feat: ws-client 支持 list_dir，返回目录列表"
```

---

### Task 5: 前端 — 三 Tab 侧边栏 + 文件浏览器

**Files:**
- Modify: `packages/server/frontend/src/Dashboard.jsx`
- Create: `packages/server/frontend/src/SessionTabs.jsx`
- Create: `packages/server/frontend/src/FileBrowser.jsx`

**Step 1: 创建 SessionTabs.jsx**

三个 tab：活跃 / 运行中 / 历史。接收 props：
- `sessions` — 活跃 session 列表（现有）
- `activeSessions` — 运行中列表（mtime）
- `historySessions` — 历史列表
- `active` — 当前选中
- `onOpen(machineId, sessionId, command, cwd)` — 打开终端回调

历史 tab 每行 hover 显示 `[▶]` `[↩]` 按钮。

**Step 2: 创建 FileBrowser.jsx**

接收 props：`ws`, `machineId`, `onLaunch(cwd)`

三个区域：
1. 最近目录（从 historySessions 取前5个唯一 cwd）
2. 目录树（发送 list_dir，展示可展开列表）
3. 手动输入框

**Step 3: 修改 Dashboard.jsx**

- 左侧面板顶部加 `[+]` 按钮，点击展开 FileBrowser
- 将 session 列表替换为 `<SessionTabs>`
- WebSocket onmessage 新增处理 `session_history`、`active_sessions`、`dir_entries`
- `openTerminal` 函数接受可选 `command` 和 `cwd` 参数

**Step 4: 构建前端**

```bash
cd packages/server/frontend && npm run build
```

Expected: 构建成功，无错误

**Step 5: Commit**

```bash
git add packages/server/frontend/src/
git commit -m "feat: 三Tab侧边栏（活跃/运行中/历史）+ 文件浏览器"
```

---

### Task 6: Pixel Agents 集成

**Files:**
- Create: `packages/server/frontend/src/PixelView.jsx`
- Modify: `packages/server/frontend/src/Dashboard.jsx`
- Modify: `lib/ws-client.js`
- Modify: `hooks/notify.js`

**Step 1: 克隆 pixel-agents webview-ui 组件**

```bash
cd /tmp && https_proxy=http://127.0.0.1:7890 git clone --depth=1 https://github.com/georgetrad/pixel-agents.git
cp -r /tmp/pixel-agents/webview-ui/src/office packages/server/frontend/src/pixel-office
cp -r /tmp/pixel-agents/webview-ui/src/hooks packages/server/frontend/src/pixel-hooks
cp /tmp/pixel-agents/webview-ui/src/constants.ts packages/server/frontend/src/pixel-constants.ts
```

**Step 2: 安装 pixel-agents 前端依赖**

```bash
cd packages/server/frontend && npm install
```

**Step 3: 创建 PixelView.jsx**

替换 `vscodeApi.ts` 的 `vscode.postMessage` 为 WebSocket 发送，
替换 `window.addEventListener('message', ...)` 为 WebSocket onmessage。

核心：创建 `useWsMessages(ws)` hook 替代 `useExtensionMessages`，
将 `agent_status` WS 消息映射到 pixel-agents 的消息格式：

```js
// WS agent_status → pixel-agents agentStatus
{ type: 'agent_status', sessionId, status, toolName, toolStatus }
→ { type: 'agentStatus', id: agentNumericId, status }
→ { type: 'agentToolStart', id, toolId, status: toolStatus }
```

底部 attribution：
```jsx
<div style={{fontSize:'0.65rem', color:'#444', textAlign:'center', padding:'4px'}}>
  Pixel art inspired by{' '}
  <a href="https://github.com/georgetrad/pixel-agents" target="_blank">Pixel Agents</a>
  {' '}by Pablo De Lucca — MIT License
</div>
```

**Step 4: hooks/notify.js 推送 agent_status 到 ws-client**

在 PreToolUse hook 触发时，通过 IPC 写入 agent_status 事件，
ws-client 读取后推送到中央服务器。

在 ws-client 的 IPC 轮询中新增：
```js
// 读取 agent_status 事件文件
const statusFile = path.join(getBaseDir(), 'ipc', 'agent-status.json');
if (fs.existsSync(statusFile)) {
  const events = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
  for (const e of events) this._send({ type: 'agent_status', ...e });
  fs.unlinkSync(statusFile);
}
```

**Step 5: Dashboard.jsx 新增切换按钮**

右上角加 `[终端] [像素]` toggle，切换显示 TerminalPanel 或 PixelView。

**Step 6: 构建并测试**

```bash
cd packages/server/frontend && npm run build 2>&1 | tail -5
```

**Step 7: Commit**

```bash
git add packages/server/frontend/src/ hooks/notify.js lib/ws-client.js
git commit -m "feat: Pixel Agents 像素可视化集成（MIT attribution）"
```

---

### Task 7: Monorepo 拆分

**Files:**
- Create: `packages/core/package.json`, `packages/core/index.js`
- Create: `packages/feishu/package.json`, `packages/feishu/index.js`
- Create: `packages/daemon/package.json`, `packages/daemon/index.js`
- Create: `packages/cli/package.json`, `packages/cli/index.js`
- Modify: `package.json` (根)
- Move: `lib/*.js` → 对应 package

**Step 1: 创建根 package.json workspaces**

```json
{
  "name": "vibeanything-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node --test tests/*.test.js",
    "build:frontend": "npm run build --workspace=packages/server"
  }
}
```

**Step 2: 创建 packages/core**

移入：`config.js`, `ipc.js`, `session-registry.js`, `message-queue.js`

```json
// packages/core/package.json
{
  "name": "@claude-hooks-feishu/core",
  "version": "1.0.0",
  "main": "index.js"
}
```

**Step 3: 创建 packages/feishu**

移入：`feishu-app.js`, `feishu-webhook.js`, `card-builder.js`, `sender.js`

依赖：`@larksuiteoapi/node-sdk`, `@claude-hooks-feishu/core`

**Step 4: 创建 packages/daemon**

移入：`daemon.js`, `ws-client.js`, `pty-manager.js`

依赖：`ws`, `node-pty`, `@claude-hooks-feishu/core`, `@claude-hooks-feishu/feishu`

**Step 5: 创建 packages/cli**

移入：`bin/cli.js` + 配置向导逻辑

依赖：`@claude-hooks-feishu/daemon`, `@claude-hooks-feishu/feishu`

**Step 6: 更新所有 require 路径**

将 `require('./config')` → `require('@claude-hooks-feishu/core/config')` 等。

hooks/ 中的 require 路径更新为 `require('@claude-hooks-feishu/core/ipc')`。

**Step 7: 运行全量测试**

```bash
npm test
```

Expected: 所有测试通过

**Step 8: Commit**

```bash
git add packages/ bin/ hooks/ package.json
git commit -m "refactor: monorepo 拆分为 core/feishu/daemon/cli/server 五个包"
```

---

## 执行顺序建议

Task 1 → 2 → 3 → 4（后端，可并行）→ Task 5（前端）→ Task 6（Pixel）→ Task 7（monorepo，最后做，影响最大）

Task 7 建议单独一个 PR，其余合并为一个 PR。
