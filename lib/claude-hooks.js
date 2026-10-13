// lib/claude-hooks.js
// 认识 ~/.claude/settings.json 里「哪几条 hook 是本项目装的」。
//
// 判据必须按**脚本文件名**，不能按目录名：原来用的是 `claude-hooks-feishu`
// （改名前的仓库目录名），仓库改叫 VibeAnything 之后它永远匹配不上 ——
// 后果是重复跑装机向导会把 Stop/Notification 的 notify.js 再装一遍，
// 而 `--remove` 一条也删不掉（卸载完配置目录没了，hook 还挂在那儿每次会话都跑）。
//
// 单独成模块是为了能被单测直接验：这块逻辑原来躺在 bin/cli.js 的向导里，
// 只有人跑一遍向导才会暴露问题。

// 本项目注册过的 hook 脚本，含已下线的 interactive.js（老机器上可能还留着）
const HOOK_SCRIPTS = [
  'notify.js', 'guard.js', 'status.js', 'fix-write-path.js',
  'format-python.sh', 'code-review.sh', 'interactive.js',
];

// 改名前装的 hook 命令里带这个目录名
const LEGACY_MARKER = 'claude-hooks-feishu';

/**
 * 某个事件下是否已经装过我们的**这个**脚本。
 * 按具体脚本判而不是「装过任意一条就算」：Stop 事件下同时有 notify.js 和 status.js，
 * 后者的存在不该让前者被跳过。
 */
function hasHookScript(handlers, script) {
  return (handlers || []).some(h => h.hooks?.some(hh => String(hh.command || '').includes(script)));
}

/** 这条 hook 是不是本项目装的（卸载时用，兼容改名前的老形态）。 */
function isOurHook(entry) {
  return !!entry?.hooks?.some(hh => {
    const cmd = String(hh.command || '');
    if (cmd.includes(LEGACY_MARKER)) return true;
    return HOOK_SCRIPTS.some(script => cmd.includes(`hooks/${script}`));
  });
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

module.exports = { HOOK_SCRIPTS, LEGACY_MARKER, hasHookScript, isOurHook, removeOurHooks };
