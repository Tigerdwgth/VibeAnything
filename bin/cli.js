#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { saveConfig, defaultConfig, getBaseDir, getHooksDir } = require('../lib/config');
// 「哪几条 hook 是我们装的」判据单独成模块（lib/claude-hooks.js），带单测
const { hasHookScript, removeOurHooks } = require('../lib/claude-hooks');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

// ---- crontab 自启动管理 ----
const CRONTAB_MARKER = '# vibeanything-daemon';

function buildCrontabLines() {
  const nodePath = process.execPath;
  const cliPath = __filename;
  const { getBaseDir } = require('../lib/config');
  const logPath = path.join(getBaseDir(), 'daemon.log');
  // 如果设置了自定义 VIBEANYTHING_HOME 则注入环境变量
  const envPrefix = process.env.VIBEANYTHING_HOME
    ? `VIBEANYTHING_HOME=${process.env.VIBEANYTHING_HOME} `
    : '';
  const cmd = `${envPrefix}${nodePath} ${cliPath} --daemon start >> ${logPath} 2>&1`;
  // 用量上报走同一份 crontab，落在 17 分而不是整点：整点是各种定时任务的高峰，
  // ccusage 要全量扫 jsonl，错开能避免和别的活儿抢磁盘。
  const usageLog = path.join(getBaseDir(), 'usage-report.log');
  const usageCmd = `${envPrefix}${nodePath} ${cliPath} --usage-report >> ${usageLog} 2>&1`;
  return [
    CRONTAB_MARKER,
    `@reboot ${cmd}`,
    `*/5 * * * * ${cmd}`,
    `17 * * * * ${usageCmd}`,
  ];
}

