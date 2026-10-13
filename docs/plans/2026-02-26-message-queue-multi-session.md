# 消息队列 + 多机多会话路由 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将飞书交互从 PULL 模式升级为 PUSH+PULL 混合模式，支持消息队列和多机多会话路由。

**Architecture:** 新增 session-registry 和 message-queue 两个模块，基于共享文件系统实现。daemon 收到消息时，有 pending request 则直接匹配，无则入队。hook 触发时先检查队列再发卡片。所有 IPC 文件增加 machineId + sessionId 寻址。

**Tech Stack:** Node.js 18+, @larksuiteoapi/node-sdk, 文件系统 IPC

---

## 前置知识

### 项目结构
```
vibeanything/
├── bin/cli.js              # CLI 安装向导 + daemon 管理
├── hooks/
│   ├── guard.js            # 危险命令拦截 (PreToolUse hook)
│   ├── interactive.js      # 双向交互 (Stop/Notification hook)
│   └── notify.js           # 通知 (Stop/Notification hook)
├── lib/
│   ├── card-builder.js     # 飞书交互卡片构建
│   ├── config.js           # 配置管理 (~/.vibeanything/config.json)
│   ├── daemon.js           # 飞书 WebSocket 守护进程
│   ├── feishu-app.js       # 飞书应用消息发送
│   ├── feishu-webhook.js   # 飞书 Webhook 发送
│   ├── ipc.js              # 文件 IPC (req/resp 文件)
│   └── sender.js           # 统一发送入口
└── tests/
```

### 当前 IPC 流程
1. Hook 写 `req-{uuid}.json` 到 `/tmp/claude-hooks-feishu/`
2. Hook 发飞书卡片，然后 poll `resp-{uuid}.json`
3. Daemon 收到飞书消息/卡片回调，写 `resp-{uuid}.json`
4. Hook 读到 resp，处理后退出

### 关键约束
- `getIpcDir()` 当前读 `CLAUDE_HOOKS_FEISHU_IPC_DIR` 环境变量或 `/tmp/claude-hooks-feishu/`
- `getBaseDir()` 返回 `~/.vibeanything/`（配置/PID/日志）
- 测试用 `node:test` + `node:assert`，运行命令: `node --test tests/*.test.js`
- 飞书卡片按钮 value 必须是对象，不能是 JSON 字符串

---

### Task 1: config.js 增加 ipcDir 和 machineId 配置

**Files:**
- Modify: `lib/config.js:20-48`
- Test: `tests/config.test.js`

**Step 1: 写失败测试**

在 `tests/config.test.js` 末尾追加：

```javascript
test('defaultConfig includes ipcDir and machineId', () => {
  const cfg = defaultConfig();
  assert.strictEqual(typeof cfg.ipcDir, 'string');
  assert.strictEqual(cfg.ipcDir, '');
  assert.strictEqual(typeof cfg.machineId, 'string');
  assert.strictEqual(cfg.machineId, '');
});

test('getMachineId returns hostname when machineId is empty', () => {
  const os = require('node:os');
  const id = getMachineId();
  assert.strictEqual(id, os.hostname());
});

test('getMachineId returns env var when set', () => {
  process.env.VIBEANYTHING_MACHINE_ID = 'test-machine-42';
  const id = getMachineId();
  assert.strictEqual(id, 'test-machine-42');
  delete process.env.VIBEANYTHING_MACHINE_ID;
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/config.test.js`
Expected: FAIL — `getMachineId is not defined`, `ipcDir` 不存在

**Step 3: 实现**

修改 `lib/config.js`：

在 `defaultConfig()` 的返回对象中增加两个字段：
```javascript
function defaultConfig() {
  return {
    ipcDir: '',       // 空则用默认 /tmp/claude-hooks-feishu
    machineId: '',    // 空则用 os.hostname() 或环境变量
    webhook: { /* ... 不变 ... */ },
    // ... 其余不变 ...
  };
}
```

新增 `getMachineId()` 函数：
```javascript
function getMachineId() {
  return process.env.VIBEANYTHING_MACHINE_ID ||
    loadConfig().machineId ||
    os.hostname();
}
```

