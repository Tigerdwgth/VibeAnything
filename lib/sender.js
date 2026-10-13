const { loadConfig } = require('./config');
const { buildCardPayload, sendWebhook } = require('./feishu-webhook');
const { buildAppCardContent, sendAppMessage } = require('./feishu-app');

function resolveEventType(hookEvent, extra = {}) {
  if (extra.guard) return 'danger_blocked';
  const map = {
    Stop: 'task_complete',
    Notification: 'permission_request',
    PostToolUseFailure: 'tool_failure'
  };
  return map[hookEvent] || 'task_complete';
}

async function send({ type, cwd, fields = [], detail }) {
  // 兼容旧的 detail 字符串格式
  if (detail && fields.length === 0) {
    fields = [{ label: '详情', value: detail }];
  }

  const config = loadConfig();
  const errors = [];

  if (config.webhook.enabled && config.webhook.url) {
    try {
      const payload = buildCardPayload({ type, cwd, fields });
      await sendWebhook(config.webhook.url, payload, config.webhook.secret);
    } catch (e) { errors.push(`webhook: ${e.message}`); }
  }

  if (config.app.enabled && config.app.appId) {
    try {
      const content = buildAppCardContent({ type, cwd, fields });
      await sendAppMessage(
        config.app.appId, config.app.appSecret,
        config.app.receiverId, config.app.receiverType, content
      );
    } catch (e) { errors.push(`app: ${e.message}`); }
  }

  if (errors.length) console.error('[feishu-hooks]', errors.join('; '));
}

module.exports = { resolveEventType, send };
