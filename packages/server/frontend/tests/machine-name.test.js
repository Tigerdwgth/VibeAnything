// 机器名的显示形态。桌面版会话列表、机器下拉、开发机面板共用这一份规则，
// 所以它错了是三处一起错 —— 表现为侧栏里一排被截断成省略号、分不出是哪台机器。
//
// 真实样本：线上 relay 当前连着的四台就包含一个带 DNS 域的名字
// （macair.tailnet-example.ts.net，daemon 用主机名当 machineId 的结果）。

import { describe, test, expect } from 'vitest';
import { shortMachineId, machineTitle } from '../src/machine-name.js';

describe('短名', () => {
  test('带 DNS 域的主机名只留第一段（线上真实样本）', () => {
    expect(shortMachineId('macair.tailnet-example.ts.net')).toBe('macair');
    expect(shortMachineId('mac-mini.local')).toBe('mac-mini');
  });

  test('本来就短的名字原样留着', () => {
    expect(shortMachineId('macmini')).toBe('macmini');
    expect(shortMachineId('gpuserver1-jdh')).toBe('gpuserver1-jdh');
    expect(shortMachineId('server-47115')).toBe('server-47115');
    expect(shortMachineId('aliyun-derper')).toBe('aliyun-derper');
  });

  test('带编号的名字一个字都不能丢 —— 编号正是用来区分同批机器的', () => {
    // 旧实现「超过两段只留前两段」会把这两台显示成同一个 gpu-4090
    expect(shortMachineId('gpu-4090-05')).toBe('gpu-4090-05');
    expect(shortMachineId('gpu-4090-06')).toBe('gpu-4090-06');
  });

  test('k8s 那种长名字保持完整，交给 CSS 省略号 + title，不做有损截断', () => {
    expect(shortMachineId('aibox-r061c3847202-cdb678b8b-h5jjf')).toBe('aibox-r061c3847202-cdb678b8b-h5jjf');
    expect(shortMachineId('aibox-r061-cdb678b8b-h5jjf.cluster.local')).toBe('aibox-r061-cdb678b8b-h5jjf');
  });

  test('空值与 local 回 local（会话可能来自没报名字的连接）', () => {
    expect(shortMachineId('')).toBe('local');
    expect(shortMachineId(null)).toBe('local');
    expect(shortMachineId(undefined)).toBe('local');
    expect(shortMachineId('local')).toBe('local');
  });
});

describe('悬停提示', () => {
  test('短名与真名不一致时才给 title —— 一致时多余的悬停提示是噪音', () => {
    expect(machineTitle('macair.tailnet-example.ts.net')).toBe('macair.tailnet-example.ts.net');
    expect(machineTitle('macmini')).toBeUndefined();
  });
});
