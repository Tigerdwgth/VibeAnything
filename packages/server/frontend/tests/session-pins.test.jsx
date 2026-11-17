// 会话置顶：切分规则（src/session-pins.js）+ 桌面侧边栏的置顶组 + 手机会话列表的置顶组。
// 组件是真组件、事件真派发；断言的是「置顶组里有谁、点下去调了什么、带了什么参数」。
// relay 那一侧（按人存、跨连接同步、鉴权）在 packages/server/tests/session-pins.test.js。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SessionTabs from '../src/SessionTabs.jsx';
import MobileSessionList from '../src/mobile/MobileSessionList.jsx';
import { ThemeContext, DARK } from '../src/theme.js';
import { isPinned, splitPinned, applyPin } from '../src/session-pins.js';
import { sessionKey } from '../src/session-key.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let calls;

// 三台开发机。macmini 与 gpu 上各有一个叫 main 的会话（手动 tmux new -s main 就会这样）。
const SESSIONS = [
  { machineId: 'macmini', sessionId: 'web', cwd: '/mac/web', isRunning: true },
  { machineId: 'macmini', sessionId: 'main', cwd: '/mac/main', isRunning: false, pinnedAt: 3000 },
  { machineId: 'gpu.tailnet.ts.net', sessionId: 'train', cwd: '/gpu/train', isRunning: true, pinnedAt: 1000 },
  { machineId: 'gpu.tailnet.ts.net', sessionId: 'main', cwd: '/gpu/main', isRunning: false, pinnedAt: 2000 },
  { machineId: 'derper', sessionId: 'relay', cwd: '/srv/relay', isRunning: false },
];