在 `module.exports` 中增加 `getMachineId`。

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/config.test.js`
Expected: PASS

**Step 5: Commit**

```bash
cd /share/user/vibeanything
git add lib/config.js tests/config.test.js
git commit -m "feat: add ipcDir and machineId to config"
```

---

### Task 2: ipc.js 支持配置化 IPC 目录

**Files:**
- Modify: `lib/ipc.js:1-9`
- Test: `tests/ipc.test.js`

**Step 1: 写失败测试**

在 `tests/ipc.test.js` 追加：

```javascript
test('getIpcDir reads from config when ipcDir is set', () => {
  // 保存原始环境变量
  const origEnv = process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  delete process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;

  // 注意：这个测试依赖 config 返回的 ipcDir
  // 由于测试环境中 config.json 可能不存在，getIpcDir 应 fallback 到默认值
  const dir = getIpcDir();
  assert.ok(typeof dir === 'string');
  assert.ok(dir.length > 0);

  // 恢复
  if (origEnv) process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = origEnv;
  else process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir; // 恢复测试目录
});
```

**Step 2: 运行测试确认当前状态**

Run: `cd /share/user/vibeanything && node --test tests/ipc.test.js`
Expected: 现有测试 PASS（新测试也应 PASS，因为 fallback 逻辑）

**Step 3: 实现**

修改 `lib/ipc.js` 的 `getIpcDir()`：

```javascript
const { loadConfig } = require('./config');

const DEFAULT_IPC_DIR = path.join(os.tmpdir(), 'claude-hooks-feishu');

function getIpcDir() {
  // 优先级: 环境变量 > config.ipcDir > 默认值
  if (process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR) {
    return process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  }
  try {
    const cfg = loadConfig();
    if (cfg.ipcDir) return cfg.ipcDir;
  } catch {}
  return DEFAULT_IPC_DIR;
}
```

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/ipc.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /share/user/vibeanything
git add lib/ipc.js tests/ipc.test.js
git commit -m "feat: ipc.js reads ipcDir from config with fallback chain"
```

---

### Task 3: 创建 session-registry.js

**Files:**
- Create: `lib/session-registry.js`
- Create: `tests/session-registry.test.js`

**Step 1: 写失败测试**

创建 `tests/session-registry.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir;

const {
  registerSession,
  getSession,
  listActiveSessions,
  removeSession,
  touchSession,
  SESSION_TTL_MS
} = require('../lib/session-registry');

test('registerSession creates session file', () => {
  registerSession({
    machineId: 'machine-1',
    sessionId: 'sess-aaa',
    cwd: '/tmp/project-a',
    pid: 1234
  });
  const sess = getSession('machine-1', 'sess-aaa');
  assert.ok(sess);
  assert.strictEqual(sess.machineId, 'machine-1');
  assert.strictEqual(sess.sessionId, 'sess-aaa');
  assert.strictEqual(sess.cwd, '/tmp/project-a');
  assert.ok(sess.registeredAt > 0);
  assert.ok(sess.lastActivity > 0);
});

test('listActiveSessions returns only non-expired sessions', () => {
  registerSession({ machineId: 'machine-1', sessionId: 'sess-bbb', cwd: '/tmp/b', pid: 2 });
  const list = listActiveSessions();
  assert.ok(list.length >= 2); // sess-aaa + sess-bbb
  assert.ok(list.some(s => s.sessionId === 'sess-aaa'));
  assert.ok(list.some(s => s.sessionId === 'sess-bbb'));
});

test('touchSession updates lastActivity', () => {
  const before = getSession('machine-1', 'sess-aaa');
  // 小延迟确保时间戳不同
  const origTime = before.lastActivity;
  touchSession('machine-1', 'sess-aaa');
  const after = getSession('machine-1', 'sess-aaa');
  assert.ok(after.lastActivity >= origTime);
});

test('removeSession deletes session file', () => {
  removeSession('machine-1', 'sess-bbb');
  const sess = getSession('machine-1', 'sess-bbb');
  assert.strictEqual(sess, null);
});

test('SESSION_TTL_MS is 7 days', () => {
  assert.strictEqual(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/session-registry.test.js`
Expected: FAIL — module not found

**Step 3: 实现**

