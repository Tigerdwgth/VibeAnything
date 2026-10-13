// 小人头顶名牌的真 DOM 行为。
//
// 2026-10-10 线上抓 DOM 才发现：跟随逻辑里那句 `node.style.display = ''`（本意是
// 「把藏起来的名牌显示回来」）实际是**删掉这条内联声明**，连 React 写的
// display:flex 一起抹掉。名牌于是变成 display:block，里面三个 span 排成一行：
// 名字和状态并排、6px 的状态灯因为成了 inline 元素宽度为 0 —— 那盏灯整整一版
// 没人见过，名牌还白白宽了一倍，是「十个人挤一间房糊成一坨」的放大器。
// 这里把「显隐不许碰 display」钉死。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentLabels } from '../src/pixel-components/AgentLabels.tsx';
import { OfficeState } from '../src/pixel-office/engine/officeState.js';
import { buildTownSpec, buildFloor } from '../src/pixel-office/layout/townLayout.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessions = [
  { machineId: 'macmini', sessionId: 'a', cwd: '/work/alpha' },
  { machineId: 'macmini', sessionId: 'b', cwd: '/work/alpha' },
];
const SIZE = { width: 1200, height: 800 };

let host; let root; let os; let town;

beforeEach(() => {
  town = buildFloor(buildTownSpec(sessions)[0], { width: 1200, height: 800 });
  os = new OfficeState(town.layout);
  host = document.createElement('div');
  host.getBoundingClientRect = () => ({
    ...SIZE, left: 0, top: 0, right: SIZE.width, bottom: SIZE.height, x: 0, y: 0, toJSON() { return this; },
  });
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const seatOf = (sid) => town.plan.seatOfSession[`macmini::${sid}`];

const info = (label, extra = {}) => ({
  label, machine: 'macmini', cwd: '/work/alpha', tool: 'Bash', running: false, offline: false, ...extra,
});

function render(props = {}) {
  act(() => {
    root.render(
      <AgentLabels
        officeState={os}
        agents={[1, 2]}
        agentStatuses={{}}
        agentInfos={{ 1: info('甲'), 2: info('乙') }}
        containerRef={{ current: host }}
        zoom={2}
        panRef={{ current: { x: 0, y: 0 } }}
        subagentCharacters={[]}
        {...props}
      />
    );
  });
}

const labels = () => [...host.querySelectorAll('div')].filter(d => d.style.zIndex === '44');
const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r())));

describe('名牌的 DOM', () => {
  beforeEach(() => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    os.addAgent(2, 1, 0, seatOf('b'), true);
  });

  test('跟随一帧之后，名牌仍然是 flex 竖排 —— 显隐不许碰 display', async () => {
    render();
    await nextFrame();
    for (const el of labels()) {
      expect(getComputedStyle(el).display).toBe('flex');
      expect(getComputedStyle(el).flexDirection).toBe('column');
    }
  });

  test('状态灯是一个有宽高的块（display 被抹掉时它会塌成 0）', async () => {
    render();
    await nextFrame();
    const dot = labels()[0].querySelector('span');
    expect(dot.style.width).toBe('6px');
    expect(getComputedStyle(dot).width).toBe('6px');
  });

  test('小人没了（会话关掉但 React 还没重渲染）→ 藏起来用 visibility，不动 display', async () => {
    render();
    await nextFrame();
    os.characters.delete(1);
    await nextFrame();
    const el = labels().find(d => d.textContent.includes('甲'));
    expect(el.style.visibility).toBe('hidden');
    expect(getComputedStyle(el).display).toBe('flex');   // 还原时不会因为没了 display 而错版
  });

  test('空闲不写副行（绿灯已经说了），在跑的写清在跑什么工具', async () => {
    render({ agentInfos: { 1: info('甲'), 2: info('乙', { running: true, tool: 'Bash' }) } });
    await nextFrame();
    const 甲 = labels().find(d => d.textContent.includes('甲'));
    const 乙 = labels().find(d => d.textContent.includes('乙'));
    expect(甲.textContent).toBe('甲');
    expect(乙.textContent).toContain('Bash 运行中');
  });

  test('机器名不再每人背一遍（屋顶名牌已经写了），但悬停还查得到', async () => {
    render();
    await nextFrame();
    const el = labels()[0];
    expect(el.textContent).not.toContain('macmini');
    expect(el.querySelector('span[title]').title).toContain('macmini');
  });
});
