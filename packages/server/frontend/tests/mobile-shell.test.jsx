// 手机版主界面的端到端接线：relay 推来的会话 → 列表 → 打开终端 → 切换 → 关闭 → 新建。
//
// 唯一的替身是 WebSocket 构造器（jsdom 的那个会真去连网络，测试里不可用）——
// 它是宿主 API，替的不是被测对象：useRelay / MobileShell / MobileSessionList /
// MobileTerminal 全是真组件，事件也都是真派发。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MobileShell from '../src/mobile/MobileShell.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 按 WebSocket 的契约造一个可驱动的替身：既支持 onX 赋值，也支持 addEventListener。 */
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

  /** 服务端推一条消息：onmessage 与 addEventListener 两路都要送到。 */
  emit(msg) {
    const ev = new window.MessageEvent('message', { data: JSON.stringify(msg) });
    this.onmessage?.(ev);
    this.dispatchEvent(ev);
  }
}

let host;
let root;
let origWebSocket;
let authFailed = 0;
let freshToken = null;   // onAuthFailed（续期）resolve 的新票；null = 续期没换成

const SESSIONS = [
  { sessionId: 'cc-one', cwd: '/work/alpha', isRunning: true, mtime: new Date().toISOString() },
  { sessionId: 'cc-two', cwd: '/work/beta', isRunning: false, mtime: new Date().toISOString() },
];

function ws() { return FakeWebSocket.instances[0]; }

function mount() {
  act(() => {
    root.render(
      <ThemeContext.Provider value={DARK}>
        <MobileShell token="tok" onAuthFailed={async () => { authFailed += 1; return freshToken; }} isDark onToggleTheme={() => {}} />
      </ThemeContext.Provider>
    );
  });
}

/** 让 relay 把「一台在线机器 + 两个会话」推下来，这是进任何界面的前置。 */
function feedSessions(sessions = SESSIONS) {
  act(() => { ws().onopen?.(); });
  act(() => {
    ws().emit({ type: 'machine_list', machines: [{ machineId: 'macmini', defaultWorkDir: '/work' }] });
    ws().emit({ type: 'active_sessions', machineId: 'macmini', sessions });
  });
}

