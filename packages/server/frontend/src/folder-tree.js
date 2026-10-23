// folder-tree.js
// 纯函数：把后端下发的平铺 folders + sessions 构建成多级文件夹树，供 RunningTab 渲染。
// 无 React 依赖，可单测（见 tests/folder-tree.test.js）。
//
// folders:  [{ id, name, parentId }]，parentId === null 为根级
// sessions: [{ ..., folderId }]，folderId 指向某个 folder.id，或 null/无效 → 根级

// node 沿 parentId 链向上能否走到 ancestorCandidate（防环用，带 seen 兜底脏数据）
function _hasAncestor(byId, startParentId, ancestorCandidate) {
  let cur = startParentId != null ? byId.get(startParentId) : null;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) return true; // 已成环
    seen.add(cur.id);
    if (cur.id === ancestorCandidate) return true;
    cur = cur.parentId != null ? byId.get(cur.parentId) : null;
  }
  return false;
}

export function buildSessionTree(folders, sessions) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const safeSessions = Array.isArray(sessions) ? sessions : [];

  const byId = new Map();
  for (const f of safeFolders) {
    byId.set(f.id, { id: f.id, name: f.name, parentId: f.parentId ?? null, children: [], sessions: [] });
  }

  const rootFolders = [];
  for (const f of safeFolders) {
    const node = byId.get(f.id);
    const parent = node.parentId != null ? byId.get(node.parentId) : null;
    // 父级存在、不是自己、且不会因此成环 → 挂到父级；否则降级为根级
    if (parent && parent.id !== node.id && !_hasAncestor(byId, parent.id, node.id)) {
      parent.children.push(node);
    } else {
      rootFolders.push(node);
    }
  }

  const rootSessions = [];
  for (const s of safeSessions) {
    const fid = s.folderId;
    if (fid != null && byId.has(fid)) byId.get(fid).sessions.push(s);
    else rootSessions.push(s); // folderId 指向已删/不存在的文件夹 → 降级到根，不丢失
  }

  // 文件夹按名称排序（稳定显示），会话保持后端给的原顺序
  const sortRec = (nodes) => {
    nodes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(rootFolders);

  return { rootFolders, rootSessions };
}

// 拍平为前序遍历列表 [{ id, name, depth, label:'a / b / c' }]，
// 供「移动到文件夹…」菜单展示带层级路径的目标。
export function flattenFolderPaths(folders) {
  const { rootFolders } = buildSessionTree(folders, []);
  const out = [];
  const walk = (nodes, prefix, depth) => {
    for (const n of nodes) {
      const label = prefix ? `${prefix} / ${n.name}` : n.name;
      out.push({ id: n.id, name: n.name, depth, label });
      walk(n.children, label, depth + 1);
    }
  };
  walk(rootFolders, '', 0);
  return out;
}

// childId 是否是 ancestorId 的后代（拖拽防环：禁止把文件夹拖进自己的子树）
export function isDescendant(folders, childId, ancestorId) {
  if (!childId || !ancestorId || childId === ancestorId) return false;
  const byId = new Map((folders || []).map(f => [f.id, f]));
  let cur = byId.get(childId);
  const seen = new Set();
  while (cur && cur.parentId != null) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

// ── 按归属人分组（管理员「全部会话」视图）──────────────────────
// 服务端只对管理员给会话和文件夹带 owner 字段（null = 无主）。
// 分组顺序：自己 → 其他人按用户名 → 无主。

export const UNOWNED_OWNER_KEY = '__unowned__';

const ownerKeyOf = (item) => item.owner || UNOWNED_OWNER_KEY;

/**
 * 一台机器上的会话和文件夹按归属人切开。
 * 每人的文件夹 = 自己名下的 + 装着自己会话的 + 上面两类的祖先链，
 * 这样别人建的文件夹里放着的会话仍挂在原来的路径下，不会被拍平到根。
 * @returns Map<ownerKey, { folders, sessions }>，folders 保持原顺序
 */
export function partitionByOwner(folders, sessions) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const byId = new Map(safeFolders.map(f => [f.id, f]));
  const seeds = new Map();   // ownerKey → Set<folderId>
  const groups = new Map();  // ownerKey → sessions[]
  const seedOf = (k) => { if (!seeds.has(k)) seeds.set(k, new Set()); return seeds.get(k); };

  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    const k = ownerKeyOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
    if (s.folderId != null && byId.has(s.folderId)) seedOf(k).add(s.folderId);
  }
  for (const f of safeFolders) {
    if ('owner' in f) seedOf(ownerKeyOf(f)).add(f.id);
  }

  const out = new Map();
  for (const [k, ids] of seeds) {
    const keep = new Set();
    for (const id of ids) {
      let cur = byId.get(id);
      while (cur && !keep.has(cur.id)) {
        keep.add(cur.id);
        cur = cur.parentId != null ? byId.get(cur.parentId) : null;
      }
    }
    out.set(k, { folders: safeFolders.filter(f => keep.has(f.id)), sessions: groups.get(k) || [] });
  }
  for (const [k, list] of groups) {
    if (!out.has(k)) out.set(k, { folders: [], sessions: list });
  }
  return out;
}

/** 自己在前，其他人按用户名，无主垫底。 */
export function sortOwnerKeys(keys, selfUsername) {
  const rank = (k) => (k === selfUsername ? 0 : k === UNOWNED_OWNER_KEY ? 2 : 1);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * 会话带了归属信息（管理员视图），且出现了自己以外的人或无主会话时才分组；
 * 普通用户、或管理员只看到自己的会话时维持原来的按机器展示。
 */
export function shouldGroupByOwner(ownerKeys, sessions, selfUsername) {
  if (!(Array.isArray(sessions) && sessions.some(s => 'owner' in s))) return false;
  return [...ownerKeys].some(k => k !== selfUsername);
}

/**
 * 运行中列表的两级分组：归属人 → 开发机。不需要分组时返回 null。
 * @param activeSessions [{ machineId, owner, folderId, ... }]
 * @param foldersByMachine { [machineId]: folders[] }
 * @returns [{ owner: ownerKey, machines: [{ machineId, folders, sessions }] }] | null
 */
export function groupRunningByOwner(activeSessions, foldersByMachine, selfUsername) {
  const byMachine = new Map();
  for (const s of activeSessions) {
    const mid = s.machineId || 'local';
    if (!byMachine.has(mid)) byMachine.set(mid, []);
    byMachine.get(mid).push(s);
  }
  const byOwner = new Map();   // ownerKey → machines[]
  for (const [machineId, sessions] of byMachine) {
    for (const [k, part] of partitionByOwner(foldersByMachine[machineId] || [], sessions)) {
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push({ machineId, ...part });
    }
  }
  if (!shouldGroupByOwner(byOwner.keys(), activeSessions, selfUsername)) return null;
  return sortOwnerKeys(byOwner.keys(), selfUsername).map(owner => ({ owner, machines: byOwner.get(owner) }));
}
