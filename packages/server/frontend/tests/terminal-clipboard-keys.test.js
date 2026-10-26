import { test, expect } from 'vitest';
import { clipboardKeyAction, isMacPlatform } from '../src/terminal-clipboard-keys.js';

const key = (k, mods = {}) => ({ type: 'keydown', key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
const WIN = { isMac: false, hasSelection: false };
const MAC = { isMac: true, hasSelection: false };

test('Windows：Ctrl+V 交给浏览器粘贴（大小写锁定也算）', () => {
  expect(clipboardKeyAction(key('v', { ctrlKey: true }), WIN)).toBe('paste');
  expect(clipboardKeyAction(key('V', { ctrlKey: true }), WIN)).toBe('paste');
});

test('Mac：Ctrl+V 仍是终端里的 \\x16（粘贴是 Cmd+V，xterm 本来就不碰）', () => {
  expect(clipboardKeyAction(key('v', { ctrlKey: true }), MAC)).toBeNull();
  expect(clipboardKeyAction(key('v', { metaKey: true }), MAC)).toBeNull();
});

test('Ctrl+Shift+V / Ctrl+Alt+V 不接管：前者 xterm 本就不编码，浏览器原生粘贴', () => {
  expect(clipboardKeyAction(key('V', { ctrlKey: true, shiftKey: true }), WIN)).toBeNull();
  expect(clipboardKeyAction(key('v', { ctrlKey: true, altKey: true }), WIN)).toBeNull();
});

test('有选中时 Ctrl+C / Ctrl+Shift+C 复制；没选中时 Ctrl+C 照常是 SIGINT', () => {
  const sel = { isMac: false, hasSelection: true };
  expect(clipboardKeyAction(key('c', { ctrlKey: true }), sel)).toBe('copy');
  expect(clipboardKeyAction(key('C', { ctrlKey: true, shiftKey: true }), sel)).toBe('copy');
  expect(clipboardKeyAction(key('c', { ctrlKey: true }), { isMac: true, hasSelection: true })).toBe('copy');
  expect(clipboardKeyAction(key('c', { ctrlKey: true }), WIN)).toBeNull();
});

test('只看 keydown', () => {
  expect(clipboardKeyAction({ ...key('v', { ctrlKey: true }), type: 'keyup' }, WIN)).toBeNull();
});

test('平台判定与 xterm 同源：navigator.platform 以 Mac 开头', () => {
  expect(isMacPlatform('MacIntel')).toBe(true);
  expect(isMacPlatform('Win32')).toBe(false);
  expect(isMacPlatform('Linux x86_64')).toBe(false);
  expect(isMacPlatform('')).toBe(false);
});
