// lib/claude-hooks.js
// 认识 ~/.claude/settings.json 里「哪几条 hook 是本项目装的」。
//
// 判据是「脚本的完整路径落在我们的安装目录下」（见 commandRunsScript）。
// 最早按改名前的目录名 `claude-hooks-feishu` 认，仓库改名后永远匹配不上 —— 重复跑向导
// 会把 notify.js 再装一遍，`--remove` 一条也删不掉。后来改成按脚本名子串认，又反过来
// 认领了用户自己的 `~/.claude/hooks/notify.js`（卸载时被删）、`git-status.js`（让 status.js 被跳过）。
//
// 单独成模块是为了能被单测直接验：这块逻辑原来躺在 bin/cli.js 的向导里，
// 只有人跑一遍向导才会暴露问题。

const path = require('node:path');
const { getHooksDir, repoRoot } = require('./paths');

// 本项目注册过的 hook 脚本，含已下线的 interactive.js（老机器上可能还留着）
const HOOK_SCRIPTS = [
  'notify.js', 'guard.js', 'status.js', 'fix-write-path.js',
  'format-python.sh', 'code-review.sh', 'interactive.js',
];

/** 命令行拆成参数，认双引号 / 单引号（statusCommand 会给带空格的路径加双引号）。 */
function commandTokens(command) {
  return [...String(command || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

/**
 * 我们的脚本会出现在哪些目录：安装向导复制到的 <VIBEANYTHING_HOME>/hooks，
 * 和 --install-status-hooks 直接引用的仓库 hooks/。调用方知道这次装到哪里时从 extraDirs 补进来。
 */
function ourHookDirs(extraDirs = []) {
  return [getHooksDir(), path.join(repoRoot(), 'hooks'), ...extraDirs].map(d => path.resolve(d));
}

// 改名前的两种目录名：老配置目录 ~/.claude-hooks-feishu，老仓库 claude-code-hooks-feishu（gpuserver1 上至今还是它）
const LEGACY_DIR_NAME = /^\.?claude(-code)?-hooks-feishu$/;

/** 改名前的装法：<老配置目录或老仓库>/hooks/<脚本>。 */
function isLegacyScriptPath(p) {
  const dir = path.dirname(p);
  return path.basename(dir) === 'hooks' && LEGACY_DIR_NAME.test(path.basename(path.dirname(dir)));
}

/**
 * 这条命令跑的是不是我们的某个脚本：参数里有一个绝对路径，文件名就是该脚本，且在我们的目录下。
 * 不能按子串认 —— `~/.claude/hooks/notify.js`（用户自己的）、`git-status.js` 都含我们的脚本名，
 * 按子串认会在卸载时删掉用户的 hook、在安装时以为已经装过而跳过。
 */
function commandRunsScript(command, script, extraDirs = []) {
  const dirs = ourHookDirs(extraDirs);
  return commandTokens(command).some(t => path.isAbsolute(t) && path.basename(t) === script &&
    (dirs.includes(path.dirname(path.resolve(t))) || isLegacyScriptPath(t)));
}

/**
 * 某个事件下是否已经装过我们的**这个**脚本。
 * 按具体脚本判而不是「装过任意一条就算」：Stop 事件下同时有 notify.js 和 status.js，
 * 后者的存在不该让前者被跳过。
 */
function hasHookScript(handlers, script, extraDirs = []) {
  return (handlers || []).some(h => h.hooks?.some(hh => commandRunsScript(hh.command, script, extraDirs)));
}

/** 这条 hook 是不是本项目装的（卸载时用，兼容改名前的老形态）。 */
function isOurHook(entry) {
  return !!entry?.hooks?.some(hh => HOOK_SCRIPTS.some(script => commandRunsScript(hh.command, script)));
}

/**
 * 从一份 settings 里摘掉本项目的 hook，别人的原样留下。
 * 事件下的数组被清空时连键一起删掉 —— 留一个空数组在那儿会让人以为还装着东西。
 * @param {object} settings ~/.claude/settings.json 的内容
 * @returns {{settings: object, removed: number}} 新的 settings（不改入参）与摘掉的条数
 */
function removeOurHooks(settings) {
  const next = { ...(settings || {}) };
  if (!next.hooks) return { settings: next, removed: 0 };
  const hooks = {};
  let removed = 0;
  for (const [event, handlers] of Object.entries(next.hooks)) {
    if (!Array.isArray(handlers)) { hooks[event] = handlers; continue; }
    const kept = handlers.filter(h => !isOurHook(h));
    removed += handlers.length - kept.length;
    if (kept.length) hooks[event] = kept;
  }
  next.hooks = hooks;
  return { settings: next, removed };
}

module.exports = { HOOK_SCRIPTS, commandRunsScript, hasHookScript, isOurHook, removeOurHooks };
