// 像素小镇的集成层：把 Dashboard 的会话状态翻译成子系统认的 window message。
//
// 这一层以前没有任何测试，而它恰恰是「画布上的小人和真实会话对不上」的所有来源：
// 标签写的是 Agent #1、每个人永远挂着硬编码的 `Working...`、hook 事件里的 sessionId
// 和会话列表不是一个命名空间却被拿去查 id（于是凭空造出画布上不存在的小人）。
// 这里断言的就是翻译结果本身：发了哪些消息、带了什么参数、什么时候**不**发。
//
// PixelApp 是一整套 canvas 引擎，与本测无关，替掉；被测对象是 PixelView 本体。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeContext, DARK } from '../src/theme.js';

vi.mock('../src/PixelApp', () => ({ default: () => null }));

const { default: PixelView, __resetPixelViewStateForTest } = await import('../src/PixelView.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let messages;      // 捕获到的 window message（子系统就是靠它收消息的）
let focused;

function onMessage(e) { messages.push(e.data); }

const render = (activeSessions, machines, foldersByMachine) => act(() => {
  root.render(
    <ThemeContext.Provider value={DARK}>
      <PixelView
        activeSessions={activeSessions}
        machines={machines}
        foldersByMachine={foldersByMachine}
        onFocusSession={(sessionId, machineId) => focused.push([sessionId, machineId])}
      />
    </ThemeContext.Provider>
  );
});

/** 机器标签页（一台开发机一个） */
const tabs = () => [...host.querySelectorAll('[data-testid="pixel-machine-tabs"] button')];
const tabLabels = () => tabs().map(b => b.textContent);
const clickTab = (text) => act(() => {
  tabs().find(b => b.textContent.includes(text)).click();
});

const typesOf = (t) => messages.filter(m => m?.type === t);
const session = (over = {}) => ({
  machineId: 'macmini', sessionId: 'cc-one', cwd: '/work/alpha', tool: 'claude', isRunning: false, ...over,
});

beforeEach(() => {
  // 集成层的 id 映射是模块级的（画布状态也是模块级的，两边必须同步），
  // 所以每个用例之间要显式重置，否则会互相串
  __resetPixelViewStateForTest();
  localStorage.clear();
  messages = [];
  focused = [];
  window.addEventListener('message', onMessage);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.removeEventListener('message', onMessage);
});

describe('谁是谁：下发真实会话信息', () => {
  test('每个小人都带上会话名、机器短名、目录、工具与在不在跑', () => {
    render([session({ sessionId: 'my-dev', machineId: 'macair.tailnet-example.ts.net', isRunning: true })]);
    const infos = typesOf('agentInfo');
    expect(infos).toHaveLength(1);
    expect(infos[0].info).toEqual({
      label: 'my-dev',                 // 用户自己起的 tmux 名 → 直接当标题（与侧栏同一套规则）
      machine: 'macair',               // 机器名剥掉 DNS 域（与侧栏同一份 machine-name.js）
      cwd: '/work/alpha',
      tool: 'claude',
      running: true,
      offline: false,
    });
  });

  test('自动会话（cc- 前缀）的标题取 cwd 末段，不是没法读的 cc-one', () => {
    render([session()]);
    expect(typesOf('agentInfo')[0].info.label).toBe('alpha');
  });

  test('同一个会话每次都得到同一个色相，不同会话错开 —— 这是「谁是谁」的第一道线索', () => {
    render([session({ sessionId: 'a' }), session({ sessionId: 'b' })]);
    const [existing] = typesOf('existingAgents');
    const hues = Object.values(existing.agentMeta).map(m => m.hueShift);
    expect(hues).toHaveLength(2);
    expect(hues[0]).not.toBe(hues[1]);
    expect(hues.every(h => Number.isInteger(h) && h >= 0 && h < 360)).toBe(true);
  });
});

describe('在干嘛：状态只跟着真实的 isRunning 走', () => {
  test('空闲的会话不会被说成在干活（原来所有人都被硬编码成 Working...）', () => {
    render([session({ isRunning: false })]);
    expect(typesOf('agentToolStart')).toHaveLength(0);
    expect(typesOf('agentStatus').map(m => m.status)).toEqual(['idle']);
    expect(typesOf('agentToolsClear')).toHaveLength(1);
  });

  test('正在跑 → 气泡写明工具与目录', () => {
    render([session({ isRunning: true })]);
    const start = typesOf('agentToolStart');
    expect(start).toHaveLength(1);
    expect(start[0].status).toBe('claude: alpha');
  });

  test('跑完了 → 收气泡 + 置 idle（而不是留着一个永远在干活的小人）', () => {
    render([session({ isRunning: true })]);
    messages.length = 0;
    render([session({ isRunning: false })]);
    expect(typesOf('agentToolsClear')).toHaveLength(1);
    expect(typesOf('agentStatus').map(m => m.status)).toEqual(['idle']);
  });

  test('状态没变就什么都不发 —— 会话列表每 2.5 秒刷一次，重发会不停重建气泡/重放提示音', () => {
    render([session({ isRunning: true })]);
    messages.length = 0;
    render([session({ isRunning: true })]);
    render([session({ isRunning: true })]);
    expect(messages).toEqual([]);
  });

  test('只有目录/名字变了就只补一条 agentInfo，不动状态', () => {
    render([session({ isRunning: true })]);
    messages.length = 0;
    render([session({ isRunning: true, cwd: '/work/beta' })]);
    expect(typesOf('agentInfo')).toHaveLength(1);
    expect(typesOf('agentToolStart')).toHaveLength(0);
  });
});

describe('增删会话', () => {
  test('新增会话 → agentCreated，并带上它的色相', () => {
    render([session({ sessionId: 'a' })]);
    messages.length = 0;
    render([session({ sessionId: 'a' }), session({ sessionId: 'b' })]);
    const created = typesOf('agentCreated');
    expect(created).toHaveLength(1);
    expect(Number.isInteger(created[0].hueShift)).toBe(true);
  });

  test('会话消失 → agentClosed（画布上移除），不留幽灵', () => {
    render([session({ sessionId: 'a' }), session({ sessionId: 'b' })]);
    messages.length = 0;
    render([session({ sessionId: 'a' })]);
    expect(typesOf('agentClosed')).toHaveLength(1);
  });

  test('两台机器上同名 tmux 是两个小人（key 带 machineId，切标签页不会互相顶掉）', () => {
    // 一台机器一个标签页，所以画布上一次只有一台机器的人；
    // 但两边的 key 带着 machineId，各自是独立的小人（id 不同、不会互相覆盖）
    render([
      session({ machineId: 'macmini', sessionId: 'main' }),
      session({ machineId: 'gpuserver1', sessionId: 'main' }),
    ]);
    expect(typesOf('existingAgents')[0].agents).toHaveLength(1);
    const first = typesOf('agentInfo')[0];
    expect(first.info.machine).toBe('gpuserver1');   // 并列时按机器名排，g 在前
    messages.length = 0;
    clickTab('macmini');
    expect(typesOf('agentClosed').map(m => m.id)).toEqual([first.id]);
    const second = typesOf('agentInfo')[0];
    expect(second.info.machine).toBe('macmini');
    expect(second.id).not.toBe(first.id);
  });

  test('改名（sessionId 变了）→ 旧的关掉、新的建出来，不会两个并存', () => {
    render([session({ sessionId: 'old-name' })]);
    messages.length = 0;
    render([session({ sessionId: 'new-name' })]);
    expect(typesOf('agentClosed')).toHaveLength(1);
    expect(typesOf('agentCreated')).toHaveLength(1);
    expect(typesOf('agentInfo')[0].info.label).toBe('new-name');
  });
});

describe('hook 事件不能凭空造小人', () => {
  const hook = (detail) => act(() => {
    window.dispatchEvent(new window.CustomEvent('hook:event', { detail }));
  });

  test('UserPromptSubmit 立刻点亮对应小人（不等 2.5 秒那轮扫描）', () => {
    render([session({ sessionId: 'cc-one', isRunning: false })]);
    messages.length = 0;
    hook({ hookEvent: 'UserPromptSubmit', machineId: 'macmini', sessionId: 'cc-one' });
    expect(typesOf('agentToolStart')).toHaveLength(1);
  });

  test('Stop → 收气泡置 idle；Notification → 等待确认', () => {
    render([session({ sessionId: 'cc-one', isRunning: true })]);
    messages.length = 0;
    hook({ hookEvent: 'Stop', machineId: 'macmini', sessionId: 'cc-one' });
    expect(typesOf('agentStatus').map(m => m.status)).toEqual(['idle']);

    messages.length = 0;
    hook({ hookEvent: 'Notification', machineId: 'macmini', sessionId: 'cc-one' });
    expect(typesOf('agentStatus').map(m => m.status)).toEqual(['waiting']);
  });

  test('hook 里的 sessionId 是 claude 的 UUID（和 tmux 名不是一个命名空间）→ 丢掉，不新建小人', () => {
    render([session({ sessionId: 'cc-one' })]);
    messages.length = 0;
    hook({
      hookEvent: 'Stop', machineId: 'macmini',
      sessionId: '3f2b1a40-dead-4beef-9999-000000000000',
    });
    expect(messages).toEqual([]);
  });

  test('hook 带的是 tmuxSession 时也能认出来', () => {
    render([session({ sessionId: 'my-dev' })]);
    messages.length = 0;
    hook({ hookEvent: 'Stop', machineId: 'macmini', sessionId: 'some-uuid', tmuxSession: 'my-dev' });
    expect(typesOf('agentStatus').map(m => m.status)).toEqual(['idle']);
  });

  test('没有 sessionId 的 hook 事件直接忽略', () => {
    render([session()]);
    messages.length = 0;
    hook({ hookEvent: 'Stop' });
    expect(messages).toEqual([]);
  });
});

describe('点小人跳转', () => {
  test('focusAgent → 把那个会话的 sessionId 与 machineId 一起交回 Dashboard', () => {
    render([session({ machineId: 'gpuserver1', sessionId: 'my-dev' })]);
    const id = typesOf('agentInfo')[0].id;
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'focusAgent', id } }));
    });
    expect(focused).toEqual([['my-dev', 'gpuserver1']]);
  });

  test('点到一个已经不存在的 id（刚关掉）→ 什么都不做，不报错', () => {
    render([session()]);
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'focusAgent', id: 9999 } }));
    });
    expect(focused).toEqual([]);
  });
});