创建 `lib/session-registry.js`：

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { getIpcDir } = require('./ipc');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function getSessionsDir() {
  const dir = path.join(getIpcDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFileName(machineId, sessionId) {
  // 清理特殊字符，避免文件名问题
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe(machineId)}_${safe(sessionId)}.json`;
}

function sessionFilePath(machineId, sessionId) {
  return path.join(getSessionsDir(), sessionFileName(machineId, sessionId));
}

function registerSession({ machineId, sessionId, cwd, pid }) {
  const now = Date.now();
  const existing = getSession(machineId, sessionId);
  const data = {
    machineId,
    sessionId,
    cwd: cwd || '',
    pid: pid || process.pid,
    registeredAt: existing?.registeredAt || now,
    lastActivity: now
  };
  fs.writeFileSync(sessionFilePath(machineId, sessionId), JSON.stringify(data), 'utf-8');
  return data;
}

function getSession(machineId, sessionId) {
  const fp = sessionFilePath(machineId, sessionId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function touchSession(machineId, sessionId) {
  const sess = getSession(machineId, sessionId);
  if (!sess) return;
  sess.lastActivity = Date.now();
  fs.writeFileSync(sessionFilePath(machineId, sessionId), JSON.stringify(sess), 'utf-8');
}

function removeSession(machineId, sessionId) {
  const fp = sessionFilePath(machineId, sessionId);
  try { fs.unlinkSync(fp); } catch {}
}

function listActiveSessions() {
  const dir = getSessionsDir();
  const now = Date.now();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (now - data.lastActivity < SESSION_TTL_MS) {
        sessions.push(data);
      }
    } catch {}
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}

function cleanExpiredSessions() {
  const dir = getSessionsDir();
  const now = Date.now();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (now - data.lastActivity >= SESSION_TTL_MS) {
        fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
  }
}

module.exports = {
  registerSession,
  getSession,
  touchSession,
  removeSession,
  listActiveSessions,
  cleanExpiredSessions,
  getSessionsDir,
  SESSION_TTL_MS
};
```

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/session-registry.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /share/user/vibeanything
git add lib/session-registry.js tests/session-registry.test.js
git commit -m "feat: add session-registry for multi-machine session tracking"
```

---

### Task 4: 创建 message-queue.js

**Files:**
- Create: `lib/message-queue.js`
- Create: `tests/message-queue.test.js`

**Step 1: 写失败测试**

创建 `tests/message-queue.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir;

const {
  enqueue,
  dequeue,
  peekQueue,
  getQueueDir
} = require('../lib/message-queue');

test('enqueue creates message file in queue dir', () => {
  const msg = enqueue({
    targetMachine: 'machine-1',
    targetSession: 'sess-aaa',
    content: '帮我写个函数',
    action: 'message',
    senderId: 'ou_123'
  });
  assert.ok(msg.id);
  assert.ok(msg.timestamp > 0);
  assert.strictEqual(msg.content, '帮我写个函数');
  assert.strictEqual(msg.consumed, false);

  // 文件应该存在
  const files = fs.readdirSync(getQueueDir());
  assert.ok(files.some(f => f.includes(msg.id)));
});

test('peekQueue returns messages for specific session', () => {
  enqueue({ targetMachine: 'machine-1', targetSession: 'sess-aaa', content: '第二条', action: 'message', senderId: 'ou_123' });
  enqueue({ targetMachine: 'machine-2', targetSession: 'sess-bbb', content: '其他会话', action: 'message', senderId: 'ou_456' });

  const msgs = peekQueue('machine-1', 'sess-aaa');
  assert.ok(msgs.length >= 2);
  assert.ok(msgs.every(m => m.targetMachine === 'machine-1' && m.targetSession === 'sess-aaa'));
  // 按时间排序（最早的在前）
  for (let i = 1; i < msgs.length; i++) {
    assert.ok(msgs[i].timestamp >= msgs[i - 1].timestamp);
  }
});

test('dequeue returns and removes oldest message for session', () => {
  const before = peekQueue('machine-1', 'sess-aaa');
  const countBefore = before.length;
  assert.ok(countBefore >= 1);

  const msg = dequeue('machine-1', 'sess-aaa');
  assert.ok(msg);
  assert.strictEqual(msg.content, '帮我写个函数'); // 最早的那条

  const after = peekQueue('machine-1', 'sess-aaa');
  assert.strictEqual(after.length, countBefore - 1);
});

test('dequeue returns null when queue is empty', () => {
  const msg = dequeue('machine-99', 'sess-nonexistent');
  assert.strictEqual(msg, null);
});

test('peekQueue with no filter returns all unconsumed messages', () => {
  const all = peekQueue();
  assert.ok(all.length >= 1);
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/message-queue.test.js`
Expected: FAIL — module not found

**Step 3: 实现**

创建 `lib/message-queue.js`：

```javascript
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getIpcDir } = require('./ipc');

function getQueueDir() {
  const dir = path.join(getIpcDir(), 'queue');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function enqueue({ targetMachine, targetSession, content, action, senderId }) {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const msg = {
    id,
    targetMachine: targetMachine || '',
    targetSession: targetSession || '',
    content,
    action: action || 'message',
    senderId: senderId || 'unknown',
    timestamp,
    consumed: false
  };
  const fileName = `msg-${timestamp}-${id}.json`;
  fs.writeFileSync(path.join(getQueueDir(), fileName), JSON.stringify(msg), 'utf-8');
  return msg;
}

function listQueueFiles() {
  const dir = getQueueDir();
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('msg-') && f.endsWith('.json'))
    .sort() // 按文件名排序 = 按时间排序（因为文件名含 timestamp）
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        data._fileName = f;
        return data;
      } catch { return null; }
    })
    .filter(Boolean);
}

