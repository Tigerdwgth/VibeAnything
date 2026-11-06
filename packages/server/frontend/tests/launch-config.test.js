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

test('createSessionId：带路径和点号的命令折成只含字母数字和 - 的 tmux 名', () => {
  assert.equal(createSessionId(['/usr/bin/Python3.11', '-m', 'x'], 1700000000000), 'new-python3-11-1700000000000');
});

test('createSessionId：超长命令名截短，总长不超过 relay 的 48 上限', () => {
  const id = createSessionId(['a'.repeat(100)], 1700000000000);
  assert.ok(id.length <= 48);
  assert.match(id, /^new-[a-z0-9_-]+-1700000000000$/);
});