function readCrontab() {
  const { execSync } = require('node:child_process');
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function writeCrontab(content) {
  const { execFileSync } = require('node:child_process');
  execFileSync('crontab', ['-'], { input: content });
}

function installCrontab() {
  const existing = readCrontab();
  if (existing.includes(CRONTAB_MARKER)) {
    console.log('⚠️  crontab 中已有 vibeanything 条目，跳过（可先 --crontab remove 再重装）');
    return false;
  }
  const lines = buildCrontabLines();
  const newContent = existing.trimEnd() + '\n' + lines.join('\n') + '\n';
  writeCrontab(newContent);
  const { getBaseDir } = require('../lib/config');
  console.log('✅ crontab 已安装:');
  console.log(`  @reboot      — 开机自动启动 daemon`);
  console.log(`  */5 * * * *  — 每5分钟检查，崩溃后自动拉起`);
  console.log(`  17 * * * *   — 每小时上报 Claude/Codex 用量到 Dashboard`);
  console.log(`  日志: ${path.join(getBaseDir(), 'daemon.log')} / usage-report.log`);
  return true;
}

function removeCrontab() {
  const existing = readCrontab();
  if (!existing.includes(CRONTAB_MARKER)) {
    console.log('crontab 中无 vibeanything 条目');
    return false;
  }
  // 过滤掉 marker 行及紧随的 crontab 行（以 @reboot 或 */5 开头）
  const filtered = existing
    .split('\n')
    .filter(line => !line.includes(CRONTAB_MARKER) && !line.includes('--daemon start'))
    .join('\n');
  writeCrontab(filtered);
  console.log('✅ crontab 条目已移除');
  return true;
}

async function main() {
  console.log('\n🔔 vibeanything 安装向导\n');
  console.log('本工具为 Claude Code 配置 hooks，并接入 Web Dashboard。\n');

  const config = defaultConfig();

  // 1. 选择 hooks
  console.log('\n请选择要启用的 hooks (回车默认全部启用):');
  const h1 = await ask('  会话事件上报 (Stop/Notification → Dashboard 小人状态与提示音) [Y/n]: ');
  config.hooks.notify = h1.trim().toLowerCase() !== 'n';
  const h2 = await ask('  危险命令拦截 [Y/n]: ');
  config.hooks.guard = h2.trim().toLowerCase() !== 'n';
  const h3 = await ask('  Python 代码格式化 [Y/n]: ');
  config.hooks.formatPython = h3.trim().toLowerCase() !== 'n';
  const h4 = await ask('  Commit 前代码审查 [Y/n]: ');
  config.hooks.codeReview = h4.trim().toLowerCase() !== 'n';

  const h6 = await ask('  Write 工具相对路径修复 (子 agent 写文件路径 undefined 修复) [Y/n]: ');
  config.hooks.fixWritePath = h6.trim().toLowerCase() !== 'n';

  if (config.hooks.formatPython) {
    const fmt = await ask('  Python 格式化工具 (black/autopep8) [black]: ');
    if (fmt.trim()) config.pythonFormatter = fmt.trim();
  }

  // 2. Web Dashboard 配置
  console.log('\n--- Web Dashboard 配置 ---');
  const enableDash = await ask('是否启用 Web Dashboard？(y/N): ');
  if (enableDash.trim().toLowerCase() === 'y') {
    const serverUrl = await ask('中央服务器 WebSocket 地址 (如 ws://your-server:3000/ws): ');
    const machineToken = await ask('Machine Token (在中央服务器 MACHINE_TOKENS 环境变量中配置): ');
    const defaultWorkDir = await ask('默认工作目录 (文件浏览器起始路径，留空用 home 目录): ');
    config.centralServer = {
      enabled: true,
      url: serverUrl.trim(),
      machineToken: machineToken.trim(),
      machineId: ''
    };
    config.defaultWorkDir = defaultWorkDir.trim();
    console.log('✅ Web Dashboard 已启用，daemon 启动后自动连接中央服务器');
  } else {
    config.centralServer = { enabled: false, url: '', machineToken: '', machineId: '' };
  }

  // 3. 保存配置
  saveConfig(config);
  console.log(`\n✅ 配置已保存到 ${path.join(getBaseDir(), 'config.json')}`);

  // 4. 复制 hooks 脚本到 ~/.vibeanything/
  const hooksDir = getHooksDir();
  const libDir = path.join(getBaseDir(), 'lib');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

  const srcRoot = path.resolve(__dirname, '..');
  // 复制 hooks
  for (const f of ['notify.js', 'guard.js', 'status.js', 'format-python.sh', 'code-review.sh', 'fix-write-path.js']) {
    const src = path.join(srcRoot, 'hooks', f);
    const dst = path.join(hooksDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  }
  // 复制 lib
  for (const f of ['config.js', 'paths.js', 'ipc.js', 'daemon.js', 'session-registry.js']) {
    const src = path.join(srcRoot, 'lib', f);
    const dst = path.join(libDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  console.log(`✅ Hook 脚本已安装到 ${hooksDir}`);

  // 5. 注入 hooks 到 ~/.claude/settings.json
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let claudeSettings = {};
  if (fs.existsSync(claudeSettingsPath)) {
    try { claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')); } catch {}
  }
  if (!claudeSettings.hooks) claudeSettings.hooks = {};

  const hooksBase = getHooksDir();
  const nodeCmd = (script) => `node ${path.join(hooksBase, script)}`;
  const shCmd = (script) => path.join(hooksBase, script);

  if (config.hooks.notify) {
    for (const event of ['Stop', 'Notification']) {
      if (!claudeSettings.hooks[event]) claudeSettings.hooks[event] = [];
      if (!hasHookScript(claudeSettings.hooks[event], 'notify.js')) {
        claudeSettings.hooks[event].push({
          hooks: [{ type: 'command', command: nodeCmd('notify.js') }]
        });
      }
    }
  }

  if (config.hooks.guard) {
    if (!claudeSettings.hooks.PreToolUse) claudeSettings.hooks.PreToolUse = [];
    const existingGuard = claudeSettings.hooks.PreToolUse.find(h =>
      h.matcher === 'Bash' && h.hooks?.some(hh => hh.command?.includes('guard.js'))
    );
    if (!existingGuard) {
      claudeSettings.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: nodeCmd('guard.js') }]
      });
    }
  }

  if (config.hooks.formatPython) {
    if (!claudeSettings.hooks.PostToolUse) claudeSettings.hooks.PostToolUse = [];
    const existingFmt = claudeSettings.hooks.PostToolUse.find(h =>
      h.hooks?.some(hh => hh.command?.includes('format-python'))
    );
    if (!existingFmt) {
      claudeSettings.hooks.PostToolUse.push({
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: shCmd('format-python.sh') }]
      });
    }
  }

  if (config.hooks.codeReview) {
    if (!claudeSettings.hooks.PreToolUse) claudeSettings.hooks.PreToolUse = [];
    const existingReview = claudeSettings.hooks.PreToolUse.find(h =>
      h.hooks?.some(hh => hh.command?.includes('code-review'))
    );
    if (!existingReview) {
      claudeSettings.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: shCmd('code-review.sh') }]
      });
    }
  }

  if (config.hooks.fixWritePath) {
    if (!claudeSettings.hooks.PreToolUse) claudeSettings.hooks.PreToolUse = [];
    const existingFix = claudeSettings.hooks.PreToolUse.find(h =>
      h.hooks?.some(hh => hh.command?.includes('fix-write-path.js'))
    );
    if (!existingFix) {
      claudeSettings.hooks.PreToolUse.push({
        matcher: 'Write',
        hooks: [{ type: 'command', command: nodeCmd('fix-write-path.js') }]
      });
    }
  }

  // 会话红绿灯状态上报：UserPromptSubmit（开始运行=红/绿灯）+ Stop（完成=空闲）。
  // 必须带 async:true —— UserPromptSubmit 默认同步阻塞超时仅 30s，会拖慢 Claude；
  // status.js 只写一个 evt 文件，异步执行即可。
  if (config.hooks.status) {
    for (const event of ['UserPromptSubmit', 'Stop']) {
      if (!claudeSettings.hooks[event]) claudeSettings.hooks[event] = [];
      const existing = claudeSettings.hooks[event].find(h =>
        h.hooks?.some(hh => hh.command?.includes('status.js'))
      );
      if (!existing) {
        claudeSettings.hooks[event].push({
          hooks: [{ type: 'command', command: nodeCmd('status.js'), async: true }]
        });
      }
    }
  }

  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2), 'utf-8');
  console.log(`✅ Hooks 已注入 ${claudeSettingsPath}`);

  console.log('\n🎉 安装完成! Claude Code hooks 已就绪。\n');
  console.log('管理命令:');
  console.log('  npx vibeanything                # 重新配置');
  console.log('  npx vibeanything --remove       # 卸载');
  console.log('  npx vibeanything --daemon start # 启动守护进程 (ws-client + hook 事件转发)');
  console.log('  npx vibeanything --daemon stop  # 停止守护进程');
  console.log('  npx vibeanything --daemon status# 查看状态');
  console.log('  npx vibeanything --server start # 启动 Web Dashboard');
  console.log('  npx vibeanything --server stop  # 停止 Web Dashboard');
  console.log('  npx vibeanything --server status# 查看 Dashboard 状态');
  console.log('  sudo npx vibeanything --deploy dashboard # 部署为 Dashboard 服务器（systemd 自启动）');
  console.log('  sudo npx vibeanything --deploy client    # 部署为客户端（systemd 自启动）\\n');

  // 6. crontab 自启动（可选）
  const enableCron = await ask('是否配置 crontab 开机自启 + 5分钟看门狗？(y/N): ');
  if (enableCron.trim().toLowerCase() === 'y') {
    installCrontab();
  }

  rl.close();
}

