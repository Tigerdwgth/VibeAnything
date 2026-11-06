// 桌面版「会话认得准」的端到端回归：App → Dashboard → SessionTabs / FileBrowser / TerminalPanel
// 全是真组件，事件真派发。替身只有宿主 API：WebSocket 构造器（jsdom 的会真去连网）、
// fetch、window.confirm，以及 getComputedStyle 的百分比尺寸（jsdom 没有布局，见下）。
//
// 锁住 2026-11-06 复现的几类错配：
//  · sessionId 就是 tmux 名，两台机器上重名很常见 —— 只按 sessionId 认会话，输入会发去另一台机器；
//  · 改名后标签不跟着换，重连时按旧名 open_terminal，开发机会新建一个同名幽灵会话；
//  · file_content / dir_entries 不核对是不是本页请求的那台机器、那个路径；
//  · 机器下线后它的会话一直挂在列表里；
//  · 历史「▶ 新建」借用了历史会话的 UUID，而不是起一个新会话。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App.jsx';
import { sessionLightTitle } from '../src/session-light.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket extends window.EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(raw) { this.sent.push(JSON.parse(raw)); }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }

  /** 服务端推一条消息：Dashboard 用 onmessage，终端面板 / 目录树用 addEventListener，两路都送到。 */
  emit(msg) {
    const ev = new window.MessageEvent('message', { data: JSON.stringify(msg) });
    this.onmessage?.(ev);
    this.dispatchEvent(ev);
  }

  /** 连接建立：Dashboard 用 onopen，终端面板等 open 事件再开 PTY。 */
  open() {
    this.onopen?.();
    this.dispatchEvent(new window.Event('open'));
  }
}

