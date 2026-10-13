// 手机版工具条：点每个键真的发出了对应的字节吗。
// 渲染真组件、派发真 click，断言的是「这条工具条的全部契约」——
// 手机上没有物理键盘，Esc / Tab / 方向键 / Ctrl-C 只有这一个入口，发错了就没有别的路能补。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MobileKeyBar from '../src/mobile/MobileKeyBar.jsx';
import { KEY_SEQUENCES } from '../src/mobile/key-sequences.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let calls;

function render(overrides = {}) {
  const props = {
    onSendText: (t) => calls.push(['text', t]),
    onSendLine: () => calls.push(['line']),
    onPickImage: () => calls.push(['image']),
    onCopyAll: () => calls.push(['copy']),
    onScrollToBottom: () => calls.push(['bottom']),
    onPaste: () => calls.push(['paste']),
    onSlashCommand: (cmd) => calls.push(['slash', cmd]),
    directKeyboard: false,
    onToggleDirectKeyboard: () => calls.push(['toggle']),
    ...overrides,
  };
  act(() => { root.render(<MobileKeyBar {...props} />); });
}

/** 按可见文字找按钮 —— 用户就是这么找的。 */
function button(label) {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
  if (!found) throw new Error(`工具条上没有「${label}」按钮，现有：${Array.from(host.querySelectorAll('button')).map(b => b.textContent).join(' / ')}`);
  return found;
}

function click(label) {
  act(() => { button(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('按键发出的字节', () => {
  const cases = [
    ['Esc', KEY_SEQUENCES.esc],
    ['⇥', KEY_SEQUENCES.tab],
    ['↑', KEY_SEQUENCES.up],
    ['↓', KEY_SEQUENCES.down],
    ['←', KEY_SEQUENCES.left],
    ['→', KEY_SEQUENCES.right],
    ['^C', KEY_SEQUENCES.ctrlC],
    ['继续', KEY_SEQUENCES.resume],
  ];
  for (const [label, seq] of cases) {
    test(`${label} → ${JSON.stringify(seq)}`, () => {
      render();
      click(label);
      expect(calls).toEqual([['text', seq]]);
    });
  }

  test('序列本身就是终端认的那几条转义码', () => {
    // 写死期望值，避免「组件和常量一起改错还互相印证」的假绿
    expect(KEY_SEQUENCES.esc).toBe('\x1b');
    expect(KEY_SEQUENCES.up).toBe('\x1b[A');
    expect(KEY_SEQUENCES.down).toBe('\x1b[B');
    expect(KEY_SEQUENCES.left).toBe('\x1b[D');
    expect(KEY_SEQUENCES.right).toBe('\x1b[C');
    expect(KEY_SEQUENCES.ctrlC).toBe('\x03');
    expect(KEY_SEQUENCES.tab).toBe('\t');
    // 「继续」必须带回车，否则只是把两个字打进输入行、Claude 不会动
    expect(KEY_SEQUENCES.resume).toBe('继续\r');
  });
});

describe('非字节类的动作', () => {
  test('⏎ 走整行发送（不是直接打一个 \\r）', () => {
    render();
    click('⏎');
    expect(calls).toEqual([['line']]);
  });

  test('＋图片 打开相册选图', () => {
    render();
    click('＋图片');
    expect(calls).toEqual([['image']]);
  });

  test('复制 调的是复制入口', () => {
    render();
    click('复制');
    expect(calls).toEqual([['copy']]);
  });

  test('⌨直连 切换按键直达模式，并反映当前状态', () => {
    render({ directKeyboard: false });
    expect(button('⌨直连').title).toMatch(/输入框模式/);
    click('⌨直连');
    expect(calls).toEqual([['toggle']]);

    render({ directKeyboard: true });
    expect(button('⌨直连').title).toMatch(/按键直达终端/);
  });
});

describe('手机上的可点性', () => {
  test('每个按钮都不小于 44px（Apple HIG 的最小可点区域）', () => {
    render();
    for (const b of host.querySelectorAll('button')) {
      expect(parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      expect(parseInt(b.style.minWidth, 10)).toBeGreaterThanOrEqual(44);
    }
  });

  test('pointerdown 被 preventDefault —— 否则一点按键，输入框失焦、键盘就收了', () => {
    render();
    const ev = new window.Event('pointerdown', { bubbles: true, cancelable: true });
    act(() => { button('↑').dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });

  test('工具条单行横向滚动，不堆成多行被视口截断', () => {
    render();
    const bar = host.firstElementChild;
    expect(bar.style.overflowX).toBe('auto');
    expect(bar.style.flexWrap).not.toBe('wrap');
    // 底部横条（home indicator）不能压住工具条
    expect(bar.style.paddingBottom).toContain('--safe-bottom');
  });
});

// 手机上滑历史进 tmux copy-mode 之后，方向键是发给程序的按键、回不到底部，
// 而这条工具条是手机端唯一的操作入口 —— 没有这个按钮就真的只能等它自己刷新。
test('「⤓」调的是回到最新，不是往 PTY 发字节', () => {
  render();
  click('⤓');
  expect(calls).toEqual([['bottom']]);
});

// 手机版工具条一度比桌面版少了三个键（/clear、/compact、粘贴）。
// 手机上没有别的入口 —— 少一个键就是少一件能做的事，所以这里把「两边键位对齐」钉死。
describe('与桌面版对齐的那几个键', () => {
  test('/clear 与 /compact 都在，点了走共用的斜杠命令通路', () => {
    render();
    click('/clear');
    click('/compact');
    expect(calls).toEqual([['slash', '/clear'], ['slash', '/compact']]);
  });

  test('斜杠命令不是直接往 PTY 敲字节 —— 它得先发 Ctrl+C 打断', () => {
    render();
    click('/clear');
    // 走 onSlashCommand 而不是 onSendText：打断的时序由 slash-commands.js 统一负责
    expect(calls.some(c => c[0] === 'text')).toBe(false);
  });

  test('「粘贴」在，且调的是粘贴回调', () => {
    render();
    click('粘贴');
    expect(calls).toEqual([['paste']]);
  });

  test('工具条覆盖桌面版快捷键栏的全部按键', () => {
    render();
    const labels = Array.from(host.querySelectorAll('button')).map(b => b.textContent);
    // 桌面版 TerminalPanel 快捷键栏上的那一排（「⤓ 最新」在手机上省成「⤓」）
    for (const expected of ['↑', '↓', '←', '→', '⤓', '⏎', '继续', '^C', '⇥', 'Esc', '/clear', '/compact', '复制', '粘贴']) {
      expect(labels).toContain(expected);
    }
  });
});
