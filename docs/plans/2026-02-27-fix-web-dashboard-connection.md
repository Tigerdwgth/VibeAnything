# 修复 Web Dashboard 连接问题 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Web Dashboard 无法显示 terminal session 和像素人的问题

**Architecture:** 问题根因是多层数据断裂：(1) IPC sessions 目录不存在导致 `session_list` 为空；(2) `active_sessions` 消息缺少 `machineId` 导致前端无法正确关联；(3) `session_history` 缺少 `machineId` 导致历史 Tab 无法打开终端；(4) PixelView 在 activeSessions 为空时不初始化。修复策略：后端补全 machineId 注入 + 前端增强空状态处理。

**Tech Stack:** Node.js, WebSocket, React

---

## Bug 分析

### 根因 1：`session_list` 始终为空
- `ws-client.js:140` 调用 `listActiveSessions()` 读取 `~/.vibeanything/ipc/sessions/*.json`
- **该目录不存在**（已验证），所以 `session_list` 永远返回 `[]`
- 前端 "活跃" Tab 永远显示 "等待开发机连接…"

### 根因 2：`active_sessions` 缺少 machineId
- `relay.js:67-73` 转发 `active_sessions` 时注入了 `machineId`：`{ ...msg, machineId }`
- 但 `Dashboard.jsx:34` 处理时用的是 `msg.machineId`，这是正确的
- **真正问题**：`active_sessions` 每 10 秒才发一次，浏览器连接后要等最多 10 秒才能收到
- 且浏览器连接时 relay 没有主动触发一次 active_sessions 推送

### 根因 3：`session_history` 缺少 machineId
- `ws-client.js:176` 发送 `{ type: 'session_history', sessions }`
- `relay.js:70` 转发时注入 `machineId` 到消息顶层：`{ ...msg, machineId }`
- 但 `Dashboard.jsx:35` 只取 `msg.sessions`，**没有把 machineId 注入到每个 session 对象**
- `HistoryTab:163` 使用 `s.machineId || 'local'`，所以所有历史 session 的 machineId 都是 `'local'`

### 根因 4：PixelView 空状态不初始化
- `PixelView.jsx:17` `if (!activeSessions.length) return;` 导致 `layoutLoaded` 消息永远不发送
- PixelApp 永远显示 "Loading..."

---

### Task 1: 修复 relay.js — 浏览器连接时立即触发 active_sessions

**Files:**
- Modify: `packages/server/relay.js:139-151`
- Test: `tests/relay-connection.test.js` (新建)

**Step 1: Write the failing test**

创建 `tests/relay-connection.test.js`:

```javascript
const { RelayServer } = require('../packages/server/relay');

describe('RelayServer browser connection', () => {
  test('should trigger active_sessions push when browser connects', () => {
    const relay = new RelayServer();
    const machineMessages = [];
    const machineWs = {
      readyState: 1,
      send: (msg) => machineMessages.push(JSON.parse(msg)),
    };
    relay.registerMachine('dev-1', machineWs);

    // 模拟机器发送 session_list
    relay.handleMachineMessage('dev-1', JSON.stringify({
      type: 'session_list', sessions: [{ id: 'abc', cwd: '/tmp' }]
    }));

    // 浏览器连接 — 需要 attachToHttpServer，但我们直接测试内部逻辑
    const browserMessages = [];
    const browserWs = {
      readyState: 1,
      send: (msg) => browserMessages.push(JSON.parse(msg)),
      on: () => {},
    };

    // 模拟浏览器连接后的行为
    const browserId = relay._addBrowser(browserWs);

    // 应该收到 session_list
    expect(browserMessages.some(m => m.type === 'session_list')).toBe(true);
    // 应该触发机器推送 active_sessions
    expect(machineMessages.some(m => m.type === 'scan_active')).toBe(true);
    // 应该触发机器推送 scan_history
    expect(machineMessages.some(m => m.type === 'scan_history')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /share/user/vibeanything && npx jest tests/relay-connection.test.js --no-coverage`
Expected: FAIL — `relay._addBrowser` 不存在

**Step 3: 修改 relay.js — 提取 _addBrowser 方法 + 浏览器连接时触发 scan_active**

在 `relay.js` 中：

1. 添加 `_addBrowser(ws)` 方法，从 `attachToHttpServer` 中提取浏览器注册逻辑
2. 浏览器连接时，除了发送 `session_list` 和 `scan_history`，还发送 `scan_active` 给所有机器

```javascript
// relay.js 新增方法
_addBrowser(ws) {
  const browserId = ++this._browserId;
  this.browsers.set(browserId, { ws, watchingMachine: null, watchingSession: null });
  ws.send(JSON.stringify({ type: 'session_list', sessions: this.getAllSessions() }));
  // 触发所有机器推送 active_sessions 和 history
  for (const [, m] of this.machines) {
    if (m.ws.readyState === 1) {
      m.ws.send(JSON.stringify({ type: 'scan_active' }));
      m.ws.send(JSON.stringify({ type: 'scan_history' }));
    }
  }
  return browserId;
}
```

同时修改 `attachToHttpServer` 中浏览器连接部分，调用 `_addBrowser`。

**Step 4: Run test to verify it passes**

Run: `npx jest tests/relay-connection.test.js --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/relay.js tests/relay-connection.test.js
git commit -m "fix: relay 浏览器连接时立即触发 active_sessions 推送"
```

---

### Task 2: 修复 ws-client.js — 处理 scan_active 消息 + 立即发送 active_sessions

