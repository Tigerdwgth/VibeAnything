// OpenCode 状态上报插件：把 session.status 等事件转成 hooks/status.js 认识的事件。
// 由 `--install-status-hooks` 生成的 ~/.config/opencode/plugins/vibeanything-status.js 加载。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STATUS_SCRIPT = fileURLToPath(new URL('./status.js', import.meta.url));

/**
 * 子会话和主会话共用一个 tmux 窗口，所以按「还有没有会话在忙」上报，
 * 否则子代理一结束灯就灭了，而主会话还在工作。
 * @param {(hookEvent: string, sessionId: string, extra?: object) => void} report
 */
export function createStatusTracker(report) {
  const busy = new Set();

  function markBusy(sessionId) {
    const wasIdle = busy.size === 0;
    busy.add(sessionId);
    if (wasIdle) report('UserPromptSubmit', sessionId);
  }

  function markIdle(sessionId) {
    if (busy.delete(sessionId) && busy.size === 0) report('Stop', sessionId);
  }

  return (event) => {
    const props = event.properties || {};
    switch (event.type) {
      case 'session.status':
        if (props.status?.type === 'idle') markIdle(props.sessionID);
        else markBusy(props.sessionID);
        break;
      case 'session.idle':
      case 'session.deleted':
        markIdle(props.sessionID ?? props.info?.id);
        break;
      case 'permission.asked':
      case 'question.asked':
        report('Notification', props.sessionID, { notification_type: 'permission_prompt' });
        break;
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
        if (busy.size > 0) report('UserPromptSubmit', props.sessionID);
        break;
      default:
    }
  };
}

function reportToStatusScript(cwd, hookEvent, sessionId, extra = {}) {
  const child = spawn('node', [STATUS_SCRIPT], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ hook_event_name: hookEvent, session_id: sessionId, cwd, ...extra }));
}

export const VibeAnythingStatus = async ({ directory }) => {
  const onEvent = createStatusTracker((...args) => reportToStatusScript(directory, ...args));
  return { event: async ({ event }) => onEvent(event) };
};
