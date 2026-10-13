// 画布引擎里这次新加的两件事：
//   ① applySeatPlan —— 按集成层算好的「谁坐哪」整体落座（一台机器一层楼、一个目录一间房）
//   ② 闲逛范围收窄到自己房间 —— 否则所有人在整张地图上乱走，分房间就白分了
//
// 这两件事以前都不存在（上游只有一间屋子、座位随机分），所以单独验。

import { describe, test, expect, beforeEach } from 'vitest';
import { OfficeState } from '../src/pixel-office/engine/officeState.js';
import { buildTownSpec, buildFloor } from '../src/pixel-office/layout/townLayout.js';
import { CharacterState } from '../src/pixel-office/types.js';

const sessions = [
  { machineId: 'macmini', sessionId: 'a', cwd: '/same', folderId: 'alpha' },
  { machineId: 'macmini', sessionId: 'b', cwd: '/same', folderId: 'beta' },
];

let town;
let os;

beforeEach(() => {
  town = buildFloor(buildTownSpec(sessions, [], { macmini: [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'beta' }] })[0], { width: 1200, height: 800 });
  os = new OfficeState(town.layout);
});

const seatOf = (sid) => town.plan.seatOfSession[`macmini::${sid}`];
const roomOf = (sid) => {
  const seat = seatOf(sid);
  return town.plan.rooms.find(r => r.seats.includes(seat)) || null;
};

describe('applySeatPlan：整体落座', () => {
  test('两个人互换座位 —— 一个一个改会互相挡住（座位「已被占用」就放弃）', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    os.addAgent(2, 1, 0, seatOf('b'), true);
    expect(os.characters.get(1).seatId).toBe(seatOf('a'));

    os.applySeatPlan({ 1: seatOf('b'), 2: seatOf('a') });
    expect(os.characters.get(1).seatId).toBe(seatOf('b'));
    expect(os.characters.get(2).seatId).toBe(seatOf('a'));
    // 两把椅子都还是「有人」，没出现一把椅子被两个人认领
    expect(os.seats.get(seatOf('a')).assigned).toBe(true);
    expect(os.seats.get(seatOf('b')).assigned).toBe(true);
  });

  test('walk=false：直接落座（地图刚重建，人本来就该跟着墙一起挪）', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    os.applySeatPlan({ 1: seatOf('b') }, false);
    const seat = os.seats.get(seatOf('b'));
    const ch = os.characters.get(1);
    expect([ch.tileCol, ch.tileRow]).toEqual([seat.seatCol, seat.seatRow]);
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.path).toEqual([]);          // 残留路径会让小人下一帧直线穿墙飞走
    expect(ch.dir).toBe(seat.facingDir);
  });

  test('walk=true：自己走过去（换了分类文件夹时看得出发生了什么）', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    os.applySeatPlan({ 1: seatOf('b') }, true);
    const ch = os.characters.get(1);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.length).toBeGreaterThan(0);
    const last = ch.path[ch.path.length - 1];
    const seat = os.seats.get(seatOf('b'));
    expect([last.col, last.row]).toEqual([seat.seatCol, seat.seatRow]);
  });

  test('计划里的座位不存在（布局与计划不同步）→ 保留原座位，不把人弄成无座', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    os.applySeatPlan({ 1: 'c:nowhere|/x:0n' });
    expect(os.characters.get(1).seatId).toBe(seatOf('a'));
    expect(os.seats.get(seatOf('a')).assigned).toBe(true);
  });

  test('计划里有画布上不存在的 id → 忽略，不抛错', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    expect(() => os.applySeatPlan({ 99: seatOf('b'), nope: seatOf('b') })).not.toThrow();
    expect(os.characters.get(1).seatId).toBe(seatOf('a'));
  });
});

describe('闲逛范围：只在自己房间里转', () => {
  test('空闲下来挑的漫游目标落在自己房间内', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    const room = roomOf('a');
    const ch = os.characters.get(1);

    // 找 40 次目标，全部都该在自己房间的矩形里（随机取点，样本多一点才有意义）
    for (let i = 0; i < 40; i++) {
      ch.isActive = false;
      ch.state = CharacterState.IDLE;
      ch.seatTimer = 0;
      ch.wanderTimer = 0;
      ch.path = [];
      os.update(0.016);
      const target = ch.path[ch.path.length - 1];
      if (!target) continue;                // 偶尔原地没动
      expect(target.col).toBeGreaterThanOrEqual(room.col);
      expect(target.col).toBeLessThan(room.col + room.cols);
      expect(target.row).toBeGreaterThanOrEqual(room.row);
      expect(target.row).toBeLessThan(room.row + room.rows);
      // 把人放回座位，下一轮重新挑
      ch.tileCol = os.seats.get(seatOf('a')).seatCol;
      ch.tileRow = os.seats.get(seatOf('a')).seatRow;
    }
  });

  test('知道每个小人在哪间房（名牌与调试要用）', () => {
    os.addAgent(1, 0, 0, seatOf('a'), true);
    expect(os.roomKeyOfCharacter(1)).toBe(roomOf('a').key);
    expect(os.roomKeyOfCharacter(999)).toBeNull();
  });

  test('手搓的旧布局没有 places → 退回全图漫游，不报错', () => {
    const plain = { ...town.layout, places: undefined };
    const bare = new OfficeState(plain);
    bare.addAgent(1, 0, 0, seatOf('a'), true);
    expect(bare.roomKeyOfCharacter(1)).toBeNull();
    expect(() => bare.update(0.016)).not.toThrow();
  });
});
