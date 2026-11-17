// packages/server/session-pins.js
// 会话置顶：username + machineId + sessionId → 置顶时间。
//
// 置顶是**每个 dashboard 用户自己的偏好**，而且天然跨开发机（置顶组里的会话来自不同机器），
// 所以它既不能存在开发机上（那是所有用户共用的一份数据，见 session-owners.js 的同款取舍），
// 也不能存在浏览器的 localStorage 里（桌面版置顶了，手机版要能看到同一份）。
// 只能记在 relay 这边，与 users / session_owners 同库。
//
// 读写模型与归属台账一致：同步内存缓存做读（会话列表每 2.5 秒按浏览器投影一次），
// 写入时同步更新缓存并落盘。未 init 时（单元测试）只用缓存，不落盘。
//
// 置顶**不是权限**：能不能看到一个会话只由 session-owners 判定，这里只回答
// 「这个人有没有把它置顶」。看不到的会话即使留着置顶记录也不会出现在任何列表里。

let _db = null;
let _saveDb = null;

// username → Map<key(machineId, sessionId), pinnedAt>
const pinsByUser = new Map();

/** 只在内存里用的键。用 \0 分隔：机器名和会话名里都不可能出现它，不会两两拼出同一个键。 */
function key(machineId, sessionId) {
  return `${machineId}\0${sessionId}`;
}

function save() {
  if (_db) _saveDb(_db);
}

/** 从 SQLite 载入置顶记录。启动时调用一次，返回条数。 */
async function init() {
  const { getDb, saveDb } = require('./auth');
  _saveDb = saveDb;
  _db = await getDb();
  pinsByUser.clear();
  const rows = _db.exec('SELECT username, machine_id, session_id, pinned_at FROM session_pins');
  let count = 0;
  for (const [username, machineId, sessionId, pinnedAt] of (rows[0]?.values || [])) {
    if (!pinsByUser.has(username)) pinsByUser.set(username, new Map());
    pinsByUser.get(username).set(key(machineId, sessionId), pinnedAt);
    count++;
  }
  return count;
}

/** 置顶时间（毫秒）；没置顶返回 null。 */
function pinnedAt(username, machineId, sessionId) {
  return pinsByUser.get(username)?.get(key(machineId, sessionId)) ?? null;
}

/**
 * 置顶。已经置顶的不动（保留原来的置顶时间 —— 置顶组按它排序，重复点一下不该让会话换位置）。
 * @returns {boolean} 是否真的发生了变化
 */
function pin(username, machineId, sessionId, now = Date.now()) {
  if (!username || !machineId || !sessionId) return false;
  if (!pinsByUser.has(username)) pinsByUser.set(username, new Map());
  const mine = pinsByUser.get(username);
  const k = key(machineId, sessionId);
  if (mine.has(k)) return false;
  mine.set(k, now);
  if (_db) {
    _db.run(
      'INSERT OR REPLACE INTO session_pins (username, machine_id, session_id, pinned_at) VALUES (?, ?, ?, ?)',
      [username, machineId, sessionId, now]
    );
    save();
  }
  return true;
}

/** 取消置顶。@returns {boolean} 是否真的发生了变化 */
function unpin(username, machineId, sessionId) {
  const mine = pinsByUser.get(username);
  if (!mine?.delete(key(machineId, sessionId))) return false;
  if (!mine.size) pinsByUser.delete(username);
  if (_db) {
    _db.run('DELETE FROM session_pins WHERE username = ? AND machine_id = ? AND session_id = ?', [username, machineId, sessionId]);
    save();
  }
  return true;
}

/**
 * 会话改名（真改 tmux 名 → sessionId 变化）：所有人对它的置顶一起迁到新 id，置顶时间不变。
 * 不迁的话，改个名字会话就从每个人的置顶组里掉出去。
 * @returns {string[]} 受影响的用户名
 */
function renameSession(machineId, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return [];
  const affected = [];
  for (const [username, mine] of pinsByUser) {
    const at = mine.get(key(machineId, oldId));
    if (at == null) continue;
    mine.delete(key(machineId, oldId));
    mine.set(key(machineId, newId), at);
    affected.push(username);
  }
  if (affected.length && _db) {
    // 新名字上若残留着旧记录（同名会话以前被置顶过又消失了），先清掉，否则 UPDATE 撞主键
    _db.run('DELETE FROM session_pins WHERE machine_id = ? AND session_id = ?', [machineId, newId]);
    _db.run('UPDATE session_pins SET session_id = ? WHERE machine_id = ? AND session_id = ?', [newId, machineId, oldId]);
    save();
  }
  return affected;
}

/**
 * 会话被停掉 / 删除：清掉所有人对它的置顶。
 * 不清的话，以后这台机器上再建一个同名 tmux 会话，会一出现就挂在置顶组里。
 * @returns {string[]} 受影响的用户名
 */
function removeSession(machineId, sessionId) {
  const k = key(machineId, sessionId);
  const affected = [];
  for (const [username, mine] of [...pinsByUser]) {
    if (!mine.delete(k)) continue;
    if (!mine.size) pinsByUser.delete(username);
    affected.push(username);
  }
  if (affected.length && _db) {
    _db.run('DELETE FROM session_pins WHERE machine_id = ? AND session_id = ?', [machineId, sessionId]);
    save();
  }
  return affected;
}

/** 测试用：清空内存缓存并解绑 db（不动库里的数据）。 */
function _resetForTest() {
  pinsByUser.clear();
  _db = null;
  _saveDb = null;
}

module.exports = { init, pinnedAt, pin, unpin, renameSession, removeSession, _resetForTest };
