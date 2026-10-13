// lib/paths.js
// 「东西放在哪」只在这里定义一次：配置目录、配置文件、hooks、pid、日志、cli 入口。
//
// 以前 getBaseDir/getConfigPath 在 config.js、getPidPath/getLogPath 在 daemon.js，
// 新加的 service.js（写 launchd/systemd unit）两边都要用 —— unit 里必须写死
// VIBEANYTHING_HOME 和日志路径。require('./daemon') 会把 ws-client 整条依赖链拖进来，
// 所以路径这一层单独拎出来：只依赖 os/path 和环境变量，谁都能安全 require。

const os = require('node:os');
const path = require('node:path');

const CONFIG_DIR_NAME = '.vibeanything';

/** 配置与运行时状态的根目录。VIBEANYTHING_HOME 可覆盖（容器/多用户同机时用）。 */
function getBaseDir() {
  return process.env.VIBEANYTHING_HOME || path.join(os.homedir(), CONFIG_DIR_NAME);
}

function getConfigPath() {
  return path.join(getBaseDir(), 'config.json');
}

function getHooksDir() {
  return path.join(getBaseDir(), 'hooks');
}

function getPidPath() {
  return path.join(getBaseDir(), 'daemon.pid');
}

function getLogPath() {
  return path.join(getBaseDir(), 'daemon.log');
}

/** 这份检出的根目录。unit 文件、自举命令都要用绝对路径。 */
function repoRoot() {
  return path.resolve(__dirname, '..');
}

function cliPath() {
  return path.join(repoRoot(), 'bin', 'cli.js');
}

module.exports = {
  CONFIG_DIR_NAME, getBaseDir, getConfigPath, getHooksDir, getPidPath, getLogPath, repoRoot, cliPath,
};
