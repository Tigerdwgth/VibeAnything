// 桌面版 TerminalPanel 的接线回归。
//
// 为什么要有这一条：手机版上线时把 TerminalPanel 里的输入框、复制入口、字节编码、
// pty_data 写入合批抽成了共用模块（TerminalComposer / clipboard.js / terminal-io.js）。
// 抽取本身是等价替换，但**接线错了不会报错，只会静默变哑**——输入框还在，敲回车
// 什么都不发。所以这里挂真 TerminalPanel、派发真事件、用一个真 EventTarget 当 ws，
// 断言「敲进去的字节确实发出去了」「收到的字节确实写进了终端」。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalPanel from '../src/TerminalPanel.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 真 EventTarget 当 ws：readyState/send 是 WebSocket 的全部契约里本测用得到的部分。 */
function fakeWs() {
  const ws = new window.EventTarget();
  ws.readyState = 1;               // WebSocket.OPEN
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  return ws;
}

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

let host;
let root;
let ws;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  ws = fakeWs();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount() {
  act(() => {
    root.render(<TerminalPanel machineId="macmini" sessionId="s-1" ws={ws} command={['claude']} />);
  });
}

const inputs = () => ws.sent.filter(m => m.type === 'terminal_input');

describe('桌面版终端的输入链路', () => {
  test('输入框敲回车 = 整行 + 回车发进 PTY，带对的 machineId / sessionId', () => {
    mount();
    const input = host.querySelector('input[type="text"]');
    expect(input).toBeTruthy();          // 抽成共用组件后输入框必须还在
    input.value = 'echo 你好';
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(inputs()).toEqual([
      { type: 'terminal_input', machineId: 'macmini', sessionId: 's-1', data: b64('echo 你好') },
      { type: 'terminal_input', machineId: 'macmini', sessionId: 's-1', data: b64('\r') },
    ]);
  });

  test('工具条的 ⏎ 也走整行发送（ref 接线没断）', () => {
    mount();
    const input = host.querySelector('input[type="text"]');
    input.value = 'ls';
    const enter = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '⏎');
    expect(enter).toBeTruthy();
    act(() => { enter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(inputs().map(m => m.data)).toEqual([b64('ls'), b64('\r')]);
    expect(input.value).toBe('');
  });

  test('「继续」按钮发的是「继续」+ 回车', () => {
    mount();
    const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '继续');
    act(() => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(inputs().map(m => m.data)).toEqual([b64('继续\r')]);
  });

  test('^C / Esc / 方向键仍然各发各的字节', () => {
    mount();
    const byText = (t) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === t);
    for (const [text, seq] of [['^C', '\x03'], ['Esc', '\x1b'], ['↑', '\x1b[A']]) {
      act(() => { byText(text).dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      expect(inputs().at(-1).data).toBe(b64(seq));
    }
  });
});

describe('桌面版终端的输出链路', () => {
  test('ws 上来的 pty_data 被解码并写进终端', async () => {
    mount();
    expect(host.querySelector('.xterm')).toBeTruthy();   // xterm 真的挂上来了
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'pty_data', sessionId: 's-1', data: b64('hello-from-pty') }),
      }));
    });
    // 写入是按帧合批的，等一帧再断言（这正是合批生效的证据）
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    expect(host.textContent).toContain('hello-from-pty');
  });

  test('别的会话的 pty_data 不写进这个终端', async () => {
    mount();
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'pty_data', sessionId: 'other', data: b64('NOT-MINE') }),
      }));
    });
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    expect(host.textContent).not.toContain('NOT-MINE');
  });
});

