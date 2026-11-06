// lib/agent-hooks.js
// 给 Claude Code、Codex、OpenCode 安装工作状态上报（hooks/status.js）。重复执行是幂等的。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { commandRunsScript, hasHookScript } = require('./claude-hooks');
const { repoRoot } = require('./paths');

const CLAUDE_STATUS_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd',
];
const CODEX_STATUS_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
];
// Codex 的 SessionEnd 总是同步执行，声明 async 只会多一条告警。status.js 立即退出，不会拖慢退出。
const CODEX_SYNC_EVENTS = ['SessionEnd'];
const STATUS_SCRIPT_NAME = 'status.js';
const OPENCODE_PLUGIN_NAME = 'vibeanything-status.js';
const CODEX_RPC_TIMEOUT_MS = 20_000;
const DEFAULT_STATUS_SCRIPT = path.join(repoRoot(), 'hooks', STATUS_SCRIPT_NAME);

function statusCommand(statusScript) {
  return `node ${JSON.stringify(statusScript)}`;
}

/** 这条命令是不是在跑我们的 status.js（statusScript 是这次安装用的那份，它所在目录也算我们的）。 */
function isStatusCommand(command, statusScript = DEFAULT_STATUS_SCRIPT) {
  return commandRunsScript(command, STATUS_SCRIPT_NAME, [path.dirname(statusScript)]);
}

/**
 * 往 hooks 表（Claude settings.hooks 与 Codex hooks.json 同构）补上缺的事件，返回新增条数。
 * @param {string} statusScript 要装的 status.js 的绝对路径
 */
function addStatusHandlers(hooks, events, statusScript, { syncEvents = [] } = {}) {
  let added = 0;
  for (const event of events) {
    hooks[event] ??= [];
    if (hasHookScript(hooks[event], STATUS_SCRIPT_NAME, [path.dirname(statusScript)])) continue;
    const handler = { type: 'command', command: statusCommand(statusScript) };
    if (!syncEvents.includes(event)) handler.async = true;
    hooks[event].push({ hooks: [handler] });
    added += 1;
  }
  return added;
}

function removeStatusHandlers(hooks, statusScript) {
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = [];
    for (const group of groups) {
      const handlers = (group.hooks || []).filter(h => !isStatusCommand(h.command, statusScript));
      removed += (group.hooks || []).length - handlers.length;
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function installClaude({ home, statusScript }) {
  const file = path.join(home, '.claude', 'settings.json');
  const settings = readJson(file, {});
  settings.hooks ??= {};
  const added = addStatusHandlers(settings.hooks, CLAUDE_STATUS_EVENTS, statusScript);
  if (added > 0) writeJson(file, settings);
  return { added };
}

function installCodexHooksFile({ home, statusScript }) {
  const file = path.join(home, '.codex', 'hooks.json');
  const config = readJson(file, {});
  config.hooks ??= {};
  const added = addStatusHandlers(config.hooks, CODEX_STATUS_EVENTS, statusScript, { syncEvents: CODEX_SYNC_EVENTS });
  if (added > 0) writeJson(file, config);
  return { added };
}

/**
 * 与 Codex 的 /hooks 界面相同的信任流程：hooks/list 取当前哈希，config/batchWrite 写入 hooks.state。
 * Codex 只运行哈希匹配的 hook，且只放行本项目的 status.js（按路径认，见 commandRunsScript），
 * 用户其它 hook —— 哪怕也叫 status.js —— 仍由用户自己审。
 */
function trustCodexStatusHooks({ home, cwd = home, statusScript = DEFAULT_STATUS_SCRIPT }) {
  return new Promise((resolve, reject) => {
    const server = spawn('codex', ['app-server'], {
      env: { ...process.env, CODEX_HOME: path.join(home, '.codex') },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const fail = (error) => { server.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error('codex app-server 响应超时')), CODEX_RPC_TIMEOUT_MS);
    const pending = new Map();
    let nextId = 1;
    let buffered = '';

    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

    server.on('error', fail);
    server.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        pending.delete(msg.id);
        if (msg.error) waiter.rej(new Error(msg.error.message));
        else waiter.res(msg.result);
      }
    });

    (async () => {
      await request('initialize', { clientInfo: { name: 'vibeanything', title: 'VibeAnything', version: '1' } });
      server.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const { data } = await request('hooks/list', { cwds: [cwd] });
      const ours = data[0].hooks.filter(h =>
        isStatusCommand(h.command, statusScript) && h.trustStatus !== 'trusted' && h.trustStatus !== 'managed');
      if (ours.length > 0) {
        await request('config/batchWrite', {
          edits: [{
            keyPath: 'hooks.state',
            value: Object.fromEntries(ours.map(h => [h.key, { trusted_hash: h.currentHash }])),
            mergeStrategy: 'upsert',
          }],
          reloadUserConfig: true,
        });
      }
      return ours.length;
    })().then((trusted) => {
      clearTimeout(timer);
      server.kill();
      resolve(trusted);
    }, (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

function installOpencodePlugin({ home, statusScript }) {
  const pluginSource = path.join(path.dirname(statusScript), 'opencode-status.mjs');
  const file = path.join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_NAME);
  const content = `// 由 vibeanything --install-status-hooks 生成\nexport { VibeAnythingStatus } from ${JSON.stringify(pluginSource)};\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content;
  if (changed) fs.writeFileSync(file, content);
  return { file, changed };
}

function hasCommand(name) {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

/** 给本机装了的 agent 全部安装，返回每家的结果；没装的 agent 记为 skipped。 */
async function installStatusHooks({ home = os.homedir(), statusScript }) {
  const result = { claude: 'skipped', codex: 'skipped', opencode: 'skipped' };
  if (hasCommand('claude') || fs.existsSync(path.join(home, '.claude'))) {
    result.claude = `新增 ${installClaude({ home, statusScript }).added} 条`;
  }
  if (hasCommand('codex')) {
    const { added } = installCodexHooksFile({ home, statusScript });
    const trusted = await trustCodexStatusHooks({ home, statusScript });
    result.codex = `新增 ${added} 条，信任 ${trusted} 条`;
  }
  if (hasCommand('opencode')) {
    result.opencode = installOpencodePlugin({ home, statusScript }).changed ? '已写入插件' : '插件已是最新';
  }
  return result;
}

/** 卸载：Claude 的摘除由 removeOurHooks 负责，这里只管 Codex 和 OpenCode。 */
function removeStatusHooks({ home = os.homedir(), statusScript = DEFAULT_STATUS_SCRIPT } = {}) {
  const codexFile = path.join(home, '.codex', 'hooks.json');
  if (fs.existsSync(codexFile)) {
    const config = readJson(codexFile, {});
    if (config.hooks && removeStatusHandlers(config.hooks, statusScript) > 0) writeJson(codexFile, config);
  }
  fs.rmSync(path.join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_NAME), { force: true });
}

module.exports = {
  CLAUDE_STATUS_EVENTS,
  CODEX_STATUS_EVENTS,
  addStatusHandlers,
  installClaude,
  installCodexHooksFile,
  installOpencodePlugin,
  installStatusHooks,
  removeStatusHooks,
  statusCommand,
  trustCodexStatusHooks,
};
