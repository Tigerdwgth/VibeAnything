#!/usr/bin/env node
// hooks/status.js —— 上报会话工作状态（黄灯 = 正在工作，绿灯 = 空闲）
//
// Claude Code 和 Codex 的 hook 直接调用本脚本，OpenCode 由插件 opencode-status.mjs 转调。
// 三家的 stdin 都带 hook_event_name / session_id / cwd。
//
// 【绝不阻塞 agent】读完 stdin 后把「查 tmux 名 + 写 evt」fork 到 detached 后台进程，父进程立即退出。
// stdout 必须保持干净：部分事件的 stdout 会被当作 JSON 解析或注入上下文。所有错误吞掉。

const { spawn } = require('node:child_process');

const RUNNING_EVENTS = new Set(['UserPromptSubmit']);
// 工具调用当心跳：daemon 重启丢了内存状态、或权限确认放行后，靠它们恢复黄灯。
const HEARTBEAT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const DONE_EVENTS = new Set(['Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'PermissionRequest']);
// 这几种通知说明 agent 在等人，其余通知（如 auth_success）不代表状态变化。
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog']);

/** 把 hook 事件映射成灯的状态；与灯无关的事件返回 null。 */
function hookStateFor(hookEvent, data = {}) {
  // 子代理的事件不代表主线状态：后台子代理在主线结束后触发 PreToolUse 会把灯错误点亮。
  if (data.agent_id) return null;
  if (RUNNING_EVENTS.has(hookEvent) || HEARTBEAT_EVENTS.has(hookEvent)) return 'running';
  if (DONE_EVENTS.has(hookEvent)) return 'done';
  if (hookEvent === 'Notification' && WAITING_NOTIFICATIONS.has(data.notification_type)) return 'done';
  return null;
}

// 所在 tmux 会话名，用于匹配 dashboard 列表。必须用 TMUX_PANE 指明窗格，否则多客户端时可能解析到别的会话。
function currentTmuxSession() {
  if (!process.env.TMUX) return '';
  const { spawnSync } = require('node:child_process');
  const args = ['display-message', '-p'];
  if (process.env.TMUX_PANE) args.push('-t', process.env.TMUX_PANE);
  const r = spawnSync('tmux', [...args, '#S'], { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

// 后台 worker：数据由父进程经环境变量传入。
function runWorker() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    // Dashboard 只列 tmux 会话。不在 tmux 里的多是 `codex exec` 这类批量任务，
    // 它们的灯没地方显示，转发过去只会让浏览器不停响提示音。
    const tmuxSession = currentTmuxSession();
    if (!tmuxSession) return;
    const hookEvent = process.env.VIBE_HOOK_EVENT;
    const sessionId = process.env.VIBE_SESSION_ID || '';
    const { getMachineId } = require('../lib/config');
    const { ensureIpcDir } = require('../lib/ipc');
    const ipcDir = ensureIpcDir();
    const timestamp = Number(process.env.VIBE_HOOK_TS);
    const evtFile = path.join(ipcDir, `evt-${timestamp}-${process.pid}.json`);
    const tmpFile = `${evtFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({
      hookEvent,
      hookState: process.env.VIBE_HOOK_STATE,
      heartbeat: HEARTBEAT_EVENTS.has(hookEvent),
      sessionId,
      tmuxSession,
      machineId: getMachineId(),
      cwd: process.env.VIBE_CWD || process.cwd(),
      // 等权限（permission_prompt）还是干完了等输入（idle_prompt）：灯都是绿的，像素小镇要区分
      notificationType: process.env.VIBE_NOTIFICATION_TYPE || undefined,
      timestamp,
    }));
    fs.renameSync(tmpFile, evtFile);   // 原子落盘：daemon 轮询不会读到写了一半的文件
  } catch { /* 后台进程，任何错误都吞掉 */ }
}

async function main() {
  // 在 hook 触发时取时间：异步 worker 落盘先后不固定，daemon 靠它丢弃迟到的旧事件。
  const firedAt = Date.now();
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { return; }

  const hookEvent = data.hook_event_name || '';
  const hookState = hookStateFor(hookEvent, data);
  if (!hookState) return;

  const child = spawn(process.execPath, [__filename, '--worker'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      VIBE_HOOK_EVENT: hookEvent,
      VIBE_HOOK_STATE: hookState,
      VIBE_HOOK_TS: String(firedAt),
      VIBE_SESSION_ID: data.session_id || '',
      VIBE_CWD: data.cwd || '',
      VIBE_NOTIFICATION_TYPE: data.notification_type || '',
    },
  });
  child.unref();
}

module.exports = { hookStateFor };

if (require.main === module) {
  if (process.argv.includes('--worker')) runWorker();
  else main().catch(() => {});
}