describe('离线会话 / 持久化 / 动作分流', () => {
  test('localStorage 里留着的死标签标成离线，不假装它是活会话', () => {
    render([session({ offline: true })]);
    expect(typesOf('agentInfo')[0].info.offline).toBe(true);
  });

  test('保存布局真的落到 localStorage（原来这条消息没人接，点保存是假的）', () => {
    render([session()]);
    const layout = { cols: 20, rows: 14, furniture: [] };
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'saveLayout', layout } }));
    });
    // 布局按机器分开存：一台机器一个标签页，切回来还得是自己那层楼
    expect(JSON.parse(localStorage.getItem('vibeanything:pixelLayout:macmini'))).toEqual(layout);
  });

  test('座位按会话 key 存，不是按数字 id —— id 刷新页面就重排了，用它存等于没存', () => {
    render([session({ machineId: 'macmini', sessionId: 'my-dev' })]);
    const id = typesOf('agentInfo')[0].id;
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', {
        detail: { type: 'saveAgentSeats', seats: { [id]: { palette: 2, hueShift: 90, seatId: 'seat-7' } } },
      }));
    });
    expect(JSON.parse(localStorage.getItem('vibeanything:pixelSeats'))).toEqual({
      'macmini::my-dev': { palette: 2, hueShift: 90, seatId: 'seat-7' },
    });
  });

  test('下次进这个视图，肤色与色相照旧（座位由小镇结构决定，见下一组）', () => {
    localStorage.setItem('vibeanything:pixelSeats', JSON.stringify({
      'macmini::my-dev': { palette: 2, hueShift: 90, seatId: 'seat-7' },
    }));
    render([session({ machineId: 'macmini', sessionId: 'my-dev' })]);
    const meta = Object.values(typesOf('existingAgents')[0].agentMeta)[0];
    expect(meta.palette).toBe(2);
    expect(meta.hueShift).toBe(90);
    // 存档里那个 seat-7 是上一版的遗留（随机分的），现在座位必须落在
    // 「这台机器的房子 + 这个分类的房间」里，所以不认它
    expect(meta.seatId).not.toBe('seat-7');
    expect(meta.seatId).toContain('macmini|root');
  });

  test('关掉某个小人 → 交给 Dashboard 关那个标签（原来这条消息没人接）', () => {
    const closed = [];
    act(() => {
      root.render(
        <ThemeContext.Provider value={DARK}>
          <PixelView
            activeSessions={[session({ machineId: 'gpuserver1', sessionId: 'my-dev' })]}
            onFocusSession={() => {}}
            onCloseSession={(m, sid) => closed.push([m, sid])}
          />
        </ThemeContext.Provider>
      );
    });
    const id = typesOf('agentInfo')[0].id;
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'closeAgent', id } }));
    });
    expect(closed).toEqual([['gpuserver1', 'my-dev']]);
  });

  test('不认识的动作消息直接忽略，不抛错', () => {
    render([session()]);
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'openSessionsFolder' } }));
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: null }));
    });
    expect(true).toBe(true);
  });
});

