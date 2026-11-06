// 像素小镇画布层的真渲染测试：自动贴合缩放、dpr 变化、「工作中」描边、悬停卡片。
// 只补 jsdom 缺的浏览器能力（2d context、布局尺寸、matchMedia 的分辨率查询），
// 被测的 OfficeCanvas / renderer / ToolOverlay 都是原样挂载。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeCanvas } from '../src/pixel-office/components/OfficeCanvas.tsx';
import { ToolOverlay } from '../src/pixel-office/components/ToolOverlay.tsx';
import { OfficeState } from '../src/pixel-office/engine/officeState.js';
import { EditorState } from '../src/pixel-office/editor/editorState.js';
import { renderScene } from '../src/pixel-office/engine/renderer.js';
import { getOutlineSprite } from '../src/pixel-office/sprites/spriteCache.js';
import { getCharacterSprites } from '../src/pixel-office/sprites/spriteData.js';
import { getCharacterSprite } from '../src/pixel-office/engine/characters.js';
import { watchDevicePixelRatio } from '../src/pixel-office/engine/dprWatch.js';
import { buildTownSpec, buildFloor } from '../src/pixel-office/layout/townLayout.js';
import { fitZoom } from '../src/pixel-office/toolUtils.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── 浏览器能力补齐 ────────────────────────────────────────────
const origRect = Element.prototype.getBoundingClientRect;
const origGetContext = HTMLCanvasElement.prototype.getContext;
const origMatchMedia = window.matchMedia;
const origDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

let cssSize;   // 容器的 CSS 尺寸
let drawn;     // drawImage 记录

function recordingContext(canvas) {
  const store = { canvas };
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'drawImage') return (...args) => drawn.push(args);
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'measureText') return () => ({ width: 0 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

// matchMedia 的分辨率查询：与浏览器一致 —— 查询只认注册时写的那个分辨率，
// 匹配结果翻转（变走或变回）时才派发 change
let queries;
function fakeMatchMedia(media) {
  const q = {
    media,
    matches: media.includes(`(resolution: ${window.devicePixelRatio}dppx)`),
    listeners: new Set(),
    addEventListener(type, fn, opts) {
      const wrapped = opts?.once ? () => { this.listeners.delete(wrapped); fn(); } : fn;
      wrapped.original = fn;
      this.listeners.add(wrapped);
    },
    removeEventListener(type, fn) {
      for (const l of this.listeners) if (l === fn || l.original === fn) this.listeners.delete(l);
    },
  };
  queries.push(q);
  return q;
}
function setDpr(dpr) {
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  for (const q of [...queries]) {
    const m = q.media.includes(`(resolution: ${dpr}dppx)`);
    if (m === q.matches) continue;
    q.matches = m;
    for (const l of [...q.listeners]) l();
  }
}

const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r())));

let host;
let root;

beforeEach(() => {
  drawn = [];
  queries = [];
  cssSize = { width: 600, height: 400 };
  Element.prototype.getBoundingClientRect = function () {
    return { ...cssSize, left: 0, top: 0, right: cssSize.width, bottom: cssSize.height, x: 0, y: 0, toJSON() { return this; } };
  };
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? recordingContext(this) : null; };
  window.matchMedia = fakeMatchMedia;
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = origRect;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  window.matchMedia = origMatchMedia;
  if (origDpr) Object.defineProperty(window, 'devicePixelRatio', origDpr);
  else delete window.devicePixelRatio;
});

/** 按 1200×800 设备像素的画布生成的一层楼 */
function floorState() {
  const sessions = [0, 1, 2, 3].map((i) => ({ machineId: 'macmini', sessionId: `s${i}`, cwd: '/w', folderId: `f${i % 2}` }));
  const folders = { macmini: [{ id: 'f0', name: '甲', parentId: null }, { id: 'f1', name: '乙', parentId: null }] };
  const town = buildFloor(buildTownSpec(sessions, [], folders)[0], { width: 1200, height: 800 });
  return { os: new OfficeState(town.layout), town };
}

