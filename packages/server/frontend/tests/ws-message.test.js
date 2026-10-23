import { test, expect } from 'vitest';
import { parseWsMessage } from '../src/ws-message.js';

test('同一个事件对象只解析一次，各监听者拿到同一个结果对象', () => {
  const e = new MessageEvent('message', { data: JSON.stringify({ type: 'pty_data', sessionId: 's' }) });
  const a = parseWsMessage(e);
  const b = parseWsMessage(e);
  expect(a).toEqual({ type: 'pty_data', sessionId: 's' });
  expect(b).toBe(a);
});

test('非 JSON 帧返回 null，也只尝试一次', () => {
  const e = new MessageEvent('message', { data: 'not json' });
  expect(parseWsMessage(e)).toBeNull();
  expect(parseWsMessage(e)).toBeNull();
});

test('不同事件各自解析', () => {
  const e1 = new MessageEvent('message', { data: '{"n":1}' });
  const e2 = new MessageEvent('message', { data: '{"n":2}' });
  expect(parseWsMessage(e1).n).toBe(1);
  expect(parseWsMessage(e2).n).toBe(2);
});
