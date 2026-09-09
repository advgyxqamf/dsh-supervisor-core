#!/usr/bin/env bash
# 组装 Tauri 壳前端目录 src-tauri/frontend/（gitignored 生成物，cargo build 前置）。
# 组成：面板产物（ui-react 镜像内容）+ bootstrap.html 引导页（壳内嵌环境就绪后 navigate 到 supervisor.html）。
# 用法: release/scripts/build-shell-frontend.sh  （在 cargo build tauri 壳前执行）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 1) 确保面板镜像存在（build-ui.sh：源码 ui/ → ui-react/）
if [ ! -f "$ROOT/ui-react/supervisor.html" ]; then
  echo "[shell-frontend] ui-react 缺失，先 build-ui.sh …"
  bash "$ROOT/release/scripts/build-ui.sh"
fi

# 2) 组装 frontend/（先删后建）
FE="$ROOT/src-tauri/frontend"
rm -rf "$FE"
mkdir -p "$FE"
cp "$ROOT/ui-react/supervisor.html" "$FE/"
cp -r "$ROOT/ui-react/assets" "$FE/assets"
cp -r "$ROOT/ui-react/dsh-logo.svg" "$FE/dsh-logo.svg" 2>/dev/null || true
cp "$ROOT/src-tauri/bootstrap/bootstrap.html" "$FE/bootstrap.html"
cp "$ROOT/src-tauri/bootstrap/shell.html" "$FE/shell.html" 2>/dev/null || true  # 共用壳框架

# 3) 自检
[ -f "$FE/supervisor.html" ] || { echo "[shell-frontend] 缺 supervisor.html"; exit 1; }
[ -f "$FE/bootstrap.html" ] || { echo "[shell-frontend] 缺 bootstrap.html"; exit 1; }
echo "[shell-frontend] 已组装 $FE（bootstrap + supervisor 双入口）"
