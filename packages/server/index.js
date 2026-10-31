// packages/server/index.js
const express = require('express');
const path = require('node:path');
const { createUser, verifyPassword, generateToken, authMiddleware, listUsers, updatePassword, isAdmin, getProfile, updateProfile } = require('./auth');
const { validateNickname, validateAvatar } = require('./profile-rules');
const owners = require('./session-owners');
const machineTokens = require('./machine-tokens');
const { sessionIdOf, hasMachineToken } = require('./relay');
const usage = require('./usage-store');

const app = express();
// 默认 100kb 装不下一次全量用量上报（几十天 × 多模型），放宽到 2mb。
app.use(express.json({ limit: '2mb' }));

// 仅管理员：会话归属的查看与转交
function adminMiddleware(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

/** 转交归属前校验目标用户存在；不存在时直接回 404 并返回 false。 */
async function ensureUserExists(owner, res) {
  const users = await listUsers();
  if (users.some(u => u.username === owner)) return true;
  res.status(404).json({ error: `用户不存在: ${owner}` });
  return false;
}

// 静态前端（Task 5 填充）
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// ── 前端版本号 ────────────────────────────────────────────────
// 部署前端只是 rsync 一份新 dist（express.static 直接生效，不重启服务），所以**开着的
// 标签页不会知道**：它手里的 index.html 是几天前拿的，里面钉着旧 bundle 的文件名，
// 不手动刷新就一直跑旧代码。「前端更新了么」这个问题以前只能靠人去比对 bundle 名。
//
// 这里给前端一个可轮询的版本号：dist/index.html 的 mtime。必须**按请求现算**而不是
// 启动时算一次 —— 不重启就换 dist 正是本项目的部署方式。stat 结果缓存 10 秒，
// 避免多个标签页轮询把它变成 stat 风暴。
const INDEX_HTML = path.join(__dirname, 'frontend/dist/index.html');
let _buildCache = { id: null, at: 0 };
app.get('/api/build', (req, res) => {
  const now = Date.now();
  if (now - _buildCache.at > 10_000) {
    let id = 'unknown';
    try { id = String(require('node:fs').statSync(INDEX_HTML).mtimeMs); } catch { /* dist 还没构建 */ }
    _buildCache = { id, at: now };
  }
  // 这条接口自己绝不能被缓存，否则轮询永远拿到同一个答案
  res.set('Cache-Control', 'no-store');
  res.json({ buildId: _buildCache.id });
});

// 注册（仅当无用户时开放，或管理员已登录时可创建新用户）
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
  // 仅当系统无用户时允许开放注册（首次初始化）
  const users = await listUsers();
  if (users.length > 0) return res.status(403).json({ error: '注册已关闭，请联系管理员' });
  try {
    const user = await createUser(username, password);
    const token = generateToken(user);
    res.json({ token, username: user.username });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '用户名已存在' });
    res.status(500).json({ error: '注册失败' });
  }
});

