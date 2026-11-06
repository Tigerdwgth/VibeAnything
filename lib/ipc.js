const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadConfig } = require('./config');
const { getBaseDir } = require('./paths');

// IPC 目录：evt 事件链路（hook 写 evt-*.json → daemon 轮询转发给浏览器）
// 及 session-registry 的 sessions 子目录都基于此目录。
//
// 默认放在本用户的配置根目录下（<VIBEANYTHING_HOME|~/.vibeanything>/ipc，权限 0700）。
// 从前是 os.tmpdir()/claude-hooks-feishu：Linux 上就是所有用户共用的 /tmp，先装的用户
// 建出 0755 的目录，后来的用户 hook 写不进去（灯永远不亮），daemon 却能读到前者的会话登记。
// hook 与 daemon 用同一个函数算目录，规则只有这一份。
const IPC_SUBDIR = 'ipc';

// 旧版默认目录。旧版本复制到 ~/.vibeanything/hooks 的 hook 脚本带着旧的 ipc.js，
// 重跑安装向导之前仍往这里写，daemon 要接着收（见 getLegacyIpcDir）。
const LEGACY_IPC_DIR = path.join(os.tmpdir(), 'claude-hooks-feishu');

/** 显式配置的目录（环境变量优先于配置文件），没配返回空串。 */
function explicitIpcDir() {
  if (process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR) {
    return process.env.CLAUDE_HOOKS_FEISHU_IPC_DIR;
  }
  try {
    return loadConfig().ipcDir || '';
  } catch {
    return '';
  }
}

function getIpcDir() {
  return explicitIpcDir() || path.join(getBaseDir(), IPC_SUBDIR);
}

/** 建好并返回 IPC 目录（新建时 0700：evt 与会话登记里有 cwd、会话 id，不给同机其他用户看）。 */
function ensureIpcDir() {
  const dir = getIpcDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 旧默认目录，仅当它确实是本用户的、且没有显式配置时返回（否则 null）。
 * 共用 /tmp 上这个目录可能是别的用户建的：不是自己的就不读也不删，免得收到别人的事件。
 */
function getLegacyIpcDir() {
  if (explicitIpcDir()) return null;
  try {
    return fs.statSync(LEGACY_IPC_DIR).uid === process.getuid() ? LEGACY_IPC_DIR : null;
  } catch {
    return null;
  }
}

module.exports = {
  getIpcDir,
  ensureIpcDir,
  getLegacyIpcDir,
  LEGACY_IPC_DIR,
};
