// 手机版终端的接线回归：挂真 MobileTerminal（含真 xterm），用真 EventTarget 当 ws，
// 派发真事件，断言手机上那几条唯一的入口确实通着。
//
// 这些东西在手机上没有替代路径：输入框是唯一能打字的地方，＋图片是唯一能把相册里的图
// 送进开发机的地方，⌨直连是唯一能逐键操作 TUI 的地方 —— 断一条就是功能消失，
// 而且断了不报错。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MobileTerminal from '../src/mobile/MobileTerminal.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakeWs() {
  const ws = new window.EventTarget();
  ws.readyState = 1;               // WebSocket.OPEN
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  return ws;
}

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const decode = (data) => new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0)));

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

function mount(props = {}) {
  act(() => {
    root.render(
      <MobileTerminal
        machineId="macmini" sessionId="s-1" ws={ws}
        command={['claude']} cwd="/work" visible
        {...props}
      />
    );
  });
}

const inputs = () => ws.sent.filter(m => m.type === 'terminal_input');
const byText = (t) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === t);
const click = (t) => act(() => { byText(t).dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

describe('基本构件都在', () => {
  test('终端 + 输入框 + 工具条 + 相册入口', () => {
    mount();
    expect(host.querySelector('.xterm')).toBeTruthy();
    expect(host.querySelector('input[type="text"]')).toBeTruthy();
    const picker = host.querySelector('input[type="file"]');
    expect(picker).toBeTruthy();
    // 手机上没有拖拽、粘贴也不顺手，相册选图是主入口，必须能直接调起图库
    expect(picker.accept).toBe('image/*');
    expect(picker.multiple).toBe(true);
    for (const label of ['Esc', '⇥', '↑', '↓', '^C', '⏎', '继续']) {
      expect(byText(label), `工具条缺少「${label}」`).toBeTruthy();
    }
  });
});

describe('输入链路', () => {
  test('输入框回车 → 整行 + 回车发进 PTY', () => {
    mount();
    const input = host.querySelector('input[type="text"]');
    input.value = '看看日志';
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(inputs().map(m => decode(m.data))).toEqual(['看看日志', '\r']);
    expect(inputs().every(m => m.machineId === 'macmini' && m.sessionId === 's-1')).toBe(true);
  });

  test('工具条按键各发各的字节', () => {
    mount();
    click('^C');
    click('Esc');
    click('继续');
    expect(inputs().map(m => decode(m.data))).toEqual(['\x03', '\x1b', '继续\r']);
  });

  test('ws 没连上时不发也不炸', () => {
    ws.readyState = 3;              // CLOSED
    mount();
    click('^C');
    expect(inputs()).toEqual([]);
  });
});

describe('输出链路', () => {
  // pty_data 落到屏幕上要过两道异步：createPtyWriteBatcher 的 requestAnimationFrame 合批，
  // 以及 xterm 自己的写入队列（term.write 是异步的，解析完才更新 DOM）。
  // 原来等「一个 rAF + 30ms」是拍脑袋的固定时长，实测 5 次里会挂 1 次 —— 改成轮询到出现为止。
  const SETTLE_MS = 800;
  const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 10)));

  async function waitForText(text) {
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline) {
      if (host.textContent.includes(text)) return true;
      await tick();                                  // eslint-disable-line no-await-in-loop
    }
    return host.textContent.includes(text);
  }

  test('pty_data 解码后写进终端', async () => {
    mount();
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'pty_data', sessionId: 's-1', data: b64('mobile-pty-ok') }),
      }));
    });
    expect(await waitForText('mobile-pty-ok')).toBe(true);
  });

  test('别的会话的输出不串进来', async () => {
    mount();
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'pty_data', sessionId: 'other', data: b64('NOT-MINE') }),
      }));
    });
    // 这条要证的是「永远不出现」，所以不能轮询到出现为止：等满同样的时长再断言没有。
    // 等得比上面那条久，串台的输出再慢也该到了。
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline) await tick();      // eslint-disable-line no-await-in-loop
    expect(host.textContent).not.toContain('NOT-MINE');
  });
});

describe('相册选图 → 上传 → 路径敲进终端', () => {
  test('选中的图片走 upload_file，回执里的路径被敲进终端', async () => {
    mount();
    const picker = host.querySelector('input[type="file"]');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'IMG_0042.PNG', { type: 'image/png' });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    act(() => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });

    // 读文件是异步的（FileReader），等它落地
    await new Promise(r => setTimeout(r, 50));
    const upload = ws.sent.find(m => m.type === 'upload_file');
    expect(upload).toBeTruthy();
    expect(upload.name).toBe('IMG_0042.PNG');
    expect(upload.machineId).toBe('macmini');
    expect(upload.sessionId).toBe('s-1');
    expect(upload.data.length).toBeGreaterThan(0);

    // 开发机落盘后回执带回绝对路径 —— 它必须被当文本敲进终端，claude 才读得到
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'file_uploaded', uploadId: upload.uploadId, path: '/home/gsj/.vibeanything/uploads/20260921/IMG_0042.PNG' }),
      }));
    });
    expect(inputs().map(m => decode(m.data))).toEqual([
      '/home/gsj/.vibeanything/uploads/20260921/IMG_0042.PNG ',
    ]);
  });

  test('别人发起的上传回执不会被当成自己的', () => {
    mount();
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'file_uploaded', uploadId: 'someone-else', path: '/tmp/x.png' }),
      }));
    });
    expect(inputs()).toEqual([]);
  });
});

