// packages/server/tests/session-owners.test.js
// 会话归属台账的纯逻辑测试：不落库（未 init），只验证内存缓存语义与可见性判定。
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const owners = require('../session-owners');

beforeEach(() => owners._resetForTest());

const ADMIN = { username: 'admin', role: 'admin' };
const ALICE = { username: 'alice', role: 'user' };
const BOB = { username: 'bob', role: 'user' };

test('共享按窗口和机器隔离，不授权文件夹及再次共享；管理员仅我视图也保留被共享窗口', () => {
  owners.setOwner('m1', 'shared', 'alice');
  owners.setFolderOwner('m1', 'folder', 'alice');
  owners.addShare('m1', 'shared', 'bob');
  owners.addShare('m1', 'shared', 'admin');
  assert.equal(owners.canAccess(BOB, 'm1', 'shared'), true);
  assert.equal(owners.canAccess(BOB, 'm2', 'shared'), false);
  assert.equal(owners.canAccess(BOB, 'm1', 'other'), false);
  assert.equal(owners.canAccessFolder(BOB, 'm1', 'folder'), false);
  assert.equal(owners.canManageSharing(BOB, 'm1', 'shared'), false);
  assert.equal(owners.canManageSharing(ALICE, 'm1', 'shared'), true);
  assert.equal(owners.canManageSharing(ADMIN, 'm1', 'shared'), true);
  assert.equal(owners.canAccess(ADMIN, 'm1', 'shared', { ownOnly: true }), true);
});

test('未登记的会话没有归属', () => {
  assert.strictEqual(owners.getOwner('m1', 's1'), null);
});

test('setOwner / getOwner 往返', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.getOwner('m1', 's1'), 'alice');
});

test('归属按 machineId 分区：同名 sessionId 在不同机器上互不影响', () => {
  owners.setOwner('m1', 'dev', 'alice');
  owners.setOwner('m2', 'dev', 'bob');
  assert.strictEqual(owners.getOwner('m1', 'dev'), 'alice');
  assert.strictEqual(owners.getOwner('m2', 'dev'), 'bob');
});

test('sessionId 含冒号时仍能正确拆分 machineId', () => {
  owners.setOwner('m1', 'Vibe/0:1', 'alice');
  const rec = owners.listOwners().find(r => r.owner === 'alice');
  assert.strictEqual(rec.machineId, 'm1');
  assert.strictEqual(rec.sessionId, 'Vibe/0:1');
});

test('renameSession 把归属迁到新 sessionId（tmux 改名后 id 会变）', () => {
  owners.setOwner('m1', 'old', 'alice');
  assert.strictEqual(owners.renameSession('m1', 'old', 'new'), true);
  assert.strictEqual(owners.getOwner('m1', 'new'), 'alice');
  assert.strictEqual(owners.getOwner('m1', 'old'), null);
  assert.strictEqual(owners.renameSession('m1', '不存在', 'x'), false);
});

test('setOwners 批量登记，跳过无变化与空参数', () => {
  owners.setOwner('m1', 's1', 'alice');
  const changed = owners.setOwners([
    { machineId: 'm1', id: 's1', owner: 'alice' },   // 无变化
    { machineId: 'm1', id: 's2', owner: 'bob' },
    { machineId: 'm1', id: '', owner: 'bob' },       // 空 id
  ]);
  assert.strictEqual(changed, 1);
  assert.strictEqual(owners.getOwner('m1', 's2'), 'bob');
});

test('canAccess：普通用户只能访问自己的会话', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.canAccess(ALICE, 'm1', 's1'), true);
  assert.strictEqual(owners.canAccess(BOB, 'm1', 's1'), false);
});

test('canAccess：admin 可访问全部，含无主会话', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.canAccess(ADMIN, 'm1', 's1'), true);
  assert.strictEqual(owners.canAccess(ADMIN, 'm1', 'unowned'), true);
});

test('canAccess：无主会话对普通用户不可见', () => {
  assert.strictEqual(owners.canAccess(ALICE, 'm1', 'unowned'), false);
});

test('canAccess ownOnly：admin 看不到他人会话', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.canAccess(ADMIN, 'm1', 's1', { ownOnly: true }), false);
});

test('canAccess ownOnly：admin 仍看得到自己的会话与无主会话', () => {
  owners.setOwner('m1', 'mine', 'admin');
  assert.strictEqual(owners.canAccess(ADMIN, 'm1', 'mine', { ownOnly: true }), true);
  assert.strictEqual(owners.canAccess(ADMIN, 'm1', 'unowned', { ownOnly: true }), true);
});

test('canAccess ownOnly：对普通用户无影响', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.canAccess(ALICE, 'm1', 's1', { ownOnly: true }), true);
  assert.strictEqual(owners.canAccess(BOB, 'm1', 's1', { ownOnly: true }), false);
  assert.strictEqual(owners.canAccess(ALICE, 'm1', 'unowned', { ownOnly: true }), false);
});

test('canAccess：未认证连接一律拒绝', () => {
  owners.setOwner('m1', 's1', 'alice');
  assert.strictEqual(owners.canAccess(null, 'm1', 's1'), false);
  assert.strictEqual(owners.canAccess({}, 'm1', 's1'), false);
  assert.strictEqual(owners.canAccess({ role: 'admin' }, 'm1', 's1'), false);
});

