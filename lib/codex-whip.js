// lib/codex-whip.js
// codex 会话在 PTY 输出里命中容量/限流错误时，自动写 `continue\r` 推它继续，
// 等效于用户在终端里敲 "continue" 再回车。只挂在 codex 会话上（见 pty-manager.create）。

const MATCHERS = [
  /model at capacity/i,
  /exceeded retry limit, last status: 429 too many requests/i,
];

const DEFAULT_COOLDOWN_MS = 30_000;
const BUFFER_LEN = 2048;

/**
 * 创建 codex 自动「抽鞭子」处理器。依赖注入 write/now，单测无需真 PTY / 真实时钟。
 *
 * @param {object} opts
 * @param {(data: string) => (boolean|void)} opts.write 命中后发出继续输入的回调；返回 false 表示没有发
 * @param {number} [opts.cooldownMs] 冷却毫秒，默认 30000
 * @param {() => number} [opts.now] 时钟（毫秒），默认 Date.now
 * @param {boolean} [opts.enabled] 是否启用，默认 true
 * @param {(msg: string) => void} [opts.onTrigger] 命中后的提示回调（daemon 日志用，可省略）
 * @returns {{ onData: (data: string) => void }}
 */
/** 一段文本里有没有容量/限流错误（pty-manager 逐个 pane 定位错误时也用它）。 */
function matchesWhipError(text) {
  return MATCHERS.some((re) => re.test(text));
}

function createCodexWhip({ write, cooldownMs, now, enabled, onTrigger }) {
  const active = enabled !== false;
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const clock = now || (() => Date.now());
  // 只保留最近一段输出做尾部匹配：错误文本可能被 PTY 分块切碎跨 chunk，
  // 全局缓冲会无限涨内存，只留尾部即可命中「最近这段是否出现过错误」。
  let buffer = '';
  let lastTriggerAt = Number.NEGATIVE_INFINITY;

  function onData(data) {
    if (!active || !write || !data) return;
    buffer = (buffer + data).slice(-BUFFER_LEN);
    if (!matchesWhipError(buffer)) return;
    // 命中就清空：错误文本留在缓冲里的话，之后任何一点无关输出都会让它再命中一次
    buffer = '';
    const t = clock();
    if (t - lastTriggerAt < cooldown) return;
    // write 返回 false = 调用方核对后发现不是新错误（如重新 attach 的整屏重绘），没有发；
    // 这种不占冷却，否则紧接着来的真错误会被冷却挡掉
    if (write('continue\r') === false) return;
    lastTriggerAt = t;
    if (onTrigger) onTrigger('codex whip: hit capacity/retry-limit, sent continue');
  }

  return { onData };
}

module.exports = { createCodexWhip, matchesWhipError, MATCHERS, DEFAULT_COOLDOWN_MS, BUFFER_LEN };
