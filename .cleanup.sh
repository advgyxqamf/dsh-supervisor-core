#!/usr/bin/env bash
set -euo pipefail
cd /home/bowen/develop/plus
echo "=== 1) 从版本库移除误提交的临时文件 ==="
git rm --cached .b2msg.tmp .commit-b2.sh -q 2>/dev/null || true
rm -f .b2msg.tmp .commit-b2.sh
printf '\n# 临时文件（发布提交时曾被误纳入）\n.b2msg.tmp\n.commit-b2.sh\n*.tmp\n' >> .gitignore
git add -A
git -c user.name='dsh-agent' -c user.email='dsh@local' commit -q -m "chore: 移除误提交的临时文件并加入 .gitignore"
echo "  $(git log --oneline -1)"
echo
echo "=== 2) 确认工作树干净 ==="
if [ -n "$(git status --porcelain)" ]; then git status --short | sed 's/^/  /'; else echo "  ✅ 干净"; fi
