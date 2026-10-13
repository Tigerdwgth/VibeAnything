// tests/mobile-route.test.js
// 手机版入口路由 /m 的真实 HTTP 行为。
//
// 为什么非测不可：express 的 `app.get('*')` SPA fallback 会吞掉它后面登记的一切路由。
// /m 一旦被放到 fallback 之后，手机上打开 /m 拿到的是**桌面版**页面 —— 页面能打开、
// 状态码 200、控制台也不报错，只有人眼能看出来不对。所以这里起真 express 实例、
// 发真 HTTP 请求，断言 /m 拿到的确实是手机版那份 HTML。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// auth.js 在模块顶层就把 DB_PATH 读进常量，必须在 require 之前指到临时目录，
// 免得测试碰用户真实的 users.db。
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mobile-route-')), 'users.db');

const { app } = require('../packages/server/index.js');

const MOBILE_HTML = path.join(__dirname, '../packages/server/frontend/dist/mobile.html');
const DESKTOP_HTML = path.join(__dirname, '../packages/server/frontend/dist/index.html');

let server;
let port;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('/m 吐的是手机版 HTML，没有被 SPA fallback 吞掉', async () => {
  const res = await get('/m');
  if (fs.existsSync(MOBILE_HTML)) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, fs.readFileSync(MOBILE_HTML, 'utf8'));
  } else {
    // 没构建过：也必须是「手机版还没构建」这句话，而不是桌面版页面
    assert.strictEqual(res.status, 503);
    assert.match(res.body, /mobile/i);
  }
});

test('/m 与 / 拿到的不是同一个页面', async () => {
  const [mobile, desktop] = await Promise.all([get('/m'), get('/')]);
  assert.notStrictEqual(mobile.body, desktop.body);
});

test('/m/任意子路径 也进手机版（将来加前端路由，刷新不会 404）', async () => {
  const [root, deep] = await Promise.all([get('/m'), get('/m/session/abc')]);
  assert.strictEqual(deep.status, root.status);
  assert.strictEqual(deep.body, root.body);
});

test('桌面版 / 不受影响，仍然是 index.html', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 200);
  if (fs.existsSync(DESKTOP_HTML)) {
    assert.strictEqual(res.body, fs.readFileSync(DESKTOP_HTML, 'utf8'));
  }
});

test('其它未知路径仍然落到桌面版 SPA fallback', async () => {
  const [unknown, desktop] = await Promise.all([get('/whatever/deep/path'), get('/')]);
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.body, desktop.body);
});

test('/m 没有遮住 API：/api/me 仍然按未登录处理', async () => {
  const res = await get('/api/me');
  assert.strictEqual(res.status, 401);
});

test('/mobile.html 本身也直接可取（静态目录照常服务）', async () => {
  if (!fs.existsSync(MOBILE_HTML)) return;
  const res = await get('/mobile.html');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, fs.readFileSync(MOBILE_HTML, 'utf8'));
});
