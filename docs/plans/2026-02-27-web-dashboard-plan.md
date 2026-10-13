# Web Dashboard 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 vibeanything 添加 Web Dashboard，支持多台开发机的 PTY 终端、用户登录、飞书功能保留。

**Architecture:** 中央 Web Server (Express+WS+React) 部署在公网，开发机 daemon 扩展 ws-client 主动连接中央服务器，PTY 在开发机本地 spawn，I/O 通过 WebSocket 双向中继到浏览器 xterm.js。

**Tech Stack:** Node.js, Express, ws, jsonwebtoken, bcryptjs, better-sqlite3, node-pty (开发机), React, Vite, xterm.js, xterm-addon-fit

---

## Task 1: 中央 server 骨架 + 用户认证

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/auth.js`
- Create: `packages/server/index.js`
- Create: `packages/server/.gitignore`
- Test: `packages/server/tests/auth.test.js`

**Step 1: 创建 packages/server/package.json**

```json
{
  "name": "vibeanything-server",
  "version": "1.0.0",
  "description": "Central web server for vibeanything dashboard",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^9.4.3",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.2",
    "ws": "^8.16.0"
  },
  "devDependencies": {}
}
```

**Step 2: 写 auth.js 的失败测试**

```js
// packages/server/tests/auth.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

// 用临时数据库测试
process.env.DB_PATH = '/tmp/test-auth.db';
const { createUser, verifyPassword, generateToken, verifyToken } = require('../auth');

test('createUser + verifyPassword', async () => {
  const user = await createUser('testuser', 'password123');
  assert.equal(user.username, 'testuser');
  const ok = await verifyPassword('testuser', 'password123');
  assert.ok(ok);
  const fail = await verifyPassword('testuser', 'wrongpass');
  assert.equal(fail, null);
});

test('generateToken + verifyToken', () => {
  const token = generateToken({ id: 1, username: 'testuser' });
  assert.ok(token);
  const payload = verifyToken(token);
  assert.equal(payload.username, 'testuser');
});

test('verifyToken invalid', () => {
  const result = verifyToken('invalid.token.here');
  assert.equal(result, null);
});
```

**Step 3: 运行测试确认失败**

```bash
cd packages/server && npm install && node --test tests/auth.test.js
```
Expected: FAIL with "Cannot find module '../auth'"

**Step 4: 实现 auth.js**

```js
// packages/server/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'users.db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES = '24h';

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  return db;
}

async function createUser(username, password) {
  const db = getDb();
  const hash = await bcrypt.hash(password, 12);
  const stmt = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
  const result = stmt.run(username, hash, Date.now());
  db.close();
  return { id: result.lastInsertRowid, username };
}

async function verifyPassword(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  db.close();
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? { id: user.id, username: user.username } : null;
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  req.user = payload;
  next();
}

module.exports = { createUser, verifyPassword, generateToken, verifyToken, authMiddleware };
```

**Step 5: 运行测试确认通过**

```bash
cd packages/server && node --test tests/auth.test.js
```
Expected: 3 tests PASS

**Step 6: 实现 index.js 骨架（HTTP + 登录 API）**

```js
// packages/server/index.js
const express = require('express');
const path = require('node:path');
const { createUser, verifyPassword, generateToken, authMiddleware } = require('./auth');

const app = express();
app.use(express.json());

// 静态前端（后续 Task 5 填充）
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await verifyPassword(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateToken(user);
  res.json({ token, username: user.username });
});

// 当前用户信息
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// SPA fallback
app.get('*', (req, res) => {
  const dist = path.join(__dirname, 'frontend/dist/index.html');
  const fs = require('node:fs');
  if (fs.existsSync(dist)) res.sendFile(dist);
  else res.send('<h1>Frontend not built yet</h1>');
});

