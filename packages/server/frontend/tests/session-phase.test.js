// 会话工作阶段的推导（pixel-office/sessionPhase.ts）：小镇上「谁在干、谁干完了在等你、
// 谁卡在权限确认上」全靠它。数据只有 isRunning（2.5 秒一轮）和 hook 事件（即时）两路，
// 各有盲区，这里把两路怎么合起来钉死。

import { describe, test, expect } from 'vitest';
import {
  phaseFromRunning, phaseFromHook, phaseAfterFocus, sortRoster, rosterRank,
} from '../src/pixel-office/sessionPhase.ts';

describe('会话列表推进阶段', () => {
  test('第一次见到：在跑 = 工作中，不在跑 = 空闲（一开始就闲着的不算「干完了」）', () => {
    expect(phaseFromRunning(undefined, undefined, true)).toBe('working');
    expect(phaseFromRunning(undefined, undefined, false)).toBe('idle');
  });

  test('列表自己从在跑翻到不在跑 → 干完了', () => {
    expect(phaseFromRunning('working', true, false)).toBe('done');
  });

  test('hook 刚点亮、列表还是旧的 false → 仍是工作中，不是「干完了」', () => {
    expect(phaseFromRunning('working', false, false)).toBe('working');
  });

  test('卡在权限确认上时灯是熄的 → 保持「等你确认」，直到重新在跑', () => {
    expect(phaseFromRunning('permission', true, false)).toBe('permission');
    expect(phaseFromRunning('permission', false, true)).toBe('working');
  });

  test('干完了 / 空闲 在不跑的时候原样保持（重复推进是幂等的）', () => {
    expect(phaseFromRunning('done', false, false)).toBe('done');
    expect(phaseFromRunning('idle', false, false)).toBe('idle');
  });
});

describe('hook 事件推进阶段', () => {
  test('UserPromptSubmit → 工作中；PermissionRequest → 等你确认', () => {
    expect(phaseFromHook('idle', { hookEvent: 'UserPromptSubmit' })).toBe('working');
    expect(phaseFromHook('working', { hookEvent: 'PermissionRequest' })).toBe('permission');
  });

  test('Stop / StopFailure：正在干或卡在权限上的才算干完了，闲着的不动', () => {
    expect(phaseFromHook('working', { hookEvent: 'Stop' })).toBe('done');
    expect(phaseFromHook('permission', { hookEvent: 'StopFailure' })).toBe('done');
    expect(phaseFromHook('idle', { hookEvent: 'Stop' })).toBe('idle');
  });

  test('Interrupt / SessionEnd：用户自己在终端里按停的 → 空闲，不提醒', () => {
    expect(phaseFromHook('working', { hookEvent: 'Interrupt' })).toBe('idle');
    expect(phaseFromHook('done', { hookEvent: 'SessionEnd' })).toBe('idle');
  });

  test('Notification 带子类型时以子类型为准', () => {
    expect(phaseFromHook('working', { hookEvent: 'Notification', notificationType: 'permission_prompt' })).toBe('permission');
    expect(phaseFromHook('done', { hookEvent: 'Notification', notificationType: 'elicitation_dialog' })).toBe('permission');
    expect(phaseFromHook('working', { hookEvent: 'Notification', notificationType: 'idle_prompt' })).toBe('working');
  });

  test('Notification 没带子类型（当前 daemon）：只有干活时收到才是权限确认', () => {
    expect(phaseFromHook('working', { hookEvent: 'Notification' })).toBe('permission');
    expect(phaseFromHook('done', { hookEvent: 'Notification' })).toBe('done');
  });

  test('无关事件原样返回', () => {
    expect(phaseFromHook('working', { hookEvent: 'PreToolUse' })).toBe('working');
  });
});

test('打开终端只清「干完了」，不碰别的阶段', () => {
  expect(phaseAfterFocus('done')).toBe('idle');
  expect(phaseAfterFocus('working')).toBe('working');
  expect(phaseAfterFocus('permission')).toBe('permission');
});

describe('会话列表排序', () => {
  const e = (key, phase, offline = false, label = key, machine = 'm') => ({ key, label, machine, phase, offline });

  test('等你确认 → 干完了 → 工作中 → 空闲 → 离线', () => {
    const sorted = sortRoster([
      e('a', 'idle'), e('b', 'working'), e('c', 'done', true), e('d', 'done'), e('e', 'permission'),
    ]);
    expect(sorted.map((x) => x.key)).toEqual(['e', 'd', 'b', 'a', 'c']);
    expect(rosterRank('done', true)).toBe(4);
  });

  test('同档按名字、再按机器排，与输入顺序无关（列表不会随刷新抖动）', () => {
    const items = [e('1', 'idle', false, 'zeta', 'm1'), e('2', 'idle', false, 'alpha', 'm2'), e('3', 'idle', false, 'alpha', 'm1')];
    const a = sortRoster(items).map((x) => x.key);
    const b = sortRoster([...items].reverse()).map((x) => x.key);
    expect(a).toEqual(['3', '2', '1']);
    expect(b).toEqual(a);
  });
});
