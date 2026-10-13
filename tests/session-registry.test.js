const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR = tmpDir;

const {
  registerSession,
  getSession,
  listActiveSessions,
  removeSession,
  touchSession,
  SESSION_TTL_MS
} = require('../lib/session-registry');

test('registerSession creates session file', () => {
  registerSession({
    machineId: 'machine-1',
    sessionId: 'sess-aaa',
    cwd: '/tmp/project-a',
    pid: 1234
  });
  const sess = getSession('machine-1', 'sess-aaa');
  assert.ok(sess);
  assert.strictEqual(sess.machineId, 'machine-1');
  assert.strictEqual(sess.sessionId, 'sess-aaa');
  assert.strictEqual(sess.cwd, '/tmp/project-a');
  assert.ok(sess.registeredAt > 0);
  assert.ok(sess.lastActivity > 0);
});

test('listActiveSessions returns only non-expired sessions', () => {
  registerSession({ machineId: 'machine-1', sessionId: 'sess-bbb', cwd: '/tmp/b', pid: 2 });
  const list = listActiveSessions();
  assert.ok(list.length >= 2);
  assert.ok(list.some(s => s.sessionId === 'sess-aaa'));
  assert.ok(list.some(s => s.sessionId === 'sess-bbb'));
});

test('touchSession updates lastActivity', () => {
  const before = getSession('machine-1', 'sess-aaa');
  const origTime = before.lastActivity;
  touchSession('machine-1', 'sess-aaa');
  const after = getSession('machine-1', 'sess-aaa');
  assert.ok(after.lastActivity >= origTime);
});

test('removeSession deletes session file', () => {
  removeSession('machine-1', 'sess-bbb');
  const sess = getSession('machine-1', 'sess-bbb');
  assert.strictEqual(sess, null);
});

test('SESSION_TTL_MS is 7 days', () => {
  assert.strictEqual(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});
