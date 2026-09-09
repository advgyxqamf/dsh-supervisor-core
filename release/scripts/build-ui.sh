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

echo "[ui] 前端统一构建（源码=$UI）"
[ -d "$UI" ] && [ -f "$UI/package.json" ] || { echo "[ui] 错误：未找到前端源码（期望 $UI/package.json）"; exit 1; }

if [ "$SKIP_INSTALL" = 0 ] && [ -f "$UI/package-lock.json" ]; then
  echo "[ui] npm ci（锁文件可复现构建）…"
  (cd "$UI" && npm ci) || { echo "[ui] npm ci 失败"; exit 1; }
fi

echo "[ui] npm run build → ui/dist/ …"
(cd "$UI" && npm run build) || { echo "[ui] UI 构建失败"; exit 1; }
[ -f "$UI/dist/supervisor.html" ] || { echo "[ui] 构建产物缺 supervisor.html"; exit 1; }

echo "[ui] 镜像 → ui-react/（守卫托管/随包出口）…"
rm -rf "$ROOT/ui-react"
cp -r "$UI/dist" "$ROOT/ui-react"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "[ui] 镜像缺 supervisor.html"; exit 1; }

grep -q '<div id="root">' "$ROOT/ui-react/supervisor.html" || { echo "[ui] 自检失败：supervisor.html 缺 root 挂载点"; exit 1; }

echo "[ui] 构建完成："
echo "    源码:  $UI"
echo "    临时:  $UI/dist"
echo "    镜像:  $ROOT/ui-react"