describe('⌨ 直连模式', () => {
  test('默认压住 xterm 的隐藏 textarea —— 否则它一获焦就弹键盘且收不回来', () => {
    mount();
    const ta = host.querySelector('.xterm-helper-textarea');
    expect(ta).toBeTruthy();
    expect(ta.hasAttribute('readonly')).toBe(true);
    expect(ta.inputMode).toBe('none');
  });

  test('打开直连后 textarea 可输入，再点一次又压回去', () => {
    mount();
    const ta = host.querySelector('.xterm-helper-textarea');
    click('⌨直连');
    expect(ta.hasAttribute('readonly')).toBe(false);
    expect(ta.inputMode).toBe('text');
    click('⌨直连');
    expect(ta.hasAttribute('readonly')).toBe(true);
    expect(ta.inputMode).toBe('none');
  });
});

// ── 滚动手势的归属（2026-09-22 修「滑起来一顿一顿」）────────────────────
//
// 手机上手势归属只在开头判定一次：起步那几个 touchmove 如果没 preventDefault，
// 浏览器就把这次手势认成自己的页面滚动/回弹，之后再 preventDefault 也没用。
// 而起步慢的时候 dy 恰恰都小于死区 —— 这两条撞在一起就是发涩的来源。
describe('滚动手势必须被终端独占', () => {
  /** 造一个真 TouchEvent 形状的事件（jsdom 没有 Touch/TouchEvent 构造器）。 */
  function touch(el, type, points) {
    const list = points.map(p => ({ clientX: p.x, clientY: p.y }));
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : list });
    Object.defineProperty(ev, 'changedTouches', { value: list });
    el.dispatchEvent(ev);
    return ev;
  }

  const termEl = () => host.querySelector('.xterm').parentElement;

  test('位移小于死区的 touchmove 也要 preventDefault', () => {
    mount();
    const el = termEl();
    touch(el, 'touchstart', [{ x: 100, y: 300 }]);
    // 1px —— 比 SCROLL_DEAD_ZONE_PX(2) 小，正是慢起步的头几帧
    const ev = touch(el, 'touchmove', [{ x: 100, y: 301 }]);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('正常滑动的 touchmove 同样 preventDefault', () => {
    mount();
    const el = termEl();
    touch(el, 'touchstart', [{ x: 100, y: 300 }]);
    const ev = touch(el, 'touchmove', [{ x: 100, y: 340 }]);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('终端容器声明 touch-action: none，浏览器不参与手势判定', () => {
    mount();
    // 不写这行浏览器默认 auto，会先花时间判断是不是平移/缩放再把事件交给我们
    expect(termEl().style.touchAction).toBe('none');
  });
});

// ── 复制（2026-09-22）──────────────────────────────────────────
//
// 手机上复制只有两条入口：长按整行松手、工具条的「复制」。两条都走 execCommand
// （HTTP 页面没有 navigator.clipboard），而浏览器随时可能拒绝。原来拒绝时一声不吭，
// 用户看到的就是「点了没反应」—— 这里锁住「失败必须给出口」。
describe('复制', () => {
  const SETTLE_MS = 800;
  const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 10)));

  async function feed(text) {
    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'pty_data', sessionId: 's-1', data: b64(text) }),
      }));
    });
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline && !host.textContent.includes(text)) await tick(); // eslint-disable-line no-await-in-loop
  }

  const fallbackBox = () => Array.from(host.querySelectorAll('textarea'))
    .find(t => t.getAttribute('aria-label') === '待复制的内容');

  test('复制成功：弹提示，不弹手动面板', async () => {
    document.execCommand = () => true;
    try {
      mount();
      await feed('copy-me-ok');
      click('复制');
      expect(host.textContent).toContain('已复制');
      expect(fallbackBox()).toBeUndefined();
    } finally { delete document.execCommand; }
  });

  test('浏览器拒绝复制：把内容摊出来让用户自己长按拷贝，而不是没反应', async () => {
    document.execCommand = () => false;
    try {
      mount();
      await feed('copy-me-fail');
      click('复制');
      const box = fallbackBox();
      expect(box).toBeTruthy();
      expect(box.value).toContain('copy-me-fail');
      expect(host.textContent).toContain('浏览器挡住了自动复制');
    } finally { delete document.execCommand; }
  });

  test('手动面板允许原生长按选择（终端那两条样式会掐掉 iOS 的选择菜单）', async () => {
    document.execCommand = () => false;
    try {
      mount();
      await feed('copy-me-style');
      click('复制');
      const box = fallbackBox();
      // 终端容器上有 touchAction:none / WebkitTouchCallout:none，会掐掉 iOS 的
      // 长按选择菜单；面板这里必须显式开回来。
      //（-webkit-touch-callout 在 jsdom 里读不回来——它不识别这个属性，
      //  连 style 属性串里都不会出现，所以只断言它旁边这几条能观测的。）
      expect(box.style.userSelect).toBe('text');
      expect(box.style.touchAction).toBe('auto');
      expect(box.readOnly).toBe(true);        // 只读：别在这儿弹出输入法
    } finally { delete document.execCommand; }
  });
});

