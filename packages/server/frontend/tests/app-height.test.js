// --app-height 校准：桌面版与手机版两个入口都靠它撑满屏幕。
//
// 手机上真实可视高度随地址栏收放、软键盘弹出实时变化，100vh/100dvh 都量不准；
// 量错的表现是底部露白条，或者软键盘把终端工具条压在屏幕外。
// jsdom 没有 visualViewport（宿主缺口），这里补一个**真 EventTarget** 当它，
// 被测的仍然是 installAppHeightSync 自己的接线。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { installAppHeightSync } from '../src/app-height.js';

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');

function setInnerHeight(h) {
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
}

/** 按规范补一个 visualViewport：它本身就是 EventTarget，只多一个 height。 */
function installVisualViewport(height) {
  const vv = new window.EventTarget();
  vv.height = height;
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

function removeVisualViewport() {
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
}

let dispose = null;

beforeEach(() => {
  document.documentElement.style.removeProperty('--app-height');
  setInnerHeight(800);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  removeVisualViewport();
});

describe('installAppHeightSync', () => {
  test('装上就先量一次，不用等任何事件', () => {
    installVisualViewport(640);
    dispose = installAppHeightSync();
    expect(appHeight()).toBe('640px');
  });

  test('优先用 visualViewport.height —— 它才是「真正看得见的那块」', () => {
    setInnerHeight(800);
    installVisualViewport(500);   // 软键盘弹起来了：布局视口仍是 800，可视只剩 500
    dispose = installAppHeightSync();
    expect(appHeight()).toBe('500px');
  });

  test('没有 visualViewport 的浏览器回落到 innerHeight', () => {
    removeVisualViewport();
    setInnerHeight(720);
    dispose = installAppHeightSync();
    expect(appHeight()).toBe('720px');
  });

  test('visualViewport resize（软键盘弹出/收起）会重新校准', () => {
    const vv = installVisualViewport(700);
    dispose = installAppHeightSync();
    vv.height = 320;
    vv.dispatchEvent(new window.Event('resize'));
    expect(appHeight()).toBe('320px');
  });

  test('visualViewport scroll（页面被键盘上推）也会重新校准', () => {
    const vv = installVisualViewport(700);
    dispose = installAppHeightSync();
    vv.height = 410;
    vv.dispatchEvent(new window.Event('scroll'));
    expect(appHeight()).toBe('410px');
  });

  test('window resize（地址栏收放）会重新校准', () => {
    removeVisualViewport();
    dispose = installAppHeightSync();
    setInnerHeight(560);
    window.dispatchEvent(new window.Event('resize'));
    expect(appHeight()).toBe('560px');
  });

  test('卸载后不再改 --app-height（页面切走了还在写就是内存泄漏）', () => {
    const vv = installVisualViewport(700);
    const stop = installAppHeightSync();
    stop();
    vv.height = 100;
    vv.dispatchEvent(new window.Event('resize'));
    setInnerHeight(123);
    window.dispatchEvent(new window.Event('resize'));
    expect(appHeight()).toBe('700px');
  });
});