// 管理员创建用户
app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
  try {
    const user = await createUser(username, password);
    res.json({ id: user.id, username: user.username });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '用户名已存在' });
    res.status(500).json({ error: '创建失败' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await verifyPassword(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateToken(user);
  res.json({ token, username: user.username });
});

// 滑动续期：凭一张仍有效的 token 换一张新的 30 天票，载荷与登录一致。
// role 在这里重新取自库 —— 它平时只认票里的值，续期就是它跟上库里变更的时机；
// 用户已被删时 getProfile 为空，同样回 401。票已过期 / 已被撤销则在 authMiddleware 就被拒了。
app.post('/api/session/refresh', authMiddleware, async (req, res) => {
  const profile = await getProfile(req.user.username);
  if (!profile) return res.status(401).json({ error: '用户已不存在，请重新登录' });
  const { id, username, role } = profile;
  res.json({ token: generateToken({ id, username, role }), username });
});

// 当前用户信息。
// role 仍取自 JWT（授权判定的单一真源就是这张票，和 WS 的 whoami 保持一致）；
// nickname / avatar 则每次查库 —— token 要隔很久才续期，改完昵称不能等到那时才生效。
app.get('/api/me', authMiddleware, async (req, res) => {
  const profile = await getProfile(req.user.username);
  if (!profile) return res.status(401).json({ error: '用户已不存在，请重新登录' });
  res.json({
    username: profile.username,
    role: req.user.role || 'user',
    nickname: profile.nickname,
    avatar: profile.avatar,
  });
});

// 修改自己的个人信息（昵称 / 头像）。只改自己，没有按用户名指定目标的入口。
// 字段语义：不传 = 不动，传 null / '' = 清空并回落默认（默认头像、以用户名当昵称）。
app.patch('/api/profile', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const patch = {};

  if ('nickname' in body) {
    const checked = validateNickname(body.nickname);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    patch.nickname = checked.value;
  }
  if ('avatar' in body) {
    const checked = validateAvatar(body.avatar);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    patch.avatar = checked.value;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: '没有要修改的字段（nickname / avatar）' });
  }

  try {
    const profile = await updateProfile(req.user.username, patch);
    res.json({
      username: profile.username,
      role: req.user.role || 'user',
      nickname: profile.nickname,
      avatar: profile.avatar,
    });
  } catch (e) {
    if (e.message === 'User not found') {
      return res.status(401).json({ error: '用户已不存在，请重新登录' });
    }
    console.error('[profile] 保存失败:', e);
    res.status(500).json({ error: '保存失败' });
  }
});

// ── 会话归属管理（仅管理员）────────────────────────────────
// 列出 relay 当前已知的全部会话及其归属，无主会话 owner 为 null
app.get('/api/session-owners', authMiddleware, adminMiddleware, (req, res) => {
  const relay = global.relayServer;
  if (!relay) return res.status(503).json({ error: 'Relay not available' });
  const sessions = relay.getAllSessions().map(s => {
    const sessionId = sessionIdOf(s);
    return { machineId: s.machineId, sessionId, cwd: s.cwd || '', owner: owners.getOwner(s.machineId, sessionId) };
  });
  res.json({ sessions, ledger: owners.listOwners(), folderLedger: owners.listFolderOwners() });
});

// 转交单个会话归属
app.post('/api/session-owners', authMiddleware, adminMiddleware, async (req, res) => {
  const { machineId, sessionId, owner } = req.body || {};
  if (!machineId || !sessionId || !owner) {
    return res.status(400).json({ error: 'machineId / sessionId / owner 不能为空' });
  }
  if (!await ensureUserExists(owner, res)) return;
  owners.setOwner(machineId, sessionId, owner);
  global.relayServer?.refreshSessionLists();
  res.json({ ok: true, machineId, sessionId, owner });
});

// 批量认领：把指定机器上（不传则全部机器）当前所有会话归给某用户。
// onlyUnowned=true 时只登记无主会话，不动已有归属 —— 存量迁移的安全默认。
app.post('/api/session-owners/claim-all', authMiddleware, adminMiddleware, async (req, res) => {
  const { owner, machineId, onlyUnowned = true } = req.body || {};
  if (!owner) return res.status(400).json({ error: 'owner 不能为空' });
  if (!await ensureUserExists(owner, res)) return;
  const relay = global.relayServer;
  if (!relay) return res.status(503).json({ error: 'Relay not available' });

  const claimed = [];
  for (const s of relay.getAllSessions()) {
    if (machineId && s.machineId !== machineId) continue;
    const sessionId = sessionIdOf(s);
    if (!sessionId) continue;
    if (onlyUnowned && owners.getOwner(s.machineId, sessionId)) continue;
    claimed.push({ machineId: s.machineId, sessionId });
  }
  // 批量登记只落一次盘（单条 setOwner = 一次全库 export + 写文件）
  owners.setOwners(claimed.map(c => ({ machineId: c.machineId, id: c.sessionId, owner })));
  relay.refreshSessionLists();
  res.json({ ok: true, owner, count: claimed.length, claimed });
});

