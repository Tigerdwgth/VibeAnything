// packages/server/session-owners.js
// 归属台账：machineId + sessionId → owner，以及 machineId + folderId → owner
// （owner = dashboard 用户名）。会话与分组文件夹共用同一套台账实现（createLedger），
// 语义一致由构造保证，而不是靠两份副本同步维护。
//
// relay 的 WebSocket 消息处理是同步的（每条 pty_input 都要过一次鉴权），
// 所以这里维护**同步内存缓存**做读，写入时同步更新缓存并落盘到 users.db。
// init() 必须在 relay 开始服务前 await 一次，把台账从库里读进缓存。
//
// 落盘是 sql.js 的全库 export + writeFileSync，单条写入并不便宜：
// 值没变就不写，批量写入走 setMany 只落一次盘。
//
// auth 走惰性 require：可见性判定是纯内存逻辑，不该把 bcrypt/sql.js 的
// WASM 依赖链拖进单元测试。未 init 时（测试）只用缓存，不落盘。

let _db = null;
let _saveDb = null;

/** 台账的线格式 key。sessionId 自身可以含冒号，只按第一个冒号切。 */
function key(machineId, id) {
  return `${machineId}:${id}`;
}

function parseKey(k) {
  const idx = k.indexOf(':');
  return { machineId: k.slice(0, idx), id: k.slice(idx + 1) };
}

/**
 * 一本归属台账 = 一张表 + 一份内存缓存 + 一套可见性判定。
 * @param rootAllowed 允许「空 id」（文件夹的根级）无条件通过
 */
function createLedger({ table, idColumn, rootAllowed = false }) {
  const cache = new Map();

  function persist(rows) {
    if (!_db) return;
    for (const [machineId, id, owner] of rows) {
      if (owner === null) {
        _db.run(`DELETE FROM ${table} WHERE machine_id = ? AND ${idColumn} = ?`, [machineId, id]);
      } else {
        _db.run(
          `INSERT OR REPLACE INTO ${table} (machine_id, ${idColumn}, owner, created_at) VALUES (?, ?, ?, ?)`,
          [machineId, id, owner, Date.now()]
        );
      }
    }
    _saveDb(_db);
  }

  return {
    size: () => cache.size,

    load() {
      cache.clear();
      const rows = _db.exec(`SELECT machine_id, ${idColumn}, owner FROM ${table}`);
      if (rows.length) {
        for (const [machineId, id, owner] of rows[0].values) cache.set(key(machineId, id), owner);
      }
      return cache.size;
    },

    get(machineId, id) {
      return cache.get(key(machineId, id)) || null;
    },

    set(machineId, id, owner) {
      if (!machineId || !id || !owner) return false;
      const k = key(machineId, id);
      if (cache.get(k) === owner) return true;   // 值没变，不必付一次全库落盘
      cache.set(k, owner);
      persist([[machineId, id, owner]]);
      return true;
    },

    /** 批量登记，只落一次盘。entries: [{machineId, id, owner}] */
    setMany(entries) {
      const changed = [];
      for (const { machineId, id, owner } of entries) {
        if (!machineId || !id || !owner) continue;
        const k = key(machineId, id);
        if (cache.get(k) === owner) continue;
        cache.set(k, owner);
        changed.push([machineId, id, owner]);
      }
      if (changed.length) persist(changed);
      return changed.length;
    },

    remove(machineId, id) {
      if (!cache.delete(key(machineId, id))) return false;
      persist([[machineId, id, null]]);
      return true;
    },

    /** 迁移归属到新 id（会话改名会真改 tmux 名 → sessionId 变化），一次落盘。 */
    rename(machineId, oldId, newId) {
      if (!oldId || !newId || oldId === newId) return false;
      const owner = cache.get(key(machineId, oldId));
      if (!owner) return false;
      cache.set(key(machineId, newId), owner);
      cache.delete(key(machineId, oldId));
      persist([[machineId, newId, owner], [machineId, oldId, null]]);
      return true;
    },

    list() {
      return [...cache.entries()].map(([k, owner]) => {
        const { machineId, id } = parseKey(k);
        return { machineId, id, owner };
      });
    },

    /**
     * 可见性判定 —— 隔离的单一真源，relay 的列表过滤与写操作鉴权都走这里。
     * admin 可见全部；普通用户只看到 owner 是自己的；无主的仅 admin 可见。
     *
     * opts.ownOnly = 管理员的「隐藏他人会话」视图开关（每条浏览器连接各自持有）。
     * 开启后 admin 退化为「自己的 + 无主的」：无主不算别人的窗口 —— 管理员直接在
     * 开发机上手动建的 tmux 从没经 dashboard 打开过就是无主，连它一起藏会让人以为
     * 自己的会话丢了。普通用户本来就只看得到自己的，这个开关对其无影响。
     */
    canAccess(user, machineId, id, { ownOnly = false } = {}) {
      if (!user?.username) return false;
      if (rootAllowed && !id) return true;      // 文件夹根级，人人可用
      if (user.role === 'admin') {
        if (!ownOnly) return true;
        const owner = cache.get(key(machineId, id));
        return !owner || owner === user.username;
      }
      return cache.get(key(machineId, id)) === user.username;
    },

    _reset() { cache.clear(); },
  };
}

const sessions = createLedger({ table: 'session_owners', idColumn: 'session_id' });
const folders  = createLedger({ table: 'folder_owners',  idColumn: 'folder_id', rootAllowed: true });

