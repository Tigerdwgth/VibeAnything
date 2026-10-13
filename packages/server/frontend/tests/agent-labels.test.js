// 小人头顶名牌的防重叠排布。
//
// 2026-10-10 线上实测：一间房里坐 10 个会话时，名牌糊成一团，互相盖住，
// 连房间的名牌也被盖掉 —— 「不知道哪个人在干嘛」又回来了。
// 这里锁住排布规则本身：靠下的（视觉前排）留在自己头顶，被挡住的往上让。

import { describe, test, expect } from 'vitest';
import { stackLabels } from '../src/pixel-components/AgentLabels.tsx';

/** 一块名牌：x 是水平中心，y 是顶边 */
const label = (id, x, y, w = 60, h = 20) => ({ id, x, y, w, h });

/** 把排布结果还原成矩形，便于断言「两两不相交」 */
function rects(items, ys) {
  return items.map(i => ({
    id: i.id, l: i.x - i.w / 2, r: i.x + i.w / 2, t: ys.get(i.id), b: ys.get(i.id) + i.h,
  }));
}

function anyOverlap(boxes) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t) return `${a.id} 与 ${b.id} 叠了`;
    }
  }
  return null;
}

describe('stackLabels', () => {
  test('本来就不挤的名牌一块都不动（不能白白把人家抬到天上去）', () => {
    const items = [label(1, 100, 100), label(2, 300, 100), label(3, 100, 300)];
    const ys = stackLabels(items);
    expect(items.map(i => ys.get(i.id))).toEqual([100, 100, 300]);
  });

  test('两块压在一起 → 让开，且让的是靠上那块（靠下 = 视觉前排，留在自己头顶）', () => {
    const 前排 = label(1, 100, 120);
    const 后排 = label(2, 100, 110);   // 两块各高 20，差 10 像素 = 压住一半
    const ys = stackLabels([后排, 前排]);
    expect(ys.get(1)).toBe(120);            // 前排原位不动
    expect(ys.get(2)).toBeLessThan(110);    // 后排往上让
    expect(anyOverlap(rects([前排, 后排], ys))).toBeNull();
  });

  test('一张桌子四个人挤在一起 → 四块名牌互不相交', () => {
    const items = [label(1, 200, 100), label(2, 206, 104), label(3, 198, 108), label(4, 202, 112)];
    expect(anyOverlap(rects(items, stackLabels(items)))).toBeNull();
  });

  test('十个人挤一间房（线上实测的那一间：三张桌子 4+4+2 人）→ 没有任何两块名牌相交', () => {
    // 一张 2x2 的桌子四面各坐一人，四个座位彼此只差一两格；桌子之间隔六格。
    const 桌 = (cx, cy, n, from) => Array.from({ length: n }, (_, k) => {
      const 方位 = [[0, -24], [-26, 0], [26, 0], [0, 24]][k];
      return label(from + k, cx + 方位[0], cy + 方位[1]);
    });
    const items = [...桌(200, 200, 4, 1), ...桌(360, 200, 4, 5), ...桌(520, 200, 2, 9)];
    const ys = stackLabels(items);
    expect(anyOverlap(rects(items, ys))).toBeNull();
    // 让开归让开，名牌不能飘得离自己的小人太远，否则认不出是谁的
    for (const i of items) expect(i.y - ys.get(i.id)).toBeLessThanOrEqual(3 * (i.h + 2));
  });

  test('水平方向本来就错得开的，不算挤（只在真的叠上了才让）', () => {
    const items = [label(1, 100, 100, 60), label(2, 170, 100, 60)];   // 两块刚好擦肩
    const ys = stackLabels(items);
    expect([ys.get(1), ys.get(2)]).toEqual([100, 100]);
  });

  test('结果与输入顺序无关（同一帧里 Map 的遍历顺序变了，名牌不能跟着跳）', () => {
    const items = [label(1, 100, 100), label(2, 104, 103), label(3, 98, 106)];
    const a = stackLabels(items);
    const b = stackLabels([...items].reverse());
    for (const i of items) expect(b.get(i.id)).toBe(a.get(i.id));
  });

  test('y 只差一两个像素（两人并肩走）时排序不翻来覆去 —— 量化到 8 像素一档', () => {
    const 甲 = label(1, 100, 100);
    const 乙 = label(2, 100, 101);
    const 第一帧 = stackLabels([甲, 乙]);
    const 第二帧 = stackLabels([{ ...甲, y: 101 }, { ...乙, y: 100 }]);  // 谁在上下换了一下
    expect(第二帧.get(1) - 第一帧.get(1)).toBeLessThanOrEqual(1);
    expect(第二帧.get(2) - 第一帧.get(2)).toBeLessThanOrEqual(1);
  });

  test('还没量到尺寸（宽高为 0）的名牌不参与挤占，也不会被挪走', () => {
    const items = [label(1, 100, 100, 0, 0), label(2, 100, 100)];
    const ys = stackLabels(items);
    expect(ys.get(1)).toBe(100);
    expect(ys.get(2)).toBe(100);
  });
});
