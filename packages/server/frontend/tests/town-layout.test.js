// 楼层生成器：一台开发机 = 一个标签页里的一整层楼，一个分类文件夹 = 一间房，一个会话 = 一个工位。
//
// 这里断言的是**几何与归属**，而不是好不好看：
//   · 网格是按画布算出来的，必须正好铺满画布（旧版四台机器挤一张图，取整缩放只剩 1×，
//     地图缩在屏幕中间一半的面积里 —— 这就是「全都显示在一页上，太大，看不清」）；
//   · 每个分类文件夹都有自己的一间房，房间之间不重叠、合起来铺满整层；
//   · 开关**会话**不重排楼层（签名不含会话数），新建/删掉**分类**才重排；
//   · 每个人都走得到自己的工位（门必须真的通）。

import { describe, test, expect } from 'vitest';
import {
  buildTownSpec, planFloor, buildFloorPlan, buildFloor, gridForZoom, townSessionKey,
} from '../src/pixel-office/layout/townLayout.js';
import {
  TILE_SIZE, MAX_COLS, MAX_ROWS, FLOOR_MIN_ROOM_COLS, FLOOR_MIN_ROOM_ROWS, FLOOR_MAX_ROOMS,
  FLOOR_FALLBACK_COLS, FLOOR_FALLBACK_ROWS,
} from '../src/pixel-constants.js';
import { TileType } from '../src/pixel-office/types.js';
import {
  layoutToTileMap, layoutToSeats, getBlockedTiles,
} from '../src/pixel-office/layout/layoutSerializer.js';
import { isWalkable } from '../src/pixel-office/layout/tileMap.js';
import { fitZoom } from '../src/pixel-office/toolUtils.js';

const S = (machineId, sessionId, folderId) => ({ machineId, sessionId, folderId, cwd: "/same/physical/path" });
/** 1360×957 的面板 @ dpr 2 —— 线上实测的画布尺寸（设备像素） */
const STAGE = { width: 2720, height: 1914 };
// 几何用例显式构造分类数据；cwd 对所有会话相同。
const specOf = (sessions, machines = []) => {
  const folders = {};
  for (const s of sessions) {
    const list = folders[s.machineId] ||= [];
    if (!list.some(f => f.id === s.folderId)) list.push({ id: s.folderId, name: s.folderId, parentId: null });
  }
  return buildTownSpec(sessions, machines, folders)[0];
};

/**
 * 从某格出发能走到的所有格子。**椅子算挡路**（引擎只给每个人临时解锁自己那一把），
 * 所以这是最严的判据：门不能开在椅子旁边，否则门后是堵死的。
 */
function floodFrom(layout, startCol, startRow) {
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);
  const seen = new Set([`${startCol},${startRow}`]);
  const queue = [[startCol, startRow]];
  while (queue.length) {
    const [c, r] = queue.shift();
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const key = `${c + dc},${r + dr}`;
      if (seen.has(key)) continue;
      if (!isWalkable(c + dc, r + dr, tileMap, blocked)) continue;
      seen.add(key);
      queue.push([c + dc, r + dr]);
    }
  }
  return seen;
}

/** 这间房里随便一块空地（用来起 BFS / 判断房间通不通） */
function openTileIn(layout, room) {
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);
  for (let r = room.row; r < room.row + room.rows; r++) {
    for (let c = room.col; c < room.col + room.cols; c++) {
      if (isWalkable(c, r, tileMap, blocked)) return [c, r];
    }
  }
  return null;
}

