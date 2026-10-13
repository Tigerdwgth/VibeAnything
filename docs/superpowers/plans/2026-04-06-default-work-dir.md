# Default Work Dir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文件浏览器打开时从每台机器配置的 `defaultWorkDir` 开始，未配置则用 homedir。

**Architecture:** 在 `config.json` 加 `defaultWorkDir` 字段；ws-client 通过 register 消息上报；relay 存入 machines map 并通过 `machine_list` 广播；前端 FileBrowser 用该字段作为初始路径。

**Tech Stack:** Node.js, React, WebSocket (ws)

---

### Task 1: 配置层加 defaultWorkDir 字段

**Files:**
- Modify: `lib/config.js`

- [ ] **Step 1: 在 defaultConfig() 中加字段**

在 `lib/config.js` 的 `defaultConfig()` 函数里，`machineId: ''` 行之后加一行：

```js
defaultWorkDir: '',      // 文件浏览器默认起始路径，空则用 os.homedir()
```

- [ ] **Step 2: 验证配置读取正常**

```bash
cd /Users/gsj/VibeAnything
node -e "const {defaultConfig} = require('./lib/config'); console.log(defaultConfig().defaultWorkDir)"
```

Expected: 输出空字符串 `''`

- [ ] **Step 3: Commit**

```bash
cd /Users/gsj/VibeAnything
git add lib/config.js
git commit -m "feat: add defaultWorkDir to config schema"
```

---

### Task 2: ws-client 在 register 消息中上报 defaultWorkDir

**Files:**
- Modify: `lib/ws-client.js`
- Modify: `lib/daemon.js`

- [ ] **Step 1: WsClient constructor 加 defaultWorkDir 参数**

在 `lib/ws-client.js` 第 373 行的 constructor 中，`this._machineId` 行后加：

```js
this._defaultWorkDir = options.defaultWorkDir || '';
```

- [ ] **Step 2: connect() 的 register 消息携带 defaultWorkDir**

在 `lib/ws-client.js` 的 `ws.on('open', ...)` 回调里，找到这一行：

```js
ws.send(JSON.stringify({ type: 'register', machineId: this._machineId }));
```

替换为：

```js
const os = require('node:os');
ws.send(JSON.stringify({
  type: 'register',
  machineId: this._machineId,
  defaultWorkDir: this._defaultWorkDir || os.homedir()
}));
```

- [ ] **Step 3: daemon.js 传入 defaultWorkDir**

在 `lib/daemon.js` 第 295 行附近创建 WsClient 的代码块中，找到：

```js
const wsClientDash = new WsClient({
  url: cfg.centralServer.url,
  machineToken: cfg.centralServer.machineToken,
  machineId: cfg.centralServer.machineId || undefined,
  ptyManager: ptyMgr
});
```

替换为：

```js
const wsClientDash = new WsClient({
  url: cfg.centralServer.url,
  machineToken: cfg.centralServer.machineToken,
  machineId: cfg.centralServer.machineId || undefined,
  defaultWorkDir: cfg.defaultWorkDir || '',
  ptyManager: ptyMgr
});
```

- [ ] **Step 4: 验证**

```bash
cd /Users/gsj/VibeAnything
node -e "
const {WsClient} = require('./lib/ws-client');
const {PtyManager} = require('./lib/pty-manager');
const c = new WsClient({url:'ws://x',machineToken:'t',machineId:'m',defaultWorkDir:'/tmp',ptyManager:new PtyManager()});
console.log(c._defaultWorkDir);
"
```

Expected: `/tmp`

- [ ] **Step 5: Commit**

```bash
cd /Users/gsj/VibeAnything
git add lib/ws-client.js lib/daemon.js
git commit -m "feat: send defaultWorkDir in register message"
```

---

### Task 3: relay 存储并广播 defaultWorkDir

**Files:**
- Modify: `packages/server/relay.js`

- [ ] **Step 1: registerMachine 加 defaultWorkDir 参数**

在 `packages/server/relay.js` 第 56 行，将：