// ── 粘贴图片只能算一次（2026-09-22 线上 bug：粘一张图传两份、敲进两条路径）──
//
// 根因在 filesFromDataTransfer：items 和 files 两个来源都取，而 item.getAsFile()
// 每次调用都现造新 File，剪贴板图片的 lastModified 取造对象那一刻的时间，
// 于是「按 name|size|lastModified 去重」挡不住。这里从组件这一端把症状钉死。
describe('粘贴图片', () => {
  /** 按真实浏览器的样子造剪贴板：items 与 files 各给一个**不同的** File 对象。 */
  function clipboardWithImage() {
    const make = (lastModified) => new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png',
      { type: 'image/png', lastModified },
    );
    return {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => make(1700000000001), webkitGetAsEntry: () => ({ isDirectory: false }) }],
      files: [make(1700000000007)],
    };
  }

  test('粘一张图只上传一次，终端里只出现一条路径', async () => {
    mount();
    const target = host.querySelector('.xterm').parentElement;
    const ev = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: clipboardWithImage(), configurable: true });
    act(() => { target.dispatchEvent(ev); });

    await new Promise(r => setTimeout(r, 50));
    const uploads = ws.sent.filter(m => m.type === 'upload_file');
    expect(uploads).toHaveLength(1);           // ← 线上是 2

    act(() => {
      ws.dispatchEvent(new window.MessageEvent('message', {
        data: JSON.stringify({ type: 'file_uploaded', uploadId: uploads[0].uploadId, path: '/tmp/up/a.png' }),
      }));
    });
    expect(inputs().map(m => decode(m.data))).toEqual(['/tmp/up/a.png ']);
  });
});

// 「粘贴」是手机上把外部文本送进终端的唯一按钮（相册那个只管文件）。
// 它必然会在 HTTP 页面上被浏览器挡下来 —— 复制那次（2026-09-22）就是栽在「挡下来之后
// 一声不吭」，所以这里的重点是：挡下来时必须有一条用户能走通的路。
describe('粘贴', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

  function stubClipboard(value) {
    Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
  }

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
    else delete window.navigator.clipboard;
  });

  const pastePanel = () => Array.from(host.querySelectorAll('textarea'))
    .find(t => t.getAttribute('aria-label') === '要粘贴到终端的内容');

  test('剪贴板读得到时，内容直接敲进终端', async () => {
    stubClipboard({ readText: async () => 'echo 粘过来的' });
    mount();
    click('粘贴');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(inputs().map(m => decode(m.data))).toEqual(['echo 粘过来的']);
    expect(pastePanel()).toBeFalsy();     // 顺利读到就不该弹面板
  });

  test('HTTP 页面上根本没有 clipboard 接口 → 弹手动粘贴框，而不是静默失败', () => {
    stubClipboard(undefined);
    mount();
    click('粘贴');
    expect(pastePanel()).toBeTruthy();
    expect(host.textContent).toContain('浏览器不让网页读剪贴板');
  });

  test('接口在但被浏览器拒绝 → 同样兜到手动粘贴框', async () => {
    stubClipboard({ readText: async () => { throw new Error('denied'); } });
    mount();
    click('粘贴');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(pastePanel()).toBeTruthy();
  });

  test('手动框里输入后点「发送到终端」，内容真的发出去', async () => {
    stubClipboard(undefined);
    mount();
    click('粘贴');

    const ta = pastePanel();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    act(() => {
      setter.call(ta, 'git status');
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    click('发送到终端');

    expect(inputs().map(m => decode(m.data))).toEqual(['git status']);
    expect(pastePanel()).toBeFalsy();     // 发完面板要收起来
  });

  test('手动框空着时「发送到终端」点不动（别往终端里发个空回车）', () => {
    stubClipboard(undefined);
    mount();
    click('粘贴');
    expect(byText('发送到终端').disabled).toBe(true);
  });

  test('「取消」只关面板，什么都不发', () => {
    stubClipboard(undefined);
    mount();
    click('粘贴');
    click('取消');
    expect(pastePanel()).toBeFalsy();
    expect(inputs()).toEqual([]);
  });

  test('剪贴板是空的：给一句提示，不往终端发空内容', async () => {
    stubClipboard({ readText: async () => '' });
    mount();
    click('粘贴');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(inputs()).toEqual([]);
    expect(host.textContent).toContain('剪贴板是空的');
  });
});

describe('斜杠命令', () => {
  test('/clear 与桌面版同一条通路：先 Ctrl+C，再命令 + 回车', async () => {
    mount();
    click('/clear');
    expect(inputs().map(m => decode(m.data))).toEqual(['\x03']);
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });
    expect(inputs().map(m => decode(m.data))).toEqual(['\x03', '/clear\r']);
  });
});
