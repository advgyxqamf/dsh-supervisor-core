#!/usr/bin/env bash
# 内核统一发布物（2026-09 定案：全平台弃 SEA，改 Node launcher 形态）。
# 背景：Node SEA 单文件二进制在 macOS 上注入后即段错误（最小 hello-world SEA 亦崩，
# 与代码/codecache/codesign 无关 = Node SEA 在 mac 的上游缺陷，铁证）。为彻底消除平台差异，
# 全平台统一发布「Node launcher」npm 包：esbuild bundle + node 启动脚本 + ui-react。
# 产物（dist/launcher/）：
#   dsh-supervisor-<ver>-<platform>-<arch>/
#     ├── bin/dsh-supervisor        # node shebang 启动脚本（require ./core.cjs）
#     ├── core.cjs                  # esbuild 单文件 bundle（含 __DSH_VERSION__ 注入）
#     └── ui-react/                 # 面板发布镜像
# 依赖：Node.js ≥18 运行时（非 SEA 免运行时——发布物需目标机有 node）。
# 用法: release/scripts/build-launcher.sh [outDir]（默认 dist/launcher）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require(\"./package.json\").version")"
OUT_REL="${1:-dist/launcher}"
mkdir -p "$OUT_REL"
OUT="$(cd "$OUT_REL" && pwd)"
PLAT="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"

echo "[0/5] 前端统一构建（release/scripts/build-ui.sh）…"
bash "$ROOT/release/scripts/build-ui.sh"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "错误：UI 镜像缺失"; exit 1; }

echo "[1/5] esbuild 打包 bin → core.cjs…"
npx --yes esbuild bin/dsh-supervisor --bundle --platform=node --format=cjs --outfile="$OUT/core.cjs" --define:__DSH_VERSION__="\"$VER\"" >/dev/null

echo "[2/5] 组装 launcher 目录…"
DIR="$OUT/dsh-supervisor-$VER-$PLAT-$ARCH"
rm -rf "$DIR"
mkdir -p "$DIR/bin"
# node 启动脚本（bin/dsh-supervisor：npm bin 链接入口）
cat > "$DIR/bin/dsh-supervisor" <<'LAUNCHER'
#!/usr/bin/env node
'use strict';
// 统一 launcher 启动器（2026-09 定案：全平台弃 SEA）。require 同目录 core.cjs（esbuild bundle）。
require('../core.cjs');
LAUNCHER
chmod 755 "$DIR/bin/dsh-supervisor"
cp "$OUT/core.cjs" "$DIR/core.cjs"
# 携带 ui-react（src/api/index.js 候选② <exe>/../ui-react 解析：pkg/bin/dsh-supervisor → pkg/ui-react）
rm -rf "$DIR/ui-react"
cp -r "$ROOT/ui-react" "$DIR/ui-react"

echo "[3/5] 冒烟：launcher self-check + --version + fresh-HOME daemon + UI 服务断言"
# bin/dsh-supervisor 需从 npm 安装语义（node bin）——直接 node 执行验证
node "$DIR/bin/dsh-supervisor" self-check
VOUT="$(node "$DIR/bin/dsh-supervisor" --version)"
echo "  --version => $VOUT"
case "$VOUT" in *v$VER) : ;; *) echo "冒烟失败：版本注入失效"; exit 1;; esac
SMOKE_HOME="$(mktemp -d)"
SMOKE_PORT=3199
cat > "$SMOKE_HOME/config.json" <<EOF
{
  "command": ["sleep", "3600"],
  "healthUrl": "http://127.0.0.1:3198/",
  "apiHost": "127.0.0.1",
  "apiPort": 3199,
  "stateFile": "$SMOKE_HOME/state.json",
  "logFile": "$SMOKE_HOME/events.log",
  "supervisorLogFile": "$SMOKE_HOME/guard.log",
  "notifyEnabled": false
}
EOF
SMOKE_LOG="$SMOKE_HOME/boot.log"
(HOME="$SMOKE_HOME" DSH_SUPERVISOR_CONFIG="$SMOKE_HOME/config.json" DSH_SUPERVISOR_LOCK_FILE="$SMOKE_HOME/guard.lock" timeout 8 node "$DIR/bin/dsh-supervisor" daemon >"$SMOKE_LOG" 2>&1 &)
sleep 2
if ! grep -q "guard started v$VER" "$SMOKE_LOG" 2>/dev/null; then
  echo "冒烟失败：fresh-HOME daemon 未能自举"; cat "$SMOKE_LOG" 2>/dev/null | head -8; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  fresh-HOME daemon 自举 OK"
UI_BODY="$(curl -s -m 2 "http://127.0.0.1:3199/" 2>/dev/null || true)"
if ! printf "%s" "$UI_BODY" | grep -q "<div id=\"root\">"; then
  echo "冒烟失败：launcher UI 服务断言未通过"; cat "$SMOKE_LOG" 2>/dev/null | head -10; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  UI 服务断言 OK"
rm -rf "$SMOKE_HOME"

echo "[4/5] 携带版本自检文件…"
# 供 self-check/版本核对复用（与 SEA 形态一致的 guardVersion 注入校验）
echo "$VER" > "$DIR/version.txt"
echo "[5/5] 产物: $DIR/（launcher 形态，Node ≥18 依赖）"