function peekQueue(targetMachine, targetSession) {
  const all = listQueueFiles().filter(m => !m.consumed);
  if (!targetMachine && !targetSession) return all;
  return all.filter(m =>
    m.targetMachine === targetMachine && m.targetSession === targetSession
  );
}

function dequeue(targetMachine, targetSession) {
  const msgs = peekQueue(targetMachine, targetSession);
  if (msgs.length === 0) return null;

  const oldest = msgs[0];
  // 删除文件
  const filePath = path.join(getQueueDir(), oldest._fileName);
  try { fs.unlinkSync(filePath); } catch {}

  delete oldest._fileName;
  return oldest;
}

module.exports = {
  enqueue,
  dequeue,
  peekQueue,
  getQueueDir
};
```

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/message-queue.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /share/user/vibeanything
git add lib/message-queue.js tests/message-queue.test.js
git commit -m "feat: add message-queue for async message delivery"
```

---

### Task 5: card-builder.js 增加 machineId 标识 + session 选择卡片

**Files:**
- Modify: `lib/card-builder.js`
- Create: `tests/card-builder.test.js`

**Step 1: 写失败测试**

创建 `tests/card-builder.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildStopCard,
  buildPermissionCard,
  buildSessionPickerCard
} = require('../lib/card-builder');

test('buildStopCard includes machineId when provided', () => {
  const card = buildStopCard({
    requestId: 'req-1',
    sessionId: 'sess-1',
    machineId: 'dev-server-01',
    cwd: '/tmp/project',
    message: 'done'
  });
  const parsed = JSON.parse(card);
  const text = parsed.elements[0].text.content;
  assert.ok(text.includes('dev-server-01'));
  assert.ok(text.includes('sess-1'));
});

test('buildPermissionCard includes machineId when provided', () => {
  const card = buildPermissionCard({
    requestId: 'req-2',
    sessionId: 'sess-2',
    machineId: 'prod-server',
    cwd: '/app',
    title: 'test',
    message: 'msg'
  });
  const parsed = JSON.parse(card);
  const text = parsed.elements[0].text.content;
  assert.ok(text.includes('prod-server'));
});

test('buildSessionPickerCard lists sessions with buttons', () => {
  const sessions = [
    { machineId: 'machine-1', sessionId: 'sess-a', cwd: '/project-a', lastActivity: Date.now() - 60000 },
    { machineId: 'machine-2', sessionId: 'sess-b', cwd: '/project-b', lastActivity: Date.now() - 300000 }
  ];
  const card = buildSessionPickerCard({ sessions, originalText: '帮我写代码' });
  const parsed = JSON.parse(card);
  assert.ok(parsed.header.title.content.includes('选择'));
  // 应该有 action 元素包含按钮
  const actions = parsed.elements.filter(e => e.tag === 'action');
  assert.ok(actions.length > 0);
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/card-builder.test.js`
Expected: FAIL — `buildSessionPickerCard is not a function`, machineId 不在卡片中