const decode = (data) => new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let host;
let root;
let origWebSocket;
let origConfirm;
let origGetComputedStyle;
let origOffset;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  localStorage.setItem('token', 'tok');
  FakeWebSocket.instances = [];
  origWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  origConfirm = window.confirm;
  window.confirm = () => true;
  // jsdom 没有布局：offsetWidth 恒为 0，getComputedStyle 原样吐回 '100%'。终端面板
  // 「量不到真实尺寸就不开 PTY」，这里给容器一个桌面窗口该有的像素尺寸，open_terminal 才发得出去。
  origOffset = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  };
  // 只给 xterm 外面的元素（终端容器及其祖先）尺寸：xterm 内部量字宽字高的元素要保持 jsdom 原样，
  // 它退回 setup-jsdom 补的 canvas 测量（8x17 一格），否则格子会被量成整个窗口那么大
  const layoutSize = (el, px) => (el.closest('.xterm') ? 0 : px);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return layoutSize(this, 800); } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return layoutSize(this, 600); } });
  origGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = (el, pseudo) => {
    const cs = origGetComputedStyle.call(window, el, pseudo);
    return new Proxy(cs, {
      get(target, prop) {
        if (prop === 'getPropertyValue') {
          return (name) => {
            const v = target.getPropertyValue(name);
            if (/%$/.test(v) && (name === 'width' || name === 'height')) return name === 'width' ? '800px' : '600px';
            return v;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.WebSocket = origWebSocket;
  window.WebSocket = origWebSocket;
  window.confirm = origConfirm;
  window.getComputedStyle = origGetComputedStyle;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origOffset.w);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffset.h);
});

const ws = () => FakeWebSocket.instances.at(-1);

async function boot() {
  await act(async () => { root.render(<App />); });
  await act(async () => { ws().open(); });
}

/** 两台机器，各有一个名叫 main 的 tmux 会话（手动 `tmux new -s main` 就是这样）。 */
async function feedTwoMachines() {
  await act(async () => {
    ws().emit({ type: 'machine_list', machines: [{ machineId: 'mA', defaultWorkDir: '/w' }, { machineId: 'mB', defaultWorkDir: '/w' }] });
    ws().emit({ type: 'active_sessions', machineId: 'mA', sessions: [{ sessionId: 'main', cwd: '/a', tool: 'bash' }] });
    ws().emit({ type: 'active_sessions', machineId: 'mB', sessions: [{ sessionId: 'main', cwd: '/b', tool: 'bash' }] });
  });
}

const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};
/** 会话列表里 cwd 为 cwd 的那一行 */
const item = (cwd) => {
  const el = Array.from(host.querySelectorAll('.sess-item')).find(d => d.textContent.includes(cwd));
  if (!el) throw new Error(`找不到 cwd 为「${cwd}」的会话行`);
  return el;
};
const tabBtn = (label) => Array.from(host.querySelectorAll('.tab-btn')).find(b => b.textContent.startsWith(label));
const sent = (type) => ws().sent.filter(m => m.type === type);
/** 没有被 display:none 藏起来的那个终端输入框 */
function visibleComposer() {
  return Array.from(host.querySelectorAll('textarea[aria-label="终端输入框"]')).find((ta) => {
    for (let el = ta; el; el = el.parentElement) if (el.style?.display === 'none') return false;
    return true;
  });
}
async function typeAndEnter(text) {
  const input = visibleComposer();
  input.value = text;
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

describe('两台机器上的同名会话', () => {
  test('先开 A 的 main 再开 B 的 main：两个终端各自挂着，输入发给 B', async () => {
    await boot();
    await feedTwoMachines();
    await click(item('/a'));
    await click(item('/b'));

    expect(host.querySelectorAll('textarea[aria-label="终端输入框"]')).toHaveLength(2);
    await act(async () => { await sleep(150); });
    const opens = sent('open_terminal').map(m => `${m.machineId}:${m.sessionId}`);
    expect(opens).toEqual(expect.arrayContaining(['mA:main', 'mB:main']));

    await typeAndEnter('whoami');
    const inputs = sent('terminal_input');
    expect(inputs.map(m => [m.machineId, m.sessionId, decode(m.data)])).toEqual([
      ['mB', 'main', 'whoami'],
      ['mB', 'main', '\r'],
    ]);
  });

  test('停止 B 的 main 只关 B 的标签，A 的标签和列表项都还在', async () => {
    await boot();
    await feedTwoMachines();
    await click(item('/a'));
    await click(item('/b'));
    await click(item('/b').querySelector('button[title="停止此 session"]'));

    expect(sent('stop_terminal')).toEqual([{ type: 'stop_terminal', machineId: 'mB', sessionId: 'main' }]);
    const open = JSON.parse(localStorage.getItem('openTerminals'));
    expect(open.map(t => `${t.machineId}:${t.sessionId}`)).toEqual(['mA:main']);
    expect(item('/a')).toBeTruthy();
    expect(() => item('/b')).toThrow();
  });

  test('B 的 hook 事件只点亮 B 的状态灯', async () => {
    await boot();
    await feedTwoMachines();
    await act(async () => {
      ws().emit({ type: 'hook_event', machineId: 'mB', sessionId: 'main', hookEvent: 'UserPromptSubmit', hookState: 'running' });
    });
    const light = (cwd) => item(cwd).querySelector('span[title]').getAttribute('title');
    expect(light('/b')).toBe(sessionLightTitle(true));
    expect(light('/a')).toBe(sessionLightTitle(false));
  });
});

describe('会话改名（session_renamed）', () => {
  test('开着的标签换成新名；别的机器上的同名标签不动；重连后按新名开 PTY', async () => {
    await boot();
    await act(async () => {
      ws().emit({ type: 'machine_list', machines: [{ machineId: 'mA' }, { machineId: 'mB' }] });
      ws().emit({ type: 'active_sessions', machineId: 'mA', sessions: [{ sessionId: 'old', cwd: '/a', tool: 'bash' }] });
      ws().emit({ type: 'active_sessions', machineId: 'mB', sessions: [{ sessionId: 'old', cwd: '/b', tool: 'bash' }] });
    });
    await click(item('/b'));
    await click(item('/a'));                       // 当前是 A 的 old
    await act(async () => {
      ws().emit({ type: 'session_renamed', machineId: 'mA', oldSessionId: 'old', newSessionId: 'new' });
      ws().emit({ type: 'active_sessions', machineId: 'mA', sessions: [{ sessionId: 'new', cwd: '/a', tool: 'bash' }] });
    });

    const open = JSON.parse(localStorage.getItem('openTerminals'));
    expect(open.map(t => `${t.machineId}:${t.sessionId}`)).toEqual(['mB:old', 'mA:new']);
    await typeAndEnter('ls');                      // 当前标签跟着换了名，输入发往新名
    expect(sent('terminal_input').map(m => `${m.machineId}:${m.sessionId}`)).toEqual(['mA:new', 'mA:new']);

    // 断线重连：新连接上只能按新名开，旧名一开开发机就会新建一个同名会话
    const first = ws();
    await act(async () => { first.close(); });
    await act(async () => { await sleep(1100); });
    expect(ws()).not.toBe(first);
    await act(async () => { ws().open(); });
    await act(async () => { await sleep(150); });
    const reopened = sent('open_terminal').map(m => `${m.machineId}:${m.sessionId}`);
    expect(reopened).toContain('mA:new');
    expect(reopened).not.toContain('mA:old');
  });
});

describe('文件预览与目录树只认本页的请求', () => {
  async function openFilesTab() {
    await boot();
    await act(async () => {
      ws().emit({ type: 'machine_list', machines: [{ machineId: 'mA', defaultWorkDir: '/w' }] });
    });
    await click(tabBtn('目录'));
    expect(sent('list_dir')).toEqual([{ type: 'list_dir', machineId: 'mA', path: '/w' }]);
  }
  const ENTRIES = [{ name: 'README.md', path: '/w/README.md', type: 'file' }];
  const previewShown = () => Array.from(host.querySelectorAll('button')).some(b => b.textContent.includes('预览'));

  test('别的机器列同一路径的 dir_entries 不进本机的目录树', async () => {
    await openFilesTab();
    await act(async () => {
      ws().emit({ type: 'dir_entries', machineId: 'mOther', path: '/w', entries: [{ name: 'other.md', path: '/w/other.md', type: 'file' }] });
    });
    expect(host.textContent).not.toContain('other.md');
    await act(async () => { ws().emit({ type: 'dir_entries', machineId: 'mA', path: '/w', entries: ENTRIES }); });
    expect(host.textContent).toContain('README.md');
  });

  test('没请求过的 file_content 不切走界面；本页点的那个文件才进预览', async () => {
    await openFilesTab();
    await act(async () => {
      ws().emit({ type: 'file_content', machineId: 'mOther', path: '/x/secret.md', content: '# 别人的' });
    });
    expect(previewShown()).toBe(false);

    await act(async () => { ws().emit({ type: 'dir_entries', machineId: 'mA', path: '/w', entries: ENTRIES }); });
    const md = Array.from(host.querySelectorAll('span')).find(s => s.textContent === 'README.md');
    await click(md);
    expect(sent('read_file')).toEqual([{ type: 'read_file', machineId: 'mA', path: '/w/README.md' }]);

    // 同一路径但来自别的机器：不是本页要的那份
    await act(async () => { ws().emit({ type: 'file_content', machineId: 'mOther', path: '/w/README.md', content: '# 错的' }); });
    expect(previewShown()).toBe(false);

    await act(async () => { ws().emit({ type: 'file_content', machineId: 'mA', path: '/w/README.md', content: '# 对的' }); });
    expect(previewShown()).toBe(true);
  });
});

describe('机器下线', () => {
  test('machine_list 里没有了的机器，它的会话从列表摘掉', async () => {
    await boot();
    await feedTwoMachines();
    await act(async () => {
      ws().emit({ type: 'machine_list', machines: [{ machineId: 'mA', defaultWorkDir: '/w' }] });
    });
    expect(item('/a')).toBeTruthy();
    expect(() => item('/b')).toThrow();
  });
});

describe('历史会话的「▶ 新建」', () => {
  test('起一个新的 sessionId，不借用历史会话的 UUID；「↩ 恢复」才用它', async () => {
    await boot();
    const uuid = '0a1b2c3d-1111-2222-3333-444455556666';
    await act(async () => {
      ws().emit({ type: 'machine_list', machines: [{ machineId: 'mA', defaultWorkDir: '/w' }] });
      ws().emit({ type: 'session_history', machineId: 'mA', sessions: [{ sessionId: uuid, cwd: '/w/proj', summary: '旧对话' }] });
    });
    await click(tabBtn('历史'));
    const btn = (t) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === t);
    await click(btn('▶ 新建'));
    await act(async () => { await sleep(150); });
    const [created] = sent('open_terminal');
    expect(created.machineId).toBe('mA');
    expect(created.sessionId).toMatch(/^new-codex-\d+$/);
    expect(created.command).toEqual(['codex']);
    expect(created.cwd).toBe('/w/proj');

    await click(tabBtn('历史'));
    await click(btn('↩ 恢复'));
    await act(async () => { await sleep(150); });
    const resumed = sent('open_terminal').at(-1);
    expect(resumed.sessionId).toBe(uuid);
    expect(resumed.command).toEqual(['claude', '--resume', uuid]);
  });
});