/** 同一批会话，一个都没置顶时的样子（relay 对没置顶的会话不带 pinnedAt 字段）。 */
const UNPINNED = SESSIONS.map((s) => {
  const { pinnedAt: _dropped, ...plain } = s;
  return plain;
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const click = (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const rightClick = (el) => act(() => {
  el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
});

// ── 切分规则 ────────────────────────────────────────────────

describe('切分规则', () => {
  test('带 pinnedAt 的是置顶的；置顶组按置顶先后排，其余保持原顺序', () => {
    const { pinned, rest } = splitPinned(SESSIONS);
    expect(pinned.map(s => `${s.machineId}/${s.sessionId}`)).toEqual([
      'gpu.tailnet.ts.net/train', 'gpu.tailnet.ts.net/main', 'macmini/main',
    ]);
    expect(rest.map(s => s.sessionId)).toEqual(['web', 'relay']);
  });

  test('没有置顶的会话时置顶组为空，列表原样', () => {
    expect(splitPinned(UNPINNED)).toEqual({ pinned: [], rest: UNPINNED });
    expect(splitPinned(undefined)).toEqual({ pinned: [], rest: [] });
  });

  test('本地先改：置顶只动 machineId 与 sessionId 都对上的那一条（另一台机器的同名会话不动）', () => {
    const next = applyPin(SESSIONS, 'macmini', 'web', true, 9000);
    expect(next.find(s => s.sessionId === 'web').pinnedAt).toBe(9000);
    expect(next.filter(isPinned)).toHaveLength(4);
    const unpinned = applyPin(SESSIONS, 'macmini', 'main', false);
    expect(isPinned(unpinned.find(s => s.machineId === 'macmini' && s.sessionId === 'main'))).toBe(false);
    expect(isPinned(unpinned.find(s => s.machineId !== 'macmini' && s.sessionId === 'main'))).toBe(true);
    // 取消后字段是没了，不是留个 null —— 与 relay 下发的形状一致
    expect('pinnedAt' in unpinned.find(s => s.machineId === 'macmini' && s.sessionId === 'main')).toBe(false);
  });

  test('本地先改：已经是那个状态、或列表里没有这个会话时原样返回（不触发重渲染）', () => {
    expect(applyPin(SESSIONS, 'macmini', 'main', true)).toBe(SESSIONS);
    expect(applyPin(SESSIONS, 'macmini', 'web', false)).toBe(SESSIONS);
    expect(applyPin(SESSIONS, 'nowhere', 'web', true)).toBe(SESSIONS);
  });
});

// ── 桌面 ────────────────────────────────────────────────────

function renderDesktop(overrides = {}) {
  act(() => root.render(
    <ThemeContext.Provider value={DARK}>
      <SessionTabs
        selfUsername="gsj" activeSessions={SESSIONS} historySessions={[]} openTerminals={[]}
        active={null} foldersByMachine={{}}
        onOpen={(...a) => calls.push(['open', ...a])}
        onStop={(...a) => calls.push(['stop', ...a])}
        onPinSession={(...a) => calls.push(['pin', ...a])}
        onRenameSession={(...a) => calls.push(['rename', ...a])}
        {...overrides}
      />
    </ThemeContext.Provider>
  ));
}

const pinnedToggle = () => host.querySelector('button.pinned-toggle');
const pinnedContent = () => document.getElementById(pinnedToggle().getAttribute('aria-controls'));
const machineToggle = (machineId) => [...host.querySelectorAll('button.machine-toggle')].find(b => b.title === machineId);
const machineContent = (machineId) => document.getElementById(machineToggle(machineId).getAttribute('aria-controls'));
const rowsIn = (el) => [...el.querySelectorAll('.sess-item')];
const rowByCwd = (el, cwd) => rowsIn(el).find(r => r.textContent.includes(cwd));
const menuItem = (text) => [...document.querySelectorAll('.va-pop > div')].find(d => d.textContent.includes(text));

describe('桌面：置顶组', () => {
  test('排在所有开发机分组上面，把不同开发机上置顶的会话聚在一起', () => {
    renderDesktop();
    const toggles = [...host.querySelectorAll('button.pinned-toggle, button.machine-toggle')];
    expect(toggles[0]).toBe(pinnedToggle());
    expect(pinnedToggle().textContent).toContain('置顶');
    expect(pinnedToggle().textContent).toContain('3 会话');
    expect(pinnedToggle().textContent).toContain('1 工作中');
    expect(rowsIn(pinnedContent()).map(r => r.querySelector('[title^="/"]').textContent)).toEqual([
      '/gpu/train', '/gpu/main', '/mac/main',
    ]);
  });

  test('每一行标出会话在哪台开发机上（短名），完整机器名放在悬停提示里', () => {
    renderDesktop();
    const badges = rowsIn(pinnedContent()).map(r => r.querySelector('.sess-machine'));
    expect(badges.map(b => b.textContent)).toEqual(['gpu', 'gpu', 'macmini']);
    expect(badges[0].title).toBe('开发机 gpu.tailnet.ts.net');
    // 开发机分组里的行不标机器（组标题就是机器）
    expect(rowByCwd(machineContent('macmini'), '/mac/web').querySelector('.sess-machine')).toBeNull();
  });

  test('置顶的会话不在原来的开发机分组里再出现一次，分组计数也只算剩下的', () => {
    renderDesktop();
    expect(rowsIn(machineContent('macmini')).map(r => r.querySelector('[title^="/"]').textContent)).toEqual(['/mac/web']);
    expect(machineToggle('macmini').textContent).toContain('1 会话');
    // gpu 上的会话全被置顶了：这台机器的分组不再单独出现
    expect(machineToggle('gpu.tailnet.ts.net')).toBeUndefined();
    expect(host.querySelectorAll('.sess-item')).toHaveLength(SESSIONS.length);
  });

  test('没有置顶的会话时不出现置顶组', () => {
    renderDesktop({ activeSessions: UNPINNED });
    expect(pinnedToggle()).toBeNull();
    expect(host.querySelectorAll('button.machine-toggle')).toHaveLength(3);
  });

  test('点置顶组里的一行：按它自己的开发机打开（两台机器上同名的 main 不会开错）', () => {
    renderDesktop();
    click(rowByCwd(pinnedContent(), '/gpu/main'));
    click(rowByCwd(pinnedContent(), '/mac/main'));
    expect(calls.map(c => c.slice(0, 3))).toEqual([
      ['open', 'gpu.tailnet.ts.net', 'main'],
      ['open', 'macmini', 'main'],
    ]);
  });

  test('当前会话在置顶组里时组标题标「当前」，且只高亮那一台机器上的那一行', () => {
    renderDesktop({ active: { machineId: 'macmini', sessionId: 'main' } });
    expect(pinnedToggle().textContent).toContain('当前');
    const accent = rowByCwd(pinnedContent(), '/mac/main').style.borderLeft;
    expect(accent).not.toContain('transparent');
    expect(rowByCwd(pinnedContent(), '/gpu/main').style.borderLeft).toContain('transparent');
  });

  test('右键普通会话 →「置顶」，带对 machineId / sessionId / true', () => {
    renderDesktop();
    rightClick(rowByCwd(machineContent('macmini'), '/mac/web'));
    click(menuItem('置顶'));
    expect(calls).toEqual([['pin', 'macmini', 'web', true]]);
  });

  test('右键置顶组里的会话 →「取消置顶」；菜单里没有只对本机文件夹有意义的「移动到根目录」', () => {
    renderDesktop();
    rightClick(rowByCwd(pinnedContent(), '/gpu/train'));
    expect(menuItem('移动到根目录')).toBeUndefined();
    click(menuItem('取消置顶'));
    expect(calls).toEqual([['pin', 'gpu.tailnet.ts.net', 'train', false]]);
  });

  test('行上的 📌 一点即取消置顶，不会顺带把会话打开', () => {
    renderDesktop();
    click(rowByCwd(pinnedContent(), '/mac/main').querySelector('button[title="取消置顶"]'));
    expect(calls).toEqual([['pin', 'macmini', 'main', false]]);
  });

  test('置顶组里也能改名，改的是那台机器上的那个会话', () => {
    renderDesktop();
    rightClick(rowByCwd(pinnedContent(), '/gpu/main'));
    click(menuItem('重命名'));
    const input = pinnedContent().querySelector('input');
    expect(input).not.toBeNull();
    act(() => {
      input.value = 'gpu-main';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual([['rename', 'gpu.tailnet.ts.net', 'main', 'gpu-main']]);
  });

  test('置顶组可以收起，刷新（重新挂载）后保持', () => {
    renderDesktop();
    click(pinnedToggle());
    expect(pinnedToggle().getAttribute('aria-expanded')).toBe('false');
    expect(rowsIn(pinnedContent())).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    renderDesktop();
    expect(pinnedToggle().getAttribute('aria-expanded')).toBe('false');
    // 收起的只是置顶组，开发机分组照常
    expect(rowsIn(machineContent('macmini'))).toHaveLength(1);
  });

  test('管理员按人分组时：置顶组仍在最上面，置顶的会话不在各人的分组里重复，行上保留归属', () => {
    const owned = [
      { machineId: 'macmini', sessionId: 'mine', cwd: '/admin', owner: 'admin' },
      { machineId: 'macmini', sessionId: 'theirs', cwd: '/carol', owner: 'carol', pinnedAt: 1000 },
      { machineId: 'gpu', sessionId: 'theirs2', cwd: '/carol-gpu', owner: 'carol' },
    ];
    renderDesktop({ selfUsername: 'admin', activeSessions: owned });
    expect(rowsIn(pinnedContent()).map(r => r.querySelector('[title^="/"]').textContent)).toEqual(['/carol']);
    expect(rowByCwd(pinnedContent(), '/carol').textContent).toContain('carol');
    const carolGroup = [...host.querySelectorAll('button.owner-toggle')].find(b => b.textContent.includes('carol'));
    expect(carolGroup.textContent).toContain('1 会话');
    expect(host.querySelectorAll('.sess-item')).toHaveLength(3);
  });
});

// ── 手机 ────────────────────────────────────────────────────

const MACHINES = [
  { machineId: 'macmini', defaultWorkDir: '/Users/gsj', sessionCount: 2 },
  { machineId: 'gpu.tailnet.ts.net', defaultWorkDir: '/home/jdh', sessionCount: 2 },
  { machineId: 'derper', defaultWorkDir: '/root', sessionCount: 1 },
];

/** 与 MobileShell 喂给它的形状一致：置顶的单独给，sessions 只有选中机器上没置顶的。 */
function renderMobile(selectedMachine = 'macmini', overrides = {}) {
  const { pinned, rest } = splitPinned(SESSIONS);
  act(() => root.render(
    <ThemeContext.Provider value={DARK}>
      <MobileSessionList
        machines={MACHINES} selectedMachine={selectedMachine}
        onSelectMachine={(m) => calls.push(['machine', m])}
        sessions={rest.filter(s => s.machineId === selectedMachine)}
        pinnedSessions={pinned}
        openSessionKeys={new Set()} activeSessionKey={null}
        onOpen={(...a) => calls.push(['open', ...a])}
        onCloseTab={(...a) => calls.push(['close', ...a])}
        onStop={(...a) => calls.push(['stop', ...a])}
        onCreate={(...a) => calls.push(['create', ...a])}
        onRenameSession={(...a) => calls.push(['rename', ...a])}
        onPinSession={(...a) => calls.push(['pin', ...a])}
        onMoveSession={(...a) => calls.push(['move', ...a])}
        {...overrides}
      />
    </ThemeContext.Provider>
  ));
}

const mobileRows = () => [...host.querySelectorAll('div')].filter(d => d.style.borderLeft);
const mobileRow = (cwd) => {
  const el = mobileRows().find(d => d.textContent.includes(cwd));
  if (!el) throw new Error(`找不到 cwd 为「${cwd}」的会话行`);
  return el;
};
const mobilePinnedToggle = () => host.querySelector('button[aria-label$="置顶"]');
const sheetItem = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.startsWith(text));

describe('手机：置顶组', () => {
  test('排在列表最上面，聚合所有开发机上置顶的会话，并标出各自在哪台机器', () => {
    renderMobile('macmini');
    expect(mobilePinnedToggle().textContent).toContain('置顶');
    expect(mobilePinnedToggle().textContent).toContain('3');
    expect(mobileRows().map(r => r.textContent.match(/\/[a-z]+\/[a-z]+/)[0])).toEqual([
      '/gpu/train', '/gpu/main', '/mac/main', '/mac/web',
    ]);
    expect(mobileRow('/gpu/train').querySelector('[title="开发机 gpu.tailnet.ts.net"]').textContent).toBe('gpu');
    expect(mobileRow('/mac/web').querySelector('[title^="开发机"]')).toBeNull();
  });

  test('切到另一台开发机，置顶组原样留着，下面换成那台机器的会话', () => {
    renderMobile('derper');
    expect(mobileRows().map(r => r.textContent.match(/\/[a-z]+\/[a-z]+/)[0])).toEqual([
      '/gpu/train', '/gpu/main', '/mac/main', '/srv/relay',
    ]);
  });

  test('点置顶组里另一台机器上的会话：按它自己的机器打开，不是当前选中的那台', () => {
    renderMobile('macmini');
    click(mobileRow('/gpu/main'));
    expect(calls[0].slice(0, 3)).toEqual(['open', 'gpu.tailnet.ts.net', 'main']);
  });

  test('会话 ⋯ →「置顶」，带对 machineId / sessionId / true，面板随即收起', () => {
    renderMobile('macmini');
    click(mobileRow('/mac/web').querySelector('button[aria-label="会话操作"]'));
    click(sheetItem('置顶'));
    expect(calls).toEqual([['pin', 'macmini', 'web', true]]);
    expect(sheetItem('重命名')).toBeUndefined();
  });

  test('置顶的会话 ⋯ →「取消置顶」；面板里没有「移动到文件夹」（手头只有当前机器的文件夹树）', () => {
    renderMobile('macmini');
    click(mobileRow('/gpu/train').querySelector('button[aria-label="会话操作"]'));
    expect(sheetItem('移动到文件夹')).toBeUndefined();
    expect(sheetItem('重命名')).toBeTruthy();
    click(sheetItem('取消置顶'));
    expect(calls).toEqual([['pin', 'gpu.tailnet.ts.net', 'train', false]]);
  });

  test('置顶组可以收起：行真的从列表里消失，里面有在跑的会话时留一个灯', () => {
    renderMobile('macmini');
    expect(mobilePinnedToggle().querySelectorAll('span[style*="border-radius: 50%"]')).toHaveLength(0);
    click(mobilePinnedToggle());
    expect(mobilePinnedToggle().getAttribute('aria-expanded')).toBe('false');
    expect(mobileRows().map(r => r.textContent.match(/\/[a-z]+\/[a-z]+/)[0])).toEqual(['/mac/web']);
    expect(mobilePinnedToggle().querySelectorAll('span[style*="border-radius: 50%"]')).toHaveLength(1);
  });

  test('没有置顶的会话时不出现置顶组', () => {
    renderMobile('macmini', { pinnedSessions: [] });
    expect(mobilePinnedToggle()).toBeNull();
  });

  test('这台机器的会话全被置顶了：不说「这台开发机上没有运行中的会话」', () => {
    renderMobile('gpu.tailnet.ts.net');
    expect(host.textContent).not.toContain('没有运行中的会话');
    renderMobile('derper', { sessions: [] });
    expect(host.textContent).toContain('没有运行中的会话');
  });

  test('新建会话的目录快捷选项里，这台机器上被置顶的会话的目录也在', () => {
    renderMobile('macmini');
    click([...host.querySelectorAll('button')].find(b => b.textContent === '＋ 新建'));
    const chips = [...host.querySelectorAll('button')].map(b => b.textContent);
    expect(chips).toContain('/mac/web');
    expect(chips).toContain('/mac/main');
    expect(chips).not.toContain('/gpu/train');
  });

  test('已打开 / 当前会话的标记在置顶组里照常（按 machineId + sessionId 认）', () => {
    renderMobile('macmini', {
      openSessionKeys: new Set([sessionKey('macmini', 'main')]),
      activeSessionKey: sessionKey('macmini', 'main'),
    });
    expect(mobileRow('/mac/main').querySelector('button[aria-label="关闭标签"]')).not.toBeNull();
    expect(mobileRow('/gpu/main').querySelector('button[aria-label="关闭标签"]')).toBeNull();
  });
});
