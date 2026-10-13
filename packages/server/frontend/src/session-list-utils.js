const SESSION_PREFIXES = [
  'new-claude-',
  'new-codex-',
  'new-gemini-',
  'new-bash-',
  'new-zsh-',
  'new-vim-',
  'codex-',
  'gemini-',
  'bash-',
  'zsh-',
  'cc-',
];

export function toolName(command) {
  if (!Array.isArray(command) || command.length === 0) return 'claude';
  const bin = command[0];
  if (!bin || bin === 'cc') return 'claude';
  return bin;
}

export function stripSessionPrefix(sessionId) {
  if (!sessionId) return '';
  for (const prefix of SESSION_PREFIXES) {
    if (sessionId.startsWith(prefix)) return sessionId.slice(prefix.length);
  }
  return sessionId;
}

// 自动生成的 sessionId：dashboard 自建（cc-/new-* 前缀）或 claude 的 UUID 会话。
// 这类名字无意义，标题用 cwd 末段更友好；其余（手动创建 / 用户重命名的 tmux 名）
// 本身就是有意义的名字，应直接作为标题显示。
export function isAutoSessionId(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return true;
  if (/^(cc-|new-(claude|codex|gemini|bash|zsh|vim)-)/.test(sid)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return true;
  return false;
}

export function getRunningSessionTitle(session) {
  const sid = String(session?.sessionId || '');
  // 用户重命名 / 手动创建的会话：sessionId 即用户起的 tmux 名 → 直接显示
  if (sid && !isAutoSessionId(sid)) return sid;
  // 自动会话：用 cwd 末段
  const cwd = String(session?.cwd || '').trim();
  if (cwd) {
    const parts = cwd.split('/').filter(Boolean);
    return parts[parts.length - 1] || '/';
  }
  return stripSessionPrefix(sid) || sid || '/';
}

export function getRunningSessionDetail(session) {
  return String(session?.cwd || session?.sessionId || '');
}

export function getRunningSessionCommand(session) {
  const tool = toolName([session?.tool || 'claude']);
  if (tool === 'claude' && session?.sessionId && !String(session.sessionId).startsWith('new-claude-')) {
    return ['claude', '--resume', session.sessionId];
  }
  return [tool];
}
