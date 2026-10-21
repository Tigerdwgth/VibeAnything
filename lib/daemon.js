const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { loadConfig } = require('./config');
const { getBaseDir, getPidPath, getLogPath, cliPath } = require('./paths');

// pid 文件里写的标记。老版本写的是一个裸 PID，读的时候两种都要认。
const PID_MARKER = 'vibeanything-daemon';
// 启动时日志超过这个大小就先转存一份。只在启动那一刻做 ——
// 进程运行中改名没用：launchd/systemd 握着的是旧 inode，会继续往那个已改名的文件里写。
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/** pid 文件内容：新格式是 JSON，老格式是裸数字。 */
function readPidFile() {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  const raw = fs.readFileSync(pidPath, 'utf-8').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed?.pid)) return parsed;
  } catch { /* 老格式 */ }
  const pid = parseInt(raw, 10);
  return Number.isInteger(pid) ? { pid, cmd: null, startedAt: null } : null;
}

/**
 * 这个 PID 是不是真的 daemon。
 *
 * 光 `process.kill(pid, 0)` 不够：2026-07-30 那次事故就是手动跑的前台进程占住了
 * pid 文件，launchd 每次拉起新实例都判「已在运行」直接退出，真正的 ws-client 从没启动。
 * PID 会被系统复用，所以要看这个进程的命令行到底是不是我们。
 */
function processLooksLikeDaemon(pid) {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!cmd) return false;
    return cmd.includes('cli.js') && cmd.includes('--daemon');
  } catch {
    // 拿不到命令行（ps 不可用 / 不是自己的进程）时不下「不是 daemon」的结论，
    // 退回「PID 活着就算在跑」—— 误判成没在跑会导致同机起两个 ws-client。
    return true;
  }
}

function isRunning() {
  const entry = readPidFile();
  if (!entry) return false;
  try {
    process.kill(entry.pid, 0);
  } catch {
    try { fs.unlinkSync(getPidPath()); } catch {}
    return false;
  }
  if (processLooksLikeDaemon(entry.pid)) return true;
  // PID 活着但不是 daemon（被复用/被别的进程占住）：清掉陈旧的 pid 文件，让托管者能拉起来
  try { fs.unlinkSync(getPidPath()); } catch {}
  return false;
}

function writePid() {
  fs.mkdirSync(getBaseDir(), { recursive: true });
  fs.writeFileSync(
    getPidPath(),
    JSON.stringify({ pid: process.pid, cmd: PID_MARKER, startedAt: Date.now() }),
    'utf-8'
  );
}

/** 日志太大就转存成 .1（只留一份备份）。返回是否真的转存了。 */
function rotateLogIfBig(limit = LOG_ROTATE_BYTES) {
  const logPath = getLogPath();
  try {
    if (fs.statSync(logPath).size < limit) return false;
    fs.renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;   // 没有日志文件 / 改不动都不该影响启动
  }
}

/**
 * 这次启动该不该留在前台。
 *
 * 显式 `--foreground` 当然算；但**还要**认出「我是被进程管理器拉起来的」这件事 ——
 * 否则会出现这种局面：机器上装的还是老的 unit（里面写的是不带 --foreground 的
 * `--daemon start`），而代码已经是新版、默认脱离到后台 → 主进程 fork 完就退出 →
 * launchd/systemd 以为它崩了 → KeepAlive/Restart 原地刷屏重启。
 * 2026-07-30 那次「假运行中」就是同形态的坑，所以这里按环境判，不只按参数判。
 *
 * 判据：launchd 给自己的 job 设 XPC_SERVICE_NAME（shell 里跑是 "0"）；
 * systemd 给 unit 设 INVOCATION_ID / JOURNAL_STREAM；再兜一层 PPID===1
 * （已经被 init/launchd 收养，说明不是从哪个 shell 直接敲出来的）。
 *
 * @param {{foreground?: boolean, env?: object, ppid?: number}} opts
 */
function shouldRunForeground({ foreground = false, env = process.env, ppid = process.ppid } = {}) {
  if (foreground) return true;
  const xpc = env.XPC_SERVICE_NAME;
  if (xpc && xpc !== '0') return true;
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return true;
  return ppid === 1;
}

/**
 * 在后台起一个 daemon（自己退出，不挂住调用方的 shell）。
 *
 * `--daemon start` 以前是**前台**常驻，于是每台机器都自己发明一套
 * `nohup ... &` / `setsid ... & disown` 的咒语，ssh 一断 daemon 可能跟着走
 * （见 LESSONS_LEARNED 2026-09-25 第 4 条）。现在默认行为就是脱离，
 * 真正的前台模式留给 launchd/systemd 用 `--foreground`。
 */
