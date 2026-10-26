// 终端里的复制 / 粘贴快捷键判定（从 TerminalPanel.jsx 抽出，便于单测）。
//
// ── 为什么 Windows / Linux 上 Ctrl+V 粘贴不了 ──
// xterm.js 在非 Mac 平台把 Ctrl+字母一律编成控制字符（Ctrl+V → \x16）发给应用，
// 并且 preventDefault —— 浏览器的原生粘贴从此不会发生：既没有文字粘贴，也没有 paste
// 事件，terminal-upload.js 接管截图 / 文件的入口同样收不到。
// Mac 上粘贴是 Cmd+V，xterm 不碰 metaKey，所以一直正常。
//
// 解法与 VS Code / Windows Terminal 一致：Ctrl+V 归浏览器粘贴。自定义按键处理返回
// false 时 xterm 直接放手、**不** preventDefault（xterm 6.0.0 CoreBrowserTerminal._keyDown），
// 原生 paste 事件照常发生，文字走 xterm 自己的粘贴（含 bracketed paste），文件走上传。
// 代价是 Windows 上不能再把 \x16 发进终端；远端 claude 的 Ctrl+V 读的是开发机的剪贴板，
// 在浏览器里本来就用不上，浏览器粘贴截图会上传后把路径敲进去。
//
// Ctrl+Shift+V / Shift+Insert 本来就不被 xterm 编码，浏览器原生粘贴，无需处理。

/** 与 xterm 的 isMac 判定同源：navigator.platform 以 Mac 开头（含 iPad 伪装的 MacIntel）。 */
export function isMacPlatform(platform) {
  return /^Mac/.test(platform || '');
}

/**
 * @param {KeyboardEvent} e
 * @param {{ isMac: boolean, hasSelection: boolean }} ctx
 * @returns {'copy' | 'paste' | null}
 *   copy  —— 有选中时 Ctrl+C / Ctrl+Shift+C：复制选区，不发 SIGINT
 *   paste —— 非 Mac 的 Ctrl+V：交给浏览器原生粘贴
 *   null  —— 照常交给 xterm
 */
export function clipboardKeyAction(e, { isMac, hasSelection }) {
  if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = (e.key || '').toLowerCase();
  if (key === 'c' && hasSelection) return 'copy';
  if (key === 'v' && !e.shiftKey && !isMac) return 'paste';
  return null;
}
