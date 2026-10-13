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
