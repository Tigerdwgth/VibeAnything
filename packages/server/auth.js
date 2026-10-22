// packages/server/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'users.db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
// 会话有效期是**滑动**的：前端定期调 POST /api/session/refresh 换新票，
// 30 天内打开过的设备永远不必重新登录。收回登录态靠 users.token_version，不靠缩短有效期。
const SESSION_LIFETIME = '30d';

let _db = null;
// username → token_version 的内存镜像。relay 的 WS 握手是同步调 verifyToken 的，
// 不能在里面异步查库，所以启动载入、改动时同步更新；null = 尚未载入（见 verifyToken）。
let _tokenVersions = null;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(data);
  } else {
    _db = new SQL.Database();
  }
  _db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // 会话归属台账：machine_id + session_id → owner（dashboard 用户名）。
  // 与 users 同库，避免第二个 SQLite 文件和第二套备份路径。
  _db.run(`CREATE TABLE IF NOT EXISTS session_owners (
    machine_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (machine_id, session_id)
  )`);
  _db.run(`CREATE TABLE IF NOT EXISTS session_shares (
    machine_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (machine_id, session_id, username)
  )`);
  // 会话分组文件夹的归属台账。文件夹树本身存在各开发机（lib/session-metadata.js），
  // 那是所有用户共用的一份数据，归属只能记在 relay 这边。
  _db.run(`CREATE TABLE IF NOT EXISTS folder_owners (
    machine_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (machine_id, folder_id)
  )`);
  // 开发机的长期 token（装机时由一次性邀请码换取）。
  // 存 token 的 sha256 而不是明文：token 只在换取那一刻显示一次，库被看到也冒充不了机器。
  // machine_id 是主键 —— 一台机器一把 token，换新即覆盖，撤销就是删这一行。
  _db.run(`CREATE TABLE IF NOT EXISTS machine_tokens (
    machine_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    label TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  )`);
  // 一次性邀请码。同样只存 sha256；machine_id 可空（空 = 装机时由客户端提出自己的名字）。
  _db.run(`CREATE TABLE IF NOT EXISTS machine_invites (
    code_hash TEXT PRIMARY KEY,
    machine_id TEXT,
    label TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_machine_id TEXT
  )`);
  migrateRoleColumn(_db);
  migrateProfileColumns(_db);
  migrateTokenVersionColumn(_db);
  _tokenVersions = loadTokenVersions(_db);
  return _db;
}

/** 表的列名列表。ADD COLUMN 重复执行会抛错，所有列迁移都先问这里。 */
function tableColumns(db, table) {
  const info = db.exec(`PRAGMA table_info(${table})`);
  return info.length ? info[0].values.map(r => r[1]) : [];
}

// users.role 迁移：老库没有该列，ADD COLUMN 重复执行会抛错，先查 PRAGMA。
// id=1（首个注册用户）默认提升为 admin —— 隔离上线后需要有人能看到全部会话并转交归属。
function migrateRoleColumn(db) {
  if (tableColumns(db, 'users').includes('role')) return;
  db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  db.run(`UPDATE users SET role = 'admin' WHERE id = 1`);
  saveDb(db);
}

// users.nickname / users.avatar 迁移：个人信息两列都可空，NULL = 没设过。
// 显示时的回落（昵称→用户名、头像→站点默认图）交给前端一处决定，库里不塞默认值 ——
// 否则「我就是想叫这个名字」和「我没改过」在数据上分不出来，将来改默认图也改不动存量。
function migrateProfileColumns(db) {
  const cols = tableColumns(db, 'users');
  let changed = false;
  if (!cols.includes('nickname')) { db.run('ALTER TABLE users ADD COLUMN nickname TEXT'); changed = true; }
  if (!cols.includes('avatar'))   { db.run('ALTER TABLE users ADD COLUMN avatar TEXT');   changed = true; }
  if (changed) saveDb(db);
}

