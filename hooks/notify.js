#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { getMachineId } = require('../lib/config');
const { registerSession } = require('../lib/session-registry');
const { getIpcDir } = require('../lib/ipc');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { /* stdin 可能为空 */ }

  const hookEvent = data.hook_event_name || 'Stop';

  // 工具调用失败不上报
  if (hookEvent === 'PostToolUseFailure') return;

  const cwd = data.cwd || process.cwd();
  const machineId = getMachineId();
  const sessionId = data.session_id || '';
  registerSession({ machineId, sessionId, cwd, pid: process.pid });

  // 写 hook 事件到 IPC 目录，供 daemon 轮询后转发给浏览器（小人状态 + 声音提醒）
  const ipcDir = getIpcDir();
  fs.mkdirSync(ipcDir, { recursive: true });
  const evtFile = path.join(ipcDir, `evt-${Date.now()}-${sessionId.slice(0, 8)}.json`);
  fs.writeFileSync(evtFile, JSON.stringify({
    hookEvent, sessionId, machineId, cwd, timestamp: Date.now()
  }));
}

main().catch((e) => console.error('[notify]', e.message));
