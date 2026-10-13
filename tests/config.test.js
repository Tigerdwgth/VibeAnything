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
  assert.strictEqual(config.webhook.enabled, false);
  assert.strictEqual(config.app.enabled, false);
  assert.ok(Array.isArray(config.dangerousPatterns));
});

test('saveConfig and loadConfig roundtrip', () => {
  const config = loadConfig();
  config.webhook.enabled = true;
  config.webhook.url = 'https://example.com/hook';
  saveConfig(config);
  const loaded = loadConfig();
  assert.strictEqual(loaded.webhook.enabled, true);
  assert.strictEqual(loaded.webhook.url, 'https://example.com/hook');
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
