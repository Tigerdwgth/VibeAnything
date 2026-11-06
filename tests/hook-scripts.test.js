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

// 主目录的各种写法：shell 会把 ~ / $HOME / ${HOME} 展开成同一个目录，`/*` 是清空它的内容。
// 旧代码只认 / 开头的参数，rm -rf ~ 直接放行 —— 而 daemon 起的 claude 带着
// --dangerously-skip-permissions，这里是唯一一道拦截。
test('guard.js 拦截主目录与受保护目录的展开写法和 /* 写法', () => {
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-user-'));
  try {
    for (const command of [
      'rm -rf ~', 'rm -rf ~/', 'rm -rf $HOME', 'rm -rf "$HOME"', 'rm -rf ${HOME}/',
      `rm -rf ${home}/*`, 'rm -rf ~/*', 'rm -fr "$HOME"/*', 'rm -rf /usr/*', 'rm -rf /*',
    ]) {
      const res = runHook('guard.js', { tool_input: { command } }, { VIBEANYTHING_HOME: vibe, HOME: home });
      assert.strictEqual(res.status, 2, `${command} 应被拦截`);
      assert.match(res.stderr, /受保护路径/);
    }
  } finally {
    fs.rmSync(vibe, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guard.js 放行主目录下的普通子目录', () => {
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-user-'));
  try {
    for (const command of ['rm -rf ~/proj/build', 'rm -rf "$HOME"/tmp/cache', 'rm -rf ${HOME}/a/*', 'rm -rf build/*']) {
      const res = runHook('guard.js', { tool_input: { command } }, { VIBEANYTHING_HOME: vibe, HOME: home });
      assert.strictEqual(res.status, 0, `${command} 不该被拦截: ${res.stderr}`);
    }
  } finally {
    fs.rmSync(vibe, { recursive: true, force: true });
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
