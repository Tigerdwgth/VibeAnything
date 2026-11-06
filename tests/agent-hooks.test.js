const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { hookStateFor } = require('../hooks/status');
const {
  CLAUDE_STATUS_EVENTS, CODEX_STATUS_EVENTS, installClaude, installCodexHooksFile,
  installOpencodePlugin, removeStatusHooks, trustCodexStatusHooks,
} = require('../lib/agent-hooks');

const STATUS_SCRIPT = path.join(__dirname, '..', 'hooks', 'status.js');
const hasCodex = spawnSync('which', ['codex'], { stdio: 'ignore' }).status === 0;

describe('hook 事件 → 灯的状态', () => {
  const cases = [
    ['UserPromptSubmit', {}, 'running'],
    ['PreToolUse', {}, 'running'],
    ['PostToolUse', {}, 'running'],
    ['Stop', {}, 'done'],
    ['StopFailure', {}, 'done'],
    ['Interrupt', {}, 'done'],
    ['SessionEnd', {}, 'done'],
    ['PermissionRequest', {}, 'done'],
    ['Notification', { notification_type: 'permission_prompt' }, 'done'],
    ['Notification', { notification_type: 'idle_prompt' }, 'done'],
    ['Notification', { notification_type: 'auth_success' }, null],
    ['SessionStart', {}, null],
    ['PreToolUse', { agent_id: 'sub-1' }, null],
    ['Stop', { agent_id: 'sub-1' }, null],
  ];
  for (const [event, data, expected] of cases) {
    test(`${event} ${JSON.stringify(data)} → ${expected}`, () => {
      assert.strictEqual(hookStateFor(event, data), expected);
    });
  }
});

describe('status.js 真实执行', () => {
  const SOCKET = `vastatus${process.pid}`;
  // -f /dev/null：否则新 server 加载用户配置，tmux-continuum 会把全部会话恢复一份
  const tmux = (...args) => spawnSync('tmux', ['-f', '/dev/null', '-L', SOCKET, ...args], { encoding: 'utf8' }).stdout.trim();
  let ipc;
  let tmuxEnv;
  beforeEach(() => {
    ipc = fs.mkdtempSync(path.join(os.tmpdir(), 'va-status-'));
    tmux('new-session', '-d', '-s', 'probe', 'sleep 60');
    tmuxEnv = {
      TMUX: `${tmux('display-message', '-p', '#{socket_path}')},0,0`,
      TMUX_PANE: tmux('display-message', '-p', '#{pane_id}'),
    };
  });
  afterEach(() => {
    tmux('kill-server');
    fs.rmSync(ipc, { recursive: true, force: true });
  });

  function run(payload, env = tmuxEnv) {
    const child = spawn(process.execPath, [STATUS_SCRIPT], {
      env: { ...process.env, CLAUDE_HOOKS_FEISHU_IPC_DIR: ipc, TMUX: '', TMUX_PANE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.stdin.end(payload);
    return new Promise((resolve) => child.on('close', () => resolve(output)));
  }

  async function waitForEvent() {
    for (let i = 0; i < 100; i += 1) {
      const files = fs.readdirSync(ipc).filter(f => f.endsWith('.json'));
      if (files.length > 0) return JSON.parse(fs.readFileSync(path.join(ipc, files[0]), 'utf8'));
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('没有等到 evt 文件');
  }

  test('工具调用写出带触发时间的心跳事件，且不污染 stdout', async () => {
    const before = Date.now();
    const output = await run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'abc', cwd: '/w' }));
    const evt = await waitForEvent();
    assert.strictEqual(output, '');
    assert.strictEqual(evt.hookState, 'running');
    assert.strictEqual(evt.heartbeat, true);
    assert.strictEqual(evt.sessionId, 'abc');
    assert.strictEqual(evt.tmuxSession, 'probe');
    assert.ok(evt.timestamp >= before && evt.timestamp <= Date.now());
  });

  test('Stop 不是心跳，要转发给浏览器', async () => {
    await run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc', cwd: '/w' }));
    const evt = await waitForEvent();
    assert.strictEqual(evt.hookState, 'done');
    assert.strictEqual(evt.heartbeat, false);
  });

  test('Notification 带上子类型，浏览器靠它区分「等你确认」和「干完了等输入」', async () => {
    await run(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'abc', cwd: '/w' }));
    const evt = await waitForEvent();
    assert.strictEqual(evt.hookState, 'done');
    assert.strictEqual(evt.notificationType, 'permission_prompt');
  });

  test('不在 tmux 里的批量任务不上报（否则浏览器每次 Stop 都响提示音）', async () => {
    await run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'exec', cwd: '/w' }), {});
    await new Promise(r => setTimeout(r, 500));
    assert.deepStrictEqual(fs.readdirSync(ipc), []);
  });

  test('stdin 不是 JSON 时静默退出', async () => {
    assert.strictEqual(await run('not json'), '');
    await new Promise(r => setTimeout(r, 200));
    assert.deepStrictEqual(fs.readdirSync(ipc), []);
  });
});