**Step 3: 实现**

修改 `lib/card-builder.js`：

1. `buildStopCard` 和 `buildPermissionCard` 的参数增加 `machineId`，在 infoLines 中增加：
```javascript
if (machineId) infoLines.push(`**机器**: ${machineId}`);
```

2. 新增 `buildSessionPickerCard`：
```javascript
function buildSessionPickerCard({ sessions, originalText }) {
  const elements = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**待发送指令**: ${originalText}` }
  });
  elements.push({ tag: 'hr' });

  const buttons = sessions.map((s, i) => {
    const ago = Math.round((Date.now() - s.lastActivity) / 60000);
    const label = `[${i + 1}] ${s.machineId}:${s.sessionId.slice(0, 8)} (${s.cwd}) - ${ago}分钟前`;
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: i === 0 ? 'primary' : 'default',
      value: { action: 'route', targetMachine: s.machineId, targetSession: s.sessionId }
    };
  });

  elements.push({ tag: 'action', actions: buttons });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '💬 也可回复数字选择目标会话' }
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 选择目标会话' },
      template: 'blue'
    },
    elements
  });
}
```

3. 在 `module.exports` 中增加 `buildSessionPickerCard`。

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/card-builder.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /share/user/vibeanything
git add lib/card-builder.js tests/card-builder.test.js
git commit -m "feat: cards show machineId, add session picker card"
```

---

### Task 6: daemon.js — 消息队列写入 + 多 session 路由

**Files:**
- Modify: `lib/daemon.js:114-166` (handleMessage)
- Modify: `lib/daemon.js:43-82` (handleCardAction)

**Step 1: 写失败测试**

创建 `tests/daemon-routing.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-route-test-'));
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir;

const { registerSession } = require('../lib/session-registry');
const { peekQueue } = require('../lib/message-queue');
const { writeRequest, listPendingRequests } = require('../lib/ipc');
const { handleMessage } = require('../lib/daemon');

test('handleMessage queues message when no pending requests', () => {
  // 注册一个 session
  registerSession({ machineId: 'test-m', sessionId: 'test-s', cwd: '/tmp', pid: 1 });

  // 模拟飞书消息（无 pending request）
  handleMessage({
    message: {
      message_type: 'text',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '帮我写个函数' }),
      message_id: 'msg-001'
    },
    sender: { sender_id: { open_id: 'ou_test' } }
  });

  // 应该入队了
  const queue = peekQueue('test-m', 'test-s');
  assert.ok(queue.length >= 1);
  assert.ok(queue.some(m => m.content === '帮我写个函数'));
});

test('handleMessage matches pending request when available', () => {
  // 写一个 pending request
  writeRequest('req-match-test', {
    requestId: 'req-match-test',
    type: 'stop',
    machineId: 'test-m',
    sessionId: 'test-s'
  });

  handleMessage({
    message: {
      message_type: 'text',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '继续' }),
      message_id: 'msg-002'
    },
    sender: { sender_id: { open_id: 'ou_test' } }
  });

  // pending request 应该被消费（resp 文件存在）
  const respFile = path.join(tmpDir, 'resp-req-match-test.json');
  assert.ok(fs.existsSync(respFile));
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/daemon-routing.test.js`
Expected: FAIL — 消息没有入队（当前代码直接 return）

**Step 3: 实现**

修改 `lib/daemon.js` 的 `handleMessage` 函数。核心变化：

