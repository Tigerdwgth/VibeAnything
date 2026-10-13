#!/usr/bin/env node
const { resolveEventType, send } = require('../lib/sender');
const { getMachineId } = require('../lib/config');
const { registerSession } = require('../lib/session-registry');

function extractToolInput(data) {
  const input = data.tool_input || {};
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.url) return input.url;
  return JSON.stringify(input);
}

function buildFields(hookEvent, data) {
  const fields = [];
  const sid = data.session_id;
  if (sid) fields.push({ label: '会话ID', value: sid });

  if (hookEvent === 'Stop') {
    const msg = data.last_assistant_message;
    if (msg) fields.push({ label: 'Claude 回复', value: msg });
    if (data.transcript_path) fields.push({ label: 'Transcript', value: data.transcript_path });
  } else if (hookEvent === 'Notification') {
    if (data.title) fields.push({ label: '标题', value: data.title });
    if (data.message) fields.push({ label: '内容', value: data.message });
    if (data.notification_type) fields.push({ label: '通知类型', value: data.notification_type });
  } else if (hookEvent === 'PostToolUseFailure') {
    if (data.tool_name) fields.push({ label: '工具', value: data.tool_name });
    fields.push({ label: '输入', value: extractToolInput(data) });
    if (data.error) fields.push({ label: '错误', value: data.error });
  }

  return fields;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { /* stdin 可能为空 */ }

  const hookEvent = data.hook_event_name || 'Stop';

  // 工具调用失败不发通知
  if (hookEvent === 'PostToolUseFailure') return;

  const cwd = data.cwd || process.cwd();
  const machineId = getMachineId();
  const sessionId = data.session_id || '';
  registerSession({ machineId, sessionId, cwd, pid: process.pid });
  const type = resolveEventType(hookEvent, {});
  const fields = buildFields(hookEvent, data);

  // 写 hook 事件到 IPC 目录，供 daemon 轮询后转发给浏览器（小人状态 + 声音提醒）
  try {
    const { getIpcDir } = require('../lib/ipc');
    const fs = require('node:fs');
    const ipcDir = getIpcDir();
    fs.mkdirSync(ipcDir, { recursive: true });
    const evtFile = require('node:path').join(ipcDir, `evt-${Date.now()}-${sessionId.slice(0, 8)}.json`);
    fs.writeFileSync(evtFile, JSON.stringify({
      hookEvent, sessionId, machineId, cwd, timestamp: Date.now()
    }));
  } catch {}

  await send({ type, cwd, fields });
}

module.exports = { buildFields, extractToolInput };

if (require.main === module) {
  main().catch((e) => console.error('[notify]', e.message));
}
