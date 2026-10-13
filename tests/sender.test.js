const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-test-'));
process.env.VIBEANYTHING_HOME = tmpHome;

const { resolveEventType } = require('../lib/sender');

test('resolveEventType maps Stop to task_complete', () => {
  assert.strictEqual(resolveEventType('Stop', {}), 'task_complete');
});

test('resolveEventType maps Notification to permission_request', () => {
  assert.strictEqual(resolveEventType('Notification', {}), 'permission_request');
});

test('resolveEventType maps PostToolUseFailure to tool_failure', () => {
  assert.strictEqual(resolveEventType('PostToolUseFailure', {}), 'tool_failure');
});

test('resolveEventType maps PreToolUse guard to danger_blocked', () => {
  assert.strictEqual(resolveEventType('PreToolUse', { guard: true }), 'danger_blocked');
});

test('resolveEventType defaults to task_complete for unknown events', () => {
  assert.strictEqual(resolveEventType('UnknownEvent', {}), 'task_complete');
});
