// lib/tmux-codex-whip.js
// 监控本机所有 tmux 会话里的 codex pane：用 capture-pane 轮询屏幕输出，检测到
// 容量/429 限流错误时用 send-keys 向该 pane 发送 `continue` + 回车（抽鞭子）。
//
// 与 pty-manager 里的 codex-whip 区别：那个只覆盖「通过 Dashboard 创建的 codex
// 会话」（create 时 command[0] === 'codex'）；这个不管会话是谁开的，只要是 tmux
// 里的 codex 进程就管得到 —— 覆盖用户手动 tmux / 其它途径启动的 codex。

const { spawnSync } = require('node:child_process');
const { createCodexWhip } = require('./codex-whip');

const DEFAULT_COOLDOWN_MS = 30000;
const CAPTURE_HISTORY_LINES = 100;

/** 执行 tmux 命令；失败（无 tmux / 会话不存在）返回空串。依赖注入便于单测。 */
function defaultExec(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '') : '';
}

/** 去掉 ANSI 控制序列后的文本指纹，用于判断「屏幕有没有变化」。 */
function hashText(s) {
  const clean = String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  let h = 5381;
  for (let i = 0; i < clean.length; i++) h = ((h << 5) + h + clean.charCodeAt(i)) | 0;
  return String(h);
}

/**
 * 创建 tmux 级的 codex 自动「抽鞭子」轮询器。
 * @param {object} opts
 * @param {(args: string[]) => string} [opts.exec] tmux 命令执行器，默认 spawnSync 'tmux'
 * @param {number} [opts.cooldownMs] 同一 pane 命中后冷却毫秒，默认 30000
 * @param {number} [opts.intervalMs] 建议轮询间隔（仅文档用途，实际由调用方 setInterval 控制）
 * @param {boolean} [opts.enabled] 是否启用，默认 true
 * @param {() => number} [opts.now] 时钟（毫秒）
 * @param {(msg: string) => void} [opts.onTrigger] 触发回调（daemon 日志用）
 * @returns {{ poll: () => void, listCodexPanes: () => Array<{target:string}> }}
 */
function createTmuxCodexWhip({ exec, cooldownMs, enabled, now, onTrigger } = {}) {
  const active = enabled !== false;
  const run = exec || defaultExec;
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const clock = now || (() => Date.now());
  // target → { whip, lastSig, lastAt }
  const panes = new Map();

  function listCodexPanes() {
    // target 必须用 tmux 的 session:window.pane 格式（window 与 pane 之间是 `.`，
    // 写成 `:` 会让 capture-pane/send-keys 报 "can't find window"）
    const out = run(['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}']);
    if (!out) return [];
    const rows = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [target, command] = line.split('\t');
      if (target && command && command.trim() === 'codex') rows.push({ target: target.trim() });
    }
    return rows;
  }

  function capturePane(target) {
    return run(['capture-pane', '-p', '-t', target, '-S', `-${CAPTURE_HISTORY_LINES}`]);
  }

  function sendContinue(target) {
    run(['send-keys', '-t', target, 'continue', 'Enter']);
  }

  function poll() {
    if (!active) return;
    const targets = listCodexPanes();
    const seen = new Set(targets.map(t => t.target));

    for (const { target } of targets) {
      let state = panes.get(target);
      if (!state) {
        state = { lastSig: null, lastAt: 0, lastTextSig: '', whip: null };
        state.whip = createCodexWhip({
          write: () => {
            sendContinue(target);
            state.lastSig = state.lastTextSig;
            state.lastAt = clock();
            if (onTrigger) onTrigger(`codex whip: hit capacity/retry-limit, sent continue to ${target}`);
          },
          cooldownMs: cooldown,
          enabled: true,
          now: clock,
        });
        panes.set(target, state);
      }

      const text = capturePane(target);
      if (!text) continue;
      // 屏幕指纹没变 = 错误文本原样停在屏幕上，不重复抽鞭子（哪怕冷却已过）。
      const sig = hashText(text);
      if (sig === state.lastSig) continue;
      state.lastTextSig = sig;
      state.whip.onData(text);
    }

    // 清理已不存在的 pane，避免 Map 无限增长
    for (const k of [...panes.keys()]) {
      if (!seen.has(k)) panes.delete(k);
    }
  }

  return { poll, listCodexPanes };
}

module.exports = { createTmuxCodexWhip, hashText, defaultExec, DEFAULT_COOLDOWN_MS };
