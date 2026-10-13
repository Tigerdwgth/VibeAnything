const { test } = require('node:test');
const assert = require('node:assert');
const { generateSign, buildCardPayload } = require('../lib/feishu-webhook');

test('generateSign produces valid base64 string', () => {
  const { timestamp, sign } = generateSign('test-secret');
  assert.ok(typeof timestamp === 'string');
  assert.ok(timestamp.length > 0);
  assert.match(sign, /^[A-Za-z0-9+/]+=*$/);
});

test('buildCardPayload returns correct structure for task_complete', () => {
  const payload = buildCardPayload({
    type: 'task_complete',
    cwd: '/home/user/project',
    fields: [{ label: 'Claude 回复摘要', value: 'Done!' }]
  });
  assert.strictEqual(payload.msg_type, 'interactive');
  assert.ok(payload.card.header.title.content.includes('任务完成'));
  assert.strictEqual(payload.card.header.template, 'green');
  const content = payload.card.elements[0].text.content;
  assert.ok(content.includes('Claude 回复摘要'));
  assert.ok(content.includes('Done!'));
});

test('buildCardPayload returns correct structure for danger_blocked', () => {
  const payload = buildCardPayload({
    type: 'danger_blocked',
    cwd: '/home/user/project',
    fields: [{ label: '命令', value: 'rm -rf /' }]
  });
  assert.ok(payload.card.header.title.content.includes('拦截'));
  assert.strictEqual(payload.card.header.template, 'red');
});

test('buildCardPayload returns correct structure for tool_failure', () => {
  const payload = buildCardPayload({
    type: 'tool_failure',
    cwd: '/home/user/project',
    fields: [
      { label: '工具', value: 'Bash' },
      { label: '错误', value: 'command not found' }
    ]
  });
  assert.ok(payload.card.header.title.content.includes('失败'));
  assert.strictEqual(payload.card.header.template, 'orange');
  const content = payload.card.elements[0].text.content;
  assert.ok(content.includes('工具'));
  assert.ok(content.includes('Bash'));
});

test('buildCardPayload returns correct structure for permission_request', () => {
  const payload = buildCardPayload({
    type: 'permission_request',
    cwd: '/home/user/project',
    fields: [{ label: '通知类型', value: 'permission_prompt' }]
  });
  assert.ok(payload.card.header.title.content.includes('确认'));
  assert.strictEqual(payload.card.header.template, 'yellow');
});

test('buildCardPayload with empty fields still works', () => {
  const payload = buildCardPayload({
    type: 'task_complete',
    cwd: '/test',
    fields: []
  });
  assert.ok(payload.card.elements[0].text.content.includes('/test'));
});
