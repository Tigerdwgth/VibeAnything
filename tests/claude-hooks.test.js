// tests/claude-hooks.test.js
// 「哪几条 hook 是本项目装的」—— 装机向导靠它去重，卸载靠它摘除。
//
// 这块原来躺在 bin/cli.js 里，判据写的是改名前的目录名 `claude-hooks-feishu`：
// 仓库改叫 VibeAnything 之后它永远匹配不上 —— 重复跑向导会把 notify.js 再装一遍，
// `--remove` 一条也删不掉（配置目录删了，hook 还挂着每次会话都跑）。
// 用真实形态的 settings.json 片段来验。

const { test } = require('node:test');
const assert = require('node:assert');

const { hasHookScript, isOurHook, removeOurHooks } = require('../lib/claude-hooks');

const cmd = (command, extra = {}) => ({ hooks: [{ type: 'command', command, ...extra }] });

// 两种真实存在的装法：向导装的（~/.vibeanything/hooks）与手工装的（仓库目录）
const WIZARD_NOTIFY = cmd('node /Users/gsj/.vibeanything/hooks/notify.js');
const REPO_STATUS = cmd('node /Users/gsj/VibeAnything/hooks/status.js', { async: true });
const LEGACY_NOTIFY = cmd('node /home/user/claude-code-hooks-feishu/hooks/notify.js');
const FOREIGN = cmd('node /Users/gsj/.claude/hooks/notify_complete.py');

test('装过就不再装：按脚本名认，仓库改名后照样认得出来', () => {
  assert.strictEqual(hasHookScript([REPO_STATUS], 'status.js'), true);
  assert.strictEqual(hasHookScript([WIZARD_NOTIFY], 'notify.js'), true);
  assert.strictEqual(hasHookScript([LEGACY_NOTIFY], 'notify.js'), true);
});

test('同一事件下 status.js 的存在不该让 notify.js 被跳过（按具体脚本判，不是按「有没有我们的 hook」）', () => {
  assert.strictEqual(hasHookScript([REPO_STATUS], 'notify.js'), false);
});

test('空列表 / 畸形条目都当「没装过」，不抛', () => {
  assert.strictEqual(hasHookScript([], 'notify.js'), false);
  assert.strictEqual(hasHookScript(undefined, 'notify.js'), false);
  assert.strictEqual(hasHookScript([{}, { hooks: [] }, { hooks: [{}] }], 'notify.js'), false);
});

test('认领范围：我们 hooks 目录下的脚本 + 改名前的老形态；别人的 hook 不认领', () => {
  assert.strictEqual(isOurHook(WIZARD_NOTIFY), true);
  assert.strictEqual(isOurHook(REPO_STATUS), true);
  assert.strictEqual(isOurHook(LEGACY_NOTIFY), true);
  assert.strictEqual(isOurHook(FOREIGN), false, '用户自己的 notify_complete.py 不是我们的');
  assert.strictEqual(isOurHook(undefined), false);
});

test('卸载：摘掉我们的、留下别人的，清空的事件键一起删掉', () => {
  const before = {
    model: 'opus',
    hooks: {
      Stop: [REPO_STATUS, FOREIGN, WIZARD_NOTIFY],
      PreToolUse: [cmd('node /Users/gsj/.vibeanything/hooks/guard.js')],
      SessionStart: [cmd('echo hi')],
    },
  };
  const { settings, removed } = removeOurHooks(before);

  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(settings.hooks.Stop, [FOREIGN]);
  assert.strictEqual(settings.hooks.PreToolUse, undefined, '清空的事件不留空数组');
  assert.deepStrictEqual(settings.hooks.SessionStart, [cmd('echo hi')]);
  assert.strictEqual(settings.model, 'opus', 'settings 里的其它设置不能动');
  // 不改入参：调用方可能还要用原值做对比
  assert.strictEqual(before.hooks.Stop.length, 3);
});

test('卸载一份没有 hooks 的 settings 是无害的空操作', () => {
  const { settings, removed } = removeOurHooks({ model: 'opus' });
  assert.strictEqual(removed, 0);
  assert.deepStrictEqual(settings, { model: 'opus' });
  assert.deepStrictEqual(removeOurHooks(undefined), { settings: {}, removed: 0 });
});

test('hooks 里非数组的值原样留着（settings 结构以后可能变）', () => {
  const { settings } = removeOurHooks({ hooks: { weird: 'string' } });
  assert.strictEqual(settings.hooks.weird, 'string');
});
