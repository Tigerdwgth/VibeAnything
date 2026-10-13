// 斜杠命令（/clear、/compact）的发送时序。桌面版和手机版共用这一份实现。
//
// 要守的是「先 Ctrl+C 再发命令」这个顺序：少了那个打断，Claude Code 正停在补全菜单或
// 确认框上时会把 `/clear` 当成普通输入吃掉 —— 表现为「点了没反应」，而终端里什么错都没有。

import { describe, test, expect } from 'vitest';
import { SLASH_COMMANDS, INTERRUPT_DELAY_MS, sendSlashCommand } from '../src/slash-commands.js';

/** 收集发出去的字节 + 被排期的回调，不等真定时器。 */
function harness() {
  const sent = [];
  const scheduled = [];
  return {
    sent,
    scheduled,
    sendText: (t) => sent.push(t),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    runPending: () => { const jobs = scheduled.splice(0); jobs.forEach(j => j.fn()); },
  };
}

describe('sendSlashCommand', () => {
  test('先发 Ctrl+C，命令排在后面而不是同一时刻发出', () => {
    const h = harness();
    sendSlashCommand(h.sendText, '/clear', { schedule: h.schedule });
    // 关键：此刻只发了打断，命令还没发
    expect(h.sent).toEqual(['\x03']);
    expect(h.scheduled).toHaveLength(1);

    h.runPending();
    expect(h.sent).toEqual(['\x03', '/clear\r']);
  });

  test('命令自带回车 —— 少了它只是把字打进去，不会执行', () => {
    const h = harness();
    sendSlashCommand(h.sendText, '/compact', { schedule: h.schedule });
    h.runPending();
    expect(h.sent.at(-1)).toBe('/compact\r');
  });

  test('打断与命令之间留了间隔，默认 %d ms'.replace('%d', INTERRUPT_DELAY_MS), () => {
    const h = harness();
    sendSlashCommand(h.sendText, '/clear', { schedule: h.schedule });
    expect(h.scheduled[0].ms).toBe(INTERRUPT_DELAY_MS);
    expect(INTERRUPT_DELAY_MS).toBeGreaterThan(0);
  });

  test('间隔可调（给慢机器留余地）', () => {
    const h = harness();
    sendSlashCommand(h.sendText, '/clear', { schedule: h.schedule, delayMs: 200 });
    expect(h.scheduled[0].ms).toBe(200);
  });

  test('SLASH_COMMANDS 就是工具条上要渲染的那几个，都以 / 开头', () => {
    expect(SLASH_COMMANDS).toEqual(['/clear', '/compact']);
    for (const cmd of SLASH_COMMANDS) expect(cmd.startsWith('/')).toBe(true);
  });

  test('默认用真 setTimeout（不传 schedule 时不会同步发出命令）', async () => {
    const sent = [];
    sendSlashCommand((t) => sent.push(t), '/clear', { delayMs: 1 });
    expect(sent).toEqual(['\x03']);              // 同步阶段只有打断
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toEqual(['\x03', '/clear\r']);  // 定时器到点后才补上命令
  });
});