```js
registerMachine(machineId, ws) {
  if (this.machines.has(machineId)) {
    console.warn(`[relay] ⚠️  machineId 碰撞: "${machineId}" 已存在，新连接将覆盖旧连接。请在各机器的 ~/.vibeanything/config.json 中设置不同的 machineId。`);
  }
  console.log(`[relay] machine registered: ${machineId}`);
  this.machines.set(machineId, { ws, sessions: [] });
}
```

替换为：

```js
registerMachine(machineId, ws, defaultWorkDir = '') {
  if (this.machines.has(machineId)) {
    console.warn(`[relay] ⚠️  machineId 碰撞: "${machineId}" 已存在，新连接将覆盖旧连接。请在各机器的 ~/.vibeanything/config.json 中设置不同的 machineId。`);
  }
  console.log(`[relay] machine registered: ${machineId}`);
  this.machines.set(machineId, { ws, sessions: [], defaultWorkDir });
}
```

- [ ] **Step 2: 在 handleMachineMessage 中处理 register 消息更新 defaultWorkDir**

在 `packages/server/relay.js` 的 `handleMachineMessage(machineId, raw)` 方法中，在现有消息处理逻辑最前面加：

```js
if (msg.type === 'register') {
  const m = this.machines.get(machineId);
  if (m && msg.defaultWorkDir) {
    m.defaultWorkDir = msg.defaultWorkDir;
    this._broadcastMachineList();
  }
  return;
}
```

- [ ] **Step 3: _broadcastMachineList 包含 defaultWorkDir**

找到 `_broadcastMachineList()` 方法：

```js
_broadcastMachineList() {
  const machines = Array.from(this.machines.keys()).map(machineId => ({ machineId }));
  const msg = JSON.stringify({ type: 'machine_list', machines });
  for (const { ws } of this.browsers.values()) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
```

替换为：

```js
_broadcastMachineList() {
  const machines = Array.from(this.machines.entries()).map(([machineId, m]) => ({
    machineId,
    defaultWorkDir: m.defaultWorkDir || ''
  }));
  const msg = JSON.stringify({ type: 'machine_list', machines });
  for (const { ws } of this.browsers.values()) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
```

- [ ] **Step 4: _addBrowser 推送机器列表也包含 defaultWorkDir**

在 `_addBrowser` 方法中，找到这行：

```js
ws.send(JSON.stringify({ type: 'machine_list', machines: Array.from(this.machines.keys()).map(machineId => ({ machineId })) }));
```

替换为：

```js
ws.send(JSON.stringify({ type: 'machine_list', machines: Array.from(this.machines.entries()).map(([machineId, m]) => ({ machineId, defaultWorkDir: m.defaultWorkDir || '' })) }));
```

- [ ] **Step 5: Commit**

```bash
cd /Users/gsj/VibeAnything
git add packages/server/relay.js
git commit -m "feat: relay stores and broadcasts defaultWorkDir per machine"
```

---

### Task 4: 前端使用 defaultWorkDir 作为初始路径

**Files:**
- Modify: `packages/server/frontend/src/Dashboard.jsx`
- Modify: `packages/server/frontend/src/FileBrowser.jsx`

- [ ] **Step 1: Dashboard.jsx 保留 defaultWorkDir 到 onlineMachines**

在 `packages/server/frontend/src/Dashboard.jsx` 第 47 行的 `machines` useMemo 中，找到：

```js
onlineMachines.forEach(m => map.set(m.machineId, { machineId: m.machineId, sessionCount: 0 }));
```

替换为：

```js
onlineMachines.forEach(m => map.set(m.machineId, { machineId: m.machineId, sessionCount: 0, defaultWorkDir: m.defaultWorkDir || '' }));
```

- [ ] **Step 2: FileBrowser.jsx 初始路径使用 machine.defaultWorkDir**

在 `packages/server/frontend/src/FileBrowser.jsx` 第 167 行的 FileBrowser 组件中，找到初始化 `treeRoot` 的代码：

```js
const [treeRoot, setTreeRoot] = useState(() => {
  const recent = [...new Set((historySessions || []).map(s => s.cwd).filter(Boolean))];
  return recent[0] || '/';
});
const [treeRootInput, setTreeRootInput] = useState(() => {
  const recent = [...new Set((historySessions || []).map(s => s.cwd).filter(Boolean))];
  return recent[0] || '/';
});
```