test('removeOwner 后回到无主', () => {
  owners.setOwner('m1', 's1', 'alice');
  owners.removeOwner('m1', 's1');
  assert.strictEqual(owners.getOwner('m1', 's1'), null);
  assert.strictEqual(owners.canAccess(ALICE, 'm1', 's1'), false);
});

test('setOwner 拒绝空参数', () => {
  assert.strictEqual(owners.setOwner('', 's1', 'alice'), false);
  assert.strictEqual(owners.setOwner('m1', '', 'alice'), false);
  assert.strictEqual(owners.setOwner('m1', 's1', ''), false);
});

// ── 分组文件夹归属 ──────────────────────────────────────────

test('canAccessFolder：只有所有者能访问自己的文件夹', () => {
  owners.setFolderOwner('m1', 'f1', 'alice');
  assert.strictEqual(owners.canAccessFolder(ALICE, 'm1', 'f1'), true);
  assert.strictEqual(owners.canAccessFolder(BOB, 'm1', 'f1'), false);
});

test('canAccessFolder：无主文件夹仅 admin 可见', () => {
  assert.strictEqual(owners.canAccessFolder(ADMIN, 'm1', 'legacy'), true);
  assert.strictEqual(owners.canAccessFolder(ALICE, 'm1', 'legacy'), false);
});

test('canAccessFolder：根级（folderId 为空）人人可用', () => {
  assert.strictEqual(owners.canAccessFolder(ALICE, 'm1', null), true);
  assert.strictEqual(owners.canAccessFolder(BOB, 'm1', ''), true);
});

test('canAccessFolder ownOnly：admin 看不到他人文件夹，无主的仍可见', () => {
  owners.setFolderOwner('m1', 'alice-f', 'alice');
  owners.setFolderOwner('m1', 'admin-f', 'admin');
  assert.strictEqual(owners.canAccessFolder(ADMIN, 'm1', 'alice-f', { ownOnly: true }), false);
  assert.strictEqual(owners.canAccessFolder(ADMIN, 'm1', 'admin-f', { ownOnly: true }), true);
  assert.strictEqual(owners.canAccessFolder(ADMIN, 'm1', 'legacy', { ownOnly: true }), true);
});

test('文件夹归属按 machineId 分区，且删除后回到无主', () => {
  owners.setFolderOwner('m1', 'f', 'alice');
  owners.setFolderOwner('m2', 'f', 'bob');
  assert.strictEqual(owners.getFolderOwner('m1', 'f'), 'alice');
  assert.strictEqual(owners.getFolderOwner('m2', 'f'), 'bob');
  owners.removeFolderOwner('m1', 'f');
  assert.strictEqual(owners.getFolderOwner('m1', 'f'), null);
  assert.strictEqual(owners.getFolderOwner('m2', 'f'), 'bob');
});

test('inferFolderOwners：按里面会话的归属推断存量文件夹', () => {
  owners.setOwner('m1', 's1', 'alice');
  const folders = [{ id: 'fa', parentId: null }];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 's1', folderId: 'fa' }]);
  assert.strictEqual(inferred.get('fa'), 'alice');
});

test('inferFolderOwners：子文件夹的归属向上传递给父级', () => {
  owners.setOwner('m1', 's1', 'alice');
  const folders = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
  ];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 's1', folderId: 'child' }]);
  assert.strictEqual(inferred.get('child'), 'alice');
  assert.strictEqual(inferred.get('root'), 'alice');
});

test('inferFolderOwners：归属有分歧或为空时不下结论', () => {
  owners.setOwner('m1', 's1', 'alice');
  owners.setOwner('m1', 's2', 'bob');
  const folders = [{ id: 'shared', parentId: null }, { id: 'empty', parentId: null }];
  const inferred = owners.inferFolderOwners('m1', folders, [
    { sessionId: 's1', folderId: 'shared' },
    { sessionId: 's2', folderId: 'shared' },
  ]);
  assert.strictEqual(inferred.has('shared'), false);
  assert.strictEqual(inferred.has('empty'), false);
});

test('inferFolderOwners：无主会话不参与推断', () => {
  const folders = [{ id: 'f', parentId: null }];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 'orphan', folderId: 'f' }]);
  assert.strictEqual(inferred.size, 0);
});

test('inferFolderOwners：父子成环时不死循环', () => {
  owners.setOwner('m1', 's1', 'alice');
  const folders = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 's1', folderId: 'a' }]);
  assert.strictEqual(inferred.get('a'), 'alice');
  assert.strictEqual(inferred.get('b'), 'alice');
});

test('inferFolderOwners：空子文件夹继承已确定归属的祖先', () => {
  owners.setOwner('m1', 's1', 'alice');
  const folders = [
    { id: 'root', parentId: null },
    { id: 'withSess', parentId: 'root' },
    { id: 'emptyChild', parentId: 'root' },
    { id: 'emptyGrandChild', parentId: 'emptyChild' },
  ];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 's1', folderId: 'withSess' }]);
  assert.strictEqual(inferred.get('emptyChild'), 'alice');
  assert.strictEqual(inferred.get('emptyGrandChild'), 'alice', '隔一层也要能继承');
});

test('inferFolderOwners：根级空文件夹没有可继承的祖先，仍不下结论', () => {
  owners.setOwner('m1', 's1', 'alice');
  const folders = [{ id: 'mine', parentId: null }, { id: 'loose', parentId: null }];
  const inferred = owners.inferFolderOwners('m1', folders, [{ sessionId: 's1', folderId: 'mine' }]);
  assert.strictEqual(inferred.has('loose'), false);
});
