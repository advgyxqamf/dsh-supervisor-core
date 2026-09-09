#!/usr/bin/env bash
# 一键发布编排（内核）：把「脏树校验 → 版本 bump/校验 → CHANGELOG → 构建 → 子包发布 → tag/推送」串成单命令。
# 用法（在仓库根执行）：
#   npm run release:core                # dry-run 编排：bump + verify + build:sea + 子包 dry-run + 打印发布清单（不 tag 不推送）
#   npm run release:core:publish        # 真发编排：同上前置验证通过后 → 子包 --publish → commit+tag v<ver> → push --tags 触发 CI
# 平台：当前机器逐平台构建（无交叉编译）；多平台发布由各平台 runner 跑 ci-core.sh --publish。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
case "${1:-}" in
  --publish|publish) PUBLISH=1 ;;
  ""|--dry-run) ;; 
  *) echo "未知参数: $1（支持 --publish=真发 / 默认 dry-run）"; exit 2 ;;
esac

echo "=== [0/6] 预检：工作树干净（发布必须从干净树出发，可复现 tag） ==="
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作树有未提交改动，中止。请先 commit/stash："; git status --short; exit 1
fi

VER="$(node -p "require('./package.json').version")"
echo "当前内核版本: $VER（package.json 单源）"

echo "=== [1/6] 版本自洽校验 ==="
npm run verify:versions

echo "=== [2/6] 构建内核 SEA（build:sea 自带 self-check/--version/fresh-HOME/UI 冒烟） ==="
npm run build:sea

echo "=== [3/6] 子包组装 + $([ $PUBLISH = 1 ] && echo 真发布 || echo dry-run) ==="
if [ "$PUBLISH" = 1 ]; then
  npm run publish:core -- --publish
else
  npm run publish:core -- --dry-run
fi

echo "=== [4/6] CHANGELOG 检查：${VER} 应有对应段 ==="
grep -q "## \[$VER\]" CHANGELOG.md || { echo "❌ CHANGELOG.md 缺 [${VER}] 段，先整理 [未发布] → [$VER]"; exit 1; }

if [ "$PUBLISH" = 1 ]; then
  echo "=== [5/6] 提交 + 打 tag + 推送（触发私有仓 build.yml 全平台产线） ==="
  git add -A && git commit -m "release: v$VER" >/dev/null
  git tag "v$VER"
  git push --tags
  echo "  ✅ 已推送 tag v$VER —— CI 矩阵将逐平台构建 SEA + 发布子包 + 挂 Release"
else
  echo "=== [5/6] （dry-run：未 commit/tag/push） ==="
fi

echo "=== [6/6] 发布清单 ==="
echo "  内核版本: v$VER"
echo "  本机子包: @dsh-sup/dsh-core-$(node -p "process.platform==='win32'?'win':process.platform")-$(node -p "process.arch")"
if [ "$PUBLISH" = 1 ]; then
  echo "  触发: build.yml → 4 平台矩阵（linux-x64/win-x64/darwin-arm64/darwin-x64）"
else
  echo "  确认无误后执行: npm run release:core:publish（真发 + tag + push）"
fi