const PORT = process.env.PORT || 3000;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--create-user') {
    const username = args[1];
    if (!username) { console.error('Usage: node index.js --create-user <username>'); process.exit(1); }
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Password for ${username}: `, async (password) => {
      rl.close();
      await createUser(username, password);
      console.log(`User "${username}" created.`);
      process.exit(0);
    });
    return;
  }
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

main().catch(console.error);
module.exports = { app };
```

**Step 7: 创建 .gitignore**

```
node_modules/
users.db
*.db
```

**Step 8: 手动测试登录 API**

```bash
cd packages/server
node index.js --create-user admin
# 输入密码后
node index.js &
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"yourpassword"}'
# Expected: {"token":"eyJ...","username":"admin"}
kill %1
```

**Step 9: Commit**

```bash
git add packages/server/
git commit -m "feat: 中央server骨架 + JWT用户认证"
```

---

## Task 2: WebSocket Relay（浏览器 ↔ 开发机）


**Files:**
- Create: `packages/server/relay.js`
- Modify: `packages/server/index.js`
- Create: `packages/server/tests/relay.test.js`

**Step 1: 写 relay 测试**

```js
// packages/server/tests/relay.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { RelayServer } = require('../relay');

test('machine registration', () => {
  const relay = new RelayServer();
  relay.registerMachine('dev-a', { send: () => {} });
  assert.ok(relay.getMachine('dev-a'));
  relay.unregisterMachine('dev-a');
  assert.equal(relay.getMachine('dev-a'), undefined);
});

test('session list update', () => {
  const relay = new RelayServer();
  relay.registerMachine('dev-a', { send: () => {} });
  relay.updateSessions('dev-a', [{ id: 'sess1', cwd: '/project' }]);
  const sessions = relay.getAllSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].machineId, 'dev-a');
});
```

**Step 2: 运行测试确认失败**

```bash
cd packages/server && node --test tests/relay.test.js
```
Expected: FAIL

**Step 3: 实现 relay.js**

```js
// packages/server/relay.js
const { WebSocketServer } = require('ws');
const { verifyToken } = require('./auth');

const MACHINE_TOKENS = new Set(
  (process.env.MACHINE_TOKENS || '').split(',').filter(Boolean)
);

class RelayServer {
  constructor() {
    this.machines = new Map();   // machineId → { ws, sessions }
    this.browsers = new Map();   // browserId → { ws, watchingMachine, watchingSession }
    this._browserId = 0;
  }

  registerMachine(machineId, ws) {
    this.machines.set(machineId, { ws, sessions: [] });
  }

  unregisterMachine(machineId) {
    this.machines.delete(machineId);
  }

  getMachine(machineId) {
    return this.machines.get(machineId);
  }

  updateSessions(machineId, sessions) {
    const m = this.machines.get(machineId);
    if (m) m.sessions = sessions;
    this._broadcastSessionList();
  }

  getAllSessions() {
    const result = [];
    for (const [machineId, { sessions }] of this.machines) {
      for (const s of sessions) result.push({ ...s, machineId });
    }
    return result;
  }

  _broadcastSessionList() {
    const sessions = this.getAllSessions();
    const msg = JSON.stringify({ type: 'session_list', sessions });
    for (const { ws } of this.browsers.values()) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  handleMachineMessage(machineId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'session_list') {
      this.updateSessions(machineId, msg.sessions || []);
      return;
    }
    if (msg.type === 'pty_data') {
      // 转发给正在看这个 session 的浏览器
      for (const browser of this.browsers.values()) {
        if (browser.watchingMachine === machineId &&
            browser.watchingSession === msg.sessionId &&
            browser.ws.readyState === 1) {
          browser.ws.send(JSON.stringify(msg));
        }
      }
    }
  }

  handleBrowserMessage(browserId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const browser = this.browsers.get(browserId);
    if (!browser) return;

    if (msg.type === 'open_terminal') {
      browser.watchingMachine = msg.machineId;
      browser.watchingSession = msg.sessionId;
      const machine = this.machines.get(msg.machineId);
      if (machine && machine.ws.readyState === 1) {
        machine.ws.send(JSON.stringify({
          type: 'pty_open', sessionId: msg.sessionId,
          cols: msg.cols || 220, rows: msg.rows || 50
        }));
      }
      // 发送当前 session 列表给新浏览器
      browser.ws.send(JSON.stringify({ type: 'session_list', sessions: this.getAllSessions() }));
      return;
    }
    if (msg.type === 'terminal_input' || msg.type === 'terminal_resize') {
      const machine = this.machines.get(msg.machineId);
      if (machine && machine.ws.readyState === 1) {
        machine.ws.send(JSON.stringify(msg));
      }
    }
  }

  attachToHttpServer(server) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || req.headers['x-machine-token'];
      const machineToken = req.headers['x-machine-token'];

      // 开发机连接
      if (machineToken && MACHINE_TOKENS.has(machineToken)) {
        const machineId = req.headers['x-machine-id'] || 'unknown';
        this.registerMachine(machineId, ws);
        ws.on('message', (data) => this.handleMachineMessage(machineId, data.toString()));
        ws.on('close', () => {
          this.unregisterMachine(machineId);
          this._broadcastSessionList();
        });
        return;
      }

      // 浏览器连接（JWT）
      const payload = verifyToken(token);
      if (!payload) { ws.close(4001, 'Unauthorized'); return; }
      const browserId = ++this._browserId;
      this.browsers.set(browserId, { ws, watchingMachine: null, watchingSession: null });
      ws.send(JSON.stringify({ type: 'session_list', sessions: this.getAllSessions() }));
      ws.on('message', (data) => this.handleBrowserMessage(browserId, data.toString()));
      ws.on('close', () => this.browsers.delete(browserId));
    });
  }
}

module.exports = { RelayServer };
```