function spawnDetached() {
  fs.mkdirSync(getBaseDir(), { recursive: true });
  const out = fs.openSync(getLogPath(), 'a');
  const child = spawn(process.execPath, [cliPath(), '--daemon', 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

function removePid() {
  try { fs.unlinkSync(getPidPath()); } catch {}
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(getLogPath(), line);
  } catch {}
}

/**
 * 启动守护进程：连接中央 Web Dashboard（ws-client 转发 PTY 数据），
 * 并轮询 IPC 目录里的 evt-*.json，把 hook 事件转发给浏览器（小人状态 + 声音提醒 + 红绿灯）。
 */
async function startDaemon({ foreground = false } = {}) {
  if (isRunning()) {
    console.log('守护进程已在运行');
    return;
  }

  // 默认脱离到后台：调用方（人、ssh、安装脚本）不必自己 nohup。
  // 被 launchd / systemd 拉起来时留在前台（哪怕 unit 里没写 --foreground），
  // 让托管者看得住这个进程 —— 判据见 shouldRunForeground。
  if (!shouldRunForeground({ foreground })) {
    const pid = spawnDetached();
    console.log(`守护进程已在后台启动 (子进程 PID: ${pid})，日志: ${getLogPath()}`);
    return;
  }

  rotateLogIfBig();
  writePid();
  log(`Daemon started, PID: ${process.pid}`);
  console.log(`守护进程已启动 (PID: ${process.pid})`);

  // 启动 Web Dashboard 连接（如已配置）
  const cfg = loadConfig();
  if (cfg.centralServer?.enabled && cfg.centralServer?.url) {
    // 支持通过 config 配置 SOCKS5 代理（用于 Tailscale userspace-networking 容器环境）
    if (cfg.centralServer.socks5Proxy && !process.env.TAILSCALE_SOCKS5) {
      process.env.TAILSCALE_SOCKS5 = cfg.centralServer.socks5Proxy;
    }
    const { WsClient } = require('./ws-client');
    const { PtyManager } = require('./pty-manager');
    const ptyMgr = new PtyManager({ codexWhip: cfg.codexWhip });
    const wsClientDash = new WsClient({
      url: cfg.centralServer.url,
      machineToken: cfg.centralServer.machineToken,
      machineId: cfg.centralServer.machineId || undefined,
      defaultWorkDir: cfg.defaultWorkDir || '',
      ptyManager: ptyMgr
    });
    wsClientDash.connect();
    log('Web Dashboard ws-client started');

    // 轮询 IPC 目录的 evt-*.json，转发 hook 事件给浏览器（小人状态 + 声音提醒）
    const { getIpcDir } = require('./ipc');
    const hookEventPoller = setInterval(() => drainHookEvents(getIpcDir(), wsClientDash), 500);

    process.on('SIGTERM', () => { wsClientDash.disconnect(); ptyMgr.destroyAll(); clearInterval(hookEventPoller); });
    process.on('SIGINT', () => { wsClientDash.disconnect(); ptyMgr.destroyAll(); clearInterval(hookEventPoller); });
  }

  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down');
    removePid();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down');
    removePid();
    process.exit(0);
  });

  // 双向交互已移除后，daemon 仅由 ws-client 的定时器与 evt 轮询保活；
  // 若未配置 centralServer，则本进程无常驻任务，退出后由 crontab 看门狗按需重启。
}

/**
 * 把 IPC 目录里 hook 写下的 evt-*.json 逐个读出、删掉、交给 ws-client。
 *
 * 跑在 daemon 的定时器里：这里抛出的异常没人接，会直接带走整个进程，
 * 而 evt 文件还没删，托管者拉起后下一轮又撞上同一个文件 —— 2026-10-09 就是这样
 * 让 macmini 每 10 秒掉线重连一次。
 */
function drainHookEvents(ipcDir, wsClient) {
  if (!fs.existsSync(ipcDir)) return;
  const files = fs.readdirSync(ipcDir).filter(f => f.startsWith('evt-') && f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(ipcDir, f);
    try {
      const evt = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      fs.unlinkSync(fp);
      // 先更新 WsClient 内存里的 hook 状态 Map（红绿灯 hook 优先、PTY 兜底），
      // 再转发给浏览器。老的 notify evt 没有 hookState，此时为 undefined，不影响。
      // 同时传 tmuxSession：手动建的会话在列表里用 tmux 名而非 UUID，用它才能匹配上。
      if (evt.hookState) wsClient.updateHookState(evt.sessionId, evt.hookState, evt.tmuxSession);
      wsClient._send({ type: 'hook_event', hookEvent: evt.hookEvent, hookState: evt.hookState, sessionId: evt.sessionId, tmuxSession: evt.tmuxSession, cwd: evt.cwd });
    } catch {}
  }
}

function stopDaemon() {
  const entry = readPidFile();
  if (!entry) {
    console.log('守护进程未运行');
    return false;
  }
  const pid = entry.pid;
  try {
    process.kill(pid, 'SIGTERM');
    removePid();
    console.log(`守护进程已停止 (PID: ${pid})`);
    return true;
  } catch {
    removePid();
    console.log('守护进程已停止（进程不存在）');
    return false;
  }
}

module.exports = {
  startDaemon,
  stopDaemon,
  drainHookEvents,
  isRunning,
  readPidFile,
  processLooksLikeDaemon,
  shouldRunForeground,
  rotateLogIfBig,
  getPidPath,
  getLogPath,
  writePid,
  removePid,
  log
};
