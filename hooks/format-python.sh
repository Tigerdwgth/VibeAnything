#!/bin/bash
# PostToolUse hook: 自动格式化 Python 文件
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{const j=JSON.parse(d);console.log(j.tool_input?.file_path||j.tool_input?.path||'')}
    catch{console.log('')}
  })
")

if [[ "$FILE_PATH" != *.py ]]; then
  exit 0
fi

if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# 读取配置中的 formatter，默认 black
CONFIG_FILE="$HOME/.claude-hooks-feishu/config.json"
FORMATTER="black"
if [ -f "$CONFIG_FILE" ]; then
  F=$(node -e "try{const c=require('$CONFIG_FILE');console.log(c.pythonFormatter||'black')}catch{console.log('black')}")
  if [ -n "$F" ]; then FORMATTER="$F"; fi
fi

if command -v "$FORMATTER" &>/dev/null; then
  "$FORMATTER" "$FILE_PATH" --quiet 2>/dev/null
  echo "已格式化: $FILE_PATH (使用 $FORMATTER)"
fi
exit 0