// 单个窗口的共享名单。收件人获得该终端的查看和操作权限，归属保持不变。
function sharingTarget(req, res, next) {
  const { machineId, sessionId } = req.method === 'GET' ? req.query : (req.body || {});
  if (typeof machineId !== 'string' || !machineId || typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'machineId / sessionId 不能为空' });
  }
  if (!owners.canManageSharing(req.user, machineId, sessionId)) {
    return res.status(403).json({ error: '只有窗口所有者或管理员可以管理共享' });
  }
  const exists = owners.getOwner(machineId, sessionId) || global.relayServer?.getAllSessions()
    .some(s => s.machineId === machineId && sessionIdOf(s) === sessionId);
  if (!exists) return res.status(404).json({ error: '窗口不存在' });
  req.sharingTarget = { machineId, sessionId };
  next();
}

function sharingState(machineId, sessionId) {
  return { machineId, sessionId, owner: owners.getOwner(machineId, sessionId), users: owners.getShares(machineId, sessionId) };
}

app.get('/api/session-shares', authMiddleware, sharingTarget, async (req, res) => {
  const { machineId, sessionId } = req.sharingTarget;
  const users = await listUsers();
  res.json({ ...sharingState(machineId, sessionId), availableUsers: users.map(u => u.username) });
});

app.post('/api/session-shares', authMiddleware, sharingTarget, async (req, res) => {
  const { machineId, sessionId } = req.sharingTarget;
  const { username } = req.body;
  if (typeof username !== 'string' || !username) return res.status(400).json({ error: '请选择共享用户' });
  if (!await ensureUserExists(username, res)) return;
  owners.addShare(machineId, sessionId, username);
  global.relayServer?.refreshSessionLists();
  res.json(sharingState(machineId, sessionId));
});

app.delete('/api/session-shares', authMiddleware, sharingTarget, (req, res) => {
  const { machineId, sessionId } = req.sharingTarget;
  const { username } = req.body;
  if (typeof username !== 'string' || !username) return res.status(400).json({ error: '请选择取消共享的用户' });
  owners.removeShare(machineId, sessionId, username);
  global.relayServer?.refreshSessionLists();
  res.json(sharingState(machineId, sessionId));
});

// 修改密码
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码不能为空' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6个字符' });
  }

  try {
    const { updatePassword } = require('./auth');
    await updatePassword(req.user.username, oldPassword, newPassword);
    // updatePassword 让所有旧票作废，给当前设备补发一张新的，否则它自己也掉线。
    // 已建立的 WS 在响应送出之后再踢：先让新票到达前端，前端收到 4001 才有票可续。
    const { id, username, role } = await getProfile(req.user.username);
    res.on('finish', () => global.relayServer?.disconnectUser(username));
    res.json({ success: true, message: '密码修改成功', token: generateToken({ id, username, role }) });
  } catch (e) {
    if (e.message.includes('Invalid old password')) {
      return res.status(401).json({ error: '旧密码错误' });
    }
    res.status(500).json({ error: '修改失败' });
  }
});

