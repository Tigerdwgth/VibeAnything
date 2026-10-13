const path = require('node:path');
const os = require('node:os');
const { loadConfig } = require('./config');

// IPC 目录：evt 事件链路（hook 写 evt-*.json → daemon 轮询转发给浏览器）
// 及 session-registry 的 sessions 子目录都基于此目录。
const DEFAULT_IPC_DIR = path.join(os.tmpdir(), 'claude-hooks-feishu');

function getIpcDir() {
  if (process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR) {
    return process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  }
  try {
    const cfg = loadConfig();
    if (cfg.ipcDir) return cfg.ipcDir;
  } catch {}
  return DEFAULT_IPC_DIR;
}

module.exports = {
  getIpcDir,
  IPC_DIR: DEFAULT_IPC_DIR
};
