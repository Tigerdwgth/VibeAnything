export const DEFAULT_LAUNCH_COMMAND = ['codex'];

export const CLI_CMDS = [
  { label: 'codex', cmd: ['codex'] },
  { label: 'claude', cmd: ['claude'] },
  { label: 'gemini', cmd: ['gemini'] },
  { label: 'bash', cmd: ['bash'] },
  { label: 'zsh', cmd: ['zsh'] },
];

export function getLaunchCommand(command) {
  return (command && command.length > 0) ? command : DEFAULT_LAUNCH_COMMAND;
}

// sessionId 会成为开发机上的 tmux 名，relay 只放行字母、数字、- 和 _（`.` `:` 会被 tmux 改写，
// 可能撞上别人的窗口），总长不超过 48。所以只取命令名本身（去掉路径）、小写、其余字符折成 -，
// 并截短：`/usr/bin/python3.11` → `new-python3-11-<时间戳>`。daemon 用 `new-<工具>-` 推断工具名。
const COMMAND_NAME_MAX = 24;

export function createSessionId(command, now = Date.now()) {
  const name = getLaunchCommand(command)[0].split('/').pop().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').slice(0, COMMAND_NAME_MAX);
  return `new-${name}-${now}`;
}