describe('机器标签页', () => {
  const lastOf = (t) => typesOf(t)[typesOf(t).length - 1];

  test('每台机器一个标签页，写短名和会话数', () => {
    render([
      session({ machineId: 'macmini', sessionId: 'a' }),
      session({ machineId: 'macmini', sessionId: 'b' }),
      session({ machineId: 'macair.tailnet-example.ts.net', sessionId: 'c' }),
    ]);
    expect(tabLabels()).toEqual(['macair1', 'macmini2']);   // 文本是「短名 + 计数」
  });

  test('选中的标签页记在 localStorage，重新挂载还是那台', () => {
    render([
      session({ machineId: 'macmini', sessionId: 'a' }),
      session({ machineId: 'gpuserver1', sessionId: 'b' }),
    ]);
    clickTab('macmini');
    expect(localStorage.getItem('vibeanything:pixelMachine')).toBe('macmini');

    act(() => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    messages.length = 0;
    render([
      session({ machineId: 'macmini', sessionId: 'a' }),
      session({ machineId: 'gpuserver1', sessionId: 'b' }),
    ]);
    expect(typesOf('agentInfo')[0].info.machine).toBe('macmini');
  });

  test('记住的那台机器没了 → 自动换到会话最多的一台，不是停在一屏空房间', () => {
    localStorage.setItem('vibeanything:pixelMachine', 'gone-machine');
    render([
      session({ machineId: 'macmini', sessionId: 'a' }),
      session({ machineId: 'macmini', sessionId: 'b' }),
      session({ machineId: 'gpuserver1', sessionId: 'c' }),
    ]);
    expect(typesOf('agentInfo').map(m => m.info.machine)).toEqual(['macmini', 'macmini']);
  });

  test('一台机器都没有时不画画布，给一句话 —— 否则子系统永远停在 Loading', () => {
    render([]);
    expect(host.textContent).toContain('还没有开发机连上来');
    expect(typesOf('layoutLoaded')).toHaveLength(0);
  });

  test('切标签页 = 换一层楼：旧机器的人收走，新机器的楼重建', () => {
    render([
      session({ machineId: 'macmini', sessionId: 'a', cwd: '/work/alpha' }),
      session({ machineId: 'gpuserver1', sessionId: 'b', cwd: '/home/jdh' }),
    ]);
    messages.length = 0;
    clickTab('macmini');
    expect(typesOf('agentClosed')).toHaveLength(1);
    expect(typesOf('agentCreated')).toHaveLength(1);
    const rooms = lastOf('layoutLoaded').layout.places.filter(p => p.kind === 'room');
    expect(rooms.map(r => r.label)).toEqual(['未分类']);
  });
});

describe('楼层：一台开发机一个标签页，一个分类文件夹一间房', () => {
  const lastOf = (t) => typesOf(t)[typesOf(t).length - 1];

  const folders = { macmini: [
    { id: 'alpha', name: '研究', parentId: null },
    { id: 'beta', name: '实验', parentId: 'alpha' },
  ] };
  test('按分类分配座位，cwd 相同也各回各房；空分类也显示', () => {
    render([
      session({ sessionId: 'a', folderId: 'alpha' }),
      session({ sessionId: 'b', folderId: 'beta' }),
      session({ sessionId: 'c', folderId: 'alpha', cwd: '/another/path' }),
    ], undefined, { macmini: [...folders.macmini, { id: 'empty', name: '空房' }] });
    const seats = Object.values(lastOf('seatPlan').plan);
    expect(seats.filter(s => s.includes('macmini|folder:alpha:'))).toHaveLength(2);
    expect(seats.filter(s => s.includes('macmini|folder:beta:'))).toHaveLength(1);
    expect(lastOf('layoutLoaded').layout.places.map(r => r.label).sort()).toEqual(['研究', '研究 / 实验', '空房'].sort());
  });
  test('没有分类的空机器显示未分类，不使用默认启动路径', () => {
    render([], [{ machineId: 'macmini', defaultWorkDir: '/physical/path' }]);
    expect(lastOf('layoutLoaded').layout.places.map(r => r.label)).toEqual(['未分类']);
  });
  test('仅改变真实启动路径不重建房间、不换座位', () => {
    render([session({ sessionId: 'a', folderId: 'alpha' })], undefined, folders);
    messages.length = 0;
    render([session({ sessionId: 'a', folderId: 'alpha', cwd: '/different' })], undefined, folders);
    expect(typesOf('layoutLoaded')).toHaveLength(0);
    expect(typesOf('seatPlan')).toHaveLength(0);
  });
  test('仅更新分类树：新增空房、重命名父房、删除空房立即生效', () => {
    const members = [session({ folderId: 'beta' })];
    render(members, undefined, folders);
    messages.length = 0;
    const added = { macmini: [...folders.macmini, { id: 'empty', name: '空房' }] };
    render(members, undefined, added);
    expect(lastOf('layoutLoaded').layout.places.map(r => r.label)).toContain('空房');
    render(members, undefined, { macmini: added.macmini.map(f => f.id === 'alpha' ? { ...f, name: '开发' } : f) });
    expect(lastOf('layoutLoaded').layout.places.map(r => r.label)).toContain('开发 / 实验');
    render(members, undefined, folders);
    expect(lastOf('layoutLoaded').layout.places.map(r => r.label)).not.toContain('空房');
  });
  test('移动会话到已有分类时走到新房，cwd 不变', () => {
    const members = [
      session({ sessionId: 'a', folderId: 'alpha' }),
      session({ sessionId: 'keep', folderId: 'alpha' }),
      session({ sessionId: 'b', folderId: 'beta' }),
    ];
    render(members, undefined, folders);
    const id = typesOf('agentInfo').find(m => m.info.label === 'a').id;
    messages.length = 0;
    render(members.map(s => s.sessionId === 'a' ? { ...s, folderId: 'beta' } : s), undefined, folders);
    expect(typesOf('layoutLoaded')).toHaveLength(0);
    expect(lastOf('seatPlan').walk).toBe(true);
    expect(lastOf('seatPlan').plan[id]).toContain('folder:beta:');
  });
  test('分类数据晚于会话到达时，从未分类重新安置到正确房间', () => {
    const members = [session({ folderId: 'beta' })];
    render(members);
    expect(Object.values(lastOf('seatPlan').plan)[0]).toContain('|root:');
    render(members, undefined, folders);
    expect(Object.values(lastOf('seatPlan').plan)[0]).toContain('|folder:beta:');
  });

  test('座位没变就不发 seatPlan（每 2.5 秒刷一轮，重发会让人反复起立落座）', () => {
    render([session({ sessionId: 'a' })]);
    messages.length = 0;
    render([session({ sessionId: 'a' })]);
    expect(typesOf('seatPlan')).toHaveLength(0);
  });

  test('切走视图再回来必须重发 layoutLoaded —— 不然 PixelApp 永远卡在 Loading', () => {
    render([session({ sessionId: 'a' })]);
    act(() => root.unmount());
    // 画布（模块级 officeState）还在，但 PixelApp 的 React 状态归零了
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    messages.length = 0;
    render([session({ sessionId: 'a' })]);
    expect(typesOf('layoutLoaded')).toHaveLength(1);
    expect(typesOf('existingAgents')).toHaveLength(1);
  });

  test('导入布局会连签名一起顶掉，不会下一轮就被自动生成的小镇覆盖', () => {
    render([session({ sessionId: 'a' })]);
    const imported = { version: 1, cols: 8, rows: 8, tiles: [], furniture: [] };
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', {
        detail: { type: 'importLayout' },
      }));
    });
    // importLayout 走的是选文件对话框，这里直接验签名存档这一步的效果：
    // 手动按导入后的状态写入，再渲染一轮，地图不应被重建
    const sig = localStorage.getItem('vibeanything:pixelLayoutSig:macmini');
    expect(sig).toBeTruthy();
    localStorage.setItem('vibeanything:pixelLayout:macmini', JSON.stringify(imported));
    localStorage.setItem('vibeanything:pixelLayoutSig:macmini', sig);
    messages.length = 0;
    render([session({ sessionId: 'a' })]);
    expect(typesOf('layoutLoaded')).toHaveLength(0);
  });
});
