import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSessionTree, flattenFolderPaths, isDescendant } from '../src/folder-tree.js';

test('空 folders：会话全进 rootSessions', () => {
  const { rootFolders, rootSessions } = buildSessionTree([], [{ sessionId: 's1', folderId: null }]);
  assert.equal(rootFolders.length, 0);
  assert.equal(rootSessions.length, 1);
});

test('单层：会话按 folderId 分配到对应文件夹', () => {
  const folders = [{ id: 'f1', name: 'A', parentId: null }];
  const sessions = [{ sessionId: 's1', folderId: 'f1' }, { sessionId: 's2', folderId: null }];
  const { rootFolders, rootSessions } = buildSessionTree(folders, sessions);
  assert.equal(rootFolders.length, 1);
  assert.equal(rootFolders[0].sessions.length, 1);
  assert.equal(rootFolders[0].sessions[0].sessionId, 's1');
  assert.equal(rootSessions.length, 1);
  assert.equal(rootSessions[0].sessionId, 's2');
});

test('3 层嵌套结构正确', () => {
  const folders = [
    { id: 'a', name: 'a', parentId: null },
    { id: 'b', name: 'b', parentId: 'a' },
    { id: 'c', name: 'c', parentId: 'b' },
  ];
  const { rootFolders } = buildSessionTree(folders, []);
  assert.equal(rootFolders.length, 1);
  assert.equal(rootFolders[0].id, 'a');
  assert.equal(rootFolders[0].children[0].id, 'b');
  assert.equal(rootFolders[0].children[0].children[0].id, 'c');
});

test('folderId 指向已删文件夹 → 降级到根（不丢失会话）', () => {
  const { rootSessions } = buildSessionTree([], [{ sessionId: 's1', folderId: 'ghost' }]);
  assert.equal(rootSessions.length, 1);
  assert.equal(rootSessions[0].sessionId, 's1');
});

test('parentId 指向不存在的父 → 当根级', () => {
  const folders = [{ id: 'x', name: 'x', parentId: 'ghost' }];
  const { rootFolders } = buildSessionTree(folders, []);
  assert.equal(rootFolders.length, 1);
  assert.equal(rootFolders[0].id, 'x');
});

test('防环：a.parent=b 且 b.parent=a 不爆栈', () => {
  const folders = [
    { id: 'a', name: 'a', parentId: 'b' },
    { id: 'b', name: 'b', parentId: 'a' },
  ];
  const { rootFolders } = buildSessionTree(folders, []);
  // 不抛错；环被打断，两者都降级为根级
  assert.equal(rootFolders.length, 2);
});

test('flattenFolderPaths 生成带层级路径的 label', () => {
  const folders = [
    { id: 'a', name: 'a', parentId: null },
    { id: 'b', name: 'b', parentId: 'a' },
    { id: 'c', name: 'c', parentId: 'b' },
  ];
  const flat = flattenFolderPaths(folders);
  assert.equal(flat.find(f => f.id === 'a').label, 'a');
  assert.equal(flat.find(f => f.id === 'b').label, 'a / b');
  assert.equal(flat.find(f => f.id === 'c').label, 'a / b / c');
});

test('isDescendant 判定后代关系', () => {
  const folders = [
    { id: 'a', name: 'a', parentId: null },
    { id: 'b', name: 'b', parentId: 'a' },
    { id: 'c', name: 'c', parentId: 'b' },
  ];
  assert.equal(isDescendant(folders, 'c', 'a'), true);
  assert.equal(isDescendant(folders, 'b', 'a'), true);
  assert.equal(isDescendant(folders, 'a', 'c'), false);
  assert.equal(isDescendant(folders, 'a', 'a'), false);
});

// ── 按归属人分组 ──────────────────────────────────────────────
import { partitionByOwner, sortOwnerKeys, shouldGroupByOwner, groupRunningByOwner, UNOWNED_OWNER_KEY } from '../src/folder-tree.js';

test('partitionByOwner：各人只拿到自己的文件夹，别人文件夹里的会话带上祖先链', () => {
  const folders = [
    { id: 'pa', name: 'admin根', parentId: null, owner: 'admin' },
    { id: 'pb', name: 'admin子', parentId: 'pa', owner: 'admin' },
    { id: 'lf', name: 'carol的', parentId: null, owner: 'carol' },
    { id: 'loose', name: '无主空', parentId: null, owner: null },
  ];
  const sessions = [
    { sessionId: 'a1', owner: 'admin', folderId: 'pa' },
    { sessionId: 'l1', owner: 'carol', folderId: 'lf' },
    { sessionId: 'l2', owner: 'carol', folderId: 'pb' },   // 管理员把它挪进了自己的子文件夹
    { sessionId: 'u1', owner: null, folderId: null },
  ];
  const parts = partitionByOwner(folders, sessions);
  assert.deepEqual(parts.get('admin').folders.map(f => f.id), ['pa', 'pb']);
  assert.deepEqual(parts.get('admin').sessions.map(s => s.sessionId), ['a1']);
  assert.deepEqual(parts.get('carol').folders.map(f => f.id), ['pa', 'pb', 'lf']);
  assert.deepEqual(parts.get('carol').sessions.map(s => s.sessionId), ['l1', 'l2']);
  assert.deepEqual(parts.get(UNOWNED_OWNER_KEY).folders.map(f => f.id), ['loose']);
  assert.deepEqual(parts.get(UNOWNED_OWNER_KEY).sessions.map(s => s.sessionId), ['u1']);
});

test('partitionByOwner：脏数据成环的祖先链不会死循环', () => {
  const folders = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
  const parts = partitionByOwner(folders, [{ sessionId: 's', owner: 'x', folderId: 'a' }]);
  assert.deepEqual(parts.get('x').folders.map(f => f.id).sort(), ['a', 'b']);
});

test('sortOwnerKeys：自己在前，其他人按名字，无主垫底', () => {
  assert.deepEqual(
    sortOwnerKeys([UNOWNED_OWNER_KEY, 'zed', 'admin', 'bob'], 'admin'),
    ['admin', 'bob', 'zed', UNOWNED_OWNER_KEY],
  );
});

test('shouldGroupByOwner：没有归属字段或只有自己时不分组', () => {
  assert.equal(shouldGroupByOwner(['admin'], [{ sessionId: 's' }], 'admin'), false);
  assert.equal(shouldGroupByOwner(['admin'], [{ sessionId: 's', owner: 'admin' }], 'admin'), false);
  assert.equal(shouldGroupByOwner(['admin', 'carol'], [{ sessionId: 's', owner: 'carol' }], 'admin'), true);
  assert.equal(shouldGroupByOwner([UNOWNED_OWNER_KEY], [{ sessionId: 's', owner: null }], 'admin'), true);
});

test('groupRunningByOwner：人 → 机器两级，同一个人跨机器聚在一组', () => {
  const sessions = [
    { machineId: 'm1', sessionId: 'a', owner: 'admin' },
    { machineId: 'm1', sessionId: 'b', owner: 'carol' },
    { machineId: 'm2', sessionId: 'c', owner: 'carol' },
  ];
  const groups = groupRunningByOwner(sessions, {}, 'admin');
  assert.deepEqual(groups.map(g => g.owner), ['admin', 'carol']);
  assert.deepEqual(groups[1].machines.map(m => [m.machineId, m.sessions.map(s => s.sessionId)]), [['m1', ['b']], ['m2', ['c']]]);
  assert.equal(groupRunningByOwner(sessions.map(({ owner, ...s }) => s), {}, 'admin'), null);
});