**Files:**
- Modify: `lib/ws-client.js:147-182`

**Step 1: Write the failing test**

在 `tests/ws-client-scan.test.js` 中：

```javascript
const { scanActiveSessions } = require('../lib/ws-client');

describe('ws-client scan_active handling', () => {
  test('scanActiveSessions returns array', () => {
    const result = scanActiveSessions();
    expect(Array.isArray(result)).toBe(true);
  });
});
```

**Step 2: Run test**

Run: `npx jest tests/ws-client-scan.test.js --no-coverage`
Expected: PASS（基础验证）

**Step 3: 修改 ws-client.js — 添加 scan_active 处理**

在 `_handleMessage` 中添加：

```javascript
} else if (msg.type === 'scan_active') {
  const sessions = scanActiveSessions();
  this._send({ type: 'active_sessions', sessions });
}
```

同时在 `connect()` 的 `ws.on('open')` 中，连接成功后立即发送一次 `active_sessions`：

```javascript
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', machineId: this._machineId }));
  this._sendSessionList();
  // 立即发送一次 active_sessions
  const activeSess = scanActiveSessions();
  this._send({ type: 'active_sessions', sessions: activeSess });
  this._startActiveSessionPoller();
});
```

**Step 4: Run all tests**

Run: `npx jest --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/ws-client.js tests/ws-client-scan.test.js
git commit -m "fix: ws-client 连接时立即发送 active_sessions + 处理 scan_active"
```

---

### Task 3: 修复 Dashboard.jsx — session_history 注入 machineId

**Files:**
- Modify: `packages/server/frontend/src/Dashboard.jsx:30-36`

**Step 1: 修改 onmessage 处理**

```javascript
ws.onmessage = (e) => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'session_list')    setSessions(msg.sessions || []);
    if (msg.type === 'active_sessions') setActiveSessions((msg.sessions || []).map(s => ({ ...s, machineId: msg.machineId })));
    if (msg.type === 'session_history') setHistorySessions((msg.sessions || []).map(s => ({ ...s, machineId: s.machineId || msg.machineId })));
  } catch {}
};
```

关键变化：`session_history` 处理时，把 relay 注入的顶层 `msg.machineId` 传递到每个 session 对象。

**Step 2: Commit**

```bash
git add packages/server/frontend/src/Dashboard.jsx
git commit -m "fix: Dashboard session_history 注入 machineId 到每个 session"
```

---

### Task 4: 修复 PixelView.jsx — 空状态初始化

**Files:**
- Modify: `packages/server/frontend/src/PixelView.jsx:16-30`

**Step 1: 修改 useEffect**

```javascript
useEffect(() => {
  // 即使 activeSessions 为空也要初始化 layout
  if (!initializedRef.current) {
    initializedRef.current = true;
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'layoutLoaded', layout: null }
    }));
  }
  const agentIds = activeSessions.map(s => getAgentId(s.sessionId));
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'existingAgents', agents: agentIds, agentMeta: {} }
  }));
}, [activeSessions.map(s => s.sessionId).join(',')]);
```

关键变化：移除 `if (!activeSessions.length) return;`，确保 `layoutLoaded` 始终发送。

**Step 2: Commit**

```bash
git add packages/server/frontend/src/PixelView.jsx
git commit -m "fix: PixelView 空状态也初始化 layout，避免永远 Loading"
```

---

### Task 5: 增强 relay.js — 添加调试日志

**Files:**
- Modify: `packages/server/relay.js`

**Step 1: 在关键路径添加 console.log**

```javascript
registerMachine(machineId, ws) {
  console.log(`[relay] machine registered: ${machineId}`);
  this.machines.set(machineId, { ws, sessions: [] });
}

handleMachineMessage(machineId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  console.log(`[relay] machine ${machineId} → ${msg.type}`,
    msg.type === 'session_list' ? `(${(msg.sessions||[]).length} sessions)` :
    msg.type === 'active_sessions' ? `(${(msg.sessions||[]).length} active)` : '');
  // ... 原有逻辑
}

_addBrowser(ws) {
  // ...
  console.log(`[relay] browser #${browserId} connected, ${this.getAllSessions().length} sessions, ${this.machines.size} machines`);
  // ...
}
```

**Step 2: Commit**

```bash
git add packages/server/relay.js
git commit -m "feat: relay 添加调试日志便于排查连接问题"
```

---

### Task 6: 端到端验证

**Step 1: 重启 server**

```bash
# 杀掉旧进程
pkill -f 'node index.js' || true
cd /share/user/vibeanything/packages/server
MACHINE_TOKENS=dev-token-abc123 node index.js > /tmp/server.log 2>&1 &
```

**Step 2: 重启 daemon**

```bash
cd /share/user/vibeanything
node bin/cli.js --daemon stop 2>/dev/null
node bin/cli.js --daemon start
```

**Step 3: 检查 server 日志**

```bash
tail -20 /tmp/server.log
```

Expected: 看到 `[relay] machine registered: local-dev` 和 `active_sessions` 消息

**Step 4: 打开浏览器验证**

- 访问 Web Dashboard
- 检查 "运行中" Tab 是否显示当前活跃的 Claude Code session
- 检查 "历史" Tab 是否显示历史 session
- 切换到 "像素" 视图，确认不再卡在 Loading

**Step 5: Final commit**

```bash
git add -A
git commit -m "fix: Web Dashboard 连接修复 — session 列表、历史、像素人全部正常"
```
