// packages/server/tests/auth.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

// 用临时数据库测试
process.env.DB_PATH = '/tmp/test-auth.db';
// 清理旧测试数据库
try { fs.unlinkSync('/tmp/test-auth.db'); } catch {}

const { createUser, verifyPassword, generateToken, verifyToken } = require('../auth');

test('createUser + verifyPassword', async () => {
  const user = await createUser('testuser', 'password123');
  assert.equal(user.username, 'testuser');
  const ok = await verifyPassword('testuser', 'password123');
  assert.ok(ok);
  const fail = await verifyPassword('testuser', 'wrongpass');
  assert.equal(fail, null);
});

test('generateToken + verifyToken', () => {
  const token = generateToken({ id: 1, username: 'testuser' });
  assert.ok(token);
  const payload = verifyToken(token);
  assert.equal(payload.username, 'testuser');
});

test('verifyToken invalid', () => {
  const result = verifyToken('invalid.token.here');
  assert.equal(result, null);
});
