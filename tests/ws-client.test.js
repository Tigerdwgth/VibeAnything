const assert = require('node:assert');
const { test } = require('node:test');
const { WsClient, scanSessionHistory, resolveIsRunning } = require('../lib/ws-client');

function createClient(ptyManager) {
  const client = new WsClient({
    url: 'ws://example.test/ws',
    machineToken: 'test-token',
    machineId: 'test-machine',
    ptyManager,
  });
  client._ws = { readyState: 0, send: () => {} };
  return client;
}

test('handles pty_input message', () => {
  const written = [];
  const client = createClient({
    create: () => {},
    write: (id, data) => { written.push({ id, data }); },
    resize: () => {},
    destroy: () => {},
  });

  client._handleMessage(JSON.stringify({
    type: 'pty_input',
    sessionId: 'sess1',
    data: Buffer.from('ls\n').toString('base64'),
  }));

  assert.deepStrictEqual(written, [{ id: 'sess1', data: 'ls\n' }]);
});

test('handles pty_split message', () => {
  const splitCalls = [];
  const client = createClient({
    create: () => {},
    write: () => {},
    resize: () => {},
    destroy: () => {},
    split: (sessionId, options) => splitCalls.push({ sessionId, options }),
  });

  client._handleMessage(JSON.stringify({
    type: 'pty_split',
    sessionId: 'sess1',
    direction: 'up',
    cwd: '/workspace/app',
    command: ['claude'],
  }));

  assert.deepStrictEqual(splitCalls, [{
    sessionId: 'sess1',
    options: {
      direction: 'up',
      cwd: '/workspace/app',
      command: ['claude'],
    },
  }]);
});

test('scanSessionHistory returns filePath field', async () => {
  const sessions = await scanSessionHistory();
  assert.ok(Array.isArray(sessions));
  for (const s of sessions) {
    assert.ok(s.filePath, 'session should have filePath');
    assert.ok(/\.(json|jsonl)$/.test(s.filePath), 'filePath should end with .json or .jsonl');
  }
});

// ── 红绿灯：完全由 hook 驱动，无 PTY 兜底（三态）──────────────

test('resolveIsRunning: hook running → true（红灯，运行中）', () => {
  assert.strictEqual(resolveIsRunning('running'), true);
});

test('resolveIsRunning: hook done → false（绿灯，已完成）', () => {
  assert.strictEqual(resolveIsRunning('done'), false);
});

test('resolveIsRunning: 无 hook 状态 → false（绿灯，空闲）', () => {
  // 没装 hook / 还没上报 / sessionId 匹配不上：默认绿灯（空闲）。只有 running 才红。
  assert.strictEqual(resolveIsRunning(undefined), false);
  assert.strictEqual(resolveIsRunning(null), false);
  assert.strictEqual(resolveIsRunning('done'), false);
  // 任意非法状态也视为空闲（绿）
  assert.strictEqual(resolveIsRunning('bogus'), false);
});

test('updateHookState 更新内存 Map 并在状态变化时触发 active_sessions 重发', () => {
  const sent = [];
  const client = createClient({});
  // 屏蔽真实扫描，只验证 updateHookState 链路：状态变化 → 调一次 _sendActiveSessions
  let sendCount = 0;
  client._sendActiveSessions = () => { sendCount++; };

  client.updateHookState('sessA', 'running');
  assert.strictEqual(sendCount, 1, '首次 running 应触发重发');
  // 再次相同状态不重发
  client.updateHookState('sessA', 'running');
  assert.strictEqual(sendCount, 1, '相同状态不应重复重发');
  // 状态变化（running → done）应再触发
  client.updateHookState('sessA', 'done');
  assert.strictEqual(sendCount, 2, '状态变化应再次重发');

  // 非法状态被忽略
  client.updateHookState('sessA', 'bogus');
  assert.strictEqual(sendCount, 2);
  client.updateHookState('', 'running');
  assert.strictEqual(sendCount, 2);
});

