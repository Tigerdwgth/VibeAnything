// tests/session-metadata.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 隔离：用临时目录作为 VIBEANYTHING_HOME，避免污染真实 ~/.vibeanything
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-meta-'));
process.env.VIBEANYTHING_HOME = tmpHome;

const meta = require('../lib/session-metadata');

function reset() {
  try { fs.rmSync(meta.getMetaPath(), { force: true }); } catch {}
}

test('createFolder 生成带 id 的根级文件夹', () => {
  reset();
  const f = meta.createFolder('AI', null);
  assert.ok(f.id);
  assert.strictEqual(f.name, 'AI');
  assert.strictEqual(f.parentId, null);
  assert.strictEqual(meta.listFolders().length, 1);
});

test('多级嵌套 + assignSession（无效 folderId 不归属）', () => {
  reset();
  const a = meta.createFolder('a', null);
  const b = meta.createFolder('b', a.id);
  assert.strictEqual(b.parentId, a.id);
  meta.assignSession('sess1', b.id);
  assert.strictEqual(meta.getAssignments()['sess1'], b.id);
  meta.assignSession('sess2', 'nonexistent');
  assert.strictEqual(meta.getAssignments()['sess2'], undefined);
});

test('assignSession(null) 移除归属', () => {
  reset();
  const a = meta.createFolder('a', null);
  meta.assignSession('s', a.id);
  assert.strictEqual(meta.getAssignments()['s'], a.id);
  meta.assignSession('s', null);
  assert.strictEqual(meta.getAssignments()['s'], undefined);
});

test('moveFolder 防环：不能移到自身的后代之下', () => {
  reset();
  const a = meta.createFolder('a', null);
  const b = meta.createFolder('b', a.id);
  const c = meta.createFolder('c', b.id);
  // a 移到 c 下 → 拒绝（c 是 a 的后代）
  assert.strictEqual(meta.moveFolder(a.id, c.id), null);
  assert.strictEqual(meta.listFolders().find(f => f.id === a.id).parentId, null);
  // a 移到自身 → 拒绝
  assert.strictEqual(meta.moveFolder(a.id, a.id), null);
  // 合法：c 移到根
  const r = meta.moveFolder(c.id, null);
  assert.ok(r);
  assert.strictEqual(r.parentId, null);
});

test('deleteFolder 把子文件夹与直属会话提升到父级', () => {
  reset();
  const a = meta.createFolder('a', null);
  const b = meta.createFolder('b', a.id);
  const c = meta.createFolder('c', b.id);
  meta.assignSession('s1', b.id);
  assert.strictEqual(meta.deleteFolder(b.id), true);
  assert.strictEqual(meta.listFolders().some(f => f.id === b.id), false);
  assert.strictEqual(meta.listFolders().find(f => f.id === c.id).parentId, a.id);
  assert.strictEqual(meta.getAssignments()['s1'], a.id);
});

test('deleteFolder 根级文件夹：直属会话归根（移除归属）', () => {
  reset();
  const a = meta.createFolder('a', null);
  meta.assignSession('s1', a.id);
  meta.deleteFolder(a.id);
  assert.strictEqual(meta.getAssignments()['s1'], undefined);
});

test('reassignSession 重命名迁移归属', () => {
  reset();
  const a = meta.createFolder('a', null);
  meta.assignSession('old-id', a.id);
  meta.reassignSession('old-id', 'new-id');
  assert.strictEqual(meta.getAssignments()['old-id'], undefined);
  assert.strictEqual(meta.getAssignments()['new-id'], a.id);
});

test('reassignSession 对未归属会话是 no-op', () => {
  reset();
  meta.reassignSession('unknown', 'whatever');
  assert.strictEqual(meta.getAssignments()['whatever'], undefined);
});

test('renameFolder 改名；空名保持原名', () => {
  reset();
  const a = meta.createFolder('a', null);
  meta.renameFolder(a.id, 'renamed');
  assert.strictEqual(meta.listFolders()[0].name, 'renamed');
  meta.renameFolder(a.id, '   ');
  assert.strictEqual(meta.listFolders()[0].name, 'renamed');
});

test('loadMeta 容错：文件不存在返回空结构', () => {
  reset();
  const m = meta.loadMeta();
  assert.deepStrictEqual(m, { folders: [], assignments: {} });
});

test('createFolder 使用调用方指定的 id（relay 下发的归属 id）', () => {
  reset();
  const f = meta.createFolder('归属固定', null, 'fixed-id-123');
  assert.strictEqual(f.id, 'fixed-id-123');
  assert.strictEqual(meta.listFolders()[0].id, 'fixed-id-123');
});