替换为：

```js
const getInitialPath = (mid) => {
  const m = (machines || []).find(mc => mc.machineId === (mid || machineId));
  if (m?.defaultWorkDir) return m.defaultWorkDir;
  const recent = [...new Set((historySessions || []).map(s => s.cwd).filter(Boolean))];
  return recent[0] || '/';
};
const [treeRoot, setTreeRoot] = useState(() => getInitialPath(machineId));
const [treeRootInput, setTreeRootInput] = useState(() => getInitialPath(machineId));
```

- [ ] **Step 3: machineId 切换时重置路径为该机器的 defaultWorkDir**

在 FileBrowser 组件中，找到 `const effectiveMachineId = selectedMachineId || machineId;` 这行，在其后加：

```js
// 切换机器时重置到该机器的默认路径
useEffect(() => {
  const path = getInitialPath(effectiveMachineId);
  setTreeRoot(path);
  setTreeRootInput(path);
}, [effectiveMachineId]);
```

注意：`useEffect` 需要从 React 导入（检查文件顶部是否已有）。

- [ ] **Step 4: Commit**

```bash
cd /Users/gsj/VibeAnything
git add packages/server/frontend/src/Dashboard.jsx packages/server/frontend/src/FileBrowser.jsx
git commit -m "feat: FileBrowser uses machine defaultWorkDir as initial path"
```

---

### Task 5: 构建前端并部署到服务器

**Files:** 无代码改动，构建 + 部署

- [ ] **Step 1: 构建前端**

```bash
cd /Users/gsj/VibeAnything/packages/server/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in X.XXs`

- [ ] **Step 2: 同步前端 dist 到服务器**

```bash
rsync -avz --delete \
  /Users/gsj/VibeAnything/packages/server/frontend/dist/ \
  root@aliyun-derper:/root/VibeAnything/packages/server/frontend/dist/
```

- [ ] **Step 3: 同步后端文件到服务器**

```bash
rsync -avz \
  /Users/gsj/VibeAnything/packages/server/relay.js \
  root@aliyun-derper:/root/VibeAnything/packages/server/relay.js
```

- [ ] **Step 4: 重启 dashboard**

```bash
ssh root@aliyun-derper "systemctl restart claude-dashboard && sleep 2 && systemctl is-active claude-dashboard"
```

Expected: `active`

- [ ] **Step 5: 重启本地 daemon**

```bash
cd /Users/gsj/VibeAnything
node bin/cli.js --daemon stop && sleep 1
node bin/cli.js --daemon start >> ~/.vibeanything/daemon.log 2>&1 &
sleep 3 && grep "ws-client.*成功" ~/.vibeanything/daemon.log | tail -1
```

Expected: `[ws-client] ✅ WebSocket 连接成功`

---

### Task 6: 端到端验证

- [ ] **Step 1: 设置本地测试用默认路径**

```bash
node -e "
const {loadConfig, saveConfig} = require('/Users/gsj/VibeAnything/lib/config');
const cfg = loadConfig();
cfg.defaultWorkDir = '/Users/gsj';
saveConfig(cfg);
console.log('saved:', cfg.defaultWorkDir);
"
```

- [ ] **Step 2: 重启 daemon 让新配置生效**

```bash
cd /Users/gsj/VibeAnything
node bin/cli.js --daemon stop && sleep 1
node bin/cli.js --daemon start >> ~/.vibeanything/daemon.log 2>&1 &
sleep 3 && grep "ws-client.*成功" ~/.vibeanything/daemon.log | tail -1
```

- [ ] **Step 3: 浏览器验证**

打开 `http://100.64.0.10:3000`，切换到 macmini 的文件浏览器，确认默认路径是 `/Users/gsj` 而不是 `/`。

- [ ] **Step 4: 切换机器验证**

在文件浏览器内切换到另一台机器（如 gpuserver1-jdh），确认路径切换到该机器的默认值（未配置则是其 homedir）。

- [ ] **Step 5: Final commit**

```bash
cd /Users/gsj/VibeAnything
git add -A
git commit -m "feat: default work dir feature complete"
```
