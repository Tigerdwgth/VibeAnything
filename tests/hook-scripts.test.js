const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS_DIR = path.resolve(__dirname, '..', 'hooks');

function runHook(script, stdinJson, env) {
  return spawnSync(process.execPath, [path.join(HOOKS_DIR, script)], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf-8',
    env: { ...process.env, ...env }
  });
}

test('notify.js 把 Stop 事件写成 evt 文件交给 daemon，不依赖任何外部通知渠道', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-home-'));
  const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-ipc-'));
  try {
    const res = runHook('notify.js', {
      hook_event_name: 'Stop',
      session_id: 'abcdef1234567890',
      cwd: '/work/demo'
    }, { VIBEANYTHING_HOME: home, CLAUDE_HOOKS_FEISHU_IPC_DIR: ipcDir, VIBEANYTHING_MACHINE_ID: 'box-1' });
    assert.strictEqual(res.status, 0, res.stderr);

    const evtFiles = fs.readdirSync(ipcDir).filter(f => /^evt-\d+-abcdef12\.json$/.test(f));
    assert.strictEqual(evtFiles.length, 1);
    const evt = JSON.parse(fs.readFileSync(path.join(ipcDir, evtFiles[0]), 'utf-8'));
    assert.strictEqual(evt.hookEvent, 'Stop');
    assert.strictEqual(evt.sessionId, 'abcdef1234567890');
    assert.strictEqual(evt.machineId, 'box-1');
    assert.strictEqual(evt.cwd, '/work/demo');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
});

test('notify.js 对 PostToolUseFailure 不写事件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-home-'));
  const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-ipc-'));
  try {
    const res = runHook('notify.js', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'abcdef1234567890'
    }, { VIBEANYTHING_HOME: home, CLAUDE_HOOKS_FEISHU_IPC_DIR: ipcDir });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(fs.readdirSync(ipcDir).filter(f => f.startsWith('evt-')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
});

test('guard.js 遇到危险命令退出码 2，并在 stderr 给出原因', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-'));
  try {
    const res = runHook('guard.js', { tool_input: { command: 'rm -rf /' }, session_id: 's1' },
      { VIBEANYTHING_HOME: home });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /已拦截危险命令: "rm -rf \/"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guard.js 放行普通命令', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-'));
  try {
    const res = runHook('guard.js', { tool_input: { command: 'ls -la' } }, { VIBEANYTHING_HOME: home });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stderr, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
