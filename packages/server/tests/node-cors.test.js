const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { nodeCors } = require('../node-cors');
let server, base;
before(async () => {
  const app = express();
  app.use(nodeCors('https://board.example, http://localhost:5173'));
  app.post('/api/login', (_req, res) => res.json({ token: 'local-token' }));
  app.post('/api/session/refresh', (_req, res) => res.status(401).json({ error: 'expired' }));
  app.get('/api/me', (_req, res) => res.json({ username: 'local' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
test('被允许的看板可以预检登录和续期，401 响应仍能被浏览器读取', async () => {
  for (const path of ['/api/login', '/api/session/refresh']) {
    const preflight = await fetch(base + path, { method: 'OPTIONS', headers: {
      Origin: 'https://board.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://board.example');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  }
  const expired = await fetch(base + '/api/session/refresh', { method: 'POST', headers: { Origin: 'https://board.example' } });
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('access-control-allow-origin'), 'https://board.example');
});
test('普通同源请求照常处理，其他来源和无关 API 不增加跨域许可', async () => {
  const same = await fetch(base + '/api/login', { method: 'POST' });
  assert.equal(same.status, 200);
  for (const [path, origin, method] of [['/api/login', 'https://other.example', 'POST'], ['/api/me', 'https://board.example', 'GET']]) {
    const response = await fetch(base + path, { method, headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});
