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
