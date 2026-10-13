// tests/active-sessions.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  scanActiveSessions,
  getTmuxSessions,
  inferActiveSessionTool,
  mergeActiveSessionMetadata,
} = require('../lib/ws-client');

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const tmuxKill = (name) => spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
const tmuxNew = (name) => spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });

test('scanActiveSessions returns array', () => {
  const result = scanActiveSessions();
  assert.ok(Array.isArray(result));
});

test('active session has required fields', () => {
  const result = scanActiveSessions();
  for (const s of result) {
    assert.ok('sessionId' in s);
    assert.ok('cwd' in s);
    assert.strictEqual(typeof s.mtime, 'number');
  }
});

test('mergeActiveSessionMetadata keeps tmux cwd and infers codex tool without claude jsonl metadata', () => {
  const tmuxSessions = [{
    tmuxName: 'cc-new-codex-1710000000000',
    sessionIdPrefix: 'new-codex-1710000000000',
    cwd: '/workspace/emos',
    startCommand: "bash -l -c 'exec codex'",
    activityMs: 1710000000000,
  }];

  const result = mergeActiveSessionMetadata(tmuxSessions, new Map());

  assert.deepStrictEqual(result, [{
    sessionId: 'new-codex-1710000000000',
    cwd: '/workspace/emos',
    mtime: 1710000000000,
    tool: 'codex',
  }]);
});

test('mergeActiveSessionMetadata prefers claude jsonl metadata when available', () => {
  const tmuxSessions = [{
    tmuxName: 'cc-sess-123',
    sessionIdPrefix: 'sess-123',
    cwd: '/workspace/fallback',
    startCommand: "bash -l -c 'exec claude --resume sess-123'",
    activityMs: 1710000000000,
  }];
  const claudeMeta = new Map([
    ['sess-123', {
      sessionId: 'sess-123',
      cwd: '/workspace/real-project',
      mtime: 1710000001234,
    }],
  ]);

  const result = mergeActiveSessionMetadata(tmuxSessions, claudeMeta);

  assert.deepStrictEqual(result, [{
    sessionId: 'sess-123',
    cwd: '/workspace/real-project',
    mtime: 1710000001234,
    tool: 'claude',
  }]);
});

test('inferActiveSessionTool recognizes dashboard session ids and start commands', () => {
  assert.equal(inferActiveSessionTool('new-claude-1710000000000', ''), 'claude');
  assert.equal(inferActiveSessionTool('new-codex-1710000000000', ''), 'codex');
  assert.equal(inferActiveSessionTool('opaque-session', "bash -l -c 'exec zsh'"), 'zsh');
});

test('mergeActiveSessionMetadata 透传手动会话（无 cc- 前缀、无 jsonl 元数据）', () => {
  const tmuxSessions = [{
    tmuxName: 'mywork',
    sessionIdPrefix: 'mywork',
    cwd: '/home/gsj/proj',
    startCommand: '',
    activityMs: 1710000000000,
  }];
  const result = mergeActiveSessionMetadata(tmuxSessions, new Map());
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].sessionId, 'mywork');
  assert.strictEqual(result[0].cwd, '/home/gsj/proj');
  assert.strictEqual(result[0].mtime, 1710000000000);
});

// ── 以下为真实 tmux 集成测试：验证“扫描到所有 tmux”这一改动 ──
test('getTmuxSessions 扫描到手动创建的非 cc- 会话，并以原名作为 sessionId', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-manual-${process.pid}`;
  tmuxKill(name); tmuxNew(name);
  try {
    const found = getTmuxSessions().find(s => s.tmuxName === name);
    assert.ok(found, '应扫描到手动 tmux 会话');
    assert.strictEqual(found.sessionIdPrefix, name, '非 cc- 会话的 sessionId 应为原名');
  } finally { tmuxKill(name); }
});

test('getTmuxSessions 对 cc- 前缀会话剥离前缀', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const raw = `unit${process.pid}`;
  const name = `cc-${raw}`;
  tmuxKill(name); tmuxNew(name);
  try {
    const found = getTmuxSessions().find(s => s.tmuxName === name);
    assert.ok(found);
    assert.strictEqual(found.sessionIdPrefix, raw, 'cc- 会话应剥离前缀');
  } finally { tmuxKill(name); }
});

test('scanActiveSessions 结果包含手动会话且 sessionId 为原名', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-scan-${process.pid}`;
  tmuxKill(name); tmuxNew(name);
  try {
    const found = scanActiveSessions().find(s => s.sessionId === name);
    assert.ok(found, 'scanActiveSessions 应包含手动会话');
    assert.strictEqual(typeof found.mtime, 'number');
  } finally { tmuxKill(name); }
});
