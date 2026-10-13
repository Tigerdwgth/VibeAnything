// lib/usage-schedule.js
// 用量上报的定时安装。
//
// 为什么不直接用 crontab：macOS 上 `crontab` 属于需要「完全磁盘访问」的操作，
// 非交互式调用（比如从这个 CLI 里 spawn）会直接挂住等授权，装不上也不报错。
// launchd 是 macOS 原生机制，写一个用户级 plist 就行，不需要任何额外授权。
// Linux 仍走 crontab（bin/cli.js --crontab install 里已经带上了上报那一行）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'com.vibeanything.usage-report';

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function isMac() {
  return process.platform === 'darwin';
}

/**
 * 生成 plist。
 * StartCalendarInterval 只给 Minute 表示「每小时的第 N 分钟」，落在 17 分是为了
 * 避开整点——ccusage 要全量扫 jsonl，整点上各种定时任务扎堆抢磁盘。
 */
function buildPlist({ nodePath, cliPath, logPath, minute = 17, vibeHome, extraPath = [] }) {
  // launchd 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，而 ccusage 的 shebang 是
  // `#!/usr/bin/env node` —— 不把 node 所在目录塞进 PATH，定时跑必然
  // "env: node: No such file or directory"，手动跑却完全正常。
  const pathDirs = [
    path.dirname(nodePath),
    ...extraPath,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  const envPairs = [['PATH', pathDirs.join(':')]];
  if (vibeHome) envPairs.push(['VIBEANYTHING_HOME', vibeHome]);
  const envEntries = `
  <key>EnvironmentVariables</key>
  <dict>
${envPairs.map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`).join('\n')}
  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>--usage-report</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <false/>${envEntries}
</dict>
</plist>
`;
}

function launchctl(args, { ignoreError = false } = {}) {
  try {
    // ignoreError 的调用（首次安装时的 bootout）本来就预期失败，
    // 把 stderr 也吞掉，否则会打出 "Boot-out failed: 3: No such process" 唬人。
    return execFileSync('launchctl', args, {
      encoding: 'utf-8',
      stdio: ignoreError ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (ignoreError) return '';
    throw new Error(`launchctl ${args.join(' ')} 失败: ${e.stderr || e.message}`);
  }
}

function install({ minute = 17 } = {}) {
  if (!isMac()) {
    throw new Error('当前系统不是 macOS，请用 `--crontab install`（其中已含每小时用量上报）');
  }
  const { getBaseDir } = require('./config');
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildPlist({
    nodePath: process.execPath,
    cliPath: path.join(__dirname, '..', 'bin', 'cli.js'),
    logPath: path.join(getBaseDir(), 'usage-report.log'),
    minute,
    vibeHome: process.env.VIBEANYTHING_HOME,
  }));
  // 先 bootout 再 bootstrap：改过 plist 后不卸载直接装，launchd 仍跑旧定义。
  const domain = `gui/${process.getuid()}`;
  launchctl(['bootout', `${domain}/${LABEL}`], { ignoreError: true });
  launchctl(['bootstrap', domain, target]);
  return { label: LABEL, path: target, minute };
}

function remove() {
  if (!isMac()) throw new Error('当前系统不是 macOS');
  const target = plistPath();
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { ignoreError: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  return { label: LABEL, path: target };
}

function status() {
  const target = plistPath();
  const exists = fs.existsSync(target);
  if (!isMac()) return { platform: process.platform, installed: false, note: '非 macOS，用 crontab' };
  const list = launchctl(['list'], { ignoreError: true });
  return {
    platform: 'darwin',
    installed: exists,
    loaded: list.includes(LABEL),
    path: target,
    label: LABEL,
  };
}

module.exports = { install, remove, status, buildPlist, plistPath, LABEL };
