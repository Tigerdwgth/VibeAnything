// 手机版工具条上每个键发给 PTY 的字节。
// 单独成文件：组件文件只导出组件（否则 react-refresh 的 Fast Refresh 会失效），
// 而且这些序列要被单测直接断言 —— 「按键发了什么」是这条工具条的全部契约。

export const KEY_SEQUENCES = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  ctrlC: '\x03',
  // 「继续」：Claude Code 停在确认点 / checkpoint 时一键续跑，语义与桌面版同一条
  resume: '继续\r',
};
