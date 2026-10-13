const { test } = require('node:test');
const assert = require('node:assert');
const { buildAppCardContent, buildTokenRequestBody } = require('../lib/feishu-app');

test('buildTokenRequestBody returns correct structure', () => {
  const body = buildTokenRequestBody('app123', 'secret456');
  assert.strictEqual(body.app_id, 'app123');
  assert.strictEqual(body.app_secret, 'secret456');
});

test('buildAppCardContent returns stringified JSON', () => {
  const content = buildAppCardContent({
    type: 'task_complete',
    cwd: '/project',
    fields: [{ label: '会话ID', value: 'abc123' }]
  });
  assert.strictEqual(typeof content, 'string');
  const parsed = JSON.parse(content);
  assert.ok(parsed.header);
  assert.ok(parsed.elements);
  assert.ok(parsed.config);
  assert.ok(parsed.elements[0].text.content.includes('会话ID'));
});

test('buildAppCardContent for danger_blocked has red template', () => {
  const content = buildAppCardContent({
    type: 'danger_blocked',
    cwd: '/project',
    fields: [{ label: '命令', value: 'rm -rf /' }]
  });
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.header.template, 'red');
  assert.ok(parsed.header.title.content.includes('拦截'));
});

test('buildAppCardContent with empty fields', () => {
  const content = buildAppCardContent({
    type: 'task_complete',
    cwd: '/project',
    fields: []
  });
  const parsed = JSON.parse(content);
  assert.ok(parsed.elements[0].text.content.includes('/project'));
});
