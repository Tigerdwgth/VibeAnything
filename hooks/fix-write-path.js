#!/usr/bin/env node
/**
 * PreToolUse hook: 将 Write 工具的相对路径转换为绝对路径。
 * 解决子 agent 使用相对路径写文件时 path 为 undefined 的问题。
 */
const path = require('node:path');

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolInput = data.tool_input || {};

    if (data.tool_name === 'Write') {
      const filePath = toolInput.file_path || '';
      if (filePath && !path.isAbsolute(filePath)) {
        toolInput.file_path = path.join(process.cwd(), filePath);
        process.stdout.write(JSON.stringify({ tool_input: toolInput }));
      }
    }
  } catch (_) {
    // 解析失败则放行，不影响正常工具调用
  }
  process.exit(0);
});