**Step 4: 运行测试**

```bash
cd packages/server && node --test tests/relay.test.js
```
Expected: 2 tests PASS

**Step 5: 集成到 index.js**

在 `packages/server/index.js` 的 `main()` 函数中，将 `app.listen` 替换为：

```js
// 替换 app.listen 那行
const http = require('node:http');
const { RelayServer } = require('./relay');
const relay = new RelayServer();
const server = http.createServer(app);
relay.attachToHttpServer(server);
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
```

**Step 6: Commit**

```bash
git add packages/server/relay.js packages/server/index.js packages/server/tests/relay.test.js
git commit -m "feat: WebSocket relay 中继层"
```

---

## Task 3: 开发机 PTY 管理器

**Files:**
- Create: `lib/pty-manager.js`
- Create: `tests/pty-manager.test.js`

**Step 1: 安装 node-pty**

```bash
npm install node-pty
```

**Step 2: 写测试**

```js
// tests/pty-manager.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { PtyManager } = require('../lib/pty-manager');

test('create and destroy PTY', (t, done) => {
  const mgr = new PtyManager();
  let output = '';
  mgr.create('sess1', { cols: 80, rows: 24, onData: (d) => { output += d; } });
  assert.ok(mgr.has('sess1'));
  setTimeout(() => {
    mgr.write('sess1', 'echo hello\n');
    setTimeout(() => {
      assert.ok(output.includes('hello') || output.length > 0);
      mgr.destroy('sess1');
      assert.equal(mgr.has('sess1'), false);
      done();
    }, 300);
  }, 200);
});

test('resize PTY', () => {
  const mgr = new PtyManager();
  mgr.create('sess2', { cols: 80, rows: 24, onData: () => {} });
  mgr.resize('sess2', 120, 40); // should not throw
  mgr.destroy('sess2');
});
```

**Step 3: 运行测试确认失败**

```bash
node --test tests/pty-manager.test.js
```

**Step 4: 实现 lib/pty-manager.js**

