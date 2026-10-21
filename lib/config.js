const fs = require('node:fs');
const os = require('node:os');
// 路径定义在 paths.js（service.js 也要用，而它不能 require daemon.js —— 会把 ws-client 整条链拖进来）
const { getBaseDir, getConfigPath, getHooksDir } = require('./paths');

function defaultConfig() {
  return {
    ipcDir: '',
    machineId: '',
    defaultWorkDir: '',      // 文件浏览器默认起始路径，空则用 os.homedir()
    hooks: {
      notify: true,
      guard: true,
      formatPython: true,
      codeReview: true,
      fixWritePath: true,
      status: true   // 会话红绿灯状态上报（UserPromptSubmit/Stop → status.js）
    },
    codexWhip: {
      enabled: true,     // codex 会话遇容量/429 限流错误时自动写 continue 续跑
      cooldownMs: 30000, // 两次自动 continue 之间的最短间隔（防抖）
      intervalMs: 5000   // 已停用：tmux 级监控已移除，改由独立插件 codex-continue 承担
    },
    server: {
      port: 3000,
      host: '0.0.0.0',    // 绑定地址（设为 Tailscale IP 可限制仅内网访问）
      machineTokens: []   // 允许连接的机器 token 列表
    },
    centralServer: {
      enabled: false,
      url: '',          // e.g. "ws://your-server:3000/ws"
      machineToken: '', // UUID，在中央服务器配置的 MACHINE_TOKENS 里
      machineId: ''     // 留空则用 getMachineId()
    },
    fileAccess: {
      blockedDirs: ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.env'],
      blockedSystemPaths: ['/etc/shadow', '/etc/passwd', '/proc', '/sys'],
      maxFileSizeKB: 100
    },
    pythonFormatter: 'black',
    dangerousPatterns: [
      'rm -r /', 'git push --force', 'git push -f',
      'git reset --hard', 'DROP TABLE', 'DROP DATABASE',
      'mkfs', 'dd if=', '> /dev/sda'
    ]
  };
}

function getMachineId() {
  if (process.env.VIBEANYTHING_MACHINE_ID) {
    return process.env.VIBEANYTHING_MACHINE_ID;
  }
  const cfg = loadConfig();
  if (cfg.machineId) {
    return cfg.machineId;
  }
  return os.hostname();
}

/**
 * 配置的合并规则：默认值在下、配置文件在上，**逐层**覆盖。
 *
 * 以前这里是一层展开（`{...defaultConfig(), ...fileJson}`），于是配置文件里只要写了
 * `"centralServer": { "url": ..., "machineToken": ... }`，整个 centralServer 默认值就被
 * 换掉 —— `enabled` 变 undefined，daemon 判 `cfg.centralServer?.enabled` 为假，装完机
 * 一声不响地不连服务器。这正是部署文档里那 40 行配置必须整段照抄的原因：
 * 少写一个嵌套字段不会报错，只会悄悄失效。
 *
 * 数组（黑名单、危险命令、machineTokens）按**替换**处理：这些是完整列表，
 * 合并进默认值只会让人删不掉默认项。
 */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 配置文件的原样内容（不掺默认值）。改配置时要基于它写回，否则会把整份默认值抄进文件。 */
function readRawConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function loadConfig() {
  return deepMerge(defaultConfig(), readRawConfig());
}

/**
 * 把一小段改动合并进配置文件并落盘，文件里只留用户真正设过的键。
 * 装机（join）只需要写 machineId + centralServer 三个字段，剩下的一律吃默认值。
 * @param {object} patch 逐层合并进现有文件的改动
 * @returns {object} 写回文件的内容（不含默认值）
 */
function patchConfigFile(patch) {
  const merged = deepMerge(readRawConfig(), patch);
  const baseDir = getBaseDir();
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function saveConfig(config) {
  const baseDir = getBaseDir();
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}

module.exports = {
  loadConfig,
  saveConfig,
  readRawConfig,
  patchConfigFile,
  deepMerge,
  getConfigPath,
  getHooksDir,
  getBaseDir,
  defaultConfig,
  getMachineId
};
