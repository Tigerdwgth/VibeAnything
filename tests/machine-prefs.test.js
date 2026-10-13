// tests/machine-prefs.test.js
// 前端纯函数：默认开发机选择（machine-prefs）与路径工具（path-utils）。
// frontend 包是 ESM，从 CJS 测试里用动态 import 载入；这几个函数不碰 localStorage。
const assert = require('node:assert');
const { test, before } = require('node:test');

let prefs, paths;
before(async () => {
  prefs = await import('../packages/server/frontend/src/machine-prefs.js');
  paths = await import('../packages/server/frontend/src/path-utils.js');
});

const MACHINES = [{ machineId: 'gpuserver1-jdh' }, { machineId: 'macmini' }];

test('从没选过时落在主力开发机 macmini，而不是列表第一台', () => {
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, null), 'macmini');
});

test('用户选过的机器在线则沿用', () => {
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, 'gpuserver1-jdh'), 'gpuserver1-jdh');
});

test('明确选了「所有开发机」（空串）不会被改回 macmini', () => {
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, ''), '');
});

test('记住的机器已离线时回落到主力开发机', () => {
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, 'aibox'), 'macmini');
});

test('调用方可覆盖首选机器，纯函数不绑定某个部署的机器名', () => {
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, null, 'gpuserver1-jdh'), 'gpuserver1-jdh');
  assert.strictEqual(prefs.resolveDefaultMachine(MACHINES, null, '不存在的机器'), 'gpuserver1-jdh');
});

test('主力开发机不在线时用第一台在线机器', () => {
  const only = [{ machineId: 'gpuserver1-jdh' }];
  assert.strictEqual(prefs.resolveDefaultMachine(only, null), 'gpuserver1-jdh');
  assert.strictEqual(prefs.resolveDefaultMachine(only, 'macmini'), 'gpuserver1-jdh');
});

test('机器列表还没到时保持原选择，不提前钉死', () => {
  assert.strictEqual(prefs.resolveDefaultMachine([], 'macmini'), 'macmini');
  assert.strictEqual(prefs.resolveDefaultMachine([], null), '');
});

test('breadcrumbs 逐段累积绝对路径', () => {
  assert.deepStrictEqual(paths.breadcrumbs('/Users/gsj'), [
    { label: '/', path: '/' },
    { label: 'Users', path: '/Users' },
    { label: 'gsj', path: '/Users/gsj' },
  ]);
});

test('breadcrumbs 过深时中间折叠为 …，保留根与末尾三段', () => {
  const items = paths.breadcrumbs('/a/b/c/d/e');
  assert.deepStrictEqual(items.map(i => i.label), ['/', '…', 'c', 'd', 'e']);
  assert.strictEqual(items[1].path, null, '折叠位不可点击');
  assert.strictEqual(items[4].path, '/a/b/c/d/e');
});

test('breadcrumbs 根目录只有一段', () => {
  assert.deepStrictEqual(paths.breadcrumbs('/'), [{ label: '/', path: '/' }]);
});

test('parentDir 处理尾斜杠与根目录', () => {
  assert.strictEqual(paths.parentDir('/Users/gsj/VibeAnything'), '/Users/gsj');
  assert.strictEqual(paths.parentDir('/Users/gsj/'), '/Users');
  assert.strictEqual(paths.parentDir('/Users'), '/');
  assert.strictEqual(paths.parentDir('/'), '/');
});