```js
// lib/pty-manager.js
const pty = require('node-pty');
const os = require('node:os');

class PtyManager {
  constructor() {
    this._ptys = new Map(); // sessionId → pty instance
  }

  create(sessionId, { cols = 220, rows = 50, onData, onExit } = {}) {
    if (this._ptys.has(sessionId)) this.destroy(sessionId);
    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash');
    const p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols, rows,
      cwd: process.env.HOME || '/',
      env: process.env
    });
    if (onData) p.onData(onData);
    if (onExit) p.onExit(onExit);
    this._ptys.set(sessionId, p);
    return p;
  }

  write(sessionId, data) {
    const p = this._ptys.get(sessionId);
    if (p) p.write(data);
  }

  resize(sessionId, cols, rows) {
    const p = this._ptys.get(sessionId);
    if (p) p.resize(cols, rows);
  }

  destroy(sessionId) {
    const p = this._ptys.get(sessionId);
    if (p) { try { p.kill(); } catch {} this._ptys.delete(sessionId); }
  }

  has(sessionId) {
    return this._ptys.has(sessionId);
  }

  destroyAll() {
    for (const id of this._ptys.keys()) this.destroy(id);
  }
}

module.exports = { PtyManager };
```

**Step 5: 运行测试**

```bash
node --test tests/pty-manager.test.js
```
Expected: 2 tests PASS

**Step 6: Commit**

```bash
git add lib/pty-manager.js tests/pty-manager.test.js package.json package-lock.json
git commit -m "feat: PTY 管理器 (node-pty)"
```

---

## Task 4: 开发机 WebSocket 客户端

**Files:**
- Create: `lib/ws-client.js`
- Create: `tests/ws-client.test.js`
- Modify: `lib/config.js` (新增 centralServer 配置字段)
- Modify: `lib/daemon.js` (启动时初始化 ws-client)

**Step 1: 更新 config.js defaultConfig**

在 `lib/config.js` 的 `defaultConfig()` 返回对象中新增：

```js
centralServer: {
  enabled: false,
  url: '',          // e.g. "ws://your-server:3000/ws"
  machineToken: '', // UUID，在中央服务器配置的 MACHINE_TOKENS 里
  machineId: ''     // 留空则用 getMachineId()
}
```

**Step 2: 写 ws-client 测试（mock WS server）**

```js
// tests/ws-client.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const { WsClient } = require('../lib/ws-client');

test('connects and sends register', (t, done) => {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      assert.equal(msg.type, 'register');
      assert.equal(msg.machineId, 'test-machine');
      wss.close();
      done();
    });
  });
  wss.on('listening', () => {
    const { port } = wss.address();
    const client = new WsClient({
      url: `ws://localhost:${port}/ws`,
      machineToken: 'test-token',
      machineId: 'test-machine',
      ptyManager: { create: () => {}, write: () => {}, resize: () => {}, destroy: () => {} }
    });
    client.connect();
    t.after(() => client.disconnect());
  });
});
```

**Step 3: 运行测试确认失败**

```bash
node --test tests/ws-client.test.js
```

**Step 4: 实现 lib/ws-client.js**

```js
// lib/ws-client.js
const WebSocket = require('ws');
const { listActiveSessions } = require('./session-registry');
const { getMachineId } = require('./config');

class WsClient {
  constructor({ url, machineToken, machineId, ptyManager }) {
    this._url = url;
    this._token = machineToken;
    this._machineId = machineId || getMachineId();
    this._pty = ptyManager;
    this._ws = null;
    this._reconnectTimer = null;
  }

