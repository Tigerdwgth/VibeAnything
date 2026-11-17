// 会话置顶：把不同开发机上的会话聚到列表最上面的「置顶」组。桌面版（SessionTabs）与
// 手机版（MobileShell / MobileSessionList / useRelay）共用。无 React 依赖，可单测。
//
// 数据从哪来：置顶记在 relay 上、按登录用户存（packages/server/session-pins.js），
// relay 下发 active_sessions 时给置顶的那几条带上 `pinnedAt`（置顶时刻的毫秒时间戳），
// 没置顶的不带这个字段。所以这里**不存任何状态**，只对会话列表做切分 ——
// 桌面版置顶了，手机版收到的列表里就已经是置顶的。
//
// 置顶的会话只出现在置顶组里，不在原来的开发机分组里再出现一次；它在开发机上的文件夹
// 归属（folderId）原样留着，取消置顶就回到原处。

export function isPinned(session) {
  return !!session?.pinnedAt;
}

/**
 * 把会话列表切成「置顶的」和「其余的」。
 * 置顶组按置顶先后排（先置顶的在上，新置顶的接在后面）—— 位置稳定，不随会话活跃度跳动；
 * 其余的保持原顺序。
 * @param {object[]} sessions 各开发机的会话（带 machineId）
 * @returns {{ pinned: object[], rest: object[] }}
 */
export function splitPinned(sessions) {
  const pinned = [];
  const rest = [];
  for (const s of (Array.isArray(sessions) ? sessions : [])) (isPinned(s) ? pinned : rest).push(s);
  pinned.sort((a, b) => a.pinnedAt - b.pinnedAt);
  return { pinned, rest };
}

/**
 * 点下「置顶 / 取消置顶」后立刻反映到本地列表，不等 relay 回推（回推随后到，以它为准）。
 * @param {object[]} sessions 现有会话列表
 * @param {boolean} pinned true = 置顶，false = 取消
 * @param {number} [now] 本地暂用的置顶时间；relay 回推时会换成它记下的那个
 * @returns {object[]} 新列表；没有命中的会话时原样返回
 */
export function applyPin(sessions, machineId, sessionId, pinned, now = Date.now()) {
  const hit = (s) => s.machineId === machineId && s.sessionId === sessionId;
  if (!sessions.some(s => hit(s) && isPinned(s) !== !!pinned)) return sessions;
  return sessions.map((s) => {
    if (!hit(s)) return s;
    if (pinned) return { ...s, pinnedAt: now };
    const { pinnedAt: _dropped, ...unpinned } = s;
    return unpinned;
  });
}
