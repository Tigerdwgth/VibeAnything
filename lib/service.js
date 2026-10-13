// lib/service.js
// 把 daemon 交给系统的进程管理器托管 —— 一条命令，macOS 和 Linux 各走各的原生方案。
//
// 为什么要有这东西：三台开发机现在是三套托管方式（mac-mini 手写的 launchd plist、
// 另两台 crontab `@reboot` + 每 5 分钟重跑 `--daemon start` 当看门狗），而仓库里原有的
// `--deploy client` 只会写**系统级** systemd unit、还要 root，macOS 上根本用不了。
// 结果是每台机器的「怎么重启 daemon」都得现场考古。
//
// 这里的选择：
//   · macOS → `~/Library/LaunchAgents` 里的 LaunchAgent（用户级，不要 sudo）
//   · Linux → `~/.config/systemd/user` 里的 systemd **user** unit（同样不要 root；
//     配 `loginctl enable-linger` 才能在没登录时也跑，安装后会提示）
//   · 两者都让系统负责「崩了拉起来」「开机自启」，所以 crontab 看门狗可以撤掉。
//
// unit 里跑的是 `--daemon start --foreground`：daemon 必须是前台进程，
// 让 launchd/systemd 直接看着它。2026-07-30 的事故就是反过来 ——
// 手动 `--daemon start` 占住了 pid 文件，launchd 每次拉起的新实例都判「已在运行」直接退出，
// 真正的 ws-client 从没启动过。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getBaseDir, getLogPath } = require('./paths');

const LAUNCHD_LABEL = 'com.vibeanything.daemon';
const SYSTEMD_UNIT = 'vibeanything-daemon.service';

/** 这份仓库里的 cli.js 绝对路径 —— unit 文件里不能写相对路径。 */
function cliPath() {
  return path.join(path.resolve(__dirname, '..'), 'bin', 'cli.js');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * macOS LaunchAgent。
 * KeepAlive 让它崩了自动拉起、RunAtLoad 让它登录即起；
 * VIBEANYTHING_HOME 必须显式写进 unit —— launchd 不读 shell 的环境变量。
 */
function buildLaunchdPlist({ node = process.execPath, cli = cliPath(), home = getBaseDir(), log = getLogPath() } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>--daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VIBEANYTHING_HOME</key><string>${xmlEscape(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/**
 * Linux systemd **user** unit（`systemctl --user`，不需要 root）。
 * Restart=always + RestartSec 顶替 crontab 那个每 5 分钟的看门狗。
 */
function buildSystemdUserUnit({ node = process.execPath, cli = cliPath(), home = getBaseDir() } = {}) {
  return `[Unit]
Description=VibeAnything daemon (ws-client)
After=network-online.target

[Service]
Type=simple
Environment=VIBEANYTHING_HOME=${home}
ExecStart=${node} ${cli} --daemon start --foreground
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** 当前平台用哪套托管。 */
function detectPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd-user';
  return null;
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

/** unit/plist 文件写在哪（给 status 和安装提示用）。 */
function serviceFilePath(platform = detectPlatform()) {
  if (platform === 'launchd') return launchdPlistPath();
  if (platform === 'systemd-user') return systemdUnitPath();
  return null;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 安装并启动服务。已安装则覆盖 unit 再重载（换了 node 版本或仓库路径就得重写）。
 * @returns {{platform: string, file: string, hints: string[]}}
 */
function installService({ platform = detectPlatform() } = {}) {
  if (!platform) throw new Error(`不支持的平台: ${process.platform}（只有 macOS / Linux 有现成托管）`);
  const file = serviceFilePath(platform);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hints = [];

  if (platform === 'launchd') {
    fs.writeFileSync(file, buildLaunchdPlist(), 'utf-8');
    const target = `gui/${process.getuid()}`;
    // 已加载过就先卸下：bootstrap 到一个已存在的 label 会直接报错
    try { run('launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]); } catch { /* 没加载过 */ }
    run('launchctl', ['bootstrap', target, file]);
    hints.push(`状态: launchctl print ${target}/${LAUNCHD_LABEL} | head -20`);
    hints.push(`重启: launchctl kickstart -k ${target}/${LAUNCHD_LABEL}`);
  } else {
    fs.writeFileSync(file, buildSystemdUserUnit(), 'utf-8');
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    hints.push(`状态: systemctl --user status ${SYSTEMD_UNIT}`);
    hints.push(`重启: systemctl --user restart ${SYSTEMD_UNIT}`);
    // 用户级 unit 默认只在该用户有登录会话时跑，服务器上要 linger 才能开机即起
    hints.push(`开机自启（未登录也跑）: sudo loginctl enable-linger ${os.userInfo().username}`);
  }
  return { platform, file, hints };
}

/** 卸载服务（不动配置，也不杀已经在跑的会话）。 */
function uninstallService({ platform = detectPlatform() } = {}) {
  if (!platform) throw new Error(`不支持的平台: ${process.platform}`);
  const file = serviceFilePath(platform);
  if (platform === 'launchd') {
    try { run('launchctl', ['bootout', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]); } catch { /* 没加载 */ }
  } else {
    try { run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]); } catch { /* 没启用 */ }
  }
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file);
  return { platform, file, existed };
}

/**
 * 服务状态。只报「托管有没有装」+ 系统给的那行状态，
 * 「daemon 是不是真连上 relay 了」要看 relay 侧，这里不假装知道。
 */
function serviceStatus({ platform = detectPlatform() } = {}) {
  if (!platform) return { platform: null, installed: false, detail: `不支持的平台: ${process.platform}` };
  const file = serviceFilePath(platform);
  const installed = fs.existsSync(file);
  let detail = '';
  try {
    detail = platform === 'launchd'
      ? run('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]).split('\n').slice(0, 12).join('\n')
      : run('systemctl', ['--user', 'status', SYSTEMD_UNIT]).split('\n').slice(0, 8).join('\n');
  } catch (e) {
    detail = (e.stdout || e.stderr || e.message || '').toString().trim().split('\n').slice(0, 6).join('\n');
  }
  return { platform, installed, file, detail };
}

module.exports = {
  buildLaunchdPlist, buildSystemdUserUnit, detectPlatform, serviceFilePath,
  installService, uninstallService, serviceStatus,
  LAUNCHD_LABEL, SYSTEMD_UNIT, cliPath,
};
