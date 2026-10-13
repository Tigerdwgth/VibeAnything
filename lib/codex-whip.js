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
 * @param {(data: string) => void} opts.write 命中后把继续输入写回 PTY 的回调
 * @param {number} [opts.cooldownMs] 冷却毫秒，默认 30000
 * @param {() => number} [opts.now] 时钟（毫秒），默认 Date.now
 * @param {boolean} [opts.enabled] 是否启用，默认 true
 * @param {(msg: string) => void} [opts.onTrigger] 命中后的提示回调（daemon 日志用，可省略）
 * @returns {{ onData: (data: string) => void }}
 */
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
    if (!MATCHERS.some((re) => re.test(buffer))) return;
    const t = clock();
    if (t - lastTriggerAt < cooldown) return;
    lastTriggerAt = t;
    write('continue\r');
    if (onTrigger) onTrigger('codex whip: hit capacity/retry-limit, sent continue');
  }

  return { onData };
}

module.exports = { createCodexWhip, MATCHERS, DEFAULT_COOLDOWN_MS, BUFFER_LEN };
