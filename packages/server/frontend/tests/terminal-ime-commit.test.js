// 「输入法开着时 Shift+= 打不出 +」的回归测试（豆包输入法）。
//
// 输入法接管的按键 keydown 是 keyCode 229，字符随后由输入法以 insertText 写进 xterm 的 textarea。
// xterm 只在 keydown 后 setTimeout(0) 比对一次 textarea；输入法写得比这晚就丢字。
// 这里用真 xterm（jsdom）按真实事件顺序回放：keydown(229) → [等待] → input(insertText) → keyup。

import { test, expect, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { attachImeCommitInput, isImeProcessKeydown } from '../src/terminal-ime';
import { fireKey } from './setup-jsdom.js';

let term, container, handle, sent;
const textarea = () => container.querySelector('.xterm-helper-textarea');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 输入法往 textarea 里写字：先改值，再派发 input（与浏览器顺序一致）。 */
function imeWrite(data, { inputType = 'insertText', isComposing = false } = {}) {
  const ta = textarea();
  if (inputType === 'deleteContentBackward') ta.value = ta.value.slice(0, -1);
  else ta.value += data;
  ta.dispatchEvent(new window.InputEvent('input', { bubbles: true, composed: true, data, inputType, isComposing }));
}

async function imeKey(data, { delayMs }) {
  fireKey(textarea(), 'keydown', { key: 'Process', code: 'Equal', keyCode: 229, shiftKey: true });
  if (delayMs) await sleep(delayMs);
  imeWrite(data);
  fireKey(textarea(), 'keyup', { key: data, code: 'Equal', keyCode: 187, shiftKey: true });
  await sleep(20);   // 让 xterm 的 setTimeout(0) 比对有机会跑（若它还在跑就会多发一份）
}

function setup({ withFix }) {
  term = new Terminal({ cols: 80, rows: 24 });
  term.open(container);
  sent = [];
  term.onData((d) => sent.push(d));
  if (withFix) {
    term.attachCustomKeyEventHandler((e) => !isImeProcessKeydown(e));
    handle = attachImeCommitInput(term, container);
  }
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  handle = null;
});

afterEach(() => {
  handle?.dispose();
  term?.dispose();
  container.remove();
});

test('根因：不接修复时，输入法写得比 xterm 的定时比对晚，字就丢了', async () => {
  setup({ withFix: false });
  await imeKey('+', { delayMs: 10 });
  expect(sent).toEqual([]);
});

test('输入法写得晚（豆包）：+ 照样发出，且只发一次', async () => {
  setup({ withFix: true });
  await imeKey('+', { delayMs: 10 });
  expect(sent).toEqual(['+']);
});

test('输入法写得快（微软拼音）：同样只发一次，不会和 xterm 的比对重复', async () => {
  setup({ withFix: true });
  await imeKey('！', { delayMs: 0 });
  expect(sent).toEqual(['！']);
});

test('连续几个符号各发一次，顺序不乱', async () => {
  setup({ withFix: true });
  await imeKey('+', { delayMs: 10 });
  await imeKey('！', { delayMs: 0 });
  await imeKey('（', { delayMs: 10 });
  expect(sent).toEqual(['+', '！', '（']);
});

test('输入法处理的退格（未在组合中）→ 发 DEL', async () => {
  setup({ withFix: true });
  fireKey(textarea(), 'keydown', { key: 'Process', code: 'Backspace', keyCode: 229 });
  imeWrite(null, { inputType: 'deleteContentBackward' });
  expect(sent).toEqual(['\x7f']);
});

test('打拼音选字的组合输入不归这里管（交给 xterm 的 composition 处理）', async () => {
  setup({ withFix: true });
  fireKey(textarea(), 'keydown', { key: 'Process', code: 'KeyN', keyCode: 229 });
  textarea().dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  imeWrite('n', { inputType: 'insertCompositionText', isComposing: true });
  expect(sent).toEqual([]);
});

test('普通按键（不经输入法）照旧由 xterm 处理', async () => {
  setup({ withFix: true });
  fireKey(textarea(), 'keydown', { key: '+', code: 'Equal', keyCode: 187, shiftKey: true });
  await sleep(20);
  expect(sent).toEqual(['+']);
});
