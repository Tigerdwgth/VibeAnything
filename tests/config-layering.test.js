// tests/config-layering.test.js
// 配置的逐层合并与最小化写入。
//
// 这条是装机体验的根：以前 loadConfig 是**一层**展开（`{...默认值, ...文件}`），
// 配置文件里只写 `centralServer: { url, machineToken }` 就会把整个 centralServer
// 默认值替换掉 —— `enabled` 变 undefined，daemon 判断 `cfg.centralServer?.enabled`
// 为假，装完机一声不响地不连服务器。所以部署文档里那 40 行必须整段照抄。
// 下面断言的就是「少写嵌套字段不再出事」。

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-'));
let config;

before(() => {
  // paths.js 每次调用都读 env（不是载入时读一次），所以这里设了就生效
  process.env.VIBEANYTHING_HOME = TMP;
  config = require('../lib/config');
});

after(() => {
  delete process.env.VIBEANYTHING_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'config.json'), { force: true });
});

const writeConfig = (obj) => fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(obj), 'utf-8');

// ── deepMerge ────────────────────────────────────────────────

test('嵌套对象逐层合并：只写一个字段不会把同层默认值抹掉', () => {
  const merged = config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9 } });
  assert.deepStrictEqual(merged, { a: { x: 1, y: 9 } });
});

test('数组是替换不是合并 —— 黑名单/危险命令是完整列表，合并会让人删不掉默认项', () => {
  const merged = config.deepMerge({ list: ['a', 'b'] }, { list: ['c'] });
  assert.deepStrictEqual(merged.list, ['c']);
});

test('显式写的 false / 空串要盖住默认值，undefined 则不盖', () => {
  const merged = config.deepMerge({ on: true, name: 'd', keep: 'x' }, { on: false, name: '', keep: undefined });
  assert.deepStrictEqual(merged, { on: false, name: '', keep: 'x' });
});

test('对象换成标量（或反之）按覆盖处理，不去硬凑', () => {
  assert.strictEqual(config.deepMerge({ a: { b: 1 } }, { a: 5 }).a, 5);
  assert.deepStrictEqual(config.deepMerge({ a: 5 }, { a: { b: 1 } }).a, { b: 1 });
});

// ── loadConfig ───────────────────────────────────────────────

test('最小配置（只有 3 个字段）也能跑起来：enabled 等默认值仍在', () => {
  writeConfig({
    machineId: 'new-box',
    centralServer: { enabled: true, url: 'ws://dash:3000/ws', machineToken: 'vamt_x' },
  });
  const cfg = config.loadConfig();
  assert.strictEqual(cfg.centralServer.enabled, true);
  assert.strictEqual(cfg.centralServer.url, 'ws://dash:3000/ws');
  assert.strictEqual(cfg.centralServer.machineId, '', '同层默认值必须还在');
  // 其它整块默认值也不能因为文件里没写就消失
  assert.deepStrictEqual(cfg.fileAccess.blockedDirs, config.defaultConfig().fileAccess.blockedDirs);
  assert.strictEqual(cfg.hooks.status, true);
  assert.strictEqual(cfg.pythonFormatter, 'black');
});

test('旧的「整段照抄」配置读出来一字不差（现网三台都是这种，升级不能改它们的行为）', () => {
  const full = {
    ...config.defaultConfig(),
    machineId: 'macmini',
    hooks: { notify: true, guard: false, formatPython: false, codeReview: false, fixWritePath: true, status: true },
  };
  writeConfig(full);
  const cfg = config.loadConfig();
  assert.deepStrictEqual(cfg.hooks, full.hooks);
  assert.strictEqual(cfg.machineId, 'macmini');
});

test('没有配置文件时就是默认值', () => {
  assert.deepStrictEqual(config.loadConfig(), config.defaultConfig());
  assert.deepStrictEqual(config.readRawConfig(), {});
});

// ── patchConfigFile ──────────────────────────────────────────

test('patchConfigFile 只写用户真正设过的键，不把整份默认值抄进文件', () => {
  config.patchConfigFile({
    machineId: 'new-box',
    centralServer: { enabled: true, url: 'ws://dash:3000/ws', machineToken: 'vamt_x' },
  });
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf-8'));
  assert.deepStrictEqual(Object.keys(raw).sort(), ['centralServer', 'machineId']);
  assert.strictEqual(raw.pythonFormatter, undefined, '默认值不该被写进文件');
});

test('patchConfigFile 保留文件里已有的其它键（装机不该把别人的配置冲掉）', () => {
  writeConfig({ machineId: 'old', pythonFormatter: 'pycodestyle', defaultWorkDir: '/srv/work' });
  config.patchConfigFile({ centralServer: { enabled: true, url: 'ws://d/ws', machineToken: 't' } });
  const raw = config.readRawConfig();
  assert.strictEqual(raw.pythonFormatter, 'pycodestyle');
  assert.strictEqual(raw.defaultWorkDir, '/srv/work');
  assert.strictEqual(raw.centralServer.machineToken, 't');
  assert.strictEqual(raw.machineId, 'old', '没 patch 的字段保持原样');
});

test('配置目录不存在时 patchConfigFile 自己建出来（新机器上就是空的）', () => {
  const nested = path.join(TMP, 'sub', 'dir');
  process.env.VIBEANYTHING_HOME = nested;
  try {
    config.patchConfigFile({ machineId: 'fresh' });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(nested, 'config.json'), 'utf-8')).machineId, 'fresh');
  } finally {
    process.env.VIBEANYTHING_HOME = TMP;
  }
});
