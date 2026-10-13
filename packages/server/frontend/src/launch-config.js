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

export function createSessionId(command, now = Date.now()) {
  return `new-${getLaunchCommand(command)[0]}-${now}`;
}