```javascript
const { enqueue } = require('./message-queue');
const { listActiveSessions } = require('./session-registry');

function handleMessage(data) {
  try {
    const msgType = data.message?.message_type;
    if (msgType !== 'text') return;

    const chatType = data.message?.chat_type || data.chat_type;
    const rawContent = JSON.parse(data.message.content || '{}');
    let text = rawContent.text || '';
    if (!text.trim()) return;

    const hasMention = /@_user_\d+/.test(text);
    if (chatType === 'group' && !hasMention) return;
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return;

    const senderId = data.sender?.sender_id?.open_id || 'unknown';
    const messageId = data.message?.message_id;

    // 1. 优先匹配 pending request
    const pending = listPendingRequests()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (pending.length > 0) {
      const target = pending[0];
      const action = resolveAction(text, target.type);
      const resp = { requestId: target.requestId, action, operatorId: senderId };
      if (action === 'message') resp.content = text;
      writeResponse(target.requestId, resp);
      log(`Message "${text}" → action:${action} matched to ${target.requestId} by ${senderId}`);
      const emoji = action === 'allow' ? 'OK' : action === 'deny' ? 'CrossMark' : 'DONE';
      addReaction(messageId, emoji);
      return;
    }

    // 2. 无 pending request → 入队
    const sessions = listActiveSessions();
    if (sessions.length === 0) {
      log(`Message from ${senderId} but no active sessions: "${text}"`);
      addReaction(messageId, 'WAIT');
      return;
    }

    if (sessions.length === 1) {
      // 只有一个活跃 session，直接路由
      enqueue({
        targetMachine: sessions[0].machineId,
        targetSession: sessions[0].sessionId,
        content: text,
        action: 'message',
        senderId
      });
      log(`Message "${text}" queued for ${sessions[0].machineId}:${sessions[0].sessionId}`);
      addReaction(messageId, 'DONE');
    } else {
      // 多个 session，检查是否有数字前缀选择
      const numMatch = text.match(/^(\d+)\s+([\s\S]+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < sessions.length) {
          const target = sessions[idx];
          enqueue({
            targetMachine: target.machineId,
            targetSession: target.sessionId,
            content: numMatch[2],
            action: 'message',
            senderId
          });
          log(`Message routed to session #${idx + 1}: ${target.machineId}:${target.sessionId}`);
          addReaction(messageId, 'DONE');
          return;
        }
      }

      // 发 session 选择卡片
      const { buildSessionPickerCard } = require('./card-builder');
      const pickerCard = buildSessionPickerCard({ sessions, originalText: text });
      // 暂存消息，等用户选择后再路由
      enqueue({
        targetMachine: '',
        targetSession: '',
        content: text,
        action: 'message',
        senderId
      });
      log(`Multiple sessions, queued unrouted message and sending picker card`);
      addReaction(messageId, 'WAIT');
      // 发送选择卡片（需要 larkClient 和 config）
      sendPickerCard(pickerCard);
    }
  } catch (e) {
    log(`Message handler error: ${e.message}`);
  }
}
```

同时增加 `sendPickerCard` 辅助函数（使用 larkClient 发送卡片到配置的 receiverId）：

```javascript
async function sendPickerCard(cardContent) {
  try {
    const { loadConfig } = require('./config');
    const config = loadConfig();
    if (config.app.enabled && config.app.appId) {
      const { sendAppMessage } = require('./feishu-app');
      await sendAppMessage(
        config.app.appId, config.app.appSecret,
        config.app.receiverId, config.app.receiverType,
        cardContent
      );
    }
  } catch (e) {
    log(`sendPickerCard failed: ${e.message}`);
  }
}
```

修改 `handleCardAction` 增加 `route` action 处理：

```javascript
// 在 handleCardAction 中增加 route 处理
if (action === 'route') {
  const { targetMachine, targetSession } = btnValue;
  // 找到未路由的消息，更新其目标
  const { peekQueue, enqueue } = require('./message-queue');
  const unrouted = peekQueue('', '');
  if (unrouted.length > 0) {
    const msg = unrouted[0];
    // 删除旧的未路由消息，重新入队到目标 session
    const { dequeue } = require('./message-queue');
    dequeue('', '');
    enqueue({
      targetMachine,
      targetSession,
      content: msg.content,
      action: msg.action,
      senderId: msg.senderId
    });
    log(`Routed message to ${targetMachine}:${targetSession}`);
  }
  return;
}
```

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/daemon-routing.test.js`
Expected: ALL PASS

**Step 5: 运行全部测试**

Run: `cd /share/user/vibeanything && node --test tests/*.test.js`
Expected: ALL PASS

**Step 6: Commit**