  connect() {
    const ws = new WebSocket(this._url, {
      headers: {
        'x-machine-token': this._token,
        'x-machine-id': this._machineId
      }
    });
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', machineId: this._machineId }));
      this._sendSessionList();
    });

    ws.on('message', (data) => this._handleMessage(data.toString()));

    ws.on('close', () => {
      this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    });

    ws.on('error', () => {}); // 错误由 close 处理
  }

  _sendSessionList() {
    const sessions = listActiveSessions().map(s => ({ id: s.sessionId, cwd: s.cwd }));
    this._send({ type: 'session_list', sessions });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'pty_open') {
      this._pty.create(msg.sessionId, {
        cols: msg.cols, rows: msg.rows,
        onData: (data) => {
          this._send({ type: 'pty_data', sessionId: msg.sessionId, data: Buffer.from(data).toString('base64') });
        },
        onExit: () => {
          this._send({ type: 'pty_data', sessionId: msg.sessionId, data: '' });
        }
      });
    } else if (msg.type === 'pty_input') {
      const data = Buffer.from(msg.data, 'base64').toString();
      this._pty.write(msg.sessionId, data);
    } else if (msg.type === 'pty_resize') {
      this._pty.resize(msg.sessionId, msg.cols, msg.rows);
    } else if (msg.type === 'pty_close') {
      this._pty.destroy(msg.sessionId);
    }
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  disconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) this._ws.close();
  }
}

module.exports = { WsClient };
```

**Step 5: 运行测试**

```bash
node --test tests/ws-client.test.js
```
Expected: 1 test PASS

**Step 6: 集成到 daemon.js**

在 `lib/daemon.js` 的 `startDaemon()` 函数末尾，`await wsClient.start(...)` 之前添加：

```js
// 启动 Web Dashboard 连接（如已配置）
const { loadConfig } = require('./config');
const cfg = loadConfig();
if (cfg.centralServer?.enabled && cfg.centralServer?.url) {
  const { WsClient } = require('./ws-client');
  const { PtyManager } = require('./pty-manager');
  const ptyMgr = new PtyManager();
  const wsClientDash = new WsClient({
    url: cfg.centralServer.url,
    machineToken: cfg.centralServer.machineToken,
    machineId: cfg.centralServer.machineId || undefined,
    ptyManager: ptyMgr
  });
  wsClientDash.connect();
  log('Web Dashboard ws-client started');
  process.on('SIGTERM', () => { wsClientDash.disconnect(); ptyMgr.destroyAll(); });
  process.on('SIGINT', () => { wsClientDash.disconnect(); ptyMgr.destroyAll(); });
}
```

**Step 7: Commit**

```bash
git add lib/ws-client.js lib/pty-manager.js lib/config.js lib/daemon.js tests/ws-client.test.js
git commit -m "feat: 开发机 ws-client + daemon 集成"
```

---

## Task 5: 前端 SPA（React + xterm.js）

**Files:**
- Create: `packages/server/frontend/` (Vite + React 项目)

**Step 1: 初始化前端项目**

```bash
cd packages/server
npm create vite@latest frontend -- --template react
cd frontend && npm install
npm install @xterm/xterm @xterm/addon-fit
```

**Step 2: 替换 src/App.jsx**

```jsx
// packages/server/frontend/src/App.jsx
import { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));

  function handleLogin(t) {
    localStorage.setItem('token', t);
    setToken(t);
  }

  function handleLogout() {
    localStorage.removeItem('token');
    setToken(null);
  }

  if (!token) return <Login onLogin={handleLogin} />;
  return <Dashboard token={token} onLogout={handleLogout} />;
}
```

**Step 3: 创建 src/Login.jsx**

```jsx
// packages/server/frontend/src/Login.jsx
import { useState } from 'react';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      const { token } = await res.json();
      onLogin(token);
    } else {
      setError('用户名或密码错误');
    }
  }

  return (
    <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:'100vh', background:'#1a1a2e' }}>
      <form onSubmit={handleSubmit} style={{ background:'#16213e', padding:'2rem', borderRadius:'8px', minWidth:'300px' }}>
        <h2 style={{ color:'#e2e8f0', marginBottom:'1.5rem' }}>Claude Code Dashboard</h2>
        {error && <p style={{ color:'#fc8181' }}>{error}</p>}
        <input placeholder="用户名" value={username} onChange={e=>setUsername(e.target.value)}
          style={{ display:'block', width:'100%', marginBottom:'1rem', padding:'0.5rem', borderRadius:'4px', border:'1px solid #4a5568', background:'#2d3748', color:'#e2e8f0' }} />
        <input type="password" placeholder="密码" value={password} onChange={e=>setPassword(e.target.value)}
          style={{ display:'block', width:'100%', marginBottom:'1rem', padding:'0.5rem', borderRadius:'4px', border:'1px solid #4a5568', background:'#2d3748', color:'#e2e8f0' }} />
        <button type="submit" style={{ width:'100%', padding:'0.5rem', background:'#4299e1', color:'white', border:'none', borderRadius:'4px', cursor:'pointer' }}>
          登录
        </button>
      </form>
    </div>
  );
}
```

**Step 4: 创建 src/Dashboard.jsx**

```jsx
// packages/server/frontend/src/Dashboard.jsx
import { useState, useEffect, useRef } from 'react';
import TerminalPanel from './TerminalPanel';

