const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { drainHookEvents } = require('../lib/daemon');
const { WsClient } = require('../lib/ws-client');

function tmpIpcDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'va-ipc-'));
}

function newClient() {
  return new WsClient({ url: 'ws://127.0.0.1:1/ws', machineToken: 't', machineId: 'test-machine' });
}

// 2026-10-09：drainHookEvents 里用到的 path 没有 require，第一份 evt 文件就让 daemon 崩溃，
// 文件又没删掉，托管者每次拉起都撞上它 —— macmini 在 Dashboard 上每 10 秒掉线一次。
test('drainHookEvents 消费 evt 文件：删掉文件并按两个 key 登记 hook 状态', () => {
  const dir = tmpIpcDir();
  const fp = path.join(dir, 'evt-1-abc.json');
  fs.writeFileSync(fp, JSON.stringify({
    hookEvent: 'Stop', hookState: 'done', sessionId: 'uuid-1', tmuxSession: 'work', cwd: '/tmp',
  }));
  const client = newClient();

  assert.doesNotThrow(() => drainHookEvents(dir, client));

  assert.equal(fs.existsSync(fp), false);
  assert.equal(client._hookStates.get('uuid-1')?.state, 'done');
  assert.equal(client._hookStates.get('work')?.state, 'done');
});

test('drainHookEvents 只认 evt-*.json，别的文件原样留着', () => {
  const dir = tmpIpcDir();
  const other = path.join(dir, 'req-1.json');
  fs.writeFileSync(other, '{}');

  drainHookEvents(dir, newClient());

  assert.equal(fs.existsSync(other), true);
});

test('drainHookEvents 遇到不存在的目录直接返回', () => {
  assert.doesNotThrow(() => drainHookEvents(path.join(os.tmpdir(), 'va-ipc-missing-' + process.pid), newClient()));
});
