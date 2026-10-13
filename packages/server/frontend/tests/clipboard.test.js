// 复制入口的回归测试。
//
// 这个模块线上摔过两次，两次都是「静默失效」——点了复制什么也不发生，没有报错、
// 没有提示，从现象上分不出是没选中还是被浏览器挡了：
//   2026-07-13  HTTP 页面 navigator.clipboard 是 undefined，同步 TypeError，.catch() 接不住。
//   2026-09-22  iOS 上 readonly textarea 的 select() 无效，execCommand 返回 false 而没人管。
// 所以这里重点测的不是「成功路径」，而是**失败时有没有出口**。
//
// jsdom 没有 document.execCommand（w3c 已废弃，它不实现），测试里显式装一个假的——
// 替的是宿主 API，不是被测对象；navigator.clipboard 在 jsdom 里本来就 undefined，
// 正好是线上 HTTP 页面的样子，不用替。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyTextToClipboard } from '../src/clipboard.js';

let execCalls;
let execResult;
let seenAtCopyTime;

beforeEach(() => {
  execCalls = [];
  execResult = true;
  seenAtCopyTime = null;
  // 文档选区是全局的：iOS 分支加的 Range 会留到下一个用例，
  // 让「非 iOS 不动文档选区」那条假红。每条用例开始前清干净。
  window.getSelection().removeAllRanges();
  document.execCommand = (cmd) => {
    execCalls.push(cmd);
    const ta = document.querySelector('textarea');
    // 记录 execCommand 被调用那一刻的状态：能不能真选中，决定了复制成不成
    seenAtCopyTime = {
      hasTextarea: !!ta,
      selectionStart: ta?.selectionStart,
      selectionEnd: ta?.selectionEnd,
      contentEditable: ta?.contentEditable,
      readOnly: ta?.readOnly,
      rangeCount: window.getSelection().rangeCount,
    };
    if (typeof execResult === 'function') return execResult();
    return execResult;
  };
});

afterEach(() => {
  delete document.execCommand;
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true,
  });
});

/** 伪装成 iPhone —— iOS 那条分支只能靠 UA 判断（iPadOS 13+ 再补 maxTouchPoints）。 */
function pretendIOS() {
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    configurable: true,
  });
}

describe('HTTP 页面（没有 navigator.clipboard）', () => {
  test('走 execCommand 回退，成功时回调 onSuccess', () => {
    expect(navigator.clipboard).toBeUndefined();   // 前提：就是线上那种非安全上下文
    const ok = [];
    const fail = [];
    copyTextToClipboard('hello', { onSuccess: () => ok.push(1), onFailure: (t) => fail.push(t) });
    expect(execCalls).toEqual(['copy']);
    expect(ok).toEqual([1]);
    expect(fail).toEqual([]);
  });

  test('execCommand 返回 false → 必须回调 onFailure，不能一声不吭', () => {
    execResult = false;
    const ok = [];
    const fail = [];
    copyTextToClipboard('hello', { onSuccess: () => ok.push(1), onFailure: (t) => fail.push(t) });
    expect(ok).toEqual([]);
    expect(fail).toEqual(['hello']);               // 把原文交出去，界面才能让用户手动拷
  });

  test('execCommand 抛异常也算失败，不把异常漏给调用方', () => {
    execResult = () => { throw new Error('blocked'); };
    const fail = [];
    expect(() => copyTextToClipboard('hello', { onFailure: (t) => fail.push(t) })).not.toThrow();
    expect(fail).toEqual(['hello']);
  });

  test('复制完把临时 textarea 收干净，不在页面上留垃圾', () => {
    copyTextToClipboard('hello', {});
    expect(seenAtCopyTime.hasTextarea).toBe(true); // 复制那一刻在
    expect(document.querySelector('textarea')).toBeNull(); // 复制完就没了
  });

  test('execCommand 调用时内容确实被选中了（没选中复制的就是空）', () => {
    copyTextToClipboard('hello', {});
    expect(seenAtCopyTime.selectionStart).toBe(0);
    expect(seenAtCopyTime.selectionEnd).toBe('hello'.length);
  });
});

describe('iOS 的 readonly 坑', () => {
  // 通用写法（select() + setSelectionRange）在 iOS 的 readonly 元素上是无效的，
  // 必须临时解开 readonly、用 Range 选中节点内容，选区留在文档上，再把属性还原
  //（还原发生在 execCommand 之前 —— 选区不会因为还原而消失，这正是这套写法的关键）。
  test('iOS 走 Range 路径：execCommand 时文档上确实留着一个选区', () => {
    pretendIOS();
    copyTextToClipboard('hello', {});
    expect(seenAtCopyTime.rangeCount).toBeGreaterThan(0);
    expect(seenAtCopyTime.selectionEnd).toBe('hello'.length);
  });

  test('iOS 路径把 readonly / contentEditable 原样还原，不把元素留在可编辑状态', () => {
    pretendIOS();
    copyTextToClipboard('hello', {});
    expect(seenAtCopyTime.readOnly).toBe(true);
    expect(seenAtCopyTime.contentEditable).not.toBe('true');
  });

  test('非 iOS 不去动文档选区，只用 textarea 自己的选区', () => {
    copyTextToClipboard('hello', {});
    expect(seenAtCopyTime.rangeCount).toBe(0);
    expect(seenAtCopyTime.readOnly).toBe(true);
  });
});

describe('有 navigator.clipboard 时（HTTPS）', () => {
  afterEach(() => { delete navigator.clipboard; });

  test('优先用异步接口，不造 textarea', async () => {
    const written = [];
    navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
    const ok = [];
    copyTextToClipboard('hello', { onSuccess: () => ok.push(1) });
    await Promise.resolve();
    expect(written).toEqual(['hello']);
    expect(execCalls).toEqual([]);
    expect(ok).toEqual([1]);
  });

  test('异步接口被拒（权限/焦点）时回退到 execCommand', async () => {
    navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
    const ok = [];
    copyTextToClipboard('hello', { onSuccess: () => ok.push(1) });
    await Promise.resolve();
    await Promise.resolve();
    expect(execCalls).toEqual(['copy']);
    expect(ok).toEqual([1]);
  });
});

test('空内容直接跳过，不弹失败面板', () => {
  const fail = [];
  copyTextToClipboard('', { onFailure: () => fail.push(1) });
  expect(execCalls).toEqual([]);
  expect(fail).toEqual([]);
});

test('onFailure 没传也不炸（桌面版就没传）', () => {
  execResult = false;
  const restored = vi.fn();
  expect(() => copyTextToClipboard('hello', { onRestoreFocus: restored })).not.toThrow();
  expect(restored).toHaveBeenCalled();
});

test('选不中就不执行复制，直接算失败 —— 否则 execCommand 会把页面上别的选区复制走', () => {
  // 让选中彻底失效（iOS 的 readonly textarea 实际就是这个效果）
  const proto = window.HTMLTextAreaElement.prototype;
  const realSelect = proto.select;
  const realSetRange = proto.setSelectionRange;
  try {
    proto.select = () => {};
    proto.setSelectionRange = () => {};
    const fail = [];
    copyTextToClipboard('hello', { onFailure: (t) => fail.push(t) });
    expect(execCalls).toEqual([]);          // 压根不该走到 execCommand
    expect(fail).toEqual(['hello']);
  } finally {
    proto.select = realSelect;
    proto.setSelectionRange = realSetRange;
  }
});
