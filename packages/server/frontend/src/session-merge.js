// 多机会话列表的合并规则。桌面版（Dashboard.jsx）与手机版（src/mobile/useRelay.js）共用。
//
// 为什么不能直接 setSessions(msg.sessions)：relay 的 `active_sessions` 是**按机器**下发的，
// 每条消息只带一台机器的全量会话。整表替换会把其它机器的会话一起清空
// —— 2026-02-27 踩过一次，表现为「多台开发机只剩最后一条消息那台」。
// 所以合并必须以 machineId 为分区键：只替换这台机器的分区，别人的原样留着。
//
// `_optimistic` 是前端自己塞进去的占位（恢复历史会话时立刻显示「恢复中…」，
// 10 秒后自行清掉）。它没有对应的服务端记录，按 machineId 过滤会把它误删，
// 所以单独拎出来保留；服务端真的把它扫出来了（同 sessionId）就让位给真数据。

/**
 * 合并一条 `active_sessions` 到现有列表。
 * @param {object[]} prev      现有列表（含其它机器与本地乐观占位）
 * @param {object[]} incoming  这条消息里的会话（该机器的全量）
 * @param {string}   machineId 这条消息属于哪台机器
 * @returns {object[]} 合并后的新列表
 */
export function mergeActiveSessions(prev, incoming, machineId) {
  const serverSessions = (incoming || []).map(s => ({ ...s, machineId }));
  const list = prev || [];
  const otherMachines = list.filter(s => s.machineId !== machineId && !s._optimistic);
  const optimistic = list.filter(
    s => s._optimistic && !serverSessions.some(ss => ss.sessionId === s.sessionId)
  );
  return [...otherMachines, ...serverSessions, ...optimistic];
}