const buttons = () => Array.from(host.querySelectorAll('button'));
const byText = (t) => buttons().find(b => b.textContent === t);
const byLabel = (l) => host.querySelector(`button[aria-label="${l}"]`);
const click = (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const rowByCwd = (cwd) => {
  const el = Array.from(host.querySelectorAll('div')).find(d => d.style.borderLeft && d.textContent.includes(cwd));
  if (!el) throw new Error(`找不到 cwd 为「${cwd}」的会话行`);
  return el;
};
const terminals = () => Array.from(host.querySelectorAll('.xterm'));

/** 每个终端面板的根 div —— 可见性（display: flex / none）切在它身上。 */
function terminalPanels() {
  return terminals().map((x) => {
    let el = x;
    while (el && !(el.style && (el.style.display === 'flex' || el.style.display === 'none'))) el = el.parentElement;
    return el;
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  authFailed = 0;
  freshToken = null;
  localStorage.clear();
  FakeWebSocket.instances = [];
  origWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.WebSocket = origWebSocket;
  window.WebSocket = origWebSocket;
});

describe('连接', () => {
  test('带着 token 连 /ws，并按偏好带上 ownOnly', () => {
    mount();
    expect(ws()).toBeTruthy();
    expect(ws().url).toContain('/ws?token=tok');
    expect(ws().url).toMatch(/ownOnly=[01]/);
  });

  test('relay 判 token 失效（4001）→ 交给续期逻辑，不立刻重连', () => {
    mount();
    act(() => { ws().onclose?.({ code: 4001, reason: 'Unauthorized' }); });
    expect(authFailed).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('多机合并', () => {
  test('两台机器各推一条 active_sessions，谁的会话都不会被另一条冲掉', () => {
    mount();
    feedSessions();                       // macmini 两个会话
    act(() => {
      ws().emit({
        type: 'machine_list',
        machines: [{ machineId: 'macmini', defaultWorkDir: '/work' }, { machineId: 'gpuserver1', defaultWorkDir: '/home/jdh' }],
      });
      ws().emit({ type: 'active_sessions', machineId: 'gpuserver1', sessions: [{ sessionId: 'g-1', cwd: '/home/jdh/x' }] });
    });
    // 机器胶囊上的数量是从**全部** activeSessions 算的：整表替换会把 macmini 清成 0
    expect(byText('macmini2')).toBeTruthy();
    expect(byText('gpuserver11')).toBeTruthy();
  });
});

describe('会话列表 → 打开终端', () => {
  test('一个终端都没开时，列表就是首页', () => {
    mount();
    feedSessions();
    expect(terminals()).toHaveLength(0);
    expect(host.textContent).toContain('/work/alpha');
    expect(host.textContent).toContain('/work/beta');
  });

  test('点一个会话 → 终端挂出来，列表让位', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    expect(terminals()).toHaveLength(1);
    expect(host.querySelector('input[type="text"]')).toBeTruthy();   // 输入框跟着出来
  });

  test('顶栏标题跟着当前会话走', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    // cc- 前缀是自动会话，标题取 cwd 末段
    expect(host.textContent).toContain('alpha');
  });

  test('打开的会话记进 localStorage，刷新还在', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    const saved = JSON.parse(localStorage.getItem('mobileOpenTerminals'));
    expect(saved.map(t => t.sessionId)).toEqual(['cc-one']);
    expect(saved[0].cwd).toBe('/work/alpha');
    expect(localStorage.getItem('mobileActiveSession')).toBe('cc-one');
  });
});

describe('抽屉与切换会话', () => {
  test('有终端时列表收进抽屉，点 ☰ 才出来', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    expect(host.textContent).not.toContain('/work/beta');   // 抽屉是关着的
    click(byLabel('会话列表'));
    expect(host.textContent).toContain('/work/beta');
  });

  test('从抽屉里点另一个会话 → 两个终端都挂着，只有新的那个可见', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    click(byLabel('会话列表'));
    click(rowByCwd('/work/beta'));
    expect(terminals()).toHaveLength(2);       // 旧终端保持挂载，xterm 内容不丢
    const visible = terminalPanels().filter(el => el.style.display !== 'none');
    expect(visible).toHaveLength(1);           // 但同一时刻只有一个露面
    expect(localStorage.getItem('mobileActiveSession')).toBe('cc-two');
  });
});

describe('关闭会话', () => {
  test('关掉当前会话 → 接力给剩下的那个，不留白屏', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    click(byLabel('会话列表'));
    click(rowByCwd('/work/beta'));           // 当前是 cc-two
    click(byLabel('会话列表'));
    click(rowByCwd('/work/beta').querySelector('button[aria-label="关闭标签"]'));
    expect(localStorage.getItem('mobileActiveSession')).toBe('cc-one');
    expect(terminals()).toHaveLength(1);
  });

  test('关掉最后一个 → 回到列表首页', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    click(byLabel('会话列表'));
    click(rowByCwd('/work/alpha').querySelector('button[aria-label="关闭标签"]'));
    expect(terminals()).toHaveLength(0);
    expect(host.textContent).toContain('/work/beta');       // 列表又铺满了
    expect(JSON.parse(localStorage.getItem('mobileOpenTerminals'))).toEqual([]);
  });

  test('relay 判归属被拒（pty_error）时自动关掉那个会话，不刷屏弹窗', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    expect(terminals()).toHaveLength(1);
    act(() => {
      ws().emit({ type: 'pty_error', action: 'open_terminal', machineId: 'macmini', sessionId: 'cc-one', error: 'denied' });
    });
    expect(terminals()).toHaveLength(0);
  });
});

describe('新建会话', () => {
  test('选 CLI + 目录 → 生成会话并直接进终端，目录被记住', () => {
    mount();
    feedSessions([]);
    click(byText('＋ 新建'));
    click(byText('bash'));
    const dir = host.querySelector('input[placeholder="/home/you/project"]');
    expect(dir.value).toBe('/work');                 // 预填机器的默认工作目录
    click(byText('在这里启动'));

    expect(terminals()).toHaveLength(1);
    const saved = JSON.parse(localStorage.getItem('mobileOpenTerminals'));
    expect(saved).toHaveLength(1);
    expect(saved[0].command).toEqual(['bash']);
    expect(saved[0].cwd).toBe('/work');
    expect(saved[0].sessionId).toMatch(/^new-bash-\d+$/);
    expect(localStorage.getItem('lastDir:macmini')).toBe('/work');
  });
});

describe('断线提示', () => {
  test('ws 没就绪时给一条明确提示，别让人以为终端卡死', () => {
    mount();
    expect(host.textContent).toContain('连接中断，正在重连…');
    act(() => { ws().onopen?.(); });
    expect(host.textContent).not.toContain('连接中断，正在重连…');
  });
});

