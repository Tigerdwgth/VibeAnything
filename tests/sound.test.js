// tests/sound.test.js
// 前端提示音开关：按浏览器记忆（localStorage），默认静音。
// frontend 包是 ESM，从 CJS 测试里用动态 import 载入；这里要先备好 localStorage /
// window.AudioContext 两个浏览器全局，再 import 模块。
const assert = require('node:assert');
const { test, before, beforeEach } = require('node:test');

const SOUND_PREF_KEY = 'vibeanything:soundEnabled';

// 极简 localStorage 替身：只要 getItem/setItem 语义对（值一律转字符串）
function createLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// 记账用的 AudioContext 替身：记录每次 osc.start 的频率，用来断言「响了几个音」
let startedFreqs = [];
let ctxCreatedCount = 0;
class FakeAudioContext {
  constructor() {
    ctxCreatedCount++;
    this.currentTime = 0;
    this.destination = {};
  }
  createOscillator() {
    let freq = null;
    return {
      connect: () => {},
      type: '',
      frequency: { setValueAtTime: (v) => { freq = v; } },
      start: () => { startedFreqs.push(freq); },
      stop: () => {},
    };
  }
  createGain() {
    return {
      connect: () => {},
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
    };
  }
}

let sound;
before(async () => {
  global.localStorage = createLocalStorage();
  global.window = { AudioContext: FakeAudioContext };
  sound = await import('../packages/server/frontend/src/sound.js');
});

beforeEach(() => {
  global.localStorage.clear();
  startedFreqs = [];
  ctxCreatedCount = 0;
});

test('默认静音：从没设置过时不响，也不去创建 AudioContext', () => {
  assert.strictEqual(sound.isSoundEnabled(), false);
  sound.playSound('Stop');
  sound.playSound('Notification');
  assert.deepStrictEqual(startedFreqs, [], '默认状态下不应发出任何声音');
});

test('打开后 Stop 响上升双音 C5→E5', () => {
  sound.setSoundEnabled(true);
  assert.strictEqual(sound.isSoundEnabled(), true);
  sound.playSound('Stop');
  assert.deepStrictEqual(startedFreqs, [523, 659]);
});

test('打开后 Notification 响单音 A4', () => {
  sound.setSoundEnabled(true);
  sound.playSound('Notification');
  assert.deepStrictEqual(startedFreqs, [440]);
});

test('再关掉就立刻静音（同一浏览器可反复切换）', () => {
  sound.setSoundEnabled(true);
  sound.playSound('Stop');
  assert.strictEqual(startedFreqs.length, 2);

  sound.setSoundEnabled(false);
  startedFreqs = [];
  sound.playSound('Stop');
  assert.deepStrictEqual(startedFreqs, [], '关掉之后不应再响');
});

test('开关写进 localStorage，刷新页面后仍然生效', () => {
  sound.setSoundEnabled(true);
  assert.strictEqual(global.localStorage.getItem(SOUND_PREF_KEY), 'on');
  sound.setSoundEnabled(false);
  assert.strictEqual(global.localStorage.getItem(SOUND_PREF_KEY), 'off');
});

test('偏好只认 on，写坏的值一律当静音（避免脏值把声音打开）', () => {
  global.localStorage.setItem(SOUND_PREF_KEY, 'true');
  assert.strictEqual(sound.isSoundEnabled(), false);
  sound.playSound('Stop');
  assert.deepStrictEqual(startedFreqs, []);
});

test('未知 hook 事件即使开着声音也不响', () => {
  sound.setSoundEnabled(true);
  sound.playSound('PreToolUse');
  assert.deepStrictEqual(startedFreqs, []);
});
