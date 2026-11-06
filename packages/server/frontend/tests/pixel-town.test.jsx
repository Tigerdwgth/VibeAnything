// 像素小镇整条链路的真渲染测试：PixelView（集成层）→ window message → PixelApp（真的
// useExtensionMessages + OfficeState + 名牌 + 画布）。不替换任何内部模块 —— 只补 jsdom
// 缺的浏览器能力（2d context、布局尺寸），断言的是用户看得到的东西：名牌写什么、头顶挂
// 什么气泡、小人坐在哪、会话列表怎么排、点了以后打开谁的终端。
//
// 覆盖：
//  · 2026-11-06 审查发现的几处缺陷（编辑过的布局被冲掉、等权限状态不消、机器全掉线
//    再回来卡 Loading、消散中的旧小人霸占座位、名牌的「在跑」冻在第一次）；
//  · 新功能：工作中 / 干完了等你 / 等你确认 / 空闲 四个阶段的名牌与气泡，
//    点名牌和会话列表打开终端并清掉「干完了」的标记。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeContext, DARK } from '../src/theme.js';
import { CharacterState } from '../src/pixel-office/types.js';

const { default: PixelView, __resetPixelViewStateForTest } = await import('../src/PixelView.jsx');
const { __officeStateForTest, __resetOfficeStateForTest } = await import('../src/PixelApp.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── 浏览器能力补齐 ────────────────────────────────────────────
// jsdom 的布局尺寸恒为 0；小镇是「按画布尺寸生成楼层」的，必须给一块有大小的画布
const STAGE = { width: 1200, height: 800 };
const origRect = Element.prototype.getBoundingClientRect;
const origGetContext = HTMLCanvasElement.prototype.getContext;

/** 什么都接、什么都不画的 2d context（画布引擎每帧要调几十种绘图方法） */
function noopContext(canvas) {
  const store = { canvas };
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'measureText') return () => ({ width: 0 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

let host;
let root;
let focused;

const session = (over = {}) => ({
  machineId: 'macmini', sessionId: 'a', cwd: '/work/alpha', tool: 'claude', isRunning: false, ...over,
});

function render(activeSessions, machines = [{ machineId: 'macmini' }], activeSession = null) {
  act(() => {
    root.render(
      <ThemeContext.Provider value={DARK}>
        <PixelView
          activeSessions={activeSessions}
          machines={machines}
          foldersByMachine={{}}
          activeSession={activeSession}
          onFocusSession={(sessionId, machineId) => focused.push([sessionId, machineId])}
        />
      </ThemeContext.Provider>,
    );
  });
}

/** 切走视图再切回来（Dashboard 里像素视图是条件渲染的，每次切回都是重新挂载） */
function remount() {
  act(() => root.unmount());
  host.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
}

const hook = (detail) => act(() => {
  window.dispatchEvent(new window.CustomEvent('hook:event', { detail }));
});
const os = () => __officeStateForTest();
const labelOf = (text) => [...host.querySelectorAll('[data-phase]')]
  .find((el) => el.style.zIndex === '44' && el.textContent.includes(text));
const rosterItems = () => [...host.querySelectorAll('[data-testid="pixel-roster-item"]')];
/** 名牌上那个人在画布上的角色（名牌按 id 渲染，React key 拿不到，这里按顺序对回去） */
const characterOf = (text) => {
  const labels = [...host.querySelectorAll('[data-phase]')].filter((el) => el.style.zIndex === '44');
  const idx = labels.indexOf(labelOf(text));
  const ids = [...os().characters.keys()].filter((id) => os().characters.get(id).matrixEffect !== 'despawn');
  return os().characters.get(ids[idx]);
};

beforeEach(() => {
  __resetPixelViewStateForTest();
  __resetOfficeStateForTest();
  localStorage.clear();
  focused = [];
  Element.prototype.getBoundingClientRect = function () {
    return { ...STAGE, left: 0, top: 0, right: STAGE.width, bottom: STAGE.height, x: 0, y: 0, toJSON() { return this; } };
  };
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? noopContext(this) : null; };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = origRect;
  HTMLCanvasElement.prototype.getContext = origGetContext;
});

describe('缺陷回归', () => {
  test('编辑模式里保存的布局，切走视图再切回来还在（挂载那一轮不能按 0×0 的画布重新生成楼层）', () => {
    render([session()]);
    const saved = JSON.parse(localStorage.getItem('vibeanything:pixelLayout:macmini'));
    const edited = { ...saved, furniture: [...saved.furniture, { uid: 'my-plant', type: 'plant', col: 1, row: 1 }] };
    act(() => {
      window.dispatchEvent(new window.CustomEvent('pixel:postMessage', { detail: { type: 'saveLayout', layout: edited } }));
    });
    remount();
    render([session()]);
    const after = JSON.parse(localStorage.getItem('vibeanything:pixelLayout:macmini'));
    expect(after.furniture.some((f) => f.uid === 'my-plant')).toBe(true);
    expect(os().getLayout().furniture.some((f) => f.uid === 'my-plant')).toBe(true);
  });

  test('会话开跑 → 名牌从「空闲」变成「工作中」（原来名牌的在跑状态冻在第一次下发的值上）', () => {
    render([session({ sessionId: 'dev' })]);
    expect(labelOf('dev').dataset.phase).toBe('idle');
    render([session({ sessionId: 'dev', isRunning: true })]);
    expect(labelOf('dev').dataset.phase).toBe('working');
    expect(labelOf('dev').textContent).toContain('claude 工作中');
  });

  test('等权限之后继续干活 → 不再挂着「等你确认」，权限气泡收掉', () => {
    render([session({ sessionId: 'dev', isRunning: true })]);
    hook({ hookEvent: 'PermissionRequest', machineId: 'macmini', tmuxSession: 'dev' });
    expect(labelOf('dev').dataset.phase).toBe('permission');
    expect(characterOf('dev').bubbleType).toBe('permission');
    // daemon 在 PermissionRequest 时把灯熄了；用户点了同意，下一个工具调用又把灯点亮
    render([session({ sessionId: 'dev', isRunning: false })]);
    expect(labelOf('dev').dataset.phase).toBe('permission');
    render([session({ sessionId: 'dev', isRunning: true })]);
    expect(labelOf('dev').dataset.phase).toBe('working');
    expect(labelOf('dev').textContent).not.toContain('等你确认');
    expect(characterOf('dev').bubbleType).toBe(null);
  });

  test('机器全部掉线再回来（relay 重启）→ 重新灌人和地图，不卡在 Loading...', () => {
    render([session({ sessionId: 'dev' })]);
    expect(labelOf('dev')).toBeTruthy();
    render([], []);
    expect(host.textContent).toContain('还没有开发机连上来');
    render([session({ sessionId: 'dev' })]);
    expect(host.textContent).not.toContain('Loading...');
    expect(labelOf('dev')).toBeTruthy();
  });

  test('切机器标签页 → 新机器的人都坐在楼层计划给的座位上，消散的旧人不占座', () => {
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(session({ machineId: 'aaa', sessionId: `x${i}` }));
    for (let i = 0; i < 4; i++) sessions.push(session({ machineId: 'bbb', sessionId: `y${i}` }));
    render(sessions, [{ machineId: 'aaa' }, { machineId: 'bbb' }]);
    const tab = [...host.querySelectorAll('[data-testid="pixel-machine-tabs"] button')]
      .find((b) => b.textContent.includes('bbb'));
    act(() => tab.click());
    // 计划座位：每间房的工位按 0n/0w/0e/0s… 依次分，第一张桌子坐满
    const live = [...os().characters.values()].filter((c) => c.matrixEffect !== 'despawn');
    expect(live).toHaveLength(4);
    expect(live.map((c) => c.seatId.split(':').pop()).sort()).toEqual(['0e', '0n', '0s', '0w']);
    os().update(1);   // 消散动画结束，旧人被删
    const assigned = [...os().seats.values()].filter((s) => s.assigned).length;
    expect(assigned).toBe(os().characters.size);
  });
});

describe('一眼看出谁在干、谁干完了在等你', () => {
  test('干完一轮 → 名牌标「完成 · 等你」，头顶挂常驻的完成气泡（不会两秒后自己消失）', () => {
    render([session({ sessionId: 'dev', isRunning: true })]);
    render([session({ sessionId: 'dev', isRunning: false })]);
    const label = labelOf('dev');
    expect(label.dataset.phase).toBe('done');
    expect(label.textContent).toContain('✓ 完成 · 等你');
    const ch = characterOf('dev');
    expect(ch.bubbleType).toBe('waiting');
    os().update(10);
    expect(ch.bubbleType).toBe('waiting');
  });

  test('一开始就闲着的会话不算「干完了」（没人在等你去看它）', () => {
    render([session({ sessionId: 'dev' })]);
    expect(labelOf('dev').dataset.phase).toBe('idle');
    expect(characterOf('dev').bubbleType).toBe(null);
  });

  test('「干完了」的标记熬得过切走视图再切回来', () => {
    render([session({ sessionId: 'dev', isRunning: true })]);
    render([session({ sessionId: 'dev', isRunning: false })]);
    remount();
    render([session({ sessionId: 'dev', isRunning: false })]);
    expect(labelOf('dev').dataset.phase).toBe('done');
    expect(characterOf('dev').bubbleType).toBe('waiting');
  });

  test('点名牌 → 打开那个会话的终端，并清掉「干完了」的标记', () => {
    render([session({ machineId: 'gpuserver1', sessionId: 'dev', isRunning: true })], [{ machineId: 'gpuserver1' }]);
    render([session({ machineId: 'gpuserver1', sessionId: 'dev', isRunning: false })], [{ machineId: 'gpuserver1' }]);
    const chip = labelOf('dev').querySelector('button');
    act(() => chip.click());
    expect(focused).toEqual([['dev', 'gpuserver1']]);
    expect(labelOf('dev').dataset.phase).toBe('idle');
    expect(characterOf('dev').bubbleType).toBe(null);
  });

  test('从侧栏打开了它的终端（小镇卸载期间），回到小镇时「干完了」的标记已清', () => {
    const sessions = (running) => [
      session({ sessionId: 'dev', isRunning: running }),
      session({ sessionId: 'other', isRunning: running }),
    ];
    render(sessions(true));
    render(sessions(false));
    remount();   // 切去看终端：小镇卸载
    render(sessions(false), undefined, { machineId: 'macmini', sessionId: 'dev' });
    expect(labelOf('dev').dataset.phase).toBe('idle');
    expect(characterOf('dev').bubbleType).toBe(null);
    expect(labelOf('other').dataset.phase).toBe('done');   // 没看过的照旧提醒
    expect(focused).toEqual([]);                            // 只清标记，不再跳一次终端
  });

  test('等你确认：PermissionRequest 挂琥珀色的权限气泡、名牌标「! 等你确认」', () => {
    render([session({ sessionId: 'dev', isRunning: true })]);
    hook({ hookEvent: 'PermissionRequest', machineId: 'macmini', tmuxSession: 'dev' });
    expect(labelOf('dev').textContent).toContain('! 等你确认');
    expect(characterOf('dev').bubbleType).toBe('permission');
  });

  test('Notification 带了 permission_prompt 子类型时以它为准；idle_prompt 不算', () => {
    render([session({ sessionId: 'p', isRunning: true }), session({ sessionId: 'q', isRunning: true })]);
    hook({ hookEvent: 'Notification', notificationType: 'idle_prompt', machineId: 'macmini', tmuxSession: 'q' });
    expect(labelOf('q').dataset.phase).toBe('working');
    hook({ hookEvent: 'Notification', notificationType: 'permission_prompt', machineId: 'macmini', tmuxSession: 'p' });
    expect(labelOf('p').dataset.phase).toBe('permission');
  });

  test('空闲的人坐回工位歇着时不播打字帧（定格坐姿），工作中的才打字', () => {
    render([session({ sessionId: 'busy', isRunning: true }), session({ sessionId: 'lazy' })]);
    const busy = characterOf('busy');
    const lazy = characterOf('lazy');
    // 都让他们坐在工位上
    lazy.state = CharacterState.TYPE;
    lazy.seatTimer = 100;
    const busyFrames = new Set();
    const lazyFrames = new Set();
    for (let i = 0; i < 20; i++) {
      os().update(0.1);
      busyFrames.add(busy.frame);
      lazyFrames.add(lazy.frame);
    }
    expect(busy.state).toBe(CharacterState.TYPE);
    expect(busyFrames.size).toBe(2);
    expect([...lazyFrames]).toEqual([0]);
  });
});

describe('会话列表', () => {
  test('按「等你确认 / 干完了 → 工作中 → 空闲」排，列出所有机器的会话', () => {
    const before = [
      session({ sessionId: 'idle-1' }),
      session({ sessionId: 'run-1', isRunning: true }),
      session({ sessionId: 'done-1', isRunning: true }),
      session({ sessionId: 'perm-1', isRunning: true }),
      session({ machineId: 'gpuserver1', sessionId: 'far-run', isRunning: true }),
    ];
    render(before, [{ machineId: 'macmini' }, { machineId: 'gpuserver1' }]);
    hook({ hookEvent: 'PermissionRequest', machineId: 'macmini', tmuxSession: 'perm-1' });
    // daemon 在 PermissionRequest 时也把灯熄了，所以 perm-1 这一轮也是 isRunning=false
    render(before.map((s) => (['done-1', 'perm-1'].includes(s.sessionId) ? { ...s, isRunning: false } : s)),
      [{ machineId: 'macmini' }, { machineId: 'gpuserver1' }]);
    const rows = rosterItems();
    expect(rows.map((r) => r.dataset.phase)).toEqual(['permission', 'done', 'working', 'working', 'idle']);
    expect(rows[0].textContent).toContain('perm-1');
    expect(rows[1].textContent).toContain('done-1');
    expect(rows.some((r) => r.textContent.includes('far-run') && r.textContent.includes('gpuserver1'))).toBe(true);
  });

  test('点列表里的一行 → 打开那个会话的终端（别的机器上的也行），干完了的标记清掉', () => {
    const machines = [{ machineId: 'macmini' }, { machineId: 'gpuserver1' }];
    render([session({ sessionId: 'here' }), session({ machineId: 'gpuserver1', sessionId: 'far', isRunning: true })], machines);
    render([session({ sessionId: 'here' }), session({ machineId: 'gpuserver1', sessionId: 'far', isRunning: false })], machines);
    const far = rosterItems().find((r) => r.textContent.includes('far'));
    expect(far.dataset.phase).toBe('done');
    act(() => far.click());
    expect(focused).toEqual([['far', 'gpuserver1']]);
    expect(rosterItems().find((r) => r.textContent.includes('far')).dataset.phase).toBe('idle');
  });

  test('可以收起，收起后还看得到有几个在等你；选择记在 localStorage', () => {
    render([session({ sessionId: 'dev', isRunning: true })]);
    render([session({ sessionId: 'dev', isRunning: false })]);
    const toggle = () => host.querySelector('[data-testid="pixel-roster-toggle"]');
    expect(host.querySelector('[data-testid="pixel-roster"]').dataset.open).toBe('true');
    act(() => toggle().click());
    const roster = host.querySelector('[data-testid="pixel-roster"]');
    expect(roster.dataset.open).toBe('false');
    expect(rosterItems()).toHaveLength(0);
    expect(roster.querySelector('[title="1 个等你"]')).toBeTruthy();
    expect(localStorage.getItem('vibeanything:pixelRosterOpen')).toBe('0');
    remount();
    render([session({ sessionId: 'dev' })]);
    expect(host.querySelector('[data-testid="pixel-roster"]').dataset.open).toBe('false');
  });
});
