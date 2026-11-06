// lib/crontab.js
// crontab 自启动（@reboot + 每 5 分钟看门狗）与每小时用量上报的那几行。
//
// 从 bin/cli.js 拎出来是为了能单测「装 / 卸」对 crontab 文本做了什么：
// 从前卸载只删 marker 和 `--daemon start` 两种行，`--usage-report` 那行留在原地，
// 卸完每小时照跑；再装一次又追加一行，越装越多。

const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');

const CRONTAB_MARKER = '# vibeanything-daemon';

/**
 * 我们写进 crontab 的几行。
 * @param {{nodePath: string, cliPath: string, baseDir: string, vibeHome?: string}} opts
 */
function buildCrontabLines({ nodePath, cliPath, baseDir, vibeHome }) {
  const logPath = path.join(baseDir, 'daemon.log');
  // 如果设置了自定义 VIBEANYTHING_HOME 则注入环境变量
  const envPrefix = vibeHome ? `VIBEANYTHING_HOME=${vibeHome} ` : '';
  const cmd = `${envPrefix}${nodePath} ${cliPath} --daemon start >> ${logPath} 2>&1`;
  // 用量上报走同一份 crontab，落在 17 分而不是整点：整点是各种定时任务的高峰，
  // ccusage 要全量扫 jsonl，错开能避免和别的活儿抢磁盘。
  const usageLog = path.join(baseDir, 'usage-report.log');
  const usageCmd = `${envPrefix}${nodePath} ${cliPath} --usage-report >> ${usageLog} 2>&1`;
  return [
    CRONTAB_MARKER,
    `@reboot ${cmd}`,
    `*/5 * * * * ${cmd}`,
    `17 * * * * ${usageCmd}`,
  ];
}

/** 是不是我们写的行：marker，或者跑 cli.js 的 daemon 启动 / 用量上报（node 与仓库路径换过也认）。 */
function isOurCrontabLine(line) {
  if (line.includes(CRONTAB_MARKER)) return true;
  return line.includes('cli.js') && (line.includes('--daemon start') || line.includes('--usage-report'));
}

/** 去掉我们写的全部行，别人的原样保留。 */
function stripOurCrontabLines(content) {
  return content.split('\n').filter(line => !isOurCrontabLine(line)).join('\n');
}

/**
 * 装：已经有 marker 就不动（返回 null）。没有 marker 时先清掉旧版卸载漏下的用量上报行，再追加一整套，
 * 保证每种行只有一份。
 */
function crontabWithOurLines(existing, lines) {
  if (existing.includes(CRONTAB_MARKER)) return null;
  return stripOurCrontabLines(existing).trimEnd() + '\n' + lines.join('\n') + '\n';
}

function readCrontab() {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function writeCrontab(content) {
  execFileSync('crontab', ['-'], { input: content });
}

module.exports = {
  CRONTAB_MARKER, buildCrontabLines, isOurCrontabLine, stripOurCrontabLines, crontabWithOurLines,
  readCrontab, writeCrontab,
};