```bash
cd /share/user/vibeanything
git add lib/daemon.js tests/daemon-routing.test.js
git commit -m "feat: daemon routes messages to queue when no pending request"
```

---

### Task 7: hooks 注册 session + 消费队列

**Files:**
- Modify: `hooks/interactive.js:66-145`
- Modify: `hooks/guard.js:52-148`
- Modify: `hooks/notify.js:36-53`

**Step 1: 写失败测试**

创建 `tests/hook-session.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-session-test-'));
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir;

const { getSession, listActiveSessions } = require('../lib/session-registry');
const { enqueue, peekQueue } = require('../lib/message-queue');
const { buildInteractivePayload, processResponse } = require('../hooks/interactive');

test('buildInteractivePayload includes machineId', () => {
  const data = {
    hook_event_name: 'Stop',
    session_id: 'sess-test-1',
    cwd: '/tmp/test-project',
    last_assistant_message: 'done'
  };
  const result = buildInteractivePayload(data);
  assert.ok(result.machineId);
  assert.ok(result.requestId);
  // 卡片内容应包含 machineId
  const card = JSON.parse(result.cardContent);
  const text = card.elements[0].text.content;
  assert.ok(text.includes(result.machineId));
});
```

**Step 2: 运行测试确认失败**

Run: `cd /share/user/vibeanything && node --test tests/hook-session.test.js`
Expected: FAIL — `machineId` 不在 buildInteractivePayload 返回值中

**Step 3: 实现**

修改 `hooks/interactive.js`：

1. 在文件顶部增加 imports：
```javascript
const { getMachineId } = require('../lib/config');
const { registerSession } = require('../lib/session-registry');
const { dequeue } = require('../lib/message-queue');
```

2. 修改 `buildInteractivePayload`，增加 machineId：
```javascript
function buildInteractivePayload(data) {
  const hookEvent = data.hook_event_name || 'Stop';
  const requestId = generateRequestId();
  const sessionId = data.session_id || '';
  const cwd = data.cwd || process.cwd();
  const machineId = getMachineId();

  let cardContent;
  if (hookEvent === 'Stop') {
    cardContent = buildStopCard({ requestId, sessionId, machineId, cwd, message: data.last_assistant_message || '', transcriptPath: data.transcript_path });
  } else {
    cardContent = buildPermissionCard({ requestId, sessionId, machineId, cwd, title: data.title || '', message: data.message || '', notificationType: data.notification_type || '' });
  }

  return { cardContent, requestId, hookEvent, sessionId, machineId, cwd };
}
```

3. 修改 `main()` 函数，在开头注册 session，发卡片前检查队列：

```javascript
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const hookEvent = data.hook_event_name || 'Stop';
  if (data.stop_hook_active) { process.exit(0); return; }

  const machineId = getMachineId();
  const sessionId = data.session_id || '';
  const cwd = data.cwd || process.cwd();

  // 注册/更新 session
  registerSession({ machineId, sessionId, cwd, pid: process.pid });

  const config = loadConfig();

  if (!isRunning()) {
    const { send } = require('../lib/sender');
    const type = resolveEventType(hookEvent, {});
    const { buildFields } = require('./notify');
    const fields = buildFields(hookEvent, data);
    await send({ type, cwd, fields });
    process.exit(0);
    return;
  }

  // 检查队列中是否有属于本 session 的消息
  if (hookEvent === 'Stop') {
    const queued = dequeue(machineId, sessionId);
    if (queued) {
      // 直接消费队列消息，不发卡片
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `用户通过飞书下达新指令: ${queued.content}`
      }));
      process.exit(0);
      return;
    }
  }

  // 正常流程：发卡片等待
  const { cardContent, requestId } = buildInteractivePayload(data);

  writeRequest(requestId, {
    requestId,
    type: hookEvent === 'Stop' ? 'stop' : 'permission',
    machineId,
    sessionId,
    hookEvent
  });

  // ... 发送卡片和 poll 的代码不变 ...
}
```

4. 修改 `hooks/guard.js`，在 `main()` 开头增加 session 注册，writeRequest 增加 machineId：

