const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-admin-users-'));
process.env.DB_PATH = path.join(tmp, 'users.db');
process.env.JWT_SECRET = 'admin-users-test-secret';
const { createUser, generateToken, listUsers } = require('../auth');
const { app } = require('../index');
let server, base, adminToken, userToken;
before(async () => {
  adminToken = generateToken(await createUser('admin', 'test-password', 'admin'));
  userToken = generateToken(await createUser('member', 'test-password', 'user'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true }); });
test('创建用户接口执行既定管理员权限，普通登录用户不能创建账号', async () => {
  for (const [token, expected] of [[null, 401], [userToken, 403], [adminToken, 200]]) {
    const response = await fetch(base + '/api/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ username: 'new-member', password: 'test-password' }),
    });
    assert.equal(response.status, expected);
  }
  assert.equal((await listUsers()).filter(user => user.username === 'new-member').length, 1);
});
