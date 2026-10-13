# 默认工作路径功能设计

## 背景

FileBrowser 当前每次打开都从 `/` 开始，体验不佳。需要支持每台开发机配置默认起始路径，打开文件浏览器时自动导航到该路径。

## 目标

- 在 `~/.vibeanything/config.json` 中配置 `defaultWorkDir`
- daemon 连接 dashboard 时上报该路径
- FileBrowser 初始化及切换机器时使用该路径
- 未配置时回落到 `os.homedir()`

## 数据流

```
~/.vibeanything/config.json
  └─ defaultWorkDir: "/Users/gsj/projects"
        ↓ ws-client 启动时读取
register 消息: { type: 'register', machineId, defaultWorkDir }
        ↓ WebSocket → relay
relay.machines.set(machineId, { ws, defaultWorkDir })
        ↓ _broadcastSessionList() 广播
浏览器机器列表: [{ machineId, defaultWorkDir, sessions }]
        ↓ FileBrowser props.machines
初始路径 = machine.defaultWorkDir || '/'
```

## 改动清单

### 1. `lib/config.js`

在 `defaultConfig()` 中加入：

```js
defaultWorkDir: '',  // 文件浏览器默认起始路径，空则用 homedir
```

### 2. `lib/ws-client.js`

构造函数加入 `defaultWorkDir` 参数：

```js
this._defaultWorkDir = options.defaultWorkDir || '';
```

`connect()` 中 register 消息附带（空时用实际 homedir）：

```js
ws.send(JSON.stringify({
  type: 'register',
  machineId: this._machineId,
  defaultWorkDir: this._defaultWorkDir || os.homedir()
}));
```

### 3. `lib/daemon.js`

创建 WsClient 时从 config 传入：

```js
const wsClientDash = new WsClient({
  url: cfg.centralServer.url,
  machineToken: cfg.centralServer.machineToken,
  machineId: cfg.centralServer.machineId || undefined,
  defaultWorkDir: cfg.defaultWorkDir || '',   // 新增
  ptyManager: ptyMgr
});
```

### 4. `packages/server/relay.js`

`registerMachine` 存储 defaultWorkDir：

```js
registerMachine(machineId, ws, defaultWorkDir = '') {
  this.machines.set(machineId, { ws, defaultWorkDir });
}
```

连接时从 register 消息获取（需在 `wss.on('connection')` 处理中读取 register 消息）：

```js
ws.once('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'register') {
    this.registerMachine(msg.machineId, ws, msg.defaultWorkDir || '');
  }
});
```

`_broadcastSessionList()` 广播时带上 `defaultWorkDir`：

```js
{ machineId, defaultWorkDir: machine.defaultWorkDir, sessionCount: ... }
```

### 5. `packages/server/frontend/src/FileBrowser.jsx`

`machines` prop 已含 `defaultWorkDir`，用于初始化路径：

```js
const machine = machines.find(m => m.machineId === machineId);
const initPath = machine?.defaultWorkDir || '/';
const [currentPath, setCurrentPath] = useState(initPath);

// 切换机器时重置路径
useEffect(() => {
  const m = machines.find(m => m.machineId === machineId);
  setCurrentPath(m?.defaultWorkDir || '/');
}, [machineId]);
```

## 错误处理

- 路径不存在：ws-client 的 `listDir` 返回空数组，前端显示空目录（现有行为，无需额外处理）
- 配置为空：ws-client 用 `os.homedir()` 填充，前端始终收到绝对路径

## 不在范围内

- Dashboard UI 上直接修改默认路径（需配置文件修改）
- 多路径历史记录
- 路径有效性校验提示
