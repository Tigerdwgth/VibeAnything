// tests/service.test.js
// 进程托管：launchd plist / systemd user unit 的内容与落点。
//
// 只验**生成的 unit 文件**，不真装：这台 mac 上跑着的 daemon 正是由
// 同名 LaunchAgent（com.vibeanything.daemon）托管的，测试里 bootstrap 一下
// 就等于把线上那个替换了。unit 里有三件事错了会直接导致「装完机不工作，
// 而且没有任何报错」，所以必须盯死：
//   1. 必须带 --foreground —— 否则 start 会 fork 出子进程后立刻退出，
//      launchd/systemd 看到主进程没了就当它崩了，KeepAlive/Restart 原地刷屏重启。
//   2. 必须显式写 VIBEANYTHING_HOME —— 托管进程不读 shell 的环境变量。
//   3. 路径必须是绝对的 —— unit 的工作目录不是你装的时候那个目录。

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const svc = require('../lib/service');

test('平台识别：macOS 走 launchd，Linux 走 systemd user，其它平台明确不支持', () => {
  assert.strictEqual(svc.detectPlatform('darwin'), 'launchd');
  assert.strictEqual(svc.detectPlatform('linux'), 'systemd-user');
  assert.strictEqual(svc.detectPlatform('win32'), null);
});

test('plist / unit 落在用户目录下 —— 装机不需要 root（原来的 --deploy client 要 sudo）', () => {
  assert.strictEqual(
    svc.serviceFilePath('launchd'),
    path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.vibeanything.daemon.plist')
  );
  assert.strictEqual(
    svc.serviceFilePath('systemd-user'),
    path.join(os.homedir(), '.config', 'systemd', 'user', 'vibeanything-daemon.service')
  );
  assert.strictEqual(svc.serviceFilePath(null), null);
});

test('launchd plist：前台模式 + 绝对路径 + 显式 HOME + 崩了拉起 + 开机自启', () => {
  const plist = svc.buildLaunchdPlist({ node: '/usr/local/bin/node', cli: '/repo/bin/cli.js', home: '/home/u/.vibeanything', log: '/home/u/.vibeanything/daemon.log' });

  assert.ok(plist.includes('<string>--foreground</string>'), '必须前台跑，否则托管者看不住它');
  assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(plist.includes('<string>/repo/bin/cli.js</string>'));
  assert.ok(plist.includes('<key>VIBEANYTHING_HOME</key><string>/home/u/.vibeanything</string>'));
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(plist.includes('<string>/home/u/.vibeanything/daemon.log</string>'));
  assert.ok(plist.startsWith('<?xml'), 'launchctl 只认 plist 格式');
});

test('plist 里的路径要转义 —— 带 & 或引号的目录名会让 plist 整个解析失败', () => {
  const plist = svc.buildLaunchdPlist({ home: '/Users/a&b/"x"' });
  assert.ok(plist.includes('/Users/a&amp;b/&quot;x&quot;'));
  assert.ok(!plist.includes('a&b'), '裸 & 会让 plist 解析不了');
});

test('systemd user unit：前台模式 + Restart=always（顶替 crontab 每 5 分钟那个看门狗）', () => {
  const unit = svc.buildSystemdUserUnit({ node: '/usr/bin/node', cli: '/repo/bin/cli.js', home: '/root/.vibeanything' });

  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/repo\/bin\/cli\.js --daemon start --foreground$/m);
  assert.match(unit, /^Environment=VIBEANYTHING_HOME=\/root\/\.vibeanything$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m, 'user unit 挂 default.target，不是 multi-user');
  // 日志交给 journald：unit 里不写重定向，省掉「日志长到 30MB 没人转存」那条老问题
  assert.ok(!unit.includes('StandardOutput='), 'user unit 不自己接管日志文件');
});

test('默认参数用的是这份检出里的 cli.js 绝对路径', () => {
  const cli = svc.cliPath();
  assert.ok(path.isAbsolute(cli));
  assert.strictEqual(path.basename(cli), 'cli.js');
  assert.ok(svc.buildSystemdUserUnit().includes(cli));
});

test('不支持的平台：安装/卸载直接报错，不去写一个没人会读的文件', () => {
  assert.throws(() => svc.installService({ platform: null }), /不支持的平台/);
  assert.throws(() => svc.uninstallService({ platform: null }), /不支持的平台/);
  assert.deepStrictEqual(svc.serviceStatus({ platform: null }).installed, false);
});
