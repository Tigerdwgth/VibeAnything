// Web Audio API 合成声音提醒
// Stop（任务完成）：上升双音调 C5→E5，清脆愉悦
// Notification（需要注意）：单音 A4，稍长
//
// 提示音开关按「浏览器」记忆（localStorage），不是全局设置：
// Dashboard 是同一个远程服务，两台机器各开一个页面，谁想响谁自己开。
// 默认关闭 —— 工作机（mac-mini）常驻页面时每条 hook 事件都响会很吵，
// 想听提醒的那台（macair）在顶栏点一下 🔕 打开即可。

const SOUND_PREF_KEY = 'vibeanything:soundEnabled';

let _ctx = null;
function getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

export function isSoundEnabled() {
  return localStorage.getItem(SOUND_PREF_KEY) === 'on';
}

export function setSoundEnabled(enabled) {
  localStorage.setItem(SOUND_PREF_KEY, enabled ? 'on' : 'off');
}

function playTone(freq, startTime, duration, gainVal, ctx) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainVal, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

export function playSound(hookEvent) {
  if (!isSoundEnabled()) return;
  try {
    const ctx = getCtx();
    const now = ctx.currentTime;
    if (hookEvent === 'Stop') {
      // 上升双音调：C5(523Hz) → E5(659Hz)
      playTone(523, now, 0.18, 0.3, ctx);
      playTone(659, now + 0.15, 0.25, 0.25, ctx);
    } else if (hookEvent === 'Notification') {
      // 单音 A4(440Hz)，稍长
      playTone(440, now, 0.35, 0.25, ctx);
    }
  } catch {}
}