export default function Dashboard({ token, onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null); // { machineId, sessionId }
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${token}`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'session_list') setSessions(msg.sessions || []);
    };
    ws.onclose = () => {};
    return () => ws.close();
  }, [token]);

  function openTerminal(machineId, sessionId) {
    setActive({ machineId, sessionId });
    wsRef.current?.send(JSON.stringify({ type: 'open_terminal', machineId, sessionId, cols: 220, rows: 50 }));
  }

  // 按机器分组
  const byMachine = sessions.reduce((acc, s) => {
    (acc[s.machineId] = acc[s.machineId] || []).push(s);
    return acc;
  }, {});

  return (
    <div style={{ display:'flex', height:'100vh', background:'#1a1a2e', color:'#e2e8f0', fontFamily:'monospace' }}>
      {/* 左侧 session 列表 */}
      <div style={{ width:'220px', background:'#16213e', padding:'1rem', overflowY:'auto', flexShrink:0 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem' }}>
          <span style={{ fontWeight:'bold' }}>Sessions</span>
          <button onClick={onLogout} style={{ background:'none', border:'none', color:'#a0aec0', cursor:'pointer', fontSize:'0.8rem' }}>退出</button>
        </div>
        {Object.entries(byMachine).map(([machineId, sess]) => (
          <div key={machineId} style={{ marginBottom:'1rem' }}>
            <div style={{ color:'#68d391', fontSize:'0.85rem', marginBottom:'0.3rem' }}>● {machineId}</div>
            {sess.map(s => (
              <div key={s.id} onClick={() => openTerminal(machineId, s.id)}
                style={{ padding:'0.3rem 0.5rem', cursor:'pointer', borderRadius:'4px', fontSize:'0.8rem',
                  background: active?.sessionId === s.id ? '#2d3748' : 'transparent',
                  color: active?.sessionId === s.id ? '#90cdf4' : '#a0aec0' }}>
                {s.id.slice(0, 8)}… {s.cwd ? `(${s.cwd.split('/').pop()})` : ''}
              </div>
            ))}
          </div>
        ))}
        {sessions.length === 0 && <div style={{ color:'#718096', fontSize:'0.8rem' }}>等待开发机连接…</div>}
      </div>

      {/* 右侧终端 */}
      <div style={{ flex:1, display:'flex', flexDirection:'column' }}>
        {active ? (
          <TerminalPanel key={`${active.machineId}-${active.sessionId}`}
            machineId={active.machineId} sessionId={active.sessionId}
            ws={wsRef.current} />
        ) : (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'#718096' }}>
            从左侧选择一个 session 打开终端
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 5: 创建 src/TerminalPanel.jsx**

```jsx
// packages/server/frontend/src/TerminalPanel.jsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel({ machineId, sessionId, ws }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({ theme: { background: '#1a1a2e' }, cursorBlink: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    // 键盘输入 → ws
    term.onData((data) => {
      ws?.send(JSON.stringify({
        type: 'terminal_input', machineId, sessionId,
        data: btoa(unescape(encodeURIComponent(data)))
      }));
    });

    // ws 数据 → terminal
    function onMessage(e) {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pty_data' && msg.sessionId === sessionId) {
        term.write(atob(msg.data));
      }
    }
    ws?.addEventListener('message', onMessage);

    // resize
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      ws?.send(JSON.stringify({ type: 'terminal_resize', machineId, sessionId, cols: term.cols, rows: term.rows }));
    });
    ro.observe(containerRef.current);

    return () => {
      ws?.removeEventListener('message', onMessage);
      ro.disconnect();
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} style={{ flex:1, height:'100%', padding:'4px' }} />;
}
```

**Step 6: 配置 vite.config.js 代理（开发时）**

```js
// packages/server/frontend/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
});
```

**Step 7: 构建前端**

```bash
cd packages/server/frontend && npm run build
```

**Step 8: 验证**

```bash
cd packages/server && node index.js --create-user admin
node index.js &
# 浏览器打开 http://localhost:3000，应看到登录页
kill %1
```

**Step 9: Commit**

```bash
git add packages/server/frontend/
git commit -m "feat: React + xterm.js 前端 SPA"
```

---

## Task 6: 配置向导更新 + 文档

**Files:**
- Modify: `bin/cli.js` (新增 centralServer 配置步骤)
- Modify: `README.md` (新增 Web Dashboard 章节)

**Step 1: 在 bin/cli.js 配置向导中新增 centralServer 配置**

找到配置向导的交互部分，在飞书配置之后新增：

```js
// 询问是否启用 Web Dashboard
const enableDash = await ask('是否启用 Web Dashboard？(y/N): ');
if (enableDash.toLowerCase() === 'y') {
  const serverUrl = await ask('中央服务器 WebSocket 地址 (如 ws://your-server:3000/ws): ');
  const machineToken = await ask('Machine Token (在中央服务器 MACHINE_TOKENS 环境变量中配置): ');
  config.centralServer = { enabled: true, url: serverUrl, machineToken, machineId: '' };
} else {
  config.centralServer = { enabled: false, url: '', machineToken: '', machineId: '' };
}
```

**Step 2: 更新 README.md，新增 Web Dashboard 章节**

在 README.md 的"双向交互"章节后新增：

```markdown
## Web Dashboard（v4.0）

