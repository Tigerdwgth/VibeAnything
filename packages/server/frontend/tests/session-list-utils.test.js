import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  getRunningSessionCommand,
  getRunningSessionDetail,
  getRunningSessionTitle,
  toolName,
} from '../src/session-list-utils.js';

test('toolName keeps claude explicit instead of collapsing to cc', () => {
  assert.equal(toolName(['claude']), 'claude');
  assert.equal(toolName(['codex']), 'codex');
});

test('running session title prefers project directory name', () => {
  assert.equal(
    getRunningSessionTitle({ sessionId: 'new-codex-1710000000000', cwd: '/workspace/emos' }),
    'emos',
  );
});

test('running session title shows user-given name for renamed/manual sessions', () => {
  // 用户重命名后的会话（tmux 名即新名）应直接显示该名，而非 cwd 末段
  assert.equal(
    getRunningSessionTitle({ sessionId: '我的项目', cwd: '/workspace/emos' }),
    '我的项目',
  );
  assert.equal(getRunningSessionTitle({ sessionId: 'mywork', cwd: '/home/x' }), 'mywork');
});

test('running session detail shows full cwd for restore disambiguation', () => {
  assert.equal(
    getRunningSessionDetail({ sessionId: 'new-codex-1710000000000', cwd: '/workspace/emos' }),
    '/workspace/emos',
  );
});

test('running session command follows the actual tool type', () => {
  assert.deepEqual(
    getRunningSessionCommand({ sessionId: 'new-codex-1710000000000', tool: 'codex' }),
    ['codex'],
  );
  assert.deepEqual(
    getRunningSessionCommand({ sessionId: 'sess-123', tool: 'claude' }),
    ['claude', '--resume', 'sess-123'],
  );
});