/** 从 SQLite 载入两本台账到内存缓存。启动时调用一次，返回会话台账条数。 */
async function init() {
  const { getDb, saveDb } = require('./auth');
  _saveDb = saveDb;
  _db = await getDb();
  const count = sessions.load();
  folders.load();
  return count;
}

// ── 会话归属 ────────────────────────────────────────────────
const getOwner       = (machineId, sessionId)        => sessions.get(machineId, sessionId);
const setOwner       = (machineId, sessionId, owner) => sessions.set(machineId, sessionId, owner);
const setOwners      = (entries)                     => sessions.setMany(entries);
const removeOwner    = (machineId, sessionId)        => sessions.remove(machineId, sessionId);
const renameSession  = (machineId, oldId, newId)     => sessions.rename(machineId, oldId, newId);
const canAccess      = (user, machineId, sessionId, opts) => sessions.canAccess(user, machineId, sessionId, opts);
const listOwners     = () => sessions.list().map(({ machineId, id, owner }) => ({ machineId, sessionId: id, owner }));

// ── 分组文件夹归属 ──────────────────────────────────────────
// 文件夹树存在各开发机上、所有用户共用一份，所以「这个文件夹是谁的」只能记在这里。
const getFolderOwner    = (machineId, folderId)        => folders.get(machineId, folderId);
const setFolderOwner    = (machineId, folderId, owner) => folders.set(machineId, folderId, owner);
const setFolderOwners   = (entries)                    => folders.setMany(entries);
const removeFolderOwner = (machineId, folderId)        => folders.remove(machineId, folderId);
const canAccessFolder   = (user, machineId, folderId, opts) => folders.canAccess(user, machineId, folderId, opts);
const folderLedgerSize  = () => folders.size();
const listFolderOwners  = () => folders.list().map(({ machineId, id, owner }) => ({ machineId, folderId: id, owner }));

/** 沿 parentId 链向上遍历祖先，带环路守卫（脏数据里出现过父子互指）。 */
function* ancestorsOf(folder, byId) {
  const seen = new Set([folder.id]);
  let cur = folder.parentId != null ? byId.get(folder.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    yield cur;
    cur = cur.parentId != null ? byId.get(cur.parentId) : null;
  }
}

/**
 * 存量文件夹归属推断（一次性迁移）。
 *
 * 2026-08-02 之前建的文件夹没有归属记录，直接按「无主」处理会让普通用户的分组
 * 集体消失。这里用已经确定的会话归属反推：一个文件夹（连同它的整棵子树）里出现的
 * 会话归属**只有一个人**时，判定文件夹属于此人；出现两个人、或一个带归属的会话都
 * 没有（空文件夹）时不下结论，留作无主等管理员处置 —— 猜错归属比留空更难收拾。
 * 空子文件夹再自顶向下继承：挂在谁的文件夹下就是谁的。
 *
 * 必须传**整棵**文件夹树（不能只传无主的那些），否则父子链断开，
 * 子文件夹既无法把归属传给父级，也无法从父级继承。
 *
 * @returns {Map<string,string>} folderId → 推断出的 owner（含已登记的，调用方自行取舍）
 */
function inferFolderOwners(machineId, folderList, sessionList) {
  const list = Array.isArray(folderList) ? folderList : [];
  const byId = new Map(list.map(f => [f.id, f]));
  const candidates = new Map(list.map(f => [f.id, new Set()]));
  // 已登记的归属本身就是证据：父级据此推断，子级据此继承
  for (const f of list) {
    const registered = getFolderOwner(machineId, f.id);
    if (registered) candidates.get(f.id).add(registered);
  }
  for (const s of (sessionList || [])) {
    const fid = s?.folderId;
    if (!fid || !candidates.has(fid)) continue;
    const owner = getOwner(machineId, s.sessionId || s.id);
    if (owner) candidates.get(fid).add(owner);
  }
  // 自底向上：子文件夹的归属同样说明父文件夹是谁在用
  for (const f of list) {
    const own = candidates.get(f.id);
    if (!own.size) continue;
    for (const anc of ancestorsOf(f, byId)) {
      for (const o of own) candidates.get(anc.id).add(o);
    }
  }
  const resolved = new Map();
  for (const [folderId, set] of candidates) {
    if (set.size === 1) resolved.set(folderId, [...set][0]);
  }
  // 再自顶向下补一次：空子文件夹自己判不出归属，但它挂在谁的文件夹下就是谁的。
  // 只查第一遍的结果，所以和遍历顺序无关。
  const inherited = new Map();
  for (const f of list) {
    if (resolved.has(f.id)) continue;
    for (const anc of ancestorsOf(f, byId)) {
      if (!resolved.has(anc.id)) continue;
      inherited.set(f.id, resolved.get(anc.id));
      break;
    }
  }
  for (const [folderId, owner] of inherited) resolved.set(folderId, owner);
  return resolved;
}

/** 测试用：清空内存缓存并解绑 db（不动库里的数据）。 */
function _resetForTest() {
  sessions._reset();
  folders._reset();
  _db = null;
  _saveDb = null;
}

module.exports = {
  init, key, parseKey,
  getOwner, setOwner, setOwners, removeOwner, renameSession, listOwners, canAccess,
  getFolderOwner, setFolderOwner, setFolderOwners, removeFolderOwner,
  listFolderOwners, canAccessFolder, folderLedgerSize, inferFolderOwners,
  _resetForTest,
};