describe('安装器', () => {
  let home;
  const statusScript = '/repo dir/hooks/status.js';
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'va-home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(home, ...p), 'utf8'));

  test('Claude：补齐缺的事件，保留用户自己的 hook 和其它设置，重复执行不重复安装', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      model: 'x',
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: 'mine.py' }] },
        { hooks: [{ type: 'command', command: 'node "/repo dir/hooks/status.js"', async: true }] },
      ] },
    }));
    assert.strictEqual(installClaude({ home, statusScript }).added, CLAUDE_STATUS_EVENTS.length - 1);
    assert.strictEqual(installClaude({ home, statusScript }).added, 0);
    const settings = readJson('.claude', 'settings.json');
    assert.strictEqual(settings.model, 'x');
    assert.strictEqual(settings.hooks.Stop.length, 2);
    assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node "/repo dir/hooks/status.js"');
    assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].async, true);
  });

  test('Claude：用户自己名字里带 status.js 的 hook 不会让我们的被跳过', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /Users/me/tools/git-status.js' }] }] },
    }));
    assert.strictEqual(installClaude({ home, statusScript }).added, CLAUDE_STATUS_EVENTS.length);
    const settings = readJson('.claude', 'settings.json');
    assert.strictEqual(settings.hooks.Stop.length, 2, '用户的 hook 保留，我们的补上');
  });

  test('Codex：SessionEnd 必须同步（否则 Codex 报告警），其余异步', () => {
    assert.strictEqual(installCodexHooksFile({ home, statusScript }).added, CODEX_STATUS_EVENTS.length);
    const { hooks } = readJson('.codex', 'hooks.json');
    assert.strictEqual(hooks.SessionEnd[0].hooks[0].async, undefined);
    assert.strictEqual(hooks.Stop[0].hooks[0].async, true);
    assert.ok(hooks.Interrupt);
  });

  test('Codex 信任走官方 RPC：只信任本项目的 hook，第二次无事可做', { skip: hasCodex ? false : 'codex 未安装' }, async () => {
    installCodexHooksFile({ home, statusScript });
    const codexHome = path.join(home, '.codex');
    const hooksFile = path.join(codexHome, 'hooks.json');
    const config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-own-hook.sh' }] });
    // 别人的脚本也叫 status.js：不在我们的目录下，不能被顺手信任
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node /elsewhere/hooks/status.js' }] });
    fs.writeFileSync(hooksFile, JSON.stringify(config));

    assert.strictEqual(await trustCodexStatusHooks({ home, statusScript }), CODEX_STATUS_EVENTS.length);
    assert.strictEqual(await trustCodexStatusHooks({ home, statusScript }), 0);
    assert.strictEqual(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8').match(/trusted_hash/g).length, CODEX_STATUS_EVENTS.length);
  });

  test('OpenCode 插件文件指向仓库里的实现，内容不变时不重写', () => {
    const first = installOpencodePlugin({ home, statusScript });
    assert.strictEqual(first.changed, true);
    assert.ok(fs.readFileSync(first.file, 'utf8').includes('"/repo dir/hooks/opencode-status.mjs"'));
    assert.strictEqual(installOpencodePlugin({ home, statusScript }).changed, false);
  });

  test('卸载只摘本项目的 hook，用户的 hook 保留', () => {
    installCodexHooksFile({ home, statusScript });
    const { file } = installOpencodePlugin({ home, statusScript });
    const hooksFile = path.join(home, '.codex', 'hooks.json');
    const config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-own-hook.sh' }] });
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node /elsewhere/hooks/status.js' }] });
    fs.writeFileSync(hooksFile, JSON.stringify(config));

    removeStatusHooks({ home, statusScript });
    const { hooks } = readJson('.codex', 'hooks.json');
    assert.deepStrictEqual(Object.keys(hooks), ['Stop']);
    assert.deepStrictEqual(hooks.Stop.map(g => g.hooks[0].command), ['user-own-hook.sh', 'node /elsewhere/hooks/status.js']);
    assert.strictEqual(fs.existsSync(file), false);
  });
});

describe('OpenCode 事件跟踪', () => {
  let createStatusTracker;
  let reports;
  let onEvent;
  const status = (sessionID, type) => ({ type: 'session.status', properties: { sessionID, status: { type } } });

  beforeEach(async () => {
    ({ createStatusTracker } = await import('../hooks/opencode-status.mjs'));
    reports = [];
    onEvent = createStatusTracker((event, sessionId) => reports.push([event, sessionId]));
  });

  test('busy 点亮，idle 熄灭，重复事件不重复上报', () => {
    onEvent(status('a', 'busy'));
    onEvent(status('a', 'busy'));
    onEvent(status('a', 'idle'));
    onEvent({ type: 'session.idle', properties: { sessionID: 'a' } });
    assert.deepStrictEqual(reports, [['UserPromptSubmit', 'a'], ['Stop', 'a']]);
  });

  test('子会话结束时主会话还在忙，灯不能灭', () => {
    onEvent(status('main', 'busy'));
    onEvent(status('child', 'busy'));
    onEvent(status('child', 'idle'));
    assert.deepStrictEqual(reports, [['UserPromptSubmit', 'main']]);
    onEvent(status('main', 'idle'));
    assert.deepStrictEqual(reports[1], ['Stop', 'main']);
  });

  test('重试中也算在工作', () => {
    onEvent(status('a', 'retry'));
    assert.deepStrictEqual(reports, [['UserPromptSubmit', 'a']]);
  });

  test('等待权限时熄灭，批复后恢复', () => {
    onEvent(status('a', 'busy'));
    onEvent({ type: 'permission.asked', properties: { sessionID: 'a' } });
    onEvent({ type: 'permission.replied', properties: { sessionID: 'a' } });
    assert.deepStrictEqual(reports, [['UserPromptSubmit', 'a'], ['Notification', 'a'], ['UserPromptSubmit', 'a']]);
  });
});
