// lib/session-metadata.js
// Dashboard 层的「会话组织元数据」：文件夹树 + 会话→文件夹归属。
//
// 会话本身是各开发机扫描 tmux 得到的（见 lib/ws-client.js scanActiveSessions），
// 本模块只存「用户怎么组织这些会话」——文件夹层级，以及每个会话归属哪个文件夹。
// 存储复用 lib/config.js 的 ~/.vibeanything/ 目录（VIBEANYTHING_HOME 可覆盖，便于隔离测试），
// 单文件 session-folders.json。
//
// 注意：归属以 sessionId 为 key。会话重命名会真改 tmux 名 → sessionId 变化，
// 调用方必须用 reassignSession(old, new) 迁移归属（见 ws-client 的 rename_session 处理）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getBaseDir } = require('./config');

function getMetaPath() {
  return path.join(getBaseDir(), 'session-folders.json');
}

function emptyMeta() {
  return { folders: [], assignments: {} };
}

function loadMeta() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getMetaPath(), 'utf-8'));
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      assignments: (parsed.assignments && typeof parsed.assignments === 'object') ? parsed.assignments : {},
    };
  } catch {
    return emptyMeta();
  }
}

function saveMeta(meta) {
  fs.mkdirSync(getBaseDir(), { recursive: true });
  fs.writeFileSync(getMetaPath(), JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

function listFolders() {
  return loadMeta().folders;
}

function getAssignments() {
  return loadMeta().assignments;
}

// candidateId 是否是 ancestorId 的后代（沿 parentId 链向上能走到 ancestorId）。
// 用于 moveFolder 防环，并对脏数据（已有环）用 seen 集合兜底。
function isDescendantFolder(folders, candidateId, ancestorId) {
  if (!candidateId || !ancestorId || candidateId === ancestorId) return false;
  const byId = new Map(folders.map(f => [f.id, f]));
  let cur = byId.get(candidateId);
  const seen = new Set();
  while (cur && cur.parentId != null) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

// id 由调用方指定时用调用方的：Dashboard 的 relay 要在创建的同一刻登记文件夹归属，
// 所以 id 在服务端生成后一并下发，两边必须是同一个。本地直接调用不传则自行生成。
function createFolder(name, parentId = null, id = null) {
  const meta = loadMeta();
  // parentId 必须指向已存在的文件夹，否则当根级
  const validParent = parentId && meta.folders.some(f => f.id === parentId) ? parentId : null;
  const folder = {
    id: id || crypto.randomUUID(),
    name: String(name || '新文件夹').trim() || '新文件夹',
    parentId: validParent,
  };
  meta.folders.push(folder);
  saveMeta(meta);
  return folder;
}

function renameFolder(id, name) {
  const meta = loadMeta();
  const folder = meta.folders.find(f => f.id === id);
  if (!folder) return null;
  const trimmed = String(name || '').trim();
  if (trimmed) folder.name = trimmed;
  saveMeta(meta);
  return folder;
}

// 删除文件夹：其直属子文件夹与直属会话「提升」到被删文件夹的父级
// （父级为根则会话变为未归属 = 根级），避免内容丢失。
function deleteFolder(id) {
  const meta = loadMeta();
  const target = meta.folders.find(f => f.id === id);
  if (!target) return false;
  const parentId = target.parentId || null;
  for (const f of meta.folders) {
    if (f.parentId === id) f.parentId = parentId;
  }
  for (const [sid, fid] of Object.entries(meta.assignments)) {
    if (fid === id) {
      if (parentId) meta.assignments[sid] = parentId;
      else delete meta.assignments[sid];
    }
  }
  meta.folders = meta.folders.filter(f => f.id !== id);
  saveMeta(meta);
  return true;
}

// 改文件夹父级。防环：不能移到自身、也不能移到自身的后代之下。
function moveFolder(id, parentId = null) {
  const meta = loadMeta();
  const folder = meta.folders.find(f => f.id === id);
  if (!folder) return null;
  if (parentId === id) return null;
  if (parentId && !meta.folders.some(f => f.id === parentId)) parentId = null;
  if (parentId && isDescendantFolder(meta.folders, parentId, id)) return null;
  folder.parentId = parentId || null;
  saveMeta(meta);
  return folder;
}

// 设置会话归属。folderId 为空或无效 → 移除归属（= 根级）。
function assignSession(sessionId, folderId) {
  if (!sessionId) return;
  const meta = loadMeta();
  if (folderId && meta.folders.some(f => f.id === folderId)) {
    meta.assignments[sessionId] = folderId;
  } else {
    delete meta.assignments[sessionId];
  }
  saveMeta(meta);
}

// 会话重命名后迁移归属：old sessionId → new sessionId。
function reassignSession(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const meta = loadMeta();
  if (Object.prototype.hasOwnProperty.call(meta.assignments, oldId)) {
    meta.assignments[newId] = meta.assignments[oldId];
    delete meta.assignments[oldId];
    saveMeta(meta);
  }
}

module.exports = {
  getMetaPath, loadMeta, saveMeta,
  listFolders, getAssignments,
  createFolder, renameFolder, deleteFolder, moveFolder,
  assignSession, reassignSession,
  isDescendantFolder,
};
