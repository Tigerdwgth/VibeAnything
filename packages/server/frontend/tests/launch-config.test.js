import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  CLI_CMDS,
  createSessionId,
  getLaunchCommand,
} from '../src/launch-config.js';

test('defaults to codex when no launch command is provided', () => {
  assert.deepEqual(getLaunchCommand(), ['codex']);
  assert.deepEqual(getLaunchCommand([]), ['codex']);
});

test('preserves explicit launch commands', () => {
  const command = ['claude'];
  assert.equal(getLaunchCommand(command), command);
});

test('builds new session ids from the effective command', () => {
  assert.equal(createSessionId(undefined, 1234), 'new-codex-1234');
  assert.equal(createSessionId(['claude'], 1234), 'new-claude-1234');
});

test('launcher menu still exposes both codex and claude', () => {
  const labels = CLI_CMDS.map(item => item.label);
  assert.ok(labels.includes('codex'));
  assert.ok(labels.includes('claude'));
});