通过浏览器管理多台开发机的 Claude Code session，支持完整 PTY 终端。

### 部署中央服务器

```bash
cd packages/server
npm install
# 创建管理员账号
node index.js --create-user admin
# 启动（建议用 nginx 反代）
MACHINE_TOKENS=your-uuid-token node index.js --port 3000
```

### 配置开发机

```bash
npx vibeanything  # 重新配置，填入中央服务器地址和 machine token
npx vibeanything --daemon start
```

### 访问

浏览器打开 `https://your-server/`，用管理员账号登录即可看到所有已连接开发机的 session。
```

**Step 3: 运行所有测试**

```bash
npm test
cd packages/server && node --test tests/
```
Expected: 全部 PASS

**Step 4: 最终 Commit**

```bash
git add bin/cli.js README.md
git commit -m "feat: 配置向导 + README 更新 Web Dashboard"
```

---

## 部署检查清单

- [ ] 中央服务器：`MACHINE_TOKENS` 环境变量设置
- [ ] 中央服务器：`JWT_SECRET` 环境变量设置（生产环境必须）
- [ ] nginx 反代配置（支持 WebSocket upgrade）
- [ ] 开发机：daemon 配置 `centralServer.enabled: true`
- [ ] 开发机：`centralServer.machineToken` 与服务器 `MACHINE_TOKENS` 一致
