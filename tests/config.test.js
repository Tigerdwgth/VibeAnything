const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 用临时目录模拟 HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
process.env.VIBEANYTHING_HOME = tmpHome;

const { loadConfig, saveConfig, getConfigPath, getHooksDir, defaultConfig, getMachineId } = require('../lib/config');

test('getConfigPath returns correct path', () => {
  const p = getConfigPath();
  assert.ok(p.endsWith('config.json'));
  assert.ok(p.includes('.vibeanything') || p.includes('hooks-test-'));
});

test('getHooksDir returns correct path', () => {
  const p = getHooksDir();
  assert.ok(p.endsWith('hooks'));
});

test('loadConfig returns default when no config exists', () => {
  const config = loadConfig();
  assert.strictEqual(config.webhook, undefined);
  assert.strictEqual(config.app, undefined);
  assert.ok(Array.isArray(config.dangerousPatterns));
});

test('saveConfig and loadConfig roundtrip', () => {
  const config = loadConfig();
  config.defaultWorkDir = '/srv/work';
  config.pythonFormatter = 'autopep8';
  saveConfig(config);
  const loaded = loadConfig();
  assert.strictEqual(loaded.defaultWorkDir, '/srv/work');
  assert.strictEqual(loaded.pythonFormatter, 'autopep8');
});

test('旧 config.json 里残留的 webhook/app 通知键被安静忽略', () => {
  fs.writeFileSync(getConfigPath(), JSON.stringify({
    machineId: 'legacy-box',
    webhook: { enabled: true, url: 'https://example.com/hook', secret: 's' },
    app: { enabled: true, appId: 'cli_x', appSecret: 'y', receiverId: 'ou_z', receiverType: 'open_id' }
  }));
  const loaded = loadConfig();
  assert.strictEqual(loaded.machineId, 'legacy-box');
  assert.strictEqual(loaded.hooks.guard, true, '其余默认值不受影响');
  fs.rmSync(getConfigPath()); // 共用同一个临时目录，别把 machineId 漏给后面的用例
});

test('defaultConfig includes ipcDir and machineId', () => {
  const cfg = defaultConfig();
  assert.strictEqual(typeof cfg.ipcDir, 'string');
  assert.strictEqual(cfg.ipcDir, '');
  assert.strictEqual(typeof cfg.machineId, 'string');
  assert.strictEqual(cfg.machineId, '');
});

test('getMachineId returns hostname when machineId is empty', () => {
  const id = getMachineId();
  assert.strictEqual(id, os.hostname());
});

test('getMachineId returns env var when set', () => {
  process.env.VIBEANYTHING_MACHINE_ID = 'test-machine-42';
  const id = getMachineId();
  assert.strictEqual(id, 'test-machine-42');
  delete process.env.VIBEANYTHING_MACHINE_ID;
});
