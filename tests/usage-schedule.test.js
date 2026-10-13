// tests/usage-schedule.test.js
// plist 用 plutil 真校验，不是只做字符串断言 —— 生成的 XML 一旦不合法，
// launchctl bootstrap 会静默失败，定时任务看着装上了其实没跑。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildPlist, LABEL } = require('../lib/usage-schedule');

const BASE = {
  nodePath: '/opt/homebrew/Cellar/node/25.6.0/bin/node',
  cliPath: '/Users/gsj/VibeAnything/bin/cli.js',
  logPath: '/Users/gsj/.vibeanything/usage-report.log',
};

test('plist 带上 node 所在目录到 PATH', () => {
  // 这条锁的是实测踩到的坑：launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
  // 而 ccusage 的 shebang 是 `#!/usr/bin/env node`，不注入就报
  // "env: node: No such file or directory"，手动跑却一切正常。
  const xml = buildPlist(BASE);
  assert.match(xml, /<key>PATH<\/key>/);
  assert.ok(xml.includes('/opt/homebrew/Cellar/node/25.6.0/bin'),
    'node 所在目录必须在 PATH 里，否则 ccusage 在 launchd 下找不到 node');
});

test('plist 含必需的 Label / 参数 / 定时字段', () => {
  const xml = buildPlist(BASE);
  assert.ok(xml.includes(`<string>${LABEL}</string>`));
  assert.ok(xml.includes('<string>--usage-report</string>'));
  assert.ok(xml.includes(BASE.nodePath));
  assert.ok(xml.includes(BASE.cliPath));
  assert.match(xml, /<key>StartCalendarInterval<\/key>/);
  assert.match(xml, /<key>Minute<\/key>\s*<integer>17<\/integer>/);
});

test('minute 可自定义', () => {
  assert.match(buildPlist({ ...BASE, minute: 5 }), /<integer>5<\/integer>/);
});

test('VIBEANYTHING_HOME 只在设置时注入', () => {
  assert.ok(!buildPlist(BASE).includes('VIBEANYTHING_HOME'));
  const withHome = buildPlist({ ...BASE, vibeHome: '/tmp/vibe-home' });
  assert.ok(withHome.includes('VIBEANYTHING_HOME'));
  assert.ok(withHome.includes('/tmp/vibe-home'));
});

test('RunAtLoad 为 false —— 装/重载时不该立刻跑一次', () => {
  assert.match(buildPlist(BASE), /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test('生成的 plist 能通过 plutil 校验', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-plist-'));
  const p = path.join(dir, `${LABEL}.plist`);
  try {
    fs.writeFileSync(p, buildPlist({ ...BASE, vibeHome: '/tmp/vibe-home' }));
    const out = execFileSync('plutil', ['-lint', p], { encoding: 'utf-8' });
    assert.match(out, /OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
