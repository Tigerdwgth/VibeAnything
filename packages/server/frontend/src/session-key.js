// 会话在前端的唯一标识：machineId + sessionId。桌面版（Dashboard / SessionTabs）与
// 手机版（MobileShell / MobileSessionList / useRelay）共用。
//
// 为什么不能只认 sessionId：它就是开发机上的 tmux 名（手动建的会话直接用 tmux 名，
// 见 lib/ws-client.js 的 getTmuxSessions），两台机器上重名很常见（0、main、dev…）。
// 只按 sessionId 比对时，点 B 机的 main 会切到已经开着的 A 机 main，打的字发去 A 机
// （2026-11-06 复现）；停止 / 关闭 / 状态灯也会串到另一台。

/** 打开列表、可见性、React key 统一用的键。 */
export function sessionKey(machineId, sessionId) {
  return `${machineId}::${sessionId}`;
}

/** s（带 machineId / sessionId 的对象，可为 null）是不是这台机器上的这个会话。 */
export function isSameSession(s, machineId, sessionId) {
  return !!s && s.machineId === machineId && s.sessionId === sessionId;
}

/**
 * 会话改名（session_renamed）后把开着的标签指向新名。
 * sessionId 就是 tmux 名，改名后旧名已经不存在：不跟着换的话，下次重连那个标签会照旧名
 * 发 open_terminal，开发机找不到就**新建**一个同名会话，再跑一遍启动命令。
 * 命令里也可能带着旧名（`claude --resume <id>`），一起换掉。
 *
 * @param {object[]} openTerminals [{ machineId, sessionId, cwd, command }]
 * @returns {object[]} 新列表；没有命中时原样返回
 */
export function renameOpenTerminals(openTerminals, machineId, oldSessionId, newSessionId) {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return openTerminals;
  if (!openTerminals.some(t => isSameSession(t, machineId, oldSessionId))) return openTerminals;
  return openTerminals.map(t => (
    isSameSession(t, machineId, oldSessionId)
      ? { ...t, sessionId: newSessionId, command: t.command?.map(a => (a === oldSessionId ? newSessionId : a)) }
      : t
  ));
}