```javascript
const { getMachineId } = require('../lib/config');
const { registerSession } = require('../lib/session-registry');

// 在 main() 中：
const machineId = getMachineId();
registerSession({ machineId, sessionId, cwd, pid: process.pid });

// writeRequest 增加 machineId：
writeRequest(requestId, {
  requestId, type: 'danger', machineId, sessionId,
  hookEvent: 'PreToolUse', command, pattern: matched
});
```

5. 修改 `hooks/notify.js`，在 `main()` 中增加 session 注册：

```javascript
const { getMachineId } = require('../lib/config');
const { registerSession } = require('../lib/session-registry');

// 在 main() 中：
const machineId = getMachineId();
const sessionId = data.session_id || '';
registerSession({ machineId, sessionId, cwd, pid: process.pid });
```

**Step 4: 运行测试确认通过**

Run: `cd /share/user/vibeanything && node --test tests/hook-session.test.js`
Expected: ALL PASS

**Step 5: 运行全部测试**

Run: `cd /share/user/vibeanything && node --test tests/*.test.js`
Expected: ALL PASS

**Step 6: Commit**

```bash
cd /share/user/vibeanything
git add hooks/interactive.js hooks/guard.js hooks/notify.js tests/hook-session.test.js
git commit -m "feat: hooks register session and consume queue messages"
```

---

### Task 8: daemon 定期清理过期 session + cli.js 更新安装文件列表

**Files:**
- Modify: `lib/daemon.js:168-218` (startDaemon)
- Modify: `bin/cli.js:85-89`

**Step 1: 实现 daemon 定期清理**

在 `lib/daemon.js` 的 `startDaemon` 函数中，启动后增加定时清理：

```javascript
const { cleanExpiredSessions } = require('./session-registry');

// 在 wsClient.start 之前：
// 每小时清理过期 session
const cleanupInterval = setInterval(() => {
  try { cleanExpiredSessions(); } catch {}
}, 60 * 60 * 1000);

process.on('SIGTERM', () => {
  clearInterval(cleanupInterval);
  log('Received SIGTERM, shutting down');
  removePid();
  process.exit(0);
});
```

**Step 2: 更新 cli.js 安装文件列表**

在 `bin/cli.js:85` 的 lib 复制列表中增加新模块：

```javascript
for (const f of ['config.js', 'feishu-webhook.js', 'feishu-app.js', 'sender.js', 'ipc.js', 'card-builder.js', 'daemon.js', 'session-registry.js', 'message-queue.js']) {
```

**Step 3: 运行全部测试**

Run: `cd /share/user/vibeanything && node --test tests/*.test.js`
Expected: ALL PASS

**Step 4: Commit**

```bash
cd /share/user/vibeanything
git add lib/daemon.js bin/cli.js
git commit -m "feat: daemon cleans expired sessions, cli installs new modules"
```

---

### Task 9: 集成测试 + 版本发布

**Files:**
- Modify: `package.json` (version bump)

**Step 1: 运行全部测试**

Run: `cd /share/user/vibeanything && node --test tests/*.test.js`
Expected: ALL PASS

**Step 2: 手动验证 daemon 启动**

Run: `cd /share/user/vibeanything && node bin/cli.js --daemon stop 2>/dev/null; node bin/cli.js --daemon start &`

检查日志：
Run: `tail -5 ~/.vibeanything/daemon.log`
Expected: "Daemon started" 日志

**Step 3: 停止 daemon**

Run: `node bin/cli.js --daemon stop`

**Step 4: 版本号更新**

修改 `package.json` version 从 `2.1.2` 到 `3.0.0`（大版本，因为 IPC 协议变化）。

**Step 5: Commit + Tag**

```bash
cd /share/user/vibeanything
git add package.json
git commit -m "chore: bump version to 3.0.0 for message queue + multi-session"
git tag v3.0.0
```

---

## 任务依赖关系

```
Task 1 (config) ──┐
                   ├── Task 3 (session-registry) ──┐
Task 2 (ipc)   ──┤                                 ├── Task 6 (daemon routing) ── Task 8 (cleanup + cli)
                   ├── Task 4 (message-queue)    ──┤                                      │
                   │                                 ├── Task 7 (hooks)          ──────────┤
                   └── Task 5 (card-builder)     ──┘                                      │
                                                                                           ▼
                                                                                    Task 9 (集成测试)