// ── 回到最新输出 ──
//
// 用户的原话是「它自动滑动到最顶端了，然后我没法直接到最底部」。滚上去之后 tmux 停在
// copy-mode，那份内容在 alternate screen —— **浏览器这边怎么滚都没用**，必须让开发机侧
// 退出 copy-mode。所以这个按钮的价值全在「那条 ws 消息确实发出去了」上。
describe('回到最新输出', () => {
  const bottomButton = () =>
    Array.from(host.querySelectorAll('button')).find(b => b.textContent.includes('最新'));

  test('点「最新」发出 scroll_to_bottom，带对的 machineId / sessionId', () => {
    mount();
    const btn = bottomButton();
    expect(btn).toBeTruthy();
    act(() => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

    expect(ws.sent.filter(m => m.type === 'scroll_to_bottom')).toEqual([
      { type: 'scroll_to_bottom', machineId: 'macmini', sessionId: 's-1' },
    ]);
  });

  test('走的是控制通路，不是往 PTY 里敲字节', () => {
    mount();
    act(() => { bottomButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    // 关键：不能用「发个 q / Esc 退出 copy-mode」来实现 —— 不在 copy-mode 时
    // 那个字节会被直接敲进正在跑的程序（比如把 q 打进正在改论文的编辑器）。
    expect(ws.sent.filter(m => m.type === 'terminal_input')).toEqual([]);
  });

  test('同时把 xterm 自己的视口也拉到底（非 tmux 的那部分内容归它管）', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const orig = Terminal.prototype.scrollToBottom;
    let calls = 0;
    Terminal.prototype.scrollToBottom = function (...args) { calls += 1; return orig.apply(this, args); };
    try {
      mount();
      act(() => { bottomButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      expect(calls).toBeGreaterThan(0);
    } finally {
      Terminal.prototype.scrollToBottom = orig;
    }
  });

  test('ws 断开时不炸，只是这一次没发出去', () => {
    mount();
    ws.readyState = 3;                 // CLOSED
    expect(() => {
      act(() => { bottomButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    }).not.toThrow();
    expect(ws.sent.filter(m => m.type === 'scroll_to_bottom')).toEqual([]);
  });
});

// 斜杠命令被抽到 src/slash-commands.js 与手机版共用了。抽取是等价替换，
// 但**接线错了不会报错，只会静默变哑** —— 这两条守住桌面版这一侧的行为没变。
// 「点了没反应」是这个项目栽过两次的那一类（09-22 手机复制、07-13 桌面复制）：
// 浏览器拒绝了剪贴板，而代码既不提示也不留出口。桌面版的「粘贴」按钮原来是
// alert + 空 catch —— 弹窗阻塞整页，被拒时一点动静没有。
describe('粘贴按钮在读不到剪贴板时要有出口', () => {
  const byText = (t) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === t);
  let realClipboard;

  beforeEach(() => { realClipboard = navigator.clipboard; });
  afterEach(() => {
    if (realClipboard === undefined) delete navigator.clipboard;
    else Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true });
  });

  const setClipboard = (value) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

  test('浏览器根本没有 clipboard API（HTTP 页面）→ 行内提示告诉用户改用 Cmd+V，不弹 alert', () => {
    const alerts = [];
    const realAlert = window.alert;
    window.alert = (m) => alerts.push(m);
    try {
      setClipboard(undefined);
      mount();
      act(() => { byText('粘贴').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      expect(alerts).toEqual([]);
      expect(host.textContent).toMatch(/Cmd\+V/);
    } finally {
      window.alert = realAlert;
    }
  });

  test('clipboard 存在但被当场拒绝 → 同样给提示（原来是空 catch，什么都不发生）', async () => {
    setClipboard({ readText: () => Promise.reject(new Error('NotAllowedError')) });
    mount();
    act(() => { byText('粘贴').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toMatch(/不让网页读剪贴板/);
  });

  test('读到内容 → 敲进 PTY 并回一条已粘贴', async () => {
    setClipboard({ readText: () => Promise.resolve('echo hi') });
    mount();
    act(() => { byText('粘贴').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(inputs().map(m => m.data)).toEqual([b64('echo hi')]);
    expect(host.textContent).toContain('已粘贴到终端');
  });
});

describe('斜杠命令', () => {
  const byText = (t) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === t);

  test('/clear 先发 Ctrl+C 打断，再发命令 + 回车', async () => {
    mount();
    act(() => { byText('/clear').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    // 打断是同步发的；命令排在定时器里（不先打断，这行字会被补全菜单吃掉）
    expect(inputs().map(m => m.data)).toEqual([b64('\x03')]);

    await act(async () => { await new Promise(r => setTimeout(r, 120)); });
    expect(inputs().map(m => m.data)).toEqual([b64('\x03'), b64('/clear\r')]);
  });

  test('/compact 同理', async () => {
    mount();
    act(() => { byText('/compact').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });
    expect(inputs().map(m => m.data)).toEqual([b64('\x03'), b64('/compact\r')]);
  });
});

describe('网页字体晚到的自愈', () => {
  // 界面用的 JetBrains Mono 是网页字体，异步到达；xterm 只在 open() 量一次格子。
  // 冷缓存下（新登录）字体稳定晚于终端创建，于是「按回退字体量出来的格子」去排
  // JetBrains Mono 的字 —— 浏览器实测 14px 下行高 16px → 18px，面板里塞进 50 行
  // 却只放得下 44 行，底部被切掉，整块终端比例不对且不会自愈。
  // 这里验的是接线：字体加载完成的事件，确实让终端重新量了一次。
  // （格子的真实数值是 jsdom 量不出来的，所以断言落在「xterm 真的重新量过」上：
  //   xterm 把 fontFamily 写进自己注入的样式表，值变了说明重量真的发生了。）

  /** 真 EventTarget 当 FontFaceSet，并记下谁还挂着监听 —— 卸载漏摘是真事故。 */
  function installFakeFontFaceSet() {
    const fonts = new window.EventTarget();
    fonts.listeners = 0;
    const add = fonts.addEventListener.bind(fonts);
    const remove = fonts.removeEventListener.bind(fonts);
    fonts.addEventListener = (...a) => { fonts.listeners++; add(...a); };
    fonts.removeEventListener = (...a) => { fonts.listeners--; remove(...a); };
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    return fonts;
  }

  const fontFamilyInUse = () => Array.from(host.querySelectorAll('style'))
    .map(s => s.textContent)
    .join('\n')
    .match(/font-family:[^;}]*/)?.[0];

  afterEach(() => {
    Object.defineProperty(document, 'fonts', { value: undefined, configurable: true });
  });

  test('字体加载完成 → 终端重新量一次字符尺寸', () => {
    const fonts = installFakeFontFaceSet();
    mount();
    expect(fonts.listeners).toBe(1);               // 面板挂上了就该在听
    const before = fontFamilyInUse();
    expect(before).toBeTruthy();                   // 前提：xterm 真把字体写进了样式表
    act(() => { fonts.dispatchEvent(new window.Event('loadingdone')); });
    expect(fontFamilyInUse()).not.toBe(before);    // 值变了 = CharSizeService 重量过
  });

  test('面板卸载后字体事件不再惊动终端（监听摘干净，否则会去 resize 别人的 tmux）', () => {
    const fonts = installFakeFontFaceSet();
    mount();
    act(() => root.unmount());
    expect(fonts.listeners).toBe(0);
    expect(() => fonts.dispatchEvent(new window.Event('loadingdone'))).not.toThrow();
    root = createRoot(host);                       // afterEach 还要 unmount 一次
  });
});
