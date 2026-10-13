// packages/server/machine-tokens.js
// 开发机身份台账：一次性邀请码 → 绑定到某台机器的长期 token。
//
// 为什么要有这东西（装机那一刻的三个老问题）：
//   1. 以前 token 是一份**全局名单**（`MACHINE_TOKENS` 环境变量），谁拿到都能连，
//      而 machineId 是客户端在握手头里自己报的 —— 等于任何一把 token 都能冒充任何一台机器，
//      而 relay 对 machineId 碰撞的处理是「新连接顶掉旧连接」，一份配置写错就能把真机踢下线。
//   2. 加一台机器要去改 systemd unit 的 `MACHINE_TOKENS=` 再重启 dashboard —— 重启会把
//      所有浏览器连接打断。
//   3. 那份名单里的 token 是明文、而且被抄进了部署文档，等于一次泄露就得全员换。
//
// 这里的做法：token 与 machineId 一对一绑定（machine_id 主键），库里只存 sha256，
// 明文只在「换取」那一刻回给客户端一次。加机器 = 发一个一次性码，零重启；撤销 = 删一行。
//
// 与 session-owners 同样的形态：**同步内存缓存**做读（WS 握手是同步路径），
// 写入时同步更新缓存并落盘到 users.db；`init()` 必须在 relay 开始服务前 await 一次。
// 未 init 时（单测）只用缓存不落盘，这样测试不必拖进 sql.js 的 WASM 依赖链。

const crypto = require('node:crypto');

let _db = null;
let _saveDb = null;

// token_hash → { machineId }
const tokenCache = new Map();
// machine_id → { tokenHash, label, createdBy, createdAt, lastSeen }
const machineCache = new Map();
// code_hash → { machineId, label, createdBy, createdAt, expiresAt, usedAt, usedMachineId }
const inviteCache = new Map();

const DEFAULT_INVITE_TTL_MS = 30 * 60 * 1000;   // 半小时：装机是当场的事，码不该长期有效
const INVITE_PREFIX = 'vai_';                   // vibeanything invite
const TOKEN_PREFIX = 'vamt_';                   // vibeanything machine token

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * 邀请码用 base32（去掉 0/1/8/O/I/L 这些手抄会认错的字符）。
 * 装机时这串字要被人从一个终端念/贴到另一个终端，可读性比熵密度重要；
 * 20 个字符 × log2(26) ≈ 94 bit，配上半小时有效期足够。
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode(length = 20) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return INVITE_PREFIX + out;
}

function randomToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

/** 邀请码两端都可能带空格/换行（从终端复制粘贴），统一按大写无空白比对。 */
function normalizeCode(code) {
  return String(code || '').trim().replace(/\s+/g, '').replace(/^vai_/i, INVITE_PREFIX);
}

// ── 落盘 ────────────────────────────────────────────────────