// users.token_version 迁移：JWT 里带 tv，与库里当前值不等即作废（改密码 +1 = 踢掉所有旧设备）。
// 老库补列后全员为 0，而老 token 没有 tv 字段按 0 算 —— 部署当下已登录的设备不会被踢。
function migrateTokenVersionColumn(db) {
  if (tableColumns(db, 'users').includes('token_version')) return;
  db.run('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  saveDb(db);
}

function loadTokenVersions(db) {
  const rows = db.exec('SELECT username, token_version FROM users');
  return new Map(rows.length ? rows[0].values : []);
}

function currentTokenVersion(username) {
  return _tokenVersions.get(username) ?? 0;
}

function isAdmin(user) {
  return user?.role === 'admin';
}

function saveDb(db) {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function createUser(username, password, role = null) {
  const db = await getDb();
  const hash = await bcrypt.hash(password, 12);
  // 首个用户自动成为 admin（空库初始化场景）
  const existing = db.exec('SELECT COUNT(*) FROM users');
  const count = existing.length ? existing[0].values[0][0] : 0;
  const finalRole = role || (count === 0 ? 'admin' : 'user');
  db.run('INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)',
    [username, hash, Date.now(), finalRole]);
  saveDb(db);
  const rows = db.exec('SELECT last_insert_rowid() as id');
  const id = rows[0]?.values[0][0];
  return { id, username, role: finalRole };
}

async function verifyPassword(username, password) {
  const db = await getDb();
  const rows = db.exec('SELECT id, username, password_hash, role FROM users WHERE username = ?', [username]);
  if (!rows.length || !rows[0].values.length) return null;
  const [id, uname, hash, role] = rows[0].values[0];
  const ok = await bcrypt.compare(password, hash);
  return ok ? { id, username: uname, role: role || 'user' } : null;
}

// tv 由这里统一盖章，调用方（登录 / 注册 / 续期 / 改密码）不用各自记得带。
function generateToken(payload) {
  if (!_tokenVersions) throw new Error('token_version 尚未载入，须先 await getDb()');
  return jwt.sign({ ...payload, tv: currentTokenVersion(payload.username) }, JWT_SECRET, { expiresIn: SESSION_LIFETIME });
}

// 同步校验（relay 握手要用）：签名 + 有效期 + tv 与当前版本一致。
// 没有 tv 的存量 token 按 0 处理。版本缓存没载入时一律拒绝，宁可全员 401 也不放行已撤销的票。
function verifyToken(token) {
  if (!_tokenVersions) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  return (payload.tv ?? 0) === currentTokenVersion(payload.username) ? payload : null;
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

async function listUsers() {
  const db = await getDb();
  const rows = db.exec('SELECT id, username, created_at, role FROM users');
  if (!rows.length) return [];
  return rows[0].values.map(([id, username, created_at, role]) => ({
    id, username, created_at, role: role || 'user'
  }));
}

async function updatePassword(username, oldPassword, newPassword) {
  const db = await getDb();
  const rows = db.exec('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
  if (!rows.length || !rows[0].values.length) throw new Error('User not found');

  const [id, uname, hash] = rows[0].values[0];

  // 验证旧密码
  const valid = await bcrypt.compare(oldPassword, hash);
  if (!valid) throw new Error('Invalid old password');

  // 更新密码，同一条语句里 token_version +1：其他设备手里的票立即作废
  const newHash = await bcrypt.hash(newPassword, 12);
  db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE username = ?', [newHash, username]);
  _tokenVersions.set(username, db.exec('SELECT token_version FROM users WHERE username = ?', [username])[0].values[0][0]);
  saveDb(db);
  return true;
}

/**
 * 读取一个用户的个人信息。nickname / avatar 没设过时是 null，回落由前端决定。
 * @returns {Promise<{id:number, username:string, nickname:string|null, avatar:string|null, role:string, created_at:number}|null>}
 */
async function getProfile(username) {
  const db = await getDb();
  const rows = db.exec(
    'SELECT id, username, nickname, avatar, role, created_at FROM users WHERE username = ?',
    [username]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const [id, uname, nickname, avatar, role, created_at] = rows[0].values[0];
  return {
    id, username: uname,
    nickname: nickname || null,
    avatar: avatar || null,
    role: role || 'user',
    created_at,
  };
}

/**
 * 更新昵称 / 头像。patch 里没出现的字段保持原样，出现且为 null 表示清空（回落默认）——
 * 「没传」和「传了空」必须分开，否则只想改昵称的请求会把头像一起抹掉。
 * @param {string} username
 * @param {{nickname?: string|null, avatar?: string|null}} patch
 */
async function updateProfile(username, patch = {}) {
  const db = await getDb();
  const current = await getProfile(username);
  if (!current) throw new Error('User not found');

  const sets = [];
  const params = [];
  if ('nickname' in patch) { sets.push('nickname = ?'); params.push(patch.nickname ?? null); }
  if ('avatar' in patch)   { sets.push('avatar = ?');   params.push(patch.avatar ?? null); }
  if (!sets.length) return current;

  params.push(username);
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`, params);
  saveDb(db);
  return getProfile(username);
}

module.exports = {
  createUser, verifyPassword, generateToken, verifyToken, authMiddleware,
  listUsers, updatePassword, getDb, saveDb, isAdmin,
  getProfile, updateProfile,
};
