// 同一条 ws 消息会派发给多个监听者（Dashboard / 每个终端面板 / 目录浏览），
// 它们拿到的是同一个 MessageEvent 对象。按事件对象记住解析结果，
// 开着 N 个终端时每条 pty_data 只 JSON.parse 一次，而不是 N+1 次。
const parsed = new WeakMap();

/** 解析 ws 消息；非 JSON 帧返回 null。 */
export function parseWsMessage(e) {
  if (parsed.has(e)) return parsed.get(e);
  let msg = null;
  try { msg = JSON.parse(e.data); } catch { /* 非 JSON 帧 */ }
  parsed.set(e, msg);
  return msg;
}
