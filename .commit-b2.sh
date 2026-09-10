#!/usr/bin/env bash
set -euo pipefail
cd /home/bowen/develop/plus
echo "=== 待提交项 ==="
git status --short | head -12
echo "  ...共 $(git status --short | wc -l) 项"
echo
echo "=== 确认 .shell-work 不再是 gitlink ==="
if git ls-files -s .shell-work | grep -q 160000; then echo "  ❌ 仍是 gitlink"; else echo "  ✅ 已不是 gitlink"; fi
echo
echo "=== 提交 ==="
git add -A
git -c user.name='dsh-agent' -c user.email='dsh@local' commit -q -F .b2msg.tmp
rm -f .b2msg.tmp
echo "  $(git log --oneline -1)"
echo
echo "=== 提交后再确认 gitlink 已消失 ==="
git ls-files -s | grep -c 160000 | xargs -I{} echo "  剩余 gitlink 数: {}"
