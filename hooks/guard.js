#!/usr/bin/env node
const { loadConfig } = require('../lib/config');

const os = require('node:os');

// 受保护的系统/用户关键目录
const PROTECTED_PATHS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys',
  '/usr', '/var', os.homedir()
];

/**
 * 把 rm 的一个参数还原成 shell 实际会删的路径：去掉引号，展开开头的 ~ / $HOME / ${HOME}。
 * 只认绝对路径，相对路径（rm -rf build）不在拦截范围内，返回 null。
 * 末尾的 `/*` 表示删目录里的全部内容，按删这个目录本身处理（rm -rf ~/* 等于清空主目录）。
 */
function targetPath(token) {
  const home = os.homedir();
  const unquoted = token.replace(/["']/g, '');
  const expanded = unquoted.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (!expanded.startsWith('/')) return null;
  const dir = expanded.endsWith('/*') ? expanded.slice(0, -2) : expanded;
  return dir.replace(/\/+$/, '') || '/';
}

/**
 * 判断 rm -rf 是否危险：只有删除系统目录或用户主目录才拦截
 * 普通的 rm -rf some_dir 放行
 */
function isDangerousRm(command) {
  // 匹配 rm 命令中包含 -r/-rf/-Rf 等递归删除标志
  if (!/\brm\b/.test(command)) return null;
  if (!/\s-[a-zA-Z]*r[a-zA-Z]*f?/.test(command) && !/\s-[a-zA-Z]*f[a-zA-Z]*r/.test(command)) return null;

  // 提取 rm 后面的路径参数（跳过 flags）
  const parts = command.split(/[;&|]/).map(s => s.trim());
  for (const part of parts) {
    if (!/\brm\b/.test(part)) continue;
    const tokens = part.split(/\s+/);
    for (const token of tokens) {
      if (token === 'rm' || token.startsWith('-')) continue;
      const resolved = targetPath(token);
      if (!resolved) continue;
      // 检查是否是受保护路径或其父路径
      for (const p of PROTECTED_PATHS) {
        if (resolved === p || p.startsWith(resolved + '/')) {
          return `rm -rf 目标为受保护路径: ${token}`;
        }
      }
    }
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const command = data.tool_input?.command || '';
  if (!command) process.exit(0);

  const config = loadConfig();
  const patterns = config.dangerousPatterns || [];

  let matched = null;
  for (const pattern of patterns) {
    if (command.includes(pattern)) {
      matched = pattern;
      break;
    }
  }

  // rm -rf 智能检测：只拦截删除系统/用户主目录
  if (!matched) {
    matched = isDangerousRm(command);
  }

  if (!matched) process.exit(0);

  // 检测到危险命令：直接拦截（exit 2），stderr 原因会反馈给 Claude
  process.stderr.write(`已拦截危险命令: "${command}" (匹配规则: ${matched})`);
  process.exit(2);
}

main().catch((e) => {
  console.error('[guard]', e.message);
  process.exit(0);
});
