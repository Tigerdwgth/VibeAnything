// 多机会话列表合并。桌面版与手机版共用这一份规则，所以它一旦错，两个端一起错。
//
// 2026-02-27 的事故：收到一条 active_sessions 就整表替换，结果多台开发机只剩最后
// 一条消息那台的会话。这里用「回归见证」把那个错法也写进来，证明用例真的抓得住。

import { describe, test, expect } from 'vitest';
import { mergeActiveSessions } from '../src/session-merge.js';

const sess = (sessionId, machineId, extra = {}) => ({ sessionId, machineId, ...extra });

describe('mergeActiveSessions', () => {
  test('只替换这条消息那台机器的分区，别的机器原样留着', () => {
    const prev = [sess('a', 'macmini'), sess('b', 'gpuserver1')];
    const next = mergeActiveSessions(prev, [{ sessionId: 'c' }], 'macmini');
    expect(next.map(s => s.sessionId).sort()).toEqual(['b', 'c']);
    expect(next.find(s => s.sessionId === 'b').machineId).toBe('gpuserver1');
  });

  test('回归见证：整表替换会丢掉其它机器的会话', () => {
    // 这是 2026-02-27 的错法，留在这里证明上面那条不是碰巧过的
    const prev = [sess('a', 'macmini'), sess('b', 'gpuserver1')];
    const wrong = (incoming, mid) => (incoming || []).map(s => ({ ...s, machineId: mid }));
    expect(wrong([{ sessionId: 'c' }], 'macmini').map(s => s.sessionId)).toEqual(['c']);
    expect(mergeActiveSessions(prev, [{ sessionId: 'c' }], 'macmini')).toHaveLength(2);
  });

  test('这台机器上一轮的会话被这一轮全量覆盖（关掉的会话要消失）', () => {
    const prev = [sess('a', 'macmini'), sess('b', 'macmini')];
    const next = mergeActiveSessions(prev, [{ sessionId: 'a' }], 'macmini');
    expect(next.map(s => s.sessionId)).toEqual(['a']);
  });

  test('每条会话都被盖上 machineId（消息里的会话不带这个字段）', () => {
    const next = mergeActiveSessions([], [{ sessionId: 'a' }, { sessionId: 'b' }], 'aibox');
    expect(next.every(s => s.machineId === 'aibox')).toBe(true);
  });

  test('本地乐观占位保留 —— 它没有对应的服务端记录，按机器过滤会误删', () => {
    const prev = [sess('restoring', 'macmini', { _optimistic: true })];
    const next = mergeActiveSessions(prev, [], 'macmini');
    expect(next.map(s => s.sessionId)).toEqual(['restoring']);
  });

  test('服务端真的扫出来了，占位就让位给真数据（不留重复行）', () => {
    const prev = [sess('restoring', 'macmini', { _optimistic: true })];
    const next = mergeActiveSessions(prev, [{ sessionId: 'restoring', cwd: '/work' }], 'macmini');
    expect(next).toHaveLength(1);
    expect(next[0]._optimistic).toBeUndefined();
    expect(next[0].cwd).toBe('/work');
  });

  test('占位属于哪台机器都保留 —— 按 machineId 过滤那一步不能把它捎走', () => {
    const prev = [sess('restoring', 'gpuserver1', { _optimistic: true })];
    const next = mergeActiveSessions(prev, [{ sessionId: 'x' }], 'macmini');
    expect(next.map(s => s.sessionId).sort()).toEqual(['restoring', 'x']);
  });

  test('空消息 / 空历史都不炸', () => {
    expect(mergeActiveSessions(undefined, undefined, 'macmini')).toEqual([]);
    expect(mergeActiveSessions([], null, 'macmini')).toEqual([]);
  });

  test('不就地改传进来的数组与对象', () => {
    const incoming = [{ sessionId: 'a' }];
    const prev = [sess('b', 'gpuserver1')];
    mergeActiveSessions(prev, incoming, 'macmini');
    expect(incoming[0].machineId).toBeUndefined();
    expect(prev).toHaveLength(1);
  });
});
