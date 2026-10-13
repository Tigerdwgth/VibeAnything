#!/usr/bin/env node
const { loadConfig } = require('../lib/config');
const { send } = require('../lib/sender');

const os = require('node:os');

// 受保护的系统/用户关键目录
const PROTECTED_PATHS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys',
  '/usr', '/var', os.homedir()
];

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
      // 解析路径
      const resolved = token.startsWith('/')
        ? token.replace(/\/+$/, '') || '/'
        : null;
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

  // 检测到危险命令：发单向通知告警，然后直接拦截（exit 2）
  const fields = [
    { label: '命令', value: command },
    { label: '匹配规则', value: matched }
  ];
  if (data.session_id) fields.push({ label: '会话ID', value: data.session_id });
  await send({ type: 'danger_blocked', cwd: data.cwd || process.cwd(), fields });
  process.stderr.write(`已拦截危险命令: "${command}" (匹配规则: ${matched})`);
  process.exit(2);
}

main().catch((e) => {
  console.error('[guard]', e.message);
  process.exit(0);
});
