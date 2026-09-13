#!/usr/bin/env bash
# 前端统一构建入口（2026-09-06 定：一源双出口）。
#   源码唯一事实源 = ui/（React，入口 supervisor.html）
#   出口① = ui/dist（构建临时产物，gitignored）
#   出口② = ui-react（守卫托管发布镜像：浏览器/局域网 GET / 服务；release.sh/SEA/npm 子包携带）
# 用法: release/scripts/build-ui.sh [--skip-install]
#   - 默认先 npm ci（可复现构建）；--skip-install 跳过（本地已装依赖时加速）
#   - 产物自检：supervisor.html 存在 + 含 root 挂载点
# 被调方：release.sh / build-sea.sh / publish-core.sh / CI（见 REDESIGN-2026-09-06-frontend-build-strategy.md）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UI="$ROOT/ui"
SKIP_INSTALL=0
[ "${1:-}" = "--skip-install" ] && SKIP_INSTALL=1
# 环境变量等价形式（2026-09-10）：供 CI（ci-core.sh）在 ui/node_modules 已就绪时
# 跳过 npm ci，省时；CI 侧不设置该变量 → 仍走可复现的 npm ci。
[ "${DSH_UI_SKIP_INSTALL:-0}" = "1" ] && SKIP_INSTALL=1

echo "[ui] unified frontend build (src=$UI)"
[ -d "$UI" ] && [ -f "$UI/package.json" ] || { echo "[ui] ERROR: frontend source missing (expected $UI/package.json)"; exit 1; }

if [ "$SKIP_INSTALL" = 0 ] && [ -f "$UI/package-lock.json" ]; then
  echo "[ui] npm ci (lockfile reproducible build)..."
  (cd "$UI" && npm ci) || { echo "[ui] ERROR: npm ci failed"; exit 1; }
fi

echo "[ui] npm run build -> ui/dist/ ..."
(cd "$UI" && npm run build) || { echo "[ui] ERROR: UI build failed"; exit 1; }
[ -f "$UI/dist/supervisor.html" ] || { echo "[ui] ERROR: supervisor.html missing in build output"; exit 1; }

echo "[ui] mirror -> ui-react/ (guard-hosted/package artifact)..."
rm -rf "$ROOT/ui-react"
cp -r "$UI/dist" "$ROOT/ui-react"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "[ui] ERROR: supervisor.html missing in mirror"; exit 1; }

grep -q '<div id="root">' "$ROOT/ui-react/supervisor.html" || { echo "[ui] ERROR: supervisor.html lacks root mount point"; exit 1; }

echo "[ui] build complete:"
echo "    src:   $UI"
echo "    tmp:   $UI/dist"
echo "    mirror: $ROOT/ui-react"