test('_computeIsRunning：完全由 hook 驱动，无 hook 状态默认 false（绿灯，不读 PTY）', () => {
  const client = createClient({});
  client._sendActiveSessions = () => {};
  client.updateHookState('sessB', 'running');
  assert.strictEqual(client._computeIsRunning('sessB'), true);
  client.updateHookState('sessB', 'done');
  assert.strictEqual(client._computeIsRunning('sessB'), false);
  // 没有 hook 状态的会话 → false（绿灯，空闲），每个会话都有灯，不再回退 PTY
  assert.strictEqual(client._computeIsRunning('sessNoHook'), false);
});

test('handles delete_session message', () => {
  const sent = [];
  const client = createClient({ create: () => {}, write: () => {}, resize: () => {}, destroy: () => {} });
  client._send = (msg) => sent.push(msg);
  client._deleteSession = (sessionId) => {
    client._send({ type: 'session_deleted', sessionId });
  };

  client._handleMessage(JSON.stringify({
    type: 'delete_session',
    sessionId: 'nonexistent-session-id',
  }));

  assert.deepStrictEqual(sent, [{
    type: 'session_deleted',
    sessionId: 'nonexistent-session-id',
  }]);
});

// ── 新会话即时可见（修复「新建会话必须刷新页面才显示」）──────────────

test('pty_open 新建会话（isNew）后立即重发 active_sessions（Dashboard 启动按钮秒显）', () => {
  let sendCount = 0;
  const client = createClient({
    create: () => ({ isNew: true, historySnapshot: null }),
    write: () => {}, resize: () => {}, destroy: () => {},
  });
  client._send = () => {};
  client._sendActiveSessions = () => { sendCount++; };

  client._handleMessage(JSON.stringify({
    type: 'pty_open', sessionId: 'sess-new', cols: 80, rows: 24,
  }));

  assert.strictEqual(sendCount, 1, '新建会话应立即触发一次 active_sessions 重发');
});

test('pty_open attach 已有会话（!isNew）不额外重发 active_sessions', () => {
  let sendCount = 0;
  const client = createClient({
    create: () => ({ isNew: false, historySnapshot: 'old screen' }),
    write: () => {}, resize: () => {}, destroy: () => {},
  });
  client._send = () => {};
  client._sendActiveSessions = () => { sendCount++; };

  client._handleMessage(JSON.stringify({
    type: 'pty_open', sessionId: 'sess-existing', cols: 80, rows: 24,
  }));

  assert.strictEqual(sendCount, 0, 'attach 已有会话不应额外触发 active_sessions 重发');
});

test('状态轮询检测到 tmux 会话集合变化时触发全量重扫（覆盖终端裸跑 claude）', () => {
  let sendCount = 0;
  const client = createClient({});
  client._send = () => {};
  client._sendActiveSessions = () => { sendCount++; };
  client._lastEnrichedBase = [];
  client._lastTmuxSig = 'cc-a|cc-b';

  // 集合未变 → 不重扫
  client._currentTmuxSignature = () => 'cc-a|cc-b';
  client._pollStatusOnce();
  assert.strictEqual(sendCount, 0, '会话集合未变不应重扫');

  // 出现新会话 → 重扫一次并更新签名
  client._currentTmuxSignature = () => 'cc-a|cc-b|cc-new';
  client._pollStatusOnce();
  assert.strictEqual(sendCount, 1, '新会话导致集合变化应触发一次全量重扫');
  assert.strictEqual(client._lastTmuxSig, 'cc-a|cc-b|cc-new', '签名应更新为最新集合');

  // 会话退出 → 也重扫
  client._currentTmuxSignature = () => 'cc-a';
  client._pollStatusOnce();
  assert.strictEqual(sendCount, 2, '会话退出导致集合变化也应触发重扫');

  // 再次稳定 → 不再重扫（退回纯内存红绿灯逻辑，base 为空则直接跳过）
  client._pollStatusOnce();
  assert.strictEqual(sendCount, 2, '集合稳定后不应继续重扫');
});