// ── 文件夹（2026-09-22）────────────────────────────────────────
// 分组数据和会话一样是「按机器分区」的：每条 folders 消息带一台机器的全量树。
// 整表替换会把别的机器的文件夹清空 —— 和 active_sessions 踩过的是同一个坑。
describe('文件夹', () => {
  test('folders 按 machineId 分区，收到第二台不清空第一台', () => {
    mount();
    act(() => {
      ws().emit({
        type: 'machine_list',
        machines: [{ machineId: 'macmini', defaultWorkDir: '/work' }, { machineId: 'gpuserver1', defaultWorkDir: '/home/jdh' }],
      });
      ws().emit({ type: 'active_sessions', machineId: 'macmini', sessions: SESSIONS });
      ws().emit({ type: 'folders', machineId: 'macmini', folders: [{ id: 'f1', name: 'Mac 分组', parentId: null }] });
      ws().emit({ type: 'folders', machineId: 'gpuserver1', folders: [{ id: 'f2', name: 'GPU 分组', parentId: null }] });
    });
    // 当前选中 macmini：看得到自己的文件夹，看不到另一台的
    expect(host.querySelector('div[aria-label="文件夹 Mac 分组"]')).toBeTruthy();
    expect(host.querySelector('div[aria-label="文件夹 GPU 分组"]')).toBeNull();
  });

  test('移动会话真的发出 move_session，参数带机器与目标文件夹', () => {
    mount();
    feedSessions();
    act(() => {
      ws().emit({ type: 'folders', machineId: 'macmini', folders: [{ id: 'f1', name: '归档', parentId: null }] });
    });
    const menu = Array.from(host.querySelectorAll('button[aria-label="会话操作"]'))[0];
    act(() => menu.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const pick = (text) => {
      const b = Array.from(host.querySelectorAll('button')).find(x => x.textContent.includes(text));
      act(() => b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    };
    pick('移动到文件夹');
    pick('归档');

    const sent = ws().sent.filter(m => m.type === 'move_session');
    expect(sent).toHaveLength(1);
    expect(sent[0].machineId).toBe('macmini');
    expect(sent[0].folderId).toBe('f1');
  });

  test('rename_error 也走同一条行内提示（改名撞名时不能静默）', () => {
    mount();
    feedSessions();
    act(() => { ws().emit({ type: 'rename_error', machineId: 'macmini', sessionId: 'cc-one', error: '已存在同名会话: dev' }); });
    expect(host.textContent).toContain('已存在同名会话: dev');
  });

  test('folder_error 走行内提示，不弹系统 alert 挡住半屏', () => {
    const realAlert = window.alert;
    const alerts = [];
    try {
      window.alert = (m) => alerts.push(m);
      mount();
      feedSessions();
      act(() => { ws().emit({ type: 'folder_error', error: '不是你的文件夹' }); });
      expect(host.textContent).toContain('不是你的文件夹');
      expect(alerts).toEqual([]);
    } finally {
      window.alert = realAlert;
    }
  });
});

// ── 会话重命名（2026-09-26）──────────────────────────────────
// sessionId 就是开发机上的 tmux 名：改名会把它换掉，所以「开着的标签」必须跟着换，
// 否则手机一切后台就重连，那个标签会照旧名发 open_terminal，开发机找不到就新建一个空会话。
describe('会话重命名', () => {
  /** 打开会话的 ⋯ 面板，点里面写着 text 的那一项。 */
  const pick = (text) => {
    const b = Array.from(host.querySelectorAll('button')).find(x => x.textContent.includes(text));
    if (!b) throw new Error(`面板里找不到「${text}」`);
    click(b);
  };
  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };

  test('⋯ → 重命名 → 输入新名 → 发出 rename_session', () => {
    mount();
    feedSessions();
    click(Array.from(host.querySelectorAll('button[aria-label="会话操作"]'))[0]);
    pick('重命名');
    const input = host.querySelector('input');
    expect(input.value).toBe('alpha');                 // 预填当前显示名（cc- 会话取 cwd 末段）
    setInput(input, '告警排查');
    pick('确定');

    const sent = ws().sent.filter(m => m.type === 'rename_session');
    expect(sent).toEqual([{ type: 'rename_session', machineId: 'macmini', sessionId: 'cc-one', newName: '告警排查' }]);
  });

  test('改名成功回推 session_renamed → 开着的标签换成新 sessionId（不是再开一个）', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));                    // 打开 cc-one
    expect(localStorage.getItem('mobileActiveSession')).toBe('cc-one');

    act(() => {
      ws().emit({
        type: 'session_renamed', machineId: 'macmini',
        oldSessionId: 'cc-one', newSessionId: '告警排查',
      });
    });

    const saved = JSON.parse(localStorage.getItem('mobileOpenTerminals'));
    expect(saved.map(t => t.sessionId)).toEqual(['告警排查']);
    expect(saved[0].command).toEqual(['claude', '--resume', '告警排查']);   // 命令里的旧名也换掉
    expect(localStorage.getItem('mobileActiveSession')).toBe('告警排查');
    expect(terminals()).toHaveLength(1);               // 还是一个终端，没有多开
  });

  test('别的机器上同名会话改名，不动本机这个标签', () => {
    mount();
    feedSessions();
    click(rowByCwd('/work/alpha'));
    act(() => {
      ws().emit({
        type: 'session_renamed', machineId: 'gpuserver1',
        oldSessionId: 'cc-one', newSessionId: '别人的',
      });
    });
    expect(JSON.parse(localStorage.getItem('mobileOpenTerminals')).map(t => t.sessionId)).toEqual(['cc-one']);
  });
});
