// tests/cli-install.test.js
// 安装向导与 crontab 的装 / 卸。向导用真子进程跑 bin/cli.js（HOME 与 VIBEANYTHING_HOME 指到临时目录），
// crontab 只验「对 crontab 文本做了什么」—— 真去改 crontab 会动到本机用户的定时任务。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  CRONTAB_MARKER, buildCrontabLines, stripOurCrontabLines, crontabWithOurLines,
} = require('../lib/crontab');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cli-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { root, home, vibe: path.join(root, 'vibe'), settings: path.join(home, '.claude', 'settings.json') };
}

// 向导的 8 个问题：4 个 hook 开关 + 路径修复 + 格式化工具 全部回车默认，Dashboard 与 crontab 选 n
const WIZARD_ANSWERS = ['', '', '', '', '', '', 'n', 'n'];

/**
 * 像人一样答题：每出现一个提示（以 ": " 结尾）才写下一行。
 * 一次性把答案全灌进 stdin 不行 —— readline 在没有挂起的 question 时收到的行会被丢掉。
 */
function runWizard({ home, vibe }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], { env: { ...process.env, HOME: home, VIBEANYTHING_HOME: vibe } });
    const answers = [...WIZARD_ANSWERS];
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      pending += chunk;
      if (pending.endsWith(': ') && answers.length > 0) {
        pending = '';
        child.stdin.write(`${answers.shift()}\n`);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (status) => { child.stdin.destroy(); resolve({ status, stdout, stderr }); });
  });
}

test('向导：settings.json 不是合法 JSON 时中止并报错，原文件一字不改，也不写配置', async () => {
  const box = sandbox();
  try {
    const broken = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls:*)"], },\n}\n';
    fs.writeFileSync(box.settings, broken);
    const res = await runWizard(box);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /不是合法的 JSON/);
    assert.strictEqual(fs.readFileSync(box.settings, 'utf8'), broken, '用户的 settings.json 被覆盖了');
    assert.strictEqual(fs.existsSync(path.join(box.vibe, 'config.json')), false, '中止前不该写配置');
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('向导：重复运行不重复装；用户自己的 ~/.claude/hooks/notify.js 不算我们的，两边并存', async () => {
  const box = sandbox();
  try {
    const userNotify = { hooks: [{ type: 'command', command: `node ${path.join(box.home, '.claude', 'hooks', 'notify.js')}` }] };
    fs.writeFileSync(box.settings, JSON.stringify({ model: 'opus', hooks: { Stop: [userNotify] } }));
    for (let i = 0; i < 2; i += 1) {
      const res = await runWizard(box);
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    }
    const settings = JSON.parse(fs.readFileSync(box.settings, 'utf8'));
    assert.strictEqual(settings.model, 'opus');
    const stopCommands = settings.hooks.Stop.map(g => g.hooks[0].command);
    assert.deepStrictEqual(stopCommands.filter(c => c.endsWith('notify.js')), [
      userNotify.hooks[0].command,
      `node ${path.join(box.vibe, 'hooks', 'notify.js')}`,
    ]);
    assert.strictEqual(stopCommands.filter(c => c.includes('status.js')).length, 1, '状态上报重复安装了');
    assert.strictEqual(settings.hooks.PreToolUse.filter(g => g.hooks[0].command.includes('guard.js')).length, 1);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

const LINES = buildCrontabLines({ nodePath: '/usr/bin/node', cliPath: '/opt/va/bin/cli.js', baseDir: '/h/.vibeanything' });
const OTHERS = '0 3 * * * /usr/local/bin/backup.sh\n*/10 * * * * other-tool --daemon start\n';

test('crontab：卸载把用量上报那行也摘掉，别人的行原样保留', () => {
  const installed = crontabWithOurLines(OTHERS, LINES);
  assert.ok(installed.includes('--usage-report'));
  const removed = stripOurCrontabLines(installed);
  assert.ok(!removed.includes(CRONTAB_MARKER));
  assert.ok(!removed.includes('cli.js'), `卸载后还留着我们的行:\n${removed}`);
  assert.ok(removed.includes('backup.sh'));
  assert.ok(removed.includes('other-tool --daemon start'), '别的工具的 --daemon start 不是我们的');
});

test('crontab：装 → 卸 → 再装，每种行只有一份；旧版卸载漏下的上报行在重装时被收掉', () => {
  const again = crontabWithOurLines(stripOurCrontabLines(crontabWithOurLines(OTHERS, LINES)), LINES);
  const count = (s, needle) => s.split('\n').filter(l => l.includes(needle)).length;
  assert.strictEqual(count(again, '--usage-report'), 1);
  assert.strictEqual(count(again, '/opt/va/bin/cli.js --daemon start'), 2);   // @reboot + */5
  assert.strictEqual(count(again, CRONTAB_MARKER), 1);

  // 旧版卸载后的现场：marker 和 daemon 行没了，上报行还在
  const leftover = `${OTHERS}${LINES[3]}\n`;
  assert.strictEqual(count(crontabWithOurLines(leftover, LINES), '--usage-report'), 1);
  // 已经装着就不动
  assert.strictEqual(crontabWithOurLines(again, LINES), null);
});
