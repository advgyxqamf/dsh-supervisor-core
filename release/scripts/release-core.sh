#!/usr/bin/env bash
# 一键发布编排（内核）——**Linux 本地生产**主入口（2026-09-10 平台分工定案）。
#
# 平台分工：
#   - linux-x64：**本脚本在 Linux 机器上生产并直推 npm**（不经 GitHub，省 Actions 额度）。
#   - win-x64 / darwin-arm64 / darwin-x64：由本脚本推送的 tag 触发 .github/workflows/build.yml
#     的 mac/win 矩阵生产。**故本脚本只允许在 Linux 上真发布**（在 mac/win 跑 --publish 会与
#     CI 形成同平台二次发布，npm 拒绝且不可覆盖）。
#
# 用法（仓库根执行）：
#   npm run release:core            # dry-run：完整门禁 + 组装 + 打印发布计划（不 tag/push/发）
#   npm run release:core:publish    # 真发：门禁通过 → commit+tag+push（触发 mac/win CI）→ 本地发 linux 子包
#
# 架构（单源，2026-09-10 重构）：
#   **验证与构建逻辑不在此重复实现**——本脚本是薄编排，验证/构建/组装全部委托 `ci-core.sh`
#   （同一份逻辑，CI 的 mac/win 也跑它）。本脚本只额外负责三件 CI 不需要的事：
#     ① 平台闸（非 Linux 拒绝真发） ② 干净树/CHANGELOG 预检 ③ tag/push 与发布时序。
#   以前本脚本自己又写了一遍 verify/test/build，与 ci-core.sh 双份维护——已消除。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
case "${1:-}" in
  --publish|publish) PUBLISH=1 ;;
  ""|--dry-run) ;;
  *) echo "未知参数: $1（支持 --publish=真发 / 默认 dry-run）"; exit 2 ;;
esac

VER="$(node -p "require('./package.json').version")"
PLAT="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
OS_TAG="$(node -p "process.platform==='win32'?'win':process.platform")"

echo "=== 平台/版本 ==="
echo "  本机: $PLAT-$ARCH   内核版本: $VER"

# ── 平台闸（仅约束真发布；dry-run 在任何平台都可跑，便于 mac/win 上先本地验一遍）──
if [ "$PUBLISH" = 1 ] && [ "$PLAT" != "linux" ]; then
  echo "❌ 本机平台为 $PLAT，而本地真发布通道**仅限 Linux**（2026-09-10 定案）。"
  echo "   $PLAT 子包由 GitHub CI 在推送 tag 后生产。请改为："
  echo "     git tag v$VER && git push --tags      # 触发 build.yml 的 mac/win 矩阵"
  echo "   若确需在本机手工发布（例如 CI 额度耗尽），用底层脚本并自行承担与 CI 的重复发布风险："
  echo "     npm run build:launcher && npm run publish:core -- --publish"
  exit 2
fi

echo "=== [1/5] 预检：工作树干净（发布必须从干净树出发，可复现 tag） ==="
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作树有未提交改动，中止。请先 commit/stash："; git status --short; exit 1
fi

echo "=== [2/5] 版本 + CHANGELOG 自洽校验 ==="
npm run verify:versions
grep -q "## \[$VER\]" CHANGELOG.md || { echo "❌ CHANGELOG.md 缺 [${VER}] 段，先整理 [未发布] → [$VER]"; exit 1; }
echo "  CHANGELOG 含 [$VER] 段 ✓"

echo "=== [3/5] 委托产线核心 ci-core.sh（verify → build-ui → npm test → build:launcher → 子包 dry-run） ==="
# 本地 ui/node_modules 已就绪时跳过 npm ci（省时）；CI 不设该变量 → 仍走可复现构建。
if [ -d "$ROOT/ui/node_modules" ]; then export DSH_UI_SKIP_INSTALL=1; fi
bash release/scripts/ci-core.sh

if [ "$PUBLISH" = 1 ]; then
  # 时序（可回退优先）：先 tag+push（标签可删；CI 需时间构建），再本地发 linux 子包。
  # 若反过来（先发 npm 后 push），一旦 push 失败即「已发布但无 tag」——同版本不可重发，无法补救。
  echo "=== [4/5] 提交 + 打 tag + 推送（触发 build.yml 的 mac/win 矩阵） ==="
  if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "release: v$VER"
  else
    echo "  工作树无待提交改动（版本已在先前提交中就位）→ 跳过 commit"
  fi
  git tag "v$VER"
  git push --tags
  echo "  ✅ 已推送 tag v$VER —— CI 将构建 win-x64 / darwin-arm64 / darwin-x64 并发布子包"

  echo "=== [5/5] 本地发布 $OS_TAG-$ARCH 子包（官方 registry） ==="
  echo "  ⚠ 若此处失败：tag 已推送、mac/win 已在 CI 发布；本步可单独重跑："
  echo "     npm run publish:core -- --publish"
  npm run publish:core -- --publish
else
  echo "=== [4/5] （dry-run：未 commit/tag/push） ==="
  echo "=== [5/5] （dry-run：未发布） ==="
fi

echo "=== 发布清单 ==="
echo "  内核版本: v$VER"
echo "  本地子包: @dsh-sup/dsh-core-$OS_TAG-$ARCH"
if [ "$PUBLISH" = 1 ]; then
  echo "  本地已发: $OS_TAG-$ARCH（官方 registry）"
  echo "  CI 待发:  win-x64 / darwin-arm64 / darwin-x64（tag v$VER 触发）"
else
  echo "  确认无误后执行: npm run release:core:publish"
fi
