// 终端输入框（composer）的行为回归。桌面版 TerminalPanel 与手机版 MobileTerminal
// 共用这一个组件，所以这里挂的是**真组件 + 真 React 渲染 + 真 DOM 事件**：
// jsdom 原生就有 CompositionEvent / KeyboardEvent，不需要任何替身。
//
// 重点锁死 2026-08-17 那条教训：Android 中文输入法按「发送」时 keydown Enter 先于
// compositionend 到达，处理顺序错了就表现为「点一下发不出去，要按两次」。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import TerminalComposer from '../src/TerminalComposer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let sent;

function render(props = {}) {
  const ref = createRef();
  act(() => {
    root.render(
      <TerminalComposer
        ref={ref}
        onSendText={(t) => sent.push(t)}
        onBeforeSendLine={() => {}}
        isBracketedPaste={() => true}
        {...props}
      />,
    );
  });
  return { input: host.querySelector('textarea'), ref };
}

function key(input, k, extra = {}) {
  const ev = new window.KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true, ...extra,
  });
  act(() => { input.dispatchEvent(ev); });
  return ev;
}

function composition(input, type, data) {
  act(() => {
    input.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, data }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  sent = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('文字不能丢', () => {
  const EXIT = '<退出 copy-mode>';
  const withExit = () => ({ onBeforeSendLine: () => sent.push(EXIT) });

  test('先退出 copy-mode 再发文字，否则文字被 copy-mode 当按键吃掉', () => {
    const { input } = render(withExit());
    input.value = '你好';
    key(input, 'Enter');
    expect(sent).toEqual([EXIT, '你好', '\r']);
  });

  test('输入法组合中按回车，兑现时同样先退出 copy-mode', () => {
    const { input } = render(withExit());
    composition(input, 'compositionstart');
    input.value = '继续';
    key(input, 'Enter', { isComposing: true });
    composition(input, 'compositionend', '继续');
    expect(sent).toEqual([EXIT, '继续', '\r']);
  });

  test('空框回车只是一次回车，不退出 copy-mode', () => {
    const { input } = render(withExit());
    key(input, 'Enter');
    expect(sent).toEqual(['\r']);
  });

  test('连接断开时文字留在框里，也不发回车', () => {
    const { input } = render({
      onSendText: (t) => { sent.push(t); return false; },
    });
    input.value = '别丢';
    key(input, 'Enter');
    expect(sent).toEqual(['别丢']);
    expect(input.value).toBe('别丢');
  });
});

describe('整行发送', () => {
  test('打字后回车 = 内容 + 回车一次发出，并清空输入框', () => {
    const { input } = render();
    input.value = 'ls -la';
    key(input, 'Enter');
    expect(sent).toEqual(['ls -la', '\r']);
    expect(input.value).toBe('');
  });

  test('空框回车 = 只发一个回车', () => {
    const { input } = render();
    key(input, 'Enter');
    expect(sent).toEqual(['\r']);
  });

  test('外部按钮可以通过 ref 触发整行发送（工具条上的 ⏎）', () => {
    const { input, ref } = render();
    input.value = 'echo hi';
    act(() => { ref.current.sendLine(); });
    expect(sent).toEqual(['echo hi', '\r']);
    expect(input.value).toBe('');
  });
});

describe('中文输入法（Android 的回车竞态）', () => {
  test('组合中按回车：先扣住，等 compositionend 把文字和回车一起发', () => {
    const { input } = render();
    composition(input, 'compositionstart');
    input.value = '你好世界';
    // 这一下 keydown 早于 compositionend 到达 —— 输入法还没提交文字
    const ev = key(input, 'Enter', { isComposing: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);              // 此刻什么都不能发，否则文字会掉

    composition(input, 'compositionend', '你好世界');
    expect(sent).toEqual(['你好世界', '\r']);  // 一次发完，用户不必再按第二下
    expect(input.value).toBe('');
  });

  test('Android 在组合提交后补发的那次 Enter 被吞掉，不会整行发两遍', () => {
    const { input } = render();
    composition(input, 'compositionstart');
    input.value = '继续';
    key(input, 'Enter', { isComposing: true });
    composition(input, 'compositionend', '继续');
    expect(sent).toEqual(['继续', '\r']);

    key(input, 'Enter');                   // 补发的重复 keydown
    expect(sent).toEqual(['继续', '\r']);   // 没有多出来的一轮

    // 吞掉只针对紧随其后的那一次，之后回车照常工作
    key(input, 'Enter');
    expect(sent).toEqual(['继续', '\r', '\r']);
  });

  test('没按回车的普通中文输入不会自己发出去', () => {
    const { input } = render();
    composition(input, 'compositionstart');
    input.value = '中文';
    composition(input, 'compositionend', '中文');
    expect(sent).toEqual([]);
    expect(input.value).toBe('中文');
  });
});

describe('空框时工具键透传给终端', () => {
  const cases = [
    ['Tab', '\t'],
    ['Escape', '\x1b'],
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['ArrowLeft', '\x1b[D'],
    ['ArrowRight', '\x1b[C'],
    ['Backspace', '\x7f'],
    ['Delete', '\x1b[3~'],
  ];
  for (const [k, seq] of cases) {
    test(`${k} → ${JSON.stringify(seq)}`, () => {
      const { input } = render();
      const ev = key(input, k);
      expect(sent).toEqual([seq]);
      expect(ev.defaultPrevented).toBe(true);
    });
  }

  test('Ctrl+字母 → 对应控制字符（Ctrl+C = \\x03）', () => {
    const { input } = render();
    key(input, 'c', { ctrlKey: true });
    key(input, 'd', { ctrlKey: true });
    expect(sent).toEqual(['\x03', '\x04']);
  });
});

describe('框里有字时是编辑，不是透传', () => {
  test('退格/方向键走浏览器默认编辑，不发给终端', () => {
    const { input } = render();
    input.value = 'abc';
    const back = key(input, 'Backspace');
    const left = key(input, 'ArrowLeft');
    expect(sent).toEqual([]);
    expect(back.defaultPrevented).toBe(false);
    expect(left.defaultPrevented).toBe(false);
  });

  test('框里有字时 Esc 照样发给终端，字不清空', () => {
    const { input } = render();
    input.value = '写了一大段';
    const ev = key(input, 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(input.value).toBe('写了一大段');
    expect(sent).toEqual(['\x1b']);
  });

  test('输入法组合中的 Esc 归输入法，不发给终端', () => {
    const { input } = render();
    composition(input, 'compositionstart');
    input.value = 'ni';
    const ev = key(input, 'Escape', { isComposing: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('Tab 在框里是插入制表符，不是补全', () => {
    const { input } = render();
    input.value = 'a';
    input.setSelectionRange(1, 1);
    key(input, 'Tab');
    expect(input.value).toBe('a\t');
    expect(sent).toEqual([]);
  });
});

describe('长文字', () => {
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  test('Shift+Enter 留给浏览器换行，不发送', () => {
    const { input } = render();
    input.value = '第一行';
    const ev = key(input, 'Enter', { shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    expect(input.value).toBe('第一行');
  });

  test('输入法组合中的 Shift+Enter 也不发送', () => {
    const { input } = render();
    composition(input, 'compositionstart');
    key(input, 'Enter', { shiftKey: true, isComposing: true });
    composition(input, 'compositionend', '字');
    expect(sent).toEqual([]);
  });

  test('多行内容整段发出，最后才有一个回车', () => {
    const { input } = render();
    input.value = '第一行\n第二行';
    key(input, 'Enter');
    expect(sent).toEqual([`${PASTE_START}第一行\r第二行${PASTE_END}`, '\r']);
    expect(input.value).toBe('');
  });

  test('程序没开 bracketed paste 时，换行转成终端的回车', () => {
    const { input } = render({ isBracketedPaste: () => false });
    input.value = 'a\nb';
    key(input, 'Enter');
    expect(sent).toEqual(['a\rb', '\r']);
  });

  test('单行内容不加粘贴标记', () => {
    const { input } = render();
    input.value = '很长'.repeat(500);
    key(input, 'Enter');
    expect(sent).toEqual(['很长'.repeat(500), '\r']);
  });

  test('框高跟内容走，发送后恢复单行', () => {
    const { input } = render();
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 120 });
    input.value = '第一行\n第二行\n第三行';
    act(() => { input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    expect(input.style.height).toBe('120px');
    key(input, 'Enter');
    expect(input.style.height).toBe('');
  });

  test('隐藏面板量不出高度时不把框压成 0', () => {
    const { input } = render();
    input.value = '第一行\n第二行';
    act(() => { input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    expect(input.style.height).toBe('auto');
  });

  test('换行键在光标处插入换行，不发送，焦点留在框里', () => {
    const { input, ref } = render();
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 64 });
    input.value = '前半后半';
    input.setSelectionRange(2, 2);
    act(() => ref.current.insertNewline());
    expect(input.value).toBe('前半\n后半');
    expect(input.selectionStart).toBe(3);
    expect(document.activeElement).toBe(input);
    expect(input.style.height).toBe('64px');
    expect(sent).toEqual([]);
  });

  test('换行后回车，多行内容整段发出', () => {
    const { input, ref } = render();
    input.value = '第一行';
    input.setSelectionRange(3, 3);
    act(() => ref.current.insertNewline());
    input.value += '第二行';
    key(input, 'Enter');
    expect(sent).toEqual([`${PASTE_START}第一行\r第二行${PASTE_END}`, '\r']);
  });
});
