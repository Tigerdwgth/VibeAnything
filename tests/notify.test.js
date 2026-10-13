const { test } = require('node:test');
const assert = require('node:assert');

test('notify should not truncate long messages', () => {
  const longMsg = 'A'.repeat(1000);
  const data = {
    hook_event_name: 'Stop',
    session_id: 'test-session',
    last_assistant_message: longMsg,
    transcript_path: '/tmp/transcript.jsonl'
  };
  const { buildFields } = require('../hooks/notify');
  const fields = buildFields('Stop', data);
  const msgField = fields.find(f => f.label === 'Claude 回复');
  assert.ok(msgField, '应包含 Claude 回复字段');
  assert.strictEqual(msgField.value, longMsg, '不应截断消息');
  assert.strictEqual(msgField.value.length, 1000);
});

test('notify should not truncate tool input', () => {
  const longCmd = 'echo ' + 'x'.repeat(500);
  const data = {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: longCmd },
    error: 'E'.repeat(500)
  };
  const { buildFields } = require('../hooks/notify');
  const fields = buildFields('PostToolUseFailure', data);
  const inputField = fields.find(f => f.label === '输入');
  assert.ok(inputField);
  assert.strictEqual(inputField.value, longCmd, '不应截断输入');
  const errorField = fields.find(f => f.label === '错误');
  assert.strictEqual(errorField.value, 'E'.repeat(500), '不应截断错误');
});
