// 终端工具条上的斜杠命令。桌面版与手机版共用这一份。
//
// 抽出来是因为「先打断再发」这个细节两边必须一致：只发 `/clear\r` 的话，Claude Code
// 正停在补全菜单或确认框上时会把这行字当普通输入吃掉，用户看到的是「点了没反应」。
// 各写一遍迟早有一边漏掉那个 Ctrl-C。

export const SLASH_COMMANDS = ['/clear', '/compact'];

// 打断与命令之间的间隔：Ctrl-C 要先被程序处理完、退出当前输入态，后面这行字才落得进去。
export const INTERRUPT_DELAY_MS = 50;

/**
 * 发一条斜杠命令：先 Ctrl-C 打断，再把命令 + 回车敲进去。
 *
 * @param {(text: string) => void} sendText 往 PTY 写字节
 * @param {string} command 形如 '/clear'
 * @param {{delayMs?: number, schedule?: (fn: Function, ms: number) => unknown}} [options]
 *        schedule 可注入，单测里不必真等定时器
 */
export function sendSlashCommand(sendText, command, options = {}) {
  const { delayMs = INTERRUPT_DELAY_MS, schedule = setTimeout } = options;
  sendText('\x03');
  schedule(() => sendText(`${command}\r`), delayMs);
}
