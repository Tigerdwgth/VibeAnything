// 房间名牌：这间屋是哪个分类文件夹。
//
// 名牌是整件事「看得出来」的关键 —— 楼层按真实结构生成了，但画布上只有像素墙，
// 不写名字还是不知道谁在哪。另外它和 canvas 必须严格对齐（同一套居中/平移数学），
// 所以这里也验位置：名牌要落在它那间房的第一行里（工位特意从第二行起排）。
// 机器名不在画布上，一台机器一个标签页（见 pixel-view.test.jsx）。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PlaceLabels } from '../src/pixel-components/PlaceLabels.jsx';
import { OfficeState } from '../src/pixel-office/engine/officeState.js';
import { buildTownSpec, buildFloor } from '../src/pixel-office/layout/townLayout.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessions = [
  { machineId: 'macmini', sessionId: 'a', cwd: '/same', folderId: 'alpha' },
  { machineId: 'macmini', sessionId: 'b', cwd: '/same', folderId: 'beta' },
];

let host;
let root;
let os;
let town;

const SIZE = { width: 1200, height: 800 };
/** 画布的设备像素尺寸（dpr=1 的 jsdom 里就是 CSS 尺寸） */
const STAGE = { width: SIZE.width, height: SIZE.height };

beforeEach(() => {
  town = buildFloor(buildTownSpec(sessions, [], { macmini: [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'beta' }] })[0], STAGE);
  os = new OfficeState(town.layout);
  host = document.createElement('div');
  // jsdom 里一切布局尺寸都是 0，名牌的跟随逻辑会直接跳过 —— 给容器一个真实尺寸
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

const render = (props = {}) => act(() => {
  root.render(
    <PlaceLabels
      officeState={os}
      containerRef={{ current: host }}
      zoom={2}
      panRef={{ current: { x: 0, y: 0 } }}
      version={1}
      {...props}
    />
  );
});

const chips = () => [...host.querySelectorAll('div')];
const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r())));

describe('名牌内容', () => {
  test('每间房写分类名称，机器名不出现在画布上（那是标签页的事）', () => {
    render();
    const texts = chips().map(d => d.textContent);
    expect(texts).toContain('alpha');
    expect(texts).toContain('beta');
    expect(texts).not.toContain('macmini');
  });

  test('悬停能看到分类路径', () => {
    render();
    const byText = (t) => chips().find(d => d.textContent === t);
    expect(byText('alpha').title).toBe('alpha');
  });

  test('名牌不会比它标的房间还宽（否则糊到隔壁房间上）', () => {
    render();
    const room = town.plan.rooms.find(r => r.label === 'alpha');
    const chip = chips().find(d => d.textContent === 'alpha');
    const maxWidth = parseFloat(chip.style.maxWidth);
    const dpr = window.devicePixelRatio || 1;
    expect(maxWidth).toBeLessThanOrEqual(room.cols * 16 * 2 / dpr);
  });

  test('编辑模式下压暗但不藏 —— 摆家具时也得知道自己在哪间屋', () => {
    render({ dimmed: true });
    const chip = chips().find(d => d.textContent === 'alpha');
    expect(Number(chip.style.opacity)).toBeLessThan(1);
    expect(chip.style.display).not.toBe('none');
  });
});

describe('跟随相机', () => {
  test('每帧只写 transform（不靠 React 重渲染），位置落在自己那间房的第一行里', async () => {
    render();
    await nextFrame();
    const chip = chips().find(d => d.textContent === 'alpha');
    expect(chip.style.transform).toMatch(/translate\(-?\d+px, -?\d+px\)/);
    const room = town.plan.rooms.find(r => r.label === 'alpha');
    const [, x, y] = chip.style.transform.match(/translate\((-?\d+)px, (-?\d+)px\)/).map(Number);
    const dpr = window.devicePixelRatio || 1;
    const zoom = 2;
    // 与 viewport.ts 同一套算式：地图居中，pan=0
    const offX = Math.floor((SIZE.width * dpr - town.plan.cols * 16 * zoom) / 2);
    const offY = Math.floor((SIZE.height * dpr - town.plan.rows * 16 * zoom) / 2);
    expect(x).toBe(Math.round((offX + (room.col + room.cols / 2) * 16 * zoom) / dpr));
    expect(y).toBe(Math.round((offY + (room.row + 0.5) * 16 * zoom) / dpr));
  });

  test('平移画布，名牌跟着走同样的距离', async () => {
    const pan = { current: { x: 0, y: 0 } };
    render({ panRef: pan });
    await nextFrame();
    const xOf = () => Number(chips().find(d => d.textContent === 'alpha')
      .style.transform.match(/translate\((-?\d+)px/)[1]);
    const before = xOf();
    pan.current = { x: 120, y: 0 };
    await nextFrame();
    const dpr = window.devicePixelRatio || 1;
    expect(xOf() - before).toBe(Math.round(120 / dpr));
  });
});