// 处理子命令与各种 --flag
const args = process.argv.slice(2);

/** `--name value` 与 `--name=value` 两种写法都认。 */
function flagValue(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

/** 读一行不回显的输入（密码）。拿不到 TTY 时退回普通可见输入，而不是直接失败。 */
function promptHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const r = readline.createInterface({ input: process.stdin, output: process.stdout });
      r.question(question, (a) => { r.close(); resolve(a.trim()); });
      return;
    }
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const onData = (chunk) => {
      const ch = chunk.toString('utf8');
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f') { value = value.slice(0, -1); return; }
      value += ch;
    };
    process.stdin.on('data', onData);
  });
}

// ── vibeanything join：用一次性邀请码把这台机器装上 ───────────
// 以前这一步是：照抄 40 行 config.json、让管理员改 dashboard 的 systemd unit 加一条
// MACHINE_TOKENS、重启服务。现在只要服务器地址 + 邀请码，配置里只落 3 个字段。
if (args[0] === 'join') {
  const { join } = require('../lib/join');
  const server = flagValue('server');
  const code = flagValue('code');
  if (!server || !code) {
    console.error('用法: vibeanything join --server <dashboard 地址> --code <邀请码> [--machine-id <名字>] [--label <备注>]');
    console.error('  邀请码由管理员签发: vibeanything invite --server <地址> --user <管理员>');
    process.exit(1);
  }
  join({ server, code, machineId: flagValue('machine-id'), label: flagValue('label') })
    .then(({ machineId, wsUrl, configPath }) => {
      console.log(`✅ 装机完成: ${machineId} → ${wsUrl}`);
      console.log(`配置已写入 ${configPath}（只写了 machineId 与 centralServer，其余走默认值）`);
      console.log('下一步: vibeanything service install   # 交给 launchd / systemd 托管');
      rl.close();
    })
    .catch((e) => { console.error(`❌ 装机失败: ${e.message}`); process.exit(1); });

// ── vibeanything invite：管理员签发一次性邀请码 ───────────────
} else if (args[0] === 'invite') {
  const { requestInvite } = require('../lib/join');
  const server = flagValue('server');
  const username = flagValue('user');
  if (!server || !username) {
    console.error('用法: vibeanything invite --server <dashboard 地址> --user <管理员> [--machine-id <机器>] [--label <备注>] [--ttl <分钟>]');
    console.error('  --machine-id 指名某台机器：此码只能换成它的 token，也是给已有机器换 token 的唯一途径');
    process.exit(1);
  }
  (async () => {
    const password = flagValue('password') || process.env.VIBEANYTHING_PASSWORD || await promptHidden(`${username} 的密码: `);
    const machineId = flagValue('machine-id');
    const invite = await requestInvite({
      server, username, password, machineId,
      label: flagValue('label'),
      ttlMinutes: flagValue('ttl') ? Number(flagValue('ttl')) : undefined,
    });
    const until = new Date(invite.expiresAt).toLocaleString();
    console.log(`\n邀请码: ${invite.code}`);
    console.log(`有效期至: ${until}（一次性，用过即废）`);
    if (invite.machineId) console.log(`仅限机器: ${invite.machineId}`);
    console.log('\n在新机器上执行：');
    console.log(`  vibeanything join --server ${invite.httpBase} --code ${invite.code}${machineId ? '' : ' --machine-id <这台机器的名字>'}`);
    console.log('  vibeanything service install\n');
    rl.close();
  })().catch((e) => { console.error(`❌ 签发失败: ${e.message}`); process.exit(1); });

// ── vibeanything service：把 daemon 交给系统托管 ──────────────
} else if (args[0] === 'service') {
  const svc = require('../lib/service');
  const sub = args[1] || 'status';
  try {
    if (sub === 'install') {
      const { platform, file, hints } = svc.installService();
      console.log(`✅ 已安装并启动（${platform}）: ${file}`);
      for (const h of hints) console.log(`  ${h}`);
    } else if (sub === 'uninstall') {
      const { platform, file, existed } = svc.uninstallService();
      console.log(existed ? `✅ 已卸载（${platform}）: ${file}` : `未安装（${platform}）`);
    } else {
      const st = svc.serviceStatus();
      console.log(`平台: ${st.platform || '不支持'}`);
      console.log(`托管文件: ${st.file || '-'} ${st.installed ? '(已安装)' : '(未安装)'}`);
      if (st.detail) console.log(st.detail);
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  rl.close();

} else if (args.includes('--daemon')) {
  const { loadConfig } = require('../lib/config');
  const cfg = loadConfig();
  const sub = args[args.indexOf('--daemon') + 1] || 'status';

  if (sub === 'start') {
    // 双向交互移除后 daemon 只负责 ws-client + evt 轮询，仅需 centralServer 配置
    const hasCentralServer = cfg.centralServer?.enabled && cfg.centralServer?.url && cfg.centralServer?.machineToken;
    if (!hasCentralServer) {
      console.log('❌ 请先配置 centralServer (url/machineToken)');
      console.log('运行: npx vibeanything');
      process.exit(1);
    }
    const { startDaemon } = require('../lib/daemon');
    // --foreground 由 launchd/systemd 的 unit 用；人和脚本直接敲 start 时默认脱离到后台
    startDaemon({ foreground: args.includes('--foreground') })
      // 前台模式里 daemon 自己的定时器/连接会把事件循环撑住；后台模式下这里关掉
      // 顶层那个 readline 之后进程就该退出 —— 不关它会一直挂着等 stdin。
      .then(() => rl.close())
      .catch(e => {
        console.error('启动失败:', e.message);
        process.exit(1);
      });
  } else if (sub === 'stop') {
    const { stopDaemon } = require('../lib/daemon');
    stopDaemon();
    rl.close();
  } else {
    const { isRunning, readPidFile, getLogPath } = require('../lib/daemon');
    const running = isRunning();
    console.log(`守护进程状态: ${running ? '✅ 运行中' : '❌ 未运行'}`);
    if (running) console.log(`PID: ${readPidFile()?.pid}`);
    console.log(`日志: ${getLogPath()}`);
    rl.close();
  }
} else if (args.includes('--server')) {
  const { loadConfig, getBaseDir } = require('../lib/config');
  const cfg = loadConfig();
  const sub = args[args.indexOf('--server') + 1] || 'status';
  const serverCfg = cfg.server || {};
  const pidPath = path.join(getBaseDir(), 'server.pid');

  if (sub === 'start') {
    const tokens = serverCfg.machineTokens || [];
    if (tokens.length === 0) {
      console.log('⚠️  未配置 server.machineTokens，开发机将无法连接');
      console.log('请在 config.json 的 server.machineTokens 中添加 token');
    }
    // 设置 env 供 relay.js 读取（兼容旧逻辑）
    process.env.MACHINE_TOKENS = tokens.join(',');
    const port = serverCfg.port || 3000;
    const host = serverCfg.host || '0.0.0.0';
    const { startServer } = require('../packages/server/index');
    startServer({ port, host, machineTokens: tokens });
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid));
    process.on('SIGTERM', () => { try { fs.unlinkSync(pidPath); } catch {} process.exit(0); });
    process.on('SIGINT', () => { try { fs.unlinkSync(pidPath); } catch {} process.exit(0); });
  } else if (sub === 'stop') {
    if (!fs.existsSync(pidPath)) { console.log('Server 未运行'); process.exit(0); }
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try { process.kill(pid, 'SIGTERM'); console.log(`Server 已停止 (PID: ${pid})`); } catch { console.log('Server 已停止（进程不存在）'); }
    try { fs.unlinkSync(pidPath); } catch {}
  } else {
    const running = fs.existsSync(pidPath) && (() => {
      try { process.kill(parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10), 0); return true; } catch { return false; }
    })();
    console.log(`Server 状态: ${running ? '✅ 运行中' : '❌ 未运行'}`);
    if (running) console.log(`PID: ${fs.readFileSync(pidPath, 'utf-8').trim()}`);
    console.log(`端口: ${serverCfg.port || 3000}`);
    console.log(`Machine Tokens: ${(serverCfg.machineTokens || []).length} 个`);
  }
} else if (args.includes('--usage-report')) {
  // 采集本机 Claude Code / Codex 用量并上报 Dashboard。crontab 每小时调它，
  // 也可手动跑一次验证链路。输出带时间戳——日志是 append 的，没戳没法排查。
  const { loadConfig } = require('../lib/config');
  const { collectAndReport } = require('../lib/usage-collector');
  const stamp = () => new Date().toISOString();
  collectAndReport(loadConfig())
    .then(r => {
      console.log(`[${stamp()}] ✅ 上报 ${r.written}/${r.collected} 条 → ${r.url}`);
      for (const e of r.errors || []) {
        console.warn(`[${stamp()}] ⚠️  ${e.agent} 采集失败（另一路不受影响）: ${e.message}`);
      }
    })
    .catch(e => {
      console.error(`[${stamp()}] ❌ 用量上报失败: ${e.message}`);
      process.exit(1);
    });
} else if (args.includes('--usage-schedule')) {
  // macOS 专用：用 launchd 而不是 crontab 装每小时上报。
  // macOS 的 crontab 要「完全磁盘访问」授权，非交互调用会直接挂住。
  const sched = require('../lib/usage-schedule');
  const sub = args[args.indexOf('--usage-schedule') + 1] || 'status';
  try {
    if (sub === 'install') {
      const r = sched.install();
      console.log(`✅ 已安装 launchd 定时任务 ${r.label}`);
      console.log(`  每小时 ${r.minute} 分上报一次`);
      console.log(`  plist: ${r.path}`);
    } else if (sub === 'remove') {
      const r = sched.remove();
      console.log(`✅ 已卸载 ${r.label}`);
    } else {
      const s = sched.status();
      console.log(`用量定时上报: ${s.installed ? '✅ 已安装' : '❌ 未安装'}${s.loaded ? '（已加载）' : ''}`);
      if (s.path) console.log(`  plist: ${s.path}`);
      if (s.note) console.log(`  ${s.note}`);
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
} else if (args.includes('--crontab')) {
  const sub = args[args.indexOf('--crontab') + 1] || '';
  if (sub === 'install') {
    installCrontab();
  } else if (sub === 'remove') {
    removeCrontab();
  } else if (sub === 'status') {
    const existing = readCrontab();
    const installed = existing.includes(CRONTAB_MARKER);
    console.log(`crontab 自启动: ${installed ? '✅ 已安装' : '❌ 未安装'}`);
    if (installed) {
      buildCrontabLines().forEach(l => console.log(' ', l));
    }
  } else {
    console.log('用法: node bin/cli.js --crontab [install|remove|status]');
  }
} else if (args.includes('--remove')) {
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(claudeSettingsPath)) {
    const existing = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    const { settings, removed } = removeOurHooks(existing);
    if (removed) console.log(`已从 ~/.claude/settings.json 摘掉 ${removed} 条本项目的 hook`);
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
  }
  const baseDir = getBaseDir();
  if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true });
  console.log('✅ 已卸载 vibeanything');
} else if (args.includes('--deploy')) {
  const { deployDashboard, deployClient } = require('../lib/deploy');
  const sub = args[args.indexOf('--deploy') + 1] || '';

  if (sub === 'dashboard') {
    deployDashboard().catch(e => {
      console.error('部署失败:', e.message);
      process.exit(1);
    });
  } else if (sub === 'client') {
    deployClient().catch(e => {
      console.error('部署失败:', e.message);
      process.exit(1);
    });
  } else {
    console.error('❌ 请指定部署模式: dashboard 或 client');
    console.log('\n用法:');
    console.log('  sudo node bin/cli.js --deploy dashboard  # 部署为 Dashboard 服务器');
    console.log('  sudo node bin/cli.js --deploy client     # 部署为客户端（开发机）');
    process.exit(1);
  }
} else {
  main().catch(console.error);
}