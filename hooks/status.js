#!/usr/bin/env node
// hooks/status.js —— 上报会话运行状态（红绿灯），由 Claude Code hooks 驱动
//
// 绑定两个事件：
//   UserPromptSubmit（用户提交 prompt，开始运行）→ hookState: 'running'（红灯=运行中）
//   Stop（Claude 完成一整轮响应）            → hookState: 'done'（绿灯=空闲）
//
// 仅写一个 evt-*.json 到 IPC 目录，daemon 轮询后转发给浏览器更新红绿灯。
//
// 【绝不阻塞 Claude】UserPromptSubmit 是同步阻塞 hook（即使配 async:true，为稳妥也不依赖它）。
// 本脚本读完 stdin 后，把「写 evt + 查 tmux 名」这些可能耗时的活儿 fork 到一个 detached
// 后台进程里干，父进程立即 exit 0。这样 Claude 最多只等「fork+exit」一瞬间，绝不会卡。
//   - stdout 必须保持干净（空）：UserPromptSubmit 的 stdout 会被当 JSON 解析/注入 prompt，
//     输出任何非 JSON 内容都会出问题。本脚本不往 stdout 写任何东西。
//   - 所有错误吞掉，绝不影响 Claude 对话。

const { spawn } = require('node:child_process');

// 把 hook 事件名映射成红绿灯状态
function hookStateFor(hookEvent) {
  if (hookEvent === 'UserPromptSubmit') return 'running'; // 开始运行
  if (hookEvent === 'Stop') return 'done';                // 完成一轮，空闲
  return null;                                            // 其他事件不处理
}

// 后台子进程真正干活：查 tmux 名 + 写 evt-*.json。被父进程 detached spawn 调起。
// 通过环境变量传数据（避免再读 stdin）。
function runWorker() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');

    const hookEvent = process.env.VIBE_HOOK_EVENT || '';
    const hookState = hookStateFor(hookEvent);
    if (!hookState) return;
    const sessionId = process.env.VIBE_SESSION_ID || '';
    const cwd = process.env.VIBE_CWD || process.cwd();

    // 所在 tmux 会话名（继承 $TMUX），用于匹配 dashboard 列表里以 tmux 名作 sessionId 的会话
    let tmuxSession = '';
    if (process.env.TMUX) {
      try {
        const r = spawnSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 2000 });
        if (r.status === 0) tmuxSession = (r.stdout || '').trim();
      } catch {}
    }

    const { getMachineId } = require('../lib/config');
    const machineId = getMachineId();
    const { getIpcDir } = require('../lib/ipc');
    const ipcDir = getIpcDir();
    fs.mkdirSync(ipcDir, { recursive: true });
    const evtFile = path.join(ipcDir, `evt-${Date.now()}-${sessionId.slice(0, 8)}.json`);
    fs.writeFileSync(evtFile, JSON.stringify({
      hookEvent, hookState, sessionId, tmuxSession, machineId, cwd, timestamp: Date.now(),
    }));
  } catch { /* 后台进程，任何错误都吞掉 */ }
}

// 父进程（hook 主入口）：读 stdin → fork detached worker → 立即 exit 0
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { /* stdin 可能为空 */ }

  const hookEvent = data.hook_event_name || '';
  if (!hookStateFor(hookEvent)) return; // 非状态事件，啥也不干，立即退出

  // 把数据通过 env 传给 detached 后台 worker，父进程不等它，立即返回
  const child = spawn(process.execPath, [__filename, '--worker'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      VIBE_HOOK_EVENT: hookEvent,
      VIBE_SESSION_ID: data.session_id || '',
      VIBE_CWD: data.cwd || '',
    },
  });
  child.unref(); // 不等子进程，父进程可以立即退出
}

module.exports = { hookStateFor };

if (require.main === module) {
  if (process.argv.includes('--worker')) {
    // 后台 worker：直接干活（查 tmux 名 + 写 evt），干完自然退出
    runWorker();
  } else {
    // hook 主入口：读 stdin → fork detached worker → 立即退出。
    // 不往 stdout/stderr 写任何东西（UserPromptSubmit 对 stdout 敏感）。
    main().catch(() => {});
  }
}
