// 会话的工作阶段：小镇上「谁在干、谁干完了在等你、谁卡在权限确认上」的唯一判据。
//
// 数据只有两路，而且各有盲区：
//  · active_sessions 里的 isRunning（与侧栏红绿灯同源，2.5 秒一轮）—— 只有「在跑 / 不在跑」，
//    分不出「干完了等你输入」和「本来就闲着」，也分不出「卡在权限确认上」；
//  · hook 事件（即时）—— 知道 Stop / PermissionRequest，但只在小镇开着时才收得到。
// 所以阶段要靠「上一次看到的状态 + 这一次的变化」推出来，状态本身存在集成层的模块级表里
// （画布状态也是模块级的，切走视图再切回来不能丢）。

import type { AgentPhase } from './types.js'

/**
 * 每轮会话列表到达时的阶段推进。
 *
 * @param cur        当前阶段（第一次见到这个会话时为 undefined）
 * @param wasRunning 上一轮会话列表里的 isRunning（第一次见到时为 undefined）
 * @param running    这一轮的 isRunning
 *
 * 「干完了」只认**会话列表自己**从在跑变成不在跑：hook 点亮（UserPromptSubmit）之后，
 * 下一轮列表可能还是旧的 false，那不是「干完了」，只是列表还没跟上。
 * 卡在权限确认上时 daemon 把灯熄了（isRunning=false），但人还没干完，阶段保持不动。
 */
export function phaseFromRunning(
  cur: AgentPhase | undefined,
  wasRunning: boolean | undefined,
  running: boolean,
): AgentPhase {
  if (running) return 'working'
  if (cur === 'working' && wasRunning === true) return 'done'
  return cur ?? 'idle'
}

/** hook 事件里与阶段有关的那几个字段（Dashboard 原样转发的 hook_event） */
export interface PhaseHook {
  hookEvent?: string
  /** Notification 的子类型。daemon 目前没有转发它（见汇报），有就以它为准 */
  notificationType?: string
}

/** 这几种通知说明 agent 停下来等人确认（与 hooks/status.js 的 WAITING_NOTIFICATIONS 对齐，去掉 idle_prompt） */
const PERMISSION_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

/**
 * hook 事件带来的阶段变化；与阶段无关的事件返回 cur 原样。
 *
 *  · UserPromptSubmit → 工作中
 *  · PermissionRequest / 权限类 Notification → 等权限
 *  · Stop / StopFailure → 正在干（或卡在权限上）的那个算「干完了」
 *  · Interrupt / SessionEnd → 空闲：是用户自己在终端里按停的，人就在那儿，不用再提醒
 *
 * Notification 没带子类型时（当前 daemon 的协议）：只有「正在干活」时收到才是权限确认 ——
 * 另一种常见的 idle_prompt 只会在 agent 已经停下 60 秒后才发，那时阶段早已不是 working。
 */
export function phaseFromHook(cur: AgentPhase | undefined, hook: PhaseHook): AgentPhase | undefined {
  switch (hook.hookEvent) {
    case 'UserPromptSubmit':
      return 'working'
    case 'PermissionRequest':
      return 'permission'
    case 'Notification':
      if (hook.notificationType) return PERMISSION_NOTIFICATIONS.has(hook.notificationType) ? 'permission' : cur
      return cur === 'working' ? 'permission' : cur
    case 'Stop':
    case 'StopFailure':
      return cur === 'working' || cur === 'permission' ? 'done' : cur
    case 'Interrupt':
    case 'SessionEnd':
      return cur === undefined ? cur : 'idle'
    default:
      return cur
  }
}

/** 用户去看过了（打开了它的终端）：「干完了」的提醒到此为止，其余阶段不受影响 */
export function phaseAfterFocus(cur: AgentPhase | undefined): AgentPhase | undefined {
  return cur === 'done' ? 'idle' : cur
}

/**
 * 会话列表的排序档位：要你动手的在最前（等权限、干完了等你），然后是正在干的，
 * 然后是闲着的，离线的垫底。
 */
export function rosterRank(phase: AgentPhase, offline: boolean): number {
  if (offline) return 4
  if (phase === 'permission') return 0
  if (phase === 'done') return 1
  if (phase === 'working') return 2
  return 3
}

export interface RosterEntry {
  key: string
  label: string
  machine: string
  phase: AgentPhase
  offline: boolean
}

/** 按档位排，同档按名字、再按机器排（结果与输入顺序无关，列表不会跟着刷新抖动） */
export function sortRoster<T extends RosterEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    rosterRank(a.phase, a.offline) - rosterRank(b.phase, b.offline)
    || a.label.localeCompare(b.label)
    || a.machine.localeCompare(b.machine)
    || a.key.localeCompare(b.key),
  )
}