// 获取指定机器的目录列表
app.get('/api/machines/:machineId/directories', authMiddleware, (req, res) => {
  const { machineId } = req.params;
  const { path: dirPath } = req.query;

  // 通过 relay 向指定机器请求目录列表
  const { RelayServer } = require('./relay');
  const relay = global.relayServer;
  if (!relay) return res.status(503).json({ error: 'Relay not available' });

  const machine = relay.getMachine(machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  // 发送请求到机器
  machine.ws.send(JSON.stringify({
    type: 'list_dir',
    path: dirPath || require('os').homedir()
  }));

  // 等待响应（简化版，实际应该用 Promise）
  res.json({ message: 'Request sent, check WebSocket for response' });
});

// ── 开发机装机（邀请码 → 绑定机器的长期 token）────────────────
// 装一台机器以前要：改 dashboard 的 systemd unit 加一条 MACHINE_TOKENS、重启服务
// （打断所有浏览器连接）、再把那串明文 token 抄进部署文档。现在：管理员发一个一次性码，
// 机器自己换一把只属于它的 token，零重启；撤销就是删一行。台账见 machine-tokens.js。

// 签发一次性邀请码。machineId 可选：给定则此码只能换成那台机器的 token
// （也是给已有机器换新 token 的唯一途径），留空则装机时由客户端提出自己的名字。
app.post('/api/machines/invite', authMiddleware, adminMiddleware, (req, res) => {
  const { machineId = null, label = null, ttlMinutes } = req.body || {};
  const ttlMs = Number(ttlMinutes) > 0 ? Number(ttlMinutes) * 60_000 : undefined;
  machineTokens.pruneInvites();
  const invite = machineTokens.createInvite({
    machineId: machineId ? String(machineId).trim() : null,
    label: label ? String(label).trim() : null,
    createdBy: req.user.username,
    ttlMs,
  });
  // code 是明文，只在这一次响应里出现（库里只有它的 sha256）
  res.json(invite);
});

// 用邀请码换 token。**不带 JWT** —— 新机器上还没有任何账号凭据，码本身就是凭据。
app.post('/api/machines/join', (req, res) => {
  const { code, machineId = null, label = null } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code 不能为空' });
  const result = machineTokens.redeemInvite(code, {
    machineId: machineId ? String(machineId).trim() : null,
    label: label ? String(label).trim() : null,
  });
  if (result.error) {
    // 码不对/过期/已用 一律 401：别让调用方据此区分「这个码存在过」。
    // 「机器已登记」是 409：这条要给出可操作的提示，不是凭据问题。
    const status = result.code === 'machine_exists' ? 409
      : result.code === 'missing_machine_id' ? 400 : 401;
    return res.status(status).json({ error: result.error, code: result.code });
  }
  console.log(`[machines] ${result.machineId} 用邀请码完成装机`);
  res.json({ machineToken: result.machineToken, machineId: result.machineId });
});

// 台账 + 在线状态。不含任何 token 材料。
app.get('/api/machines', authMiddleware, adminMiddleware, (req, res) => {
  const relay = global.relayServer;
  const online = new Set(relay ? [...relay.machines.keys()] : []);
  const machines = machineTokens.listMachines().map(m => ({ ...m, online: online.has(m.machineId) }));
  // 还在用旧全局 token 的机器不在台账里，但它们确实在线 —— 列出来才知道还剩几台没换装
  const legacy = [...online].filter(id => !machineTokens.hasMachine(id)).map(machineId => ({ machineId }));
  res.json({ machines, legacyMachines: legacy, pendingInvites: machineTokens.listPendingInvites() });
});

// 撤销一台机器：token 立刻失效，并把它已经建立的连接踢掉
// （鉴权只在握手那一刻发生，不踢的话它能一直挂着）。
app.delete('/api/machines/:machineId', authMiddleware, adminMiddleware, (req, res) => {
  const { machineId } = req.params;
  const revoked = machineTokens.revokeMachine(machineId);
  if (!revoked) return res.status(404).json({ error: `机器未登记: ${machineId}` });
  const disconnected = global.relayServer?.disconnectMachine(machineId) || false;
  res.json({ ok: true, machineId, disconnected });
});

// ── 用量台账（Claude Code / Codex）────────────────────────────
// 上报口用 machineToken 鉴权而不是 JWT：采集器跑在 cron 里，24h 就过期的 JWT
// 没法无人值守续期；machineToken 和 WS 握手共用同一份名单，装机时已经配好了。
app.post('/api/usage/report', async (req, res) => {
  if (!hasMachineToken(req.headers['x-machine-token'])) {
    return res.status(401).json({ error: 'invalid machine token' });
  }
  const { records } = req.body || {};
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records 必须是数组' });
  if (records.length > 2000) return res.status(413).json({ error: 'records 单次上限 2000 条' });
  for (const [i, r] of records.entries()) {
    const err = usage.validateRecord(r);
    if (err) return res.status(400).json({ error: `records[${i}]: ${err}` });
  }
  try {
    const { written } = await usage.upsertRecords(records);
    res.json({ ok: true, written });
  } catch (e) {
    console.error('[usage] 上报写入失败:', e);
    res.status(500).json({ error: '写入失败' });
  }
});

// 查询口用 JWT。普通用户被强制限定成自己，只有管理员能看全员、并用 ?username= 下钻。
app.get('/api/usage/summary', authMiddleware, async (req, res) => {
  const admin = isAdmin(req.user);
  const username = admin ? (req.query.username || undefined) : req.user.username;
  try {
    const data = await usage.querySummary({
      since: req.query.since, until: req.query.until, username,
    });
    res.json({ ...data, scope: admin ? 'all' : 'self', username: username || null });
  } catch (e) {
    console.error('[usage] 查询失败:', e);
    res.status(500).json({ error: '查询失败' });
  }
});

// ── 手机版入口 ────────────────────────────────────────────────
// /m 与 /m/* 都吐 frontend/dist/mobile.html（Vite 的第二个入口，独立的一棵 React 应用，
// 不是桌面版的响应式变体）。**必须排在下面的 SPA fallback 之前** —— app.get('*')
// 会把 /m 一起吞掉，用户点进来看到的会是桌面版。
// /m/* 同样指向它，让手机版将来加前端路由时刷新不会 404。
app.get(['/m', '/m/*'], (req, res) => {
  const mobile = path.join(__dirname, 'frontend/dist/mobile.html');
  const fs = require('node:fs');
  if (fs.existsSync(mobile)) res.sendFile(mobile);
  else res.status(503).send('<h1>Mobile frontend not built yet. Run: cd packages/server/frontend && npm run build</h1>');
});

// SPA fallback
app.get('*', (req, res) => {
  const dist = path.join(__dirname, 'frontend/dist/index.html');
  const fs = require('node:fs');
  if (fs.existsSync(dist)) res.sendFile(dist);
  else res.send('<h1>Frontend not built yet. Run: cd frontend && npm run build</h1>');
});

const PORT = process.env.PORT || 3000;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--create-user') {
    const username = args[1];
    if (!username) {
      console.error('Usage: node index.js --create-user <username> [--admin]');
      process.exit(1);
    }
    const role = args.includes('--admin') ? 'admin' : null;
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Password for ${username}: `, async (password) => {
      rl.close();
      const user = await createUser(username, password, role);
      console.log(`User "${username}" created (role=${user.role}).`);
      process.exit(0);
    });
    return;
  }
  // 启动只有 startServer 一条路径：以前 main 和它各抄一份 relay 构造 + 证书探测 +
  // http/https 分支 + 台账初始化，两边时序还不一致。
  startServer({ port: PORT });
}

/**
 * 启动 server（CLI --server start 与直接运行都走这里）
 * @param {{ port?: number, host?: string, machineTokens?: string[], useHttps?: boolean }} opts
 */
function startServer(opts = {}) {
  const port = opts.port || process.env.PORT || 3000;
  const host = opts.host || process.env.HOST || '0.0.0.0';
  const fs = require('node:fs');
  const { RelayServer, addMachineTokens } = require('./relay');
  if (opts.machineTokens?.length) addMachineTokens(opts.machineTokens);
  const relay = new RelayServer();
  global.relayServer = relay;

  // 检查是否启用 HTTPS
  const certPath = process.env.SSL_CERT || path.join(__dirname, '../../certs/cert.pem');
  const keyPath = process.env.SSL_KEY || path.join(__dirname, '../../certs/key.pem');
  const useHttps = opts.useHttps !== false && fs.existsSync(certPath) && fs.existsSync(keyPath);

  let server;
  if (useHttps) {
    const https = require('node:https');
    const options = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    };
    server = https.createServer(options, app);
  } else {
    const http = require('node:http');
    server = http.createServer(app);
  }
  // 先载入归属台账再开始监听：台账为空时所有会话都会被判为无主，
  // 普通用户会在这个窗口内看到空列表。（同一次 getDb 也把 token_version 载入内存，
  // verifyToken 在此之前一律拒绝，所以握手必须排在它后面。）
  owners.init().then(async (count) => {
    console.log(`[relay] 会话归属台账已载入 ${count} 条，文件夹 ${owners.folderLedgerSize()} 条`);
    // 机器台账同样要在开始接受握手之前载入：空台账会让所有装过机的机器退回旧名单判定，
    // 那条路不绑 machineId。
    const machineCount = await machineTokens.init();
    console.log(`[relay] 开发机台账已载入 ${machineCount} 台`);
    relay.attachToHttpServer(server);
    const scheme = useHttps ? 'https' : 'http';
    server.listen(port, host, () => console.log(`Server running on ${scheme}://${host}:${port}`));
  });
  return server;
}

// 仅直接运行时执行 main()，被 require 时跳过
if (require.main === module) {
  main().catch(console.error);
}
module.exports = { app, startServer };
