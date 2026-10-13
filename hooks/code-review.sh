#!/bin/bash
# PreToolUse hook: git commit 前自动代码审查
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{const j=JSON.parse(d);console.log(j.tool_input?.command||'')}
    catch{console.log('')}
  })
")

# 只拦截 git commit 命令
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

CWD=$(echo "$INPUT" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{const j=JSON.parse(d);console.log(j.cwd||'.')}
    catch{console.log('.')}
  })
")

cd "$CWD" 2>/dev/null || exit 0

# 检查暂存区的 Python 文件
STAGED_PY=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep '\.py$')
if [ -n "$STAGED_PY" ]; then
  echo "=== 代码审查: 检查暂存的 Python 文件 ==="
  ISSUES=""
  for f in $STAGED_PY; do
    if [ -f "$f" ] && command -v pycodestyle &>/dev/null; then
      RESULT=$(pycodestyle "$f" 2>&1)
      if [ -n "$RESULT" ]; then
        ISSUES="$ISSUES\n$RESULT"
      fi
    fi
  done
  if [ -n "$ISSUES" ]; then
    echo "发现代码风格问题:"
    echo -e "$ISSUES"
    echo "建议修复后再 commit。"
  else
    echo "代码审查通过，无风格问题。"
  fi
fi
exit 0
