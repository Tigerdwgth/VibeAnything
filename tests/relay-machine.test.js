// relay 机器连接生命周期单测：聚焦「断线重连陈旧 close 误删」竞态修复。
// relay.js 顶部 require('./auth') 会拉起 bcryptjs/jsonwebtoken/sql.js（本地未装且与本测无关），
// 故在 require relay 之前，把 './auth' 模块预置成最小 stub，绕开传递依赖。
const { test } = require('node:test');
const assert = require('node:assert');

const authPath = require.resolve('../packages/server/auth.js');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: { verifyToken: () => null },
};

const { RelayServer, BROWSER_POLICY, PANE_ACTIONS } = require('../packages/server/relay.js');

// 最小假 ws：满足 relay 用到的 readyState / send / close / on('pong')。
function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    send(s) { this.sent.push(s); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
    ping() {},
    on() {},
  };
}

function machineIdsInList(relay) {
  // 复用 relay 给浏览器发 machine_list 时的同一构建逻辑。
  return Array.from(relay.machines.entries()).map(([id]) => id);
}

test('断线重连：旧连接 close 不删新连接条目，机器仍在 machine_list', () => {
  const relay = new RelayServer();
  const oldWs = fakeWs();
  const newWs = fakeWs();

  relay.registerMachine('macmini', oldWs);
  assert.deepStrictEqual(machineIdsInList(relay), ['macmini']);

  // 重连：新 ws 覆盖旧 ws（碰撞）。
  relay.registerMachine('macmini', newWs);
  assert.strictEqual(relay.machines.get('macmini').ws, newWs, '新连接应覆盖进 Map');

  // 旧 ws 的 close 晚到 —— 必须被守卫拦住，不能删掉新条目。
  relay._handleMachineClose('macmini', oldWs);
  assert.ok(relay.machines.has('macmini'), '旧 close 误删了新条目（竞态回归）');
  assert.deepStrictEqual(machineIdsInList(relay), ['macmini']);
  assert.strictEqual(relay.machines.get('macmini').ws, newWs);
});

test('注册碰撞时主动关闭被取代的旧连接', () => {
  const relay = new RelayServer();
  const oldWs = fakeWs();
  const newWs = fakeWs();

  relay.registerMachine('dev1', oldWs);
  relay.registerMachine('dev1', newWs);

  assert.ok(oldWs.closed, '旧连接应被主动 close');
  assert.strictEqual(oldWs.closed.code, 4000);
  assert.strictEqual(newWs.closed, null, '新连接不应被关闭');
});

test('当前连接 close 正常注销机器', () => {
  const relay = new RelayServer();
  const ws = fakeWs();
  relay.registerMachine('dev2', ws);
  assert.ok(relay.machines.has('dev2'));

  relay._handleMachineClose('dev2', ws);
  assert.ok(!relay.machines.has('dev2'), '本连接 close 应注销机器');
});

test('getAllSessions 给每个会话打上 machineId 标签', () => {
  const relay = new RelayServer();
  const ws = fakeWs();
  relay.registerMachine('dev3', ws);
  relay.updateSessions('dev3', [{ sessionId: 's1' }, { sessionId: 's2' }]);
  const all = relay.getAllSessions();
  assert.strictEqual(all.length, 2);
  assert.ok(all.every(s => s.machineId === 'dev3'));
});

// 分屏工具条新开的两条通道（切换焦点 / 删除分屏）都是对着别人会话就能造成破坏的操作，
// 必须走会话归属校验，不能图省事标成 open。
test('select_pane / kill_pane / scroll_to_bottom 走会话归属校验，不是开放通道', () => {
  for (const type of ['select_pane', 'kill_pane', 'scroll_to_bottom']) {
    const policy = BROWSER_POLICY[type];
    assert.ok(policy, `${type} 必须在 BROWSER_POLICY 里登记，否则会被一律拒绝`);
    assert.ok(!policy.open, `${type} 不能标成开放通道`);
    assert.strictEqual(typeof policy.session, 'function', `${type} 必须声明取 sessionId 的方式`);
    assert.strictEqual(policy.session({ sessionId: 'abc' }), 'abc');
    // 认领语义只属于「新建会话」，删/切分屏套上去等于把别人的会话认成自己的
    assert.ok(!policy.claimSession, `${type} 不该有 claimSession`);
  }
});

// relay 把浏览器的窗格操作翻译成开发机侧的消息类型，两边各有一张表。
// 名字对不上的后果是**静默失灵**：relay 照发不误，开发机认不出就一声不吭地丢掉，
// 用户看到的是「点了这个按钮没反应」，而日志里什么都没有。所以在这里把两张表对上。
test('窗格操作的类型名两端必须对得上（对不上就是点了没反应）', () => {
  // ws-client 只在开发机侧跑，这里单独 require 它的表来比对
  const { PANE_OPS } = require('../lib/ws-client.js');

  for (const [browserType, machineType] of Object.entries(PANE_ACTIONS)) {
    assert.ok(
      PANE_OPS[machineType],
      `relay 会把 ${browserType} 发成 ${machineType}，但 ws-client 不认这个类型`
    );
    assert.strictEqual(
      typeof PANE_OPS[machineType].run, 'function',
      `${machineType} 必须声明怎么调 pty-manager`
    );
  }
  // 反向也要成立：开发机认的每种窗格操作都应有浏览器侧的入口，否则是段死代码
  const emitted = new Set(Object.values(PANE_ACTIONS));
  for (const machineType of Object.keys(PANE_OPS)) {
    assert.ok(emitted.has(machineType), `${machineType} 没有任何浏览器入口会触发`);
  }

  // 每种浏览器侧的类型都必须同时登记在鉴权表里，否则会被一律丢弃
  for (const browserType of Object.keys(PANE_ACTIONS)) {
    assert.ok(BROWSER_POLICY[browserType], `${browserType} 没在 BROWSER_POLICY 里登记`);
  }
});
