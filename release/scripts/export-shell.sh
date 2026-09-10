#!/usr/bin/env bash
# 导出公开壳仓库（dsh-supervisor-launcher）：壳源码 + 产品主页 README + MIT LICENSE + 公开仓 CI。
# 用法: release/scripts/export-shell.sh [publicRepoUrl]   # URL 缺省=只组装到 dist/export-shell/，不推送
#   publicRepoUrl 示例: git@github.com:<you>/dsh-supervisor-launcher.git
#
# ⚠ 双仓拆分（2026-09 定稿）：壳源码已不在本内核仓（本仓无 src-tauri/）。
#   壳现居独立公开仓，拥有自己的 CI（launcher-build.yml）——本脚本仅作「历史同步桥」保留，
#   不再是从零导出壳的通道。壳源码位置按下列顺序解析：
#     1) 环境变量 DSH_SHELL_DIR 指向的目录（可为壳仓根，或其中的 src-tauri）
#     2) 本仓旁挂的壳 checkout：.shell-work/src-tauri（CONTINUE-HANDOFF 约定的固定壳工作区）
#   找不到即明确报错退出（不再静默 cp 失败）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${1:-}"
OUT="dist/export-shell"

# 壳源码定位（双仓拆分后本仓无 src-tauri）
SHELL_SRC=""
if [ -n "${DSH_SHELL_DIR:-}" ]; then
  if [ -d "$DSH_SHELL_DIR/src-tauri" ]; then SHELL_SRC="$DSH_SHELL_DIR/src-tauri"; elif [ -d "$DSH_SHELL_DIR" ]; then SHELL_SRC="$DSH_SHELL_DIR"; fi
elif [ -d "$ROOT/.shell-work/src-tauri" ]; then
  SHELL_SRC="$ROOT/.shell-work/src-tauri"
fi
if [ -z "$SHELL_SRC" ] || [ ! -f "$SHELL_SRC/tauri.conf.json" ]; then
  echo "❌ 未找到壳源码（本仓已剥离 src-tauri）。请设置 DSH_SHELL_DIR=<壳仓路径>，"
  echo "   或在 $ROOT/.shell-work 放置壳 checkout。壳仓：wasi7mglns/dsh-supervisor-launcher。"
  exit 1
fi
echo "[export-shell] 壳源码: $SHELL_SRC"
rm -rf "$OUT"; mkdir -p "$OUT/src-tauri"

# 1) 壳源码（排除 target 构建物）
for f in Cargo.toml build.rs tauri.conf.json; do
  [ -f "$SHELL_SRC/$f" ] && cp "$SHELL_SRC/$f" "$OUT/src-tauri/"
done
for d in src capabilities bootstrap icons tests; do
  [ -d "$SHELL_SRC/$d" ] && cp -r "$SHELL_SRC/$d" "$OUT/src-tauri/"
done
# tests/ 必須随壳仓携带（2026-09-11）：CI 的「产物验收」步骤依赖
# tests/updater_artifacts.rs —— 它用 Tauri 自己的依赖（minisign-verify +
# RemoteRelease）验证产出的更新包与清单正是 Tauri 会接受的东西。
# 若缺失，CI 会在验收步骤失败（宁可失败也不静默发布不可更新的产物）。
# 公开壳 = 引导器形态（Phase 3 定案）：frontendDist 改回 bootstrap（仅引导页，MIT 可独立编译）。
# 完整面板壳（内嵌闭源 UI 产物）仅在内核仓本地构建（release/scripts/build-shell-frontend.sh 组装 frontend/）。
python3 - "$OUT/src-tauri/tauri.conf.json" "$OUT/src-tauri/Cargo.toml" <<'PY'
import json, sys, re
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
c['build']['frontendDist'] = 'bootstrap'
json.dump(c, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')
cargo_p = sys.argv[2]
# 公开壳无默认 embedded-panel feature（引导器模式）
s = open(cargo_p, encoding='utf-8').read()
s = re.sub(r'default = \["embedded-panel"\]\n', '', s)
open(cargo_p, 'w', encoding='utf-8').write(s)
print('[export-shell] frontendDist → bootstrap + Cargo.toml 去默认 embedded-panel（引导器形态）')
PY

# 2) 产品主页 README / MIT LICENSE / gitignore / 公开仓 CI
# 2b) CI 门禁脚本（**单源**：内核 ci/ 为准，导出到壳仓 ci/，避免两处漂移）
#     check-glibc.sh：断言 Linux 产物不超出 glibc 基座上限。
#     背景（实测）：glibc 前向兼容——在 Ubuntu 24.04(2.39) 构建的产物无法在
#     Ubuntu 22.04(2.35)/Debian 12(2.36) 运行；该门禁防止此缺陷回归。
mkdir -p "$OUT/ci"
cp "$ROOT/ci/check-glibc.sh" "$OUT/ci/check-glibc.sh"
chmod +x "$OUT/ci/check-glibc.sh"
# 2c) 壳发布工具（**单源**：内核 shell-release/ 为准）
#     assemble-shell-pkg.js：把「安装包 + .sig」组装为 npm 包（缺 .sig 即失败）
#     make-manifest.js      ：汇总为 Tauri 静态清单 shell-manifest.json
#     两者与 CI（launcher-build.yml）配套；放内核仓以保持单一事实源。
mkdir -p "$OUT/shell-release"
cp "$ROOT/shell-release/assemble-shell-pkg.js" "$OUT/shell-release/"
cp "$ROOT/shell-release/make-manifest.js" "$OUT/shell-release/"
chmod +x "$OUT/shell-release/"*.js
cp "$SHELL_SRC/LAUNCHER_README.md" "$OUT/README.md"
cp "$SHELL_SRC/LICENSE" "$OUT/LICENSE"
cp "$SHELL_SRC/.gitignore.shell" "$OUT/.gitignore"
mkdir -p "$OUT/.github/workflows"
cp "$SHELL_SRC/launcher-build.yml" "$OUT/.github/workflows/build.yml"

# 3) 冒烟自检（确保公开仓内容不含内核资产）
for p in "$OUT/src-tauri"/*; do
  case "$(basename "$p")" in src|capabilities|bootstrap|icons|Cargo.toml|build.rs|tauri.conf.json) ;;
    *) echo "警告: 意外文件进入导出: $p";; esac
done
[ -d "$OUT/src-tauri/target" ] && { echo "错误: target 误入导出"; exit 1; }
echo "== 公开壳仓库已组装: $OUT/（$(du -sh "$OUT" | awk '{print $1}')） =="
ls "$OUT" "$OUT/src-tauri"

if [ -n "$URL" ]; then
  cd "$OUT"
  git init -q -b main
  git add -A
  git -c user.name=dsh-supervisor-launcher -c user.email=dev@local.dsh commit -qm "shell export $(date +%F)"
  git remote add origin "$URL" 2>/dev/null || true
  echo "推送: cd $OUT && git push -u origin main"
else
  echo "（未给 URL：仅组装。推送命令样例: bash release/scripts/export-shell.sh git@github.com:<you>/dsh-supervisor-launcher.git）"
fi