describe('按 VibeAnything 分类分房间', () => {
  const folders = { m: [
    { id: 'a', name: '研究', parentId: null },
    { id: 'b', name: '实验', parentId: 'a' },
    { id: 'c', name: '实验', parentId: null },
    { id: 'empty', name: '空分类', parentId: null },
  ] };
  test('同分类不同 cwd 合房，同 cwd 不同分类分房；子分类和空分类独立成房', () => {
    const [house] = buildTownSpec([
      { machineId: 'm', sessionId: '1', folderId: 'a', cwd: '/first' },
      { machineId: 'm', sessionId: '2', folderId: 'a', cwd: '/second' },
      { machineId: 'm', sessionId: '3', folderId: 'b', cwd: '/first' },
      { machineId: 'm', sessionId: '4', folderId: 'c', cwd: '/first' },
    ], [], folders);
    expect(house.rooms).toHaveLength(4);
    expect(house.rooms.find(r => r.key === 'm|folder:a').sessionKeys).toEqual(['m::1', 'm::2']);
    expect(house.rooms.find(r => r.key === 'm|folder:b')).toMatchObject({ label: '研究 / 实验', sessionKeys: ['m::3'] });
    expect(house.rooms.find(r => r.key === 'm|folder:empty').sessionKeys).toEqual([]);
  });
  test('未分类与已删除分类的会话进入未分类；默认分类文件夹不建房', () => {
    const [house] = buildTownSpec([
      S('m', 'a', null), S('m', 'b', 'deleted'),
    ], [{ machineId: 'm', defaultWorkDir: '/physical' }], folders);
    expect(house.rooms.find(r => r.label === '未分类').sessionKeys).toEqual(['m::a', 'm::b']);
    expect(house.rooms.some(r => r.path === '/physical')).toBe(false);
    expect(buildTownSpec([], [{ machineId: 'm' }])[0].rooms[0].label).toBe('未分类');
  });
  test('同名同 id 分类按机器隔离，未在线的历史分类不凭空造机器', () => {
    const specs = buildTownSpec([S('m', 'x', 'a'), S('n', 'x', 'a')], [], {
      ...folders, n: [{ id: 'a', name: '另一台' }], stale: [{ id: 'z', name: '旧分类' }],
    });
    expect(specs.map(h => h.key)).toEqual(['m', 'n']);
    expect(specs[1].rooms[0]).toMatchObject({ key: 'n|folder:a', label: '另一台', sessionKeys: ['n::x'] });
  });
  test('关闭最后一个会话保留分类房，删除分类才移除房间', () => {
    expect(buildTownSpec([], [{ machineId: 'm' }], folders)[0].rooms).toHaveLength(4);
    const removed = { m: folders.m.filter(f => f.id !== 'empty') };
    expect(buildTownSpec([], [{ machineId: 'm' }], removed)[0].rooms).toHaveLength(3);
  });
  test('重命名及移动父分类更新名牌，房间键与座位保持身份', () => {
    const members = [S('m', 'x', 'b')];
    const before = buildFloorPlan(buildTownSpec(members, [], folders)[0], STAGE).plan;
    const changed = { m: folders.m.map(f => f.id === 'a' ? { ...f, name: '项目', parentId: 'c' } : f) };
    const after = buildFloorPlan(buildTownSpec(members, [], changed)[0], STAGE, { preferredSeats: before.seatOfSession }).plan;
    expect(after.rooms.find(r => r.key === 'm|folder:b').label).toBe('实验 / 项目 / 实验');
    expect(after.signature).not.toBe(before.signature);
    expect(after.seatOfSession['m::x']).toBe(before.seatOfSession['m::x']);
  });
});

describe('网格：按画布算，正好铺满', () => {
  test('gridForZoom 给出的网格铺满画布，误差不到一格', () => {
    for (const zoom of [2, 3, 4, 5]) {
      const grid = gridForZoom(STAGE, zoom);
      const unit = TILE_SIZE * zoom;
      expect(grid.cols * unit).toBeLessThanOrEqual(STAGE.width);
      expect((grid.cols + 1) * unit).toBeGreaterThan(STAGE.width);
      expect(grid.rows * unit).toBeLessThanOrEqual(STAGE.height);
      expect((grid.rows + 1) * unit).toBeGreaterThan(STAGE.height);
    }
  });

  test('还量不到画布尺寸时退回固定网格（首帧 / jsdom）', () => {
    expect(gridForZoom({ width: 0, height: 0 }, 4)).toEqual({ cols: FLOOR_FALLBACK_COLS, rows: FLOOR_FALLBACK_ROWS });
  });

  test('网格不超过地图上限', () => {
    const grid = gridForZoom({ width: 40000, height: 40000 }, 1);
    expect(grid.cols).toBeLessThanOrEqual(MAX_COLS);
    expect(grid.rows).toBeLessThanOrEqual(MAX_ROWS);
  });

  test('画布那边的 fitZoom 会挑回同一档缩放，且两个方向都铺满 ≥90%', () => {
    // 这条是「占满整个页面」的真正判据：生成端挑的 zoom 必须等于渲染端算出来的
    const spec = specOf([
      S('macmini', 'a', '/Users/gsj'),
      S('macmini', 'b', '/private/tmp'),
      S('macmini', 'c', '/Users/gsj/VibeAnything'),
    ]);
    const { plan, zoom } = buildFloorPlan(spec, STAGE);
    expect(fitZoom(plan.cols, plan.rows, STAGE.width, STAGE.height)).toBe(zoom);
    expect((plan.cols * TILE_SIZE * zoom) / STAGE.width).toBeGreaterThan(0.9);
    expect((plan.rows * TILE_SIZE * zoom) / STAGE.height).toBeGreaterThan(0.9);
  });

  test('房间少就用大格子（看得清），房间多了才换小格子', () => {
    const few = buildFloorPlan(specOf([S('m', 'a', '/a')]), STAGE);
    const many = buildFloorPlan(specOf(
      Array.from({ length: 9 }, (_, i) => S('m', `s${i}`, `/dir${i}`)),
    ), STAGE);
    expect(few.zoom).toBeGreaterThan(many.zoom);
    expect(few.zoom).toBeGreaterThanOrEqual(4);
  });
});

describe('房间：铺满整层楼、互不重叠', () => {
  const spec = specOf([
    S('macmini', 'a', '/Users/gsj'),
    S('macmini', 'b', '/private/tmp'),
    S('macmini', 'c', '/Users/gsj/VibeAnything'),
    S('macmini', 'd', '/Users/gsj/work'),
    S('macmini', 'e', '/Users/gsj/dev'),
  ]);

  test('五个分类 → 五间房，一间都不少', () => {
    const { plan } = buildFloorPlan(spec, STAGE);
    expect(plan.rooms).toHaveLength(5);
    expect(new Set(plan.rooms.map(r => r.key)).size).toBe(5);
    expect(plan.mergedDirs).toBe(0);
  });

  test('房间不重叠、都在外墙里面、都不小于最小尺寸', () => {
    const { plan } = buildFloorPlan(spec, STAGE);
    const used = new Set();
    for (const room of plan.rooms) {
      expect(room.cols).toBeGreaterThanOrEqual(FLOOR_MIN_ROOM_COLS);
      expect(room.rows).toBeGreaterThanOrEqual(FLOOR_MIN_ROOM_ROWS);
      expect(room.col).toBeGreaterThanOrEqual(1);
      expect(room.row).toBeGreaterThanOrEqual(1);
      expect(room.col + room.cols).toBeLessThanOrEqual(plan.cols - 1);
      expect(room.row + room.rows).toBeLessThanOrEqual(plan.rows - 1);
      for (let r = room.row; r < room.row + room.rows; r++) {
        for (let c = room.col; c < room.col + room.cols; c++) {
          expect(used.has(`${c},${r}`)).toBe(false);
          used.add(`${c},${r}`);
        }
      }
    }
    // 铺满：内部的格子除了分隔墙（每道墙 1 格）之外都归某间房
    const inner = (plan.cols - 2) * (plan.rows - 2);
    expect(used.size / inner).toBeGreaterThan(0.75);
  });

  test('整层楼四周是外墙，房间地板不越界', () => {
    const { plan, layout } = buildFloor(spec, STAGE);
    const at = (c, r) => layout.tiles[r * plan.cols + c];
    for (let c = 0; c < plan.cols; c++) {
      expect(at(c, 0)).toBe(TileType.WALL);
      expect(at(c, plan.rows - 1)).toBe(TileType.WALL);
    }
    for (let r = 0; r < plan.rows; r++) {
      expect(at(0, r)).toBe(TileType.WALL);
      expect(at(plan.cols - 1, r)).toBe(TileType.WALL);
    }
  });

  test('分类多到放不下：留下会话最多的几间，其余并成「其他 N 个分类」', () => {
    const many = specOf(Array.from({ length: 30 }, (_, i) => S('m', `s${i}`, `/dir${i}`)));
    const { plan } = buildFloorPlan(many, STAGE);
    expect(plan.rooms.length).toBeLessThanOrEqual(FLOOR_MAX_ROOMS);
    const merged = plan.rooms.find(r => r.key.endsWith('|__more__'));
    expect(merged).toBeTruthy();
    expect(merged.label).toMatch(/^其他 \d+ 个分类$/);
    // 一个会话都不能丢
    const seated = Object.keys(plan.seatOfSession).length;
    expect(seated + plan.unseated).toBe(30);
  });

  test('房间名牌那一行不摆工位 —— 否则小人名牌会顶掉房间名', () => {
    const { plan } = buildFloorPlan(spec, STAGE);
    for (const room of plan.rooms) {
      expect(room.islandRow).toBeGreaterThan(room.row);
    }
  });
});

describe('工位与座位', () => {
  // 线上实测的 macmini：/Users/gsj 一个分类就有 21 个会话
  const crowded = specOf([
    ...Array.from({ length: 21 }, (_, i) => S('macmini', `s${i}`, '/Users/gsj')),
    S('macmini', 'tmp', '/private/tmp'),
  ]);

  test('一个分类 21 个会话：人人有座（够不下就自动换小格子多排工位）', () => {
    const { plan } = buildFloorPlan(crowded, STAGE);
    expect(plan.unseated).toBe(0);
    const room = plan.rooms.find(r => r.path === '/Users/gsj');
    expect(room.seats.length).toBeGreaterThanOrEqual(21);
  });

  test('座位都在自己房间里（椅子家具的坐标必须落在房间范围内）', () => {
    const { plan, layout } = buildFloor(crowded, STAGE);
    const seats = layoutToSeats(layout.furniture);
    for (const room of plan.rooms) {
      for (const uid of room.seats) {
        const seat = seats.get(uid);
        expect(seat).toBeTruthy();
        expect(seat.seatCol).toBeGreaterThanOrEqual(room.col);
        expect(seat.seatCol).toBeLessThan(room.col + room.cols);
        expect(seat.seatRow).toBeGreaterThanOrEqual(room.row);
        expect(seat.seatRow).toBeLessThan(room.row + room.rows);
      }
    }
  });

  test('同样的结构算两遍，座位分配一模一样（座位 uid 按内容派生，不按下标）', () => {
    const a = buildFloorPlan(crowded, STAGE).plan;
    const b = buildFloorPlan(crowded, STAGE).plan;
    expect(b.seatOfSession).toEqual(a.seatOfSession);
    expect(b.signature).toBe(a.signature);
  });
});

describe('工位数量按会话数来，不按房间大小来', () => {
  test('一个会话的房间只摆一组工位 —— 房间是铺满画布的分区，照面积摆满会是一屋子空桌', () => {
    const { plan } = buildFloorPlan(specOf([S('m', 'a', '/one')]), STAGE);
    const room = plan.rooms[0];
    // 房间很大（铺满整层），但桌子只有一组
    expect(room.cols).toBeGreaterThan(15);
    expect(room.islandCols * room.islandRows).toBe(1);
    expect(room.seats).toHaveLength(4);
  });

  test('人多了就多摆几组，够坐且有余量', () => {
    const { plan } = buildFloorPlan(specOf(
      Array.from({ length: 21 }, (_, i) => S('m', `s${i}`, '/one')),
    ), STAGE);
    const room = plan.rooms[0];
    expect(room.seats.length).toBeGreaterThanOrEqual(Math.ceil(21 * 1.3));
    expect(plan.unseated).toBe(0);
  });

  test('工位数取台阶值：多开一个会话不改桌子数（否则座位 uid 全变、整层楼重排）', () => {
    const before = buildFloorPlan(specOf(
      Array.from({ length: 21 }, (_, i) => S('m', `s${i}`, '/one')),
    ), STAGE).plan;
    const after = buildFloorPlan(specOf(
      Array.from({ length: 22 }, (_, i) => S('m', `s${i}`, '/one')),
    ), STAGE).plan;
    expect(after.signature).toBe(before.signature);
    expect(after.rooms[0].seats).toEqual(before.rooms[0].seats);
  });

  test('会话数跨过台阶（桌子真要多摆一排）签名才变', () => {
    const one = buildFloorPlan(specOf([S('m', 'a', '/one')]), STAGE).plan;
    const eight = buildFloorPlan(specOf(
      Array.from({ length: 8 }, (_, i) => S('m', `s${i}`, '/one')),
    ), STAGE).plan;
    expect(eight.signature).not.toBe(one.signature);
    expect(eight.rooms[0].seats.length).toBeGreaterThan(one.rooms[0].seats.length);
  });
});

describe('动态增删：开关会话不重排，增删分类才重排', () => {
  const base = [S('m', 'a', '/one'), S('m', 'b', '/two')];

  test('同一批分类下多开一个会话：签名不变（整层楼不重建）', () => {
    const before = buildFloorPlan(specOf(base), STAGE).plan;
    const after = buildFloorPlan(specOf([...base, S('m', 'c', '/one')]), STAGE).plan;
    expect(after.signature).toBe(before.signature);
    expect(after.cols).toBe(before.cols);
  });

  test('多开的会话坐空位，原来的人不挪位置', () => {
    const before = buildFloorPlan(specOf(base), STAGE).plan;
    const after = buildFloorPlan(specOf([...base, S('m', 'c', '/one')]), STAGE, {
      preferredSeats: before.seatOfSession,
    }).plan;
    expect(after.seatOfSession['m::a']).toBe(before.seatOfSession['m::a']);
    expect(after.seatOfSession['m::b']).toBe(before.seatOfSession['m::b']);
    expect(after.seatOfSession['m::c']).toBeTruthy();
    expect(after.seatOfSession['m::c']).not.toBe(before.seatOfSession['m::a']);
  });

  test('关掉一个会话：剩下的人原地不动', () => {
    const before = buildFloorPlan(specOf([...base, S('m', 'c', '/one')]), STAGE).plan;
    const after = buildFloorPlan(specOf(base), STAGE, { preferredSeats: before.seatOfSession }).plan;
    expect(after.signature).toBe(before.signature);
    expect(after.seatOfSession['m::a']).toBe(before.seatOfSession['m::a']);
    expect(after.seatOfSession['m::b']).toBe(before.seatOfSession['m::b']);
    expect(after.seatOfSession['m::c']).toBeUndefined();
  });

  test('新开一个分类：签名变、房间多一间（这就是「动态增房间」）', () => {
    const before = buildFloorPlan(specOf(base), STAGE).plan;
    const after = buildFloorPlan(specOf([...base, S('m', 'c', '/three')]), STAGE).plan;
    expect(after.signature).not.toBe(before.signature);
    expect(after.rooms).toHaveLength(before.rooms.length + 1);
    expect(after.rooms.map(r => r.path)).toContain('/three');
  });

  test('删除一个分类：那间房消失', () => {
    const after = buildFloorPlan(specOf([S('m', 'a', '/one')]), STAGE).plan;
    expect(after.rooms.map(r => r.path)).toEqual(['/one']);
  });

  test('画布尺寸变了（拖窗口）签名就变 —— 新网格才能继续铺满', () => {
    const wide = buildFloorPlan(specOf(base), STAGE).plan;
    const narrow = buildFloorPlan(specOf(base), { width: 1200, height: 900 }).plan;
    expect(narrow.signature).not.toBe(wide.signature);
  });
});

describe('连通性：每个人都走得到自己的工位', () => {
  const spec = specOf([
    S('m', 'a', '/one'), S('m', 'b', '/two'), S('m', 'c', '/three'),
    S('m', 'd', '/four'), S('m', 'e', '/five'), S('m', 'f', '/six'),
  ]);

  test('从任一间房出发能走到所有房间（门必须真的开在空地旁边）', () => {
    const { plan, layout } = buildFloor(spec, STAGE);
    const start = openTileIn(layout, plan.rooms[0]);
    expect(start).toBeTruthy();
    const reach = floodFrom(layout, start[0], start[1]);
    for (const room of plan.rooms) {
      const tiles = [];
      for (let r = room.row; r < room.row + room.rows; r++) {
        for (let c = room.col; c < room.col + room.cols; c++) {
          if (reach.has(`${c},${r}`)) tiles.push(`${c},${r}`);
        }
      }
      expect(tiles.length, `房间 ${room.label} 走不到`).toBeGreaterThan(0);
    }
  });

  test('每把椅子旁边都有一格走得到的空地（引擎只解锁自己那把椅子）', () => {
    const { plan, layout } = buildFloor(spec, STAGE);
    const start = openTileIn(layout, plan.rooms[0]);
    const reach = floodFrom(layout, start[0], start[1]);
    const seats = layoutToSeats(layout.furniture);
    for (const [uid, seat] of seats) {
      const near = [[0, -1], [0, 1], [-1, 0], [1, 0]]
        .some(([dc, dr]) => reach.has(`${seat.seatCol + dc},${seat.seatRow + dr}`));
      expect(near, `座位 ${uid} 四周没有走得到的空地`).toBe(true);
    }
  });
});

describe('会话 key', () => {
  test('带机器名，两台机器上同名 tmux 不会撞', () => {
    expect(townSessionKey({ machineId: 'a', sessionId: 'x' })).toBe('a::x');
    expect(townSessionKey({ sessionId: 'x' })).toBe('local::x');
  });
});

describe('planFloor 直接给网格也能用（集成层每轮算座位走的就是它）', () => {
  test('给定网格 → 房间铺满该网格，签名含网格尺寸', () => {
    const plan = planFloor(specOf([S('m', 'a', '/one'), S('m', 'b', '/two')]), { cols: 30, rows: 20 });
    expect(plan.cols).toBe(30);
    expect(plan.rows).toBe(20);
    expect(plan.signature).toContain('30x20');
  });
});