describe('自动贴合缩放', () => {
  test('画布翻倍（拖到 Retina 屏）时网格一格不变，也要重新贴合；dpr 连着变也每次都跟上', async () => {
    const { os, town } = floorState();
    const { cols, rows } = town.layout;
    const fitAt = (w, h) => fitZoom(cols, rows, w, h);
    const fits = [];
    act(() => {
      root.render(
        <OfficeCanvas
          officeState={os} onClick={() => {}} isEditMode={false} editorState={new EditorState()}
          onEditorTileAction={() => {}} onEditorEraseAction={() => {}} onEditorSelectionChange={() => {}}
          onDeleteSelected={() => {}} onRotateSelected={() => {}} onDragMove={() => {}} editorTick={0}
          zoom={1} onZoomChange={() => {}} onAutoZoom={(z) => fits.push(z)} panRef={{ current: { x: 0, y: 0 } }}
        />,
      );
    });
    await nextFrame();
    const z1 = fitAt(1200, 800);
    expect(fits).toEqual([z1]);
    act(() => setDpr(4));
    await nextFrame();
    // 2400×1600：同一张图（地图尺寸没变）要放大一倍。原来只看 cols×rows，这一步什么都不发生
    const z2 = fitAt(2400, 1600);
    expect(z2).toBe(z1 * 2);
    expect(fits).toEqual([z1, z2]);
    act(() => setDpr(3));
    await nextFrame();
    // 第二次变化（4→3）也听得见：原来的分辨率查询只认最初那个 2dppx
    expect(fits).toEqual([z1, z2, fitAt(1800, 1200)]);
  });

  test('watchDevicePixelRatio：2 → 1 → 1.5 → 2 每一次都回调，停止之后不再回调', () => {
    let calls = 0;
    const stop = watchDevicePixelRatio(() => { calls++; });
    setDpr(1);
    setDpr(1.5);
    setDpr(2);
    expect(calls).toBe(3);
    stop();
    setDpr(1);
    expect(calls).toBe(3);
  });
});

describe('「工作中」的描边', () => {
  test('工作中的人多画一层描边（主题黄），空闲 / 干完了的不画', () => {
    const { os, town } = floorState();
    os.addAgent(1, 0, 0, town.plan.seatOfSession['macmini::s0'], true);
    os.addAgent(2, 1, 0, town.plan.seatOfSession['macmini::s1'], true);
    os.setAgentPhase(1, 'working');
    os.setAgentPhase(2, 'done');
    const ctx = recordingContext(document.createElement('canvas'));
    renderScene(ctx, [], [os.characters.get(1)], 0, 0, 2, null, null);
    const working = drawn.length;
    drawn = [];
    renderScene(ctx, [], [os.characters.get(2)], 0, 0, 2, null, null);
    expect(working).toBe(2);
    expect(drawn.length).toBe(1);
  });

  test('描边的颜色可以指定，不同颜色各自缓存、互不覆盖', () => {
    const sprite = [['', '#000', ''], ['#000', '#000', '#000']];
    const yellow = getOutlineSprite(sprite, '#facc15');
    const white = getOutlineSprite(sprite);
    expect(yellow.flat()).toContain('#facc15');
    expect(yellow.flat()).not.toContain('#FFFFFF');
    expect(white.flat()).toContain('#FFFFFF');
  });

  test('坐着歇着的人用坐姿精灵，不用打字精灵', () => {
    const { os, town } = floorState();
    os.addAgent(1, 0, 0, town.plan.seatOfSession['macmini::s0'], true);
    const ch = os.characters.get(1);
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    os.setAgentPhase(1, 'working');
    expect(getCharacterSprite(ch, sprites)).toBe(sprites.typing[ch.dir][ch.frame % 2]);
    os.setAgentPhase(1, 'permission');
    expect(getCharacterSprite(ch, sprites)).toBe(sprites.reading[ch.dir][0]);
    os.setAgentPhase(1, 'idle');
    expect(getCharacterSprite(ch, sprites)).toBe(sprites.reading[ch.dir][0]);
  });
});

describe('悬停卡片', () => {
  test('鼠标移到小人身上（画布直接写 officeState.hoveredAgentId）→ 下一帧就弹出卡片', async () => {
    const { os, town } = floorState();
    os.addAgent(1, 0, 0, town.plan.seatOfSession['macmini::s0'], true);
    act(() => {
      root.render(
        <ToolOverlay
          officeState={os} agents={[1]} agentTools={{}} subagentCharacters={[]}
          containerRef={{ current: host }} zoom={2} panRef={{ current: { x: 0, y: 0 } }} onCloseAgent={() => {}}
        />,
      );
    });
    await nextFrame();
    expect(host.textContent).toBe('');
    os.hoveredAgentId = 1;
    await nextFrame();
    await nextFrame();
    expect(host.textContent).toContain('空闲');
    os.hoveredAgentId = null;
    await nextFrame();
    await nextFrame();
    expect(host.textContent).toBe('');
  });
});