function persistMachine(machineId) {
  if (!_db) return;
  const m = machineCache.get(machineId);
  if (!m) {
    _db.run('DELETE FROM machine_tokens WHERE machine_id = ?', [machineId]);
  } else {
    _db.run(
      `INSERT OR REPLACE INTO machine_tokens
       (machine_id, token_hash, label, created_by, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
      [machineId, m.tokenHash, m.label || null, m.createdBy || null, m.createdAt, m.lastSeen || null]
    );
  }
  _saveDb(_db);
}

function persistInvite(codeHash) {
  if (!_db) return;
  const inv = inviteCache.get(codeHash);
  if (!inv) {
    _db.run('DELETE FROM machine_invites WHERE code_hash = ?', [codeHash]);
  } else {
    _db.run(
      `INSERT OR REPLACE INTO machine_invites
       (code_hash, machine_id, label, created_by, created_at, expires_at, used_at, used_machine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [codeHash, inv.machineId || null, inv.label || null, inv.createdBy || null,
        inv.createdAt, inv.expiresAt, inv.usedAt || null, inv.usedMachineId || null]
    );
  }
  _saveDb(_db);
}

/** 从 users.db 载入两张表。启动时调用一次，返回已登记的机器数。 */
async function init() {
  const { getDb, saveDb } = require('./auth');
  _saveDb = saveDb;
  _db = await getDb();
  load();
  return machineCache.size;
}

function load() {
  tokenCache.clear();
  machineCache.clear();
  inviteCache.clear();
  const machines = _db.exec('SELECT machine_id, token_hash, label, created_by, created_at, last_seen FROM machine_tokens');
  if (machines.length) {
    for (const [machineId, tokenHash, label, createdBy, createdAt, lastSeen] of machines[0].values) {
      machineCache.set(machineId, { tokenHash, label, createdBy, createdAt, lastSeen });
      tokenCache.set(tokenHash, { machineId });
    }
  }
  const invites = _db.exec(
    `SELECT code_hash, machine_id, label, created_by, created_at, expires_at, used_at, used_machine_id
     FROM machine_invites`
  );
  if (invites.length) {
    for (const [codeHash, machineId, label, createdBy, createdAt, expiresAt, usedAt, usedMachineId] of invites[0].values) {
      inviteCache.set(codeHash, { machineId, label, createdBy, createdAt, expiresAt, usedAt, usedMachineId });
    }
  }
}

// ── 邀请码 ──────────────────────────────────────────────────

/**
 * 发一个一次性邀请码。
 * @param {{machineId?: string, label?: string, createdBy?: string, ttlMs?: number, now?: number}} opts
 *        machineId 给定 = 这个码只能换成这台机器的 token（也用于给已有机器换一把新 token）；
 *        留空 = 装机时由客户端提出自己的 machineId，且不允许顶掉已有机器（见 redeemInvite）。
 * @returns {{code: string, expiresAt: number, machineId: string|null}} code 是明文，只在这里出现一次
 */
function createInvite({ machineId = null, label = null, createdBy = null, ttlMs = DEFAULT_INVITE_TTL_MS, now = Date.now() } = {}) {
  const code = randomCode();
  const codeHash = sha256(code);
  const expiresAt = now + Math.max(60_000, Number(ttlMs) || DEFAULT_INVITE_TTL_MS);
  inviteCache.set(codeHash, {
    machineId: machineId || null, label, createdBy, createdAt: now, expiresAt, usedAt: null, usedMachineId: null,
  });
  persistInvite(codeHash);
  return { code, expiresAt, machineId: machineId || null };
}

/**
 * 用邀请码换这台机器的长期 token。
 *
 * 失败不抛异常，回 `{ error }` —— 调用方（HTTP 接口）要把它翻成状态码，
 * 而「码不对」和「这台机器已经登记过了」要给不同的提示。
 *
 * @param {string} code 明文邀请码
 * @param {{machineId?: string, label?: string, now?: number}} opts machineId = 客户端提出的名字
 * @returns {{machineToken: string, machineId: string}|{error: string, code: string}}
 */
function redeemInvite(code, { machineId = null, label = null, now = Date.now() } = {}) {
  const codeHash = sha256(normalizeCode(code));
  const invite = inviteCache.get(codeHash);
  if (!invite) return { error: '邀请码无效', code: 'invalid_code' };
  if (invite.usedAt) return { error: '邀请码已被使用', code: 'code_used' };
  if (invite.expiresAt <= now) return { error: '邀请码已过期', code: 'code_expired' };

  // 码上指定了机器就以码为准（客户端报的名字只是建议）；没指定就用客户端报的。
  const target = invite.machineId || String(machineId || '').trim();
  if (!target) return { error: '缺少 machineId', code: 'missing_machine_id' };

  // 不指定机器的通用码**不能**顶掉已登记的机器：否则一个泄露的通用码就能把
  // 任意一台在线开发机的身份接走（relay 对 machineId 碰撞是「新连接顶掉旧的」）。
  if (!invite.machineId && machineCache.has(target)) {
    return { error: `机器 ${target} 已登记，请让管理员为它单独签发邀请码或先撤销`, code: 'machine_exists' };
  }

  const machineToken = randomToken();
  const tokenHash = sha256(machineToken);
  const prev = machineCache.get(target);
  if (prev) tokenCache.delete(prev.tokenHash);   // 换新 token，旧的当场失效
  machineCache.set(target, {
    tokenHash,
    label: label || invite.label || prev?.label || null,
    createdBy: invite.createdBy || prev?.createdBy || null,
    createdAt: now,
    lastSeen: null,
  });
  tokenCache.set(tokenHash, { machineId: target });
  invite.usedAt = now;
  invite.usedMachineId = target;
  persistMachine(target);
  persistInvite(codeHash);
  return { machineToken, machineId: target };
}

/** 清掉已过期且未使用的邀请码。返回清掉的条数。 */
function pruneInvites({ now = Date.now() } = {}) {
  let removed = 0;
  for (const [codeHash, inv] of [...inviteCache.entries()]) {
    if (inv.usedAt || inv.expiresAt > now) continue;
    inviteCache.delete(codeHash);
    persistInvite(codeHash);
    removed += 1;
  }
  return removed;
}

/** 还没用、还没过期的邀请码（只回元信息，明文码无法还原）。 */
function listPendingInvites({ now = Date.now() } = {}) {
  const out = [];
  for (const inv of inviteCache.values()) {
    if (inv.usedAt || inv.expiresAt <= now) continue;
    out.push({ machineId: inv.machineId, label: inv.label, createdBy: inv.createdBy, expiresAt: inv.expiresAt });
  }
  return out;
}

// ── 机器 token ──────────────────────────────────────────────

/**
 * token → machineId。握手路径上调用，必须同步且 O(1)。
 * @returns {string|null} 绑定的 machineId；token 不在台账里时 null
 */
function resolveToken(token) {
  if (!token) return null;
  return tokenCache.get(sha256(token))?.machineId || null;
}

/** 这台机器有没有登记过 token。 */
function hasMachine(machineId) {
  return machineCache.has(machineId);
}

/** 记一次「见到这台机器」。落盘前先比对，避免每次握手都 export 整个库。 */
function touch(machineId, { now = Date.now() } = {}) {
  const m = machineCache.get(machineId);
  if (!m) return false;
  // 一分钟内重复握手（断线重连）不必重写库
  if (m.lastSeen && now - m.lastSeen < 60_000) return false;
  m.lastSeen = now;
  persistMachine(machineId);
  return true;
}

/** 台账里的全部机器（不含任何 token 材料）。 */
function listMachines() {
  return [...machineCache.entries()].map(([machineId, m]) => ({
    machineId, label: m.label || null, createdBy: m.createdBy || null,
    createdAt: m.createdAt, lastSeen: m.lastSeen || null,
  }));
}

/** 撤销一台机器：token 当场失效。返回是否真的删掉了一条。 */
function revokeMachine(machineId) {
  const m = machineCache.get(machineId);
  if (!m) return false;
  tokenCache.delete(m.tokenHash);
  machineCache.delete(machineId);
  persistMachine(machineId);
  return true;
}

function ledgerSize() {
  return machineCache.size;
}

function _resetForTest() {
  tokenCache.clear();
  machineCache.clear();
  inviteCache.clear();
  _db = null;
  _saveDb = null;
}

module.exports = {
  init, createInvite, redeemInvite, pruneInvites, listPendingInvites,
  resolveToken, hasMachine, touch, listMachines, revokeMachine, ledgerSize,
  DEFAULT_INVITE_TTL_MS, INVITE_PREFIX, TOKEN_PREFIX,
  _resetForTest,
};
