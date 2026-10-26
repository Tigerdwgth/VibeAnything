// 「这是手机/平板」的判定。桌面版终端据此决定要不要压住 xterm 的输入框（防止自动弹出键盘）。
//
// 不能用「有没有触摸能力」（'ontouchstart' in window / maxTouchPoints > 0）：Windows 触屏笔记本
// 也有触摸能力，被当成手机后 xterm 的 helper textarea 被设成 readonly —— 普通按键靠 keydown
// 还能打出来，但**输入法提交的字符**（中文、全角标点、输入法开着时的 Shift+符号）都要写进
// textarea 才能被 xterm 读到，readonly 下全部丢失。
//
// 改看主指针：手机/平板的主指针是手指（pointer: coarse）且不能悬停（hover: none）；
// 笔记本即使带触屏，主指针也是鼠标/触控板。
export function isTouchOnlyDevice(win = window) {
  return !!win.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
}
