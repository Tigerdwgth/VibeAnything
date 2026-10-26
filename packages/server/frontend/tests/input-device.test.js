import { test, expect } from 'vitest';
import { isTouchOnlyDevice } from '../src/input-device.js';

// 按真实设备的媒体特性回答 matchMedia：只有同时满足 hover:none 与 pointer:coarse 才是手机/平板
const device = ({ hover, pointer }) => ({
  matchMedia: (q) => ({ matches: q === '(hover: none) and (pointer: coarse)' && hover === 'none' && pointer === 'coarse' }),
});

test('手机/平板（主指针是手指、不能悬停）→ 是', () => {
  expect(isTouchOnlyDevice(device({ hover: 'none', pointer: 'coarse' }))).toBe(true);
});

test('Windows 触屏笔记本（主指针是触控板/鼠标）→ 不是，输入框不能被压成只读', () => {
  expect(isTouchOnlyDevice(device({ hover: 'hover', pointer: 'fine' }))).toBe(false);
});

test('没有 matchMedia 的环境 → 不是', () => {
  expect(isTouchOnlyDevice({})).toBe(false);
});
