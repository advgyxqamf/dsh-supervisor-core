#!/usr/bin/env bash
# 内核构建物化（SEA 单文件 + V8 字节码）：源码→二进制，npm 发布物=二进制而非 .js。
# 用法: release/scripts/build-sea.sh [outDir]（默认 dist/sea）；产物 dsh-supervisor-<ver>-<platform>-<arch>
# 版本规范：版本号单一事实源=仓库 package.json；此处以 --define 注入编译期常量 __DSH_VERSION__。
# UI（2026-09-06 Phase 1）：SEA 发行物自足携带 ui-react（exe 同目录），src/api/index.js 多候选解析。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require(\"./package.json\").version")"
OUT_REL="${1:-dist/sea}"
mkdir -p "$OUT_REL"
OUT="$(cd "$OUT_REL" && pwd)"

echo "[0/6] 前端统一构建（release/scripts/build-ui.sh）…"
bash "$ROOT/release/scripts/build-ui.sh"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "错误：UI 镜像缺失"; exit 1; }

echo "[1/6] esbuild 打包 bin…"
npx --yes esbuild bin/dsh-supervisor --bundle --platform=node --format=cjs --outfile="$OUT/bundle.cjs" --define:__DSH_VERSION__="\"$VER\"" >/dev/null

echo "[2/6] sea-config…"
# useCodeCache：V8 字节码缓存。已知在 macOS arm64 上 SEA self-check 启动会 Segmentation fault（Node
# issue #47168 类，mac arm64 + code cache 组合不稳定）；Linux/Windows 正常。darwin 降级纯 JS 快照
# （源码明文，非字节码混淆）换取可运行；其余平台保留字节码混淆。
SEA_USE_CODECACHE="true"
if [ "$(node -p "process.platform")" = "darwin" ]; then
  SEA_USE_CODECACHE="false"
  echo "[build-sea] darwin 平台：禁用 useCodeCache（mac arm64 SEA code-cache segfault 规避）"
fi
cat > "$OUT/sea-config.json" <<EOF
{
  "main": "bundle.cjs",
  "output": "prep.blob",
  "useCodeCache": $SEA_USE_CODECACHE,
  "disableExperimentalSEAWarning": true
}
EOF
(cd "$OUT" && node --experimental-sea-config sea-config.json)

echo "[3/6] 复制 Node 骨架 + 携带 ui-react…"
PLAT="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
BIN="$OUT/dsh-supervisor-$VER-$PLAT-$ARCH"
NODE_BIN="$(command -v node)"
cp "$NODE_BIN" "$BIN" && chmod 755 "$BIN"
echo "[3/6] node=$NODE_BIN $(node -p "process.version") $PLAT/$ARCH"
# darwin 最小 SEA 冒烟（无 local 语法问题版）：隔离『本 runner Node SEA 能力』 vs 『项目 blob』
if [ "$(node -p "process.platform")" = "darwin" ]; then
  echo "[3.5/6] darwin 最小 SEA 冒烟（隔离平台能力）…"
  MINI="$(mktemp -d)"
  echo 'console.log("SEA-MINI-OK v" + process.version)' > "$MINI/mini.cjs"
  printf '{ "main": "%s/mini.cjs", "output": "%s/mini.blob", "useCodeCache": false, "disableExperimentalSEAWarning": true }\n' "$MINI" "$MINI" > "$MINI/mini.json"
  (cd "$MINI" && node --experimental-sea-config mini.json >/dev/null 2>&1)
  cp "$NODE_BIN" "$MINI/mini-bin" && chmod 755 "$MINI/mini-bin"
  npx --yes postject "$MINI/mini-bin" NODE_SEA_BLOB "$MINI/mini.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null 2>&1
  codesign --force --sign - "$MINI/mini-bin" >/dev/null 2>&1
  MINI_OUT="$($MINI/mini-bin 2>&1 | head -1)" || true
  echo "  [darwin 最小 SEA] 输出: ${MINI_OUT:-（无输出/崩溃）}"
  rm -rf "$MINI"
  # 结论打印：minimal 崩 → Node SEA 在本 macOS 不可用（需换发布形态）；minimal OK → 项目 blob 层问题
fi
# 先清后拷，避免在既有 dist/sea/ui-react 上累积出 ui-react/ui-react 双重嵌套
rm -rf "$OUT/ui-react"
cp -r "$ROOT/ui-react" "$OUT/ui-react"

echo "[4/6] postject 注入…"
chmod u+w "$BIN"
npx --yes postject "$BIN" NODE_SEA_BLOB "$OUT/prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
# macOS 强制代码签名（arm64 尤其）：postject 注入会破坏原 node 签名，未重新签名即运行
# → 系统以 SIGSEGV 杀进程（Node SEA 官方文档要求 mac 注入后 codesign，adhoc 即可）。
if [ "$(node -p "process.platform")" = "darwin" ]; then
  echo "[4.5/6] darwin 平台 codesign --sign -（adhoc，postject 后必需）…"
  codesign --sign - "$BIN" || { echo "冒烟失败：darwin codesign 失败"; exit 1; }
fi

echo "[5/6] 冒烟：self-check + --version + fresh-HOME daemon + UI 服务断言"
"$BIN" self-check
VOUT=$("$BIN" --version)
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
(HOME="$SMOKE_HOME" DSH_SUPERVISOR_CONFIG="$SMOKE_HOME/config.json" DSH_SUPERVISOR_LOCK_FILE="$SMOKE_HOME/guard.lock" timeout 8 "$BIN" daemon >"$SMOKE_LOG" 2>&1 &)
sleep 2
if ! grep -q "guard started v$VER" "$SMOKE_LOG" 2>/dev/null; then
  echo "冒烟失败：fresh-HOME daemon 未能自举"; cat "$SMOKE_LOG" 2>/dev/null | head -8; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  fresh-HOME daemon 自举 OK"
UI_BODY="$(curl -s -m 2 "http://127.0.0.1:3199/" 2>/dev/null || true)"
if ! printf "%s" "$UI_BODY" | grep -q "<div id=\"root\">"; then
  echo "冒烟失败：SEA UI 服务断言未通过（GET /:3199 未返回 root 挂载点）"; cat "$SMOKE_LOG" 2>/dev/null | head -10; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  UI 服务断言 OK（GET / → supervisor.html root 挂载点）"
rm -rf "$SMOKE_HOME"
echo "  产物: $BIN"
