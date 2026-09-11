#!/usr/bin/env bash
# 一键发布编排（内核）。
#
# ── 两种生产模式（2026-09-11）──
#
#  A) **全平台本地生产** —— 推荐，**零 GitHub Actions 额度**
#       npm run release:core:all            # dry-run（完整门禁 + 组装 + 打印计划）
#       npm run release:core:all:publish    # 真发：一次构建 → 派生 4 平台 → 全部直推 npm
#
#  B) 单平台本地生产 + CI 补 mac/win —— 历史模式，**消耗额度**
#       npm run release:core:publish        # 本机发自己的平台；推 tag 触发 CI 发其余平台
#
# 为什么 A 可行（实测依据）：launcher 是**纯 JS 产物**——内核依赖数为 0、产物中 .node 数为 0，
#   平台差异**仅**体现在 npm 的 os/cpu 元数据与目录名。同一 bundle 在 linux / win32 / darwin 三种
#   覆盖下 sha256 完全一致（本机逐一验证）。故**一台 Linux 即可产出全部四平台的正确产物**。
#
# 为什么需要 A（真实动因）：私有仓 Actions 额度按倍率计费（macOS 10x、Windows 2x），
#   本仓 mac/win 矩阵约 110 分钟/次，免费额度 2000 分钟/月仅够约 18 次 —— 曾实测耗尽
#   （run #25 起 job 拿不到 runner、steps=0、秒级失败）。A 模式把额度消耗降为 0。
#
# 架构（单源，2026-09-10 重构）：**验证与构建逻辑不在此重复实现**——本脚本是薄编排，
#   验证/构建/组装全部委托 ci-core.sh（CI 的 mac/win 也跑它）。本脚本只额外负责三件
#   CI 不需要的事：① 干净树/CHANGELOG 预检 ② tag/push 时序 ③ 发布清单汇总。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
ALL_PLATFORMS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish|publish) PUBLISH=1 ;;
    --all-platforms) ALL_PLATFORMS=1 ;;
    ""|--dry-run) ;;
    *) echo "未知参数: $1（支持 --publish / --all-platforms / 默认 dry-run）"; exit 2 ;;
  esac
  shift
done

VER="$(node -p "require('./package.json').version")"
HOST_PLAT="$(node -p "process.platform")"
HOST_ARCH="$(node -p "process.arch")"
HOST_OS="$(node -p "process.platform==='win32'?'win':process.platform")"

echo "=== 模式/版本 ==="
echo "  本机: $HOST_PLAT-$HOST_ARCH   内核版本: $VER"
if [ "$ALL_PLATFORMS" = 1 ]; then
  echo "  生产模式: **全平台本地生产**（不经 GitHub CI，零 Actions 额度）"
else
  echo "  生产模式: 单平台本地生产（$HOST_OS-$HOST_ARCH）+ CI 补其余平台（消耗额度）"
fi

# ── 平台闸 ──
# 单平台真发布在非 Linux 上会与 CI 形成同平台二次发布（npm 拒绝且不可覆盖），故仍拦；
# 全平台模式已自带全部平台，无此问题，任何平台皆可。
if [ "$PUBLISH" = 1 ] && [ "$ALL_PLATFORMS" != 1 ] && [ "$HOST_PLAT" != "linux" ]; then
  echo "❌ 本机为 $HOST_PLAT：单平台真发布通道仅限 Linux（2026-09-10 定案）。"
  echo "   请改用全平台模式（它不依赖 CI，任何平台都能跑）："
  echo "     npm run release:core:all:publish"
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

if [ "$ALL_PLATFORMS" = 1 ]; then
  echo "=== [3/5] 委托产线核心 ci-core.sh --all-platforms（verify → build-ui → npm test → 构建全平台 → 全平台 dry-run） ==="
else
  echo "=== [3/5] 委托产线核心 ci-core.sh（verify → build-ui → npm test → build:launcher → 子包 dry-run） ==="
fi
# 本地 ui/node_modules 已就绪时跳过 npm ci（省时）；CI 不设该变量 → 仍走可复现构建。
if [ -d "$ROOT/ui/node_modules" ]; then export DSH_UI_SKIP_INSTALL=1; fi
if [ "$ALL_PLATFORMS" = 1 ]; then
  bash release/scripts/ci-core.sh --all-platforms
else
  bash release/scripts/ci-core.sh
fi

if [ "$PUBLISH" = 1 ]; then
  # 时序（可回退优先）：先 tag+push（标签可删），再本地发子包。
  # 若反过来（先发 npm 后 push），一旦 push 失败即「已发布但无 tag」——同版本不可重发，无法补救。
  echo "=== [4/5] 提交 + 打 tag + 推送 ==="
  if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "release: v$VER"
  else
    echo "  工作树无待提交改动（版本已在先前提交中就位）→ 跳过 commit"
  fi
  git tag "v$VER"
  # 必须同时推**分支**与 tag（2026-09-11 修复）：只 `git push --tags` 会让提交仅存在于 tag 上，
  # 既造成仓库状态不一致，也让依赖默认分支的手动触发跑到旧版本；
  # 更关键的是 GitHub 对「指向非分支提交的 tag」**不触发 workflow**（实测匹配 run 数为 0）。
  git push origin HEAD --tags
  echo "  ✅ 已推送分支 + tag v$VER"
  if [ "$ALL_PLATFORMS" = 1 ]; then
    echo "     注：tag 仍会触发 CI，但 workflow 的 precheck 会先判断「本版是否已全部发布」，"
    echo "         已全部发布即**跳过整个 mac/win 矩阵**（把额度消耗从约 110 分钟压到约 1 分钟）。"
  else
    echo "     CI 将构建其余平台并发布子包。"
  fi

  if [ "$ALL_PLATFORMS" = 1 ]; then
    echo "=== [5/5] 全平台本地发布（4 个平台，官方 registry） ==="
    echo "  ⚠ 幂等：已存在的平台会自动跳过并核对体积，可安全重跑。"
    npm run publish:core -- --publish --all-platforms
  else
    echo "=== [5/5] 本地发布 $HOST_OS-$HOST_ARCH 子包（官方 registry） ==="
    echo "  ⚠ 若此处失败：tag 已推送；本步可单独重跑："
    echo "     npm run publish:core -- --publish"
    npm run publish:core -- --publish
  fi
else
  echo "=== [4/5] （dry-run：未 commit/tag/push） ==="
  echo "=== [5/5] （dry-run：未发布） ==="
fi

echo "=== 发布清单 ==="
echo "  内核版本: $VER"
if [ "$ALL_PLATFORMS" = 1 ]; then
  echo "  平台: linux-x64 / darwin-arm64 / darwin-x64 / win-x64（全平台）"
  if [ "$PUBLISH" = 1 ]; then
    echo "  已发布: 全部 4 个平台（官方 registry）"
  else
    echo "  确认无误后执行: npm run release:core:all:publish"
  fi
else
  echo "  本地子包: @dsh-sup/dsh-core-$HOST_OS-$HOST_ARCH"
  if [ "$PUBLISH" = 1 ]; then
    echo "  本地已发: $HOST_OS-$HOST_ARCH（官方 registry）"
    echo "  CI 待发:  其余平台（tag v$VER 触发）"
  else
    echo "  确认无误后执行: npm run release:core:publish（或 release:core:all:publish 走零额度全平台）"
  fi
fi
