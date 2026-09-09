#!/usr/bin/env bash
# 内核 npm 子包发布（构建物 = SEA 二进制；版本 = 单源注入，裸版本——npm 强制不带 v 前缀）。
# 用法（在对应平台机器运行，无交叉编译；脚本按本机 platform/arch 自动识别）：
#   release/scripts/publish-core.sh                  # 组装 + npm publish --dry-run（安全检查，推荐先跑）
#   release/scripts/publish-core.sh --publish        # 真发布（需 npm 登录且有 scope 权限）
#   release/scripts/publish-core.sh --scope @acme    # 指定 scope（不传则读 package.json npmPublish.scope 或环境 DSH_CORE_SCOPE，兜底 @dsh-core）
# 版本规范（DESIGN §16）：version 从仓库根 package.json 注入（禁手写）；发布前强制校验
# 二进制 self-check 自报版本 === 单源版本（防产物错配发布）；产物命名 dsh-supervisor-<ver>-<plat>-<arch>。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"

# ---- 参数：--publish / --scope <val> / --scope=<val> ----
PUBLISH=0
SCOPE="$(node -p "try{const p=require('./package.json');(p.npmPublish&&p.npmPublish.scope)||''}catch(e){''}")"
MAIN_LICENSE="$(node -p "require('./package.json').license")"
[ -n "$SCOPE" ] || SCOPE="${DSH_CORE_SCOPE:-}"
[ -n "$SCOPE" ] || SCOPE="@dsh-sup"   # 产品 scope（2026-09 用户定稿：@dsh-sup/dsh-core-<os>-<arch>）
while [ $# -gt 0 ]; do case "$1" in
  --publish) PUBLISH=1 ;;
  --dry-run) PUBLISH=0 ;;   # 显式 dry-run（默认即 dry-run；供编排脚本语义清晰传递）
  --scope) SCOPE="${2:?--scope 需要值}"; shift ;;
  --scope=*) SCOPE="${1#*=}" ;;
  *) echo "未知参数: $1（支持 --publish / --dry-run / --scope <val>）"; exit 2 ;;
esac; shift; done

# ---- 平台识别与产物定位 ----
PLAT="$(node -p "process.platform")"   # linux | darwin | win32
ARCH="$(node -p "process.arch")"       # x64 | arm64
case "$PLAT" in linux) OS_TAG=linux;; darwin) OS_TAG=darwin;; win32) OS_TAG=win;;
  *) echo "不支持的平台: $PLAT"; exit 1;; esac
case "$ARCH" in x64|arm64) ;; *) echo "不支持的架构: $ARCH （子包仅 x64/arm64）"; exit 1;; esac
PKG_NAME="$SCOPE/dsh-core-$OS_TAG-$ARCH"
SRC_BIN="dist/sea/dsh-supervisor-$VER-$PLAT-$ARCH"
[ -f "$SRC_BIN" ] || { echo "缺少构建产物: $SRC_BIN （请先 npm run build:sea）"; exit 1; }
BIN_NAME="dsh-supervisor"; [ "$PLAT" = win32 ] && BIN_NAME="dsh-supervisor.exe"

# ---- 冒烟 + 版本核对（防产物错配） ----
GV="$("$SRC_BIN" self-check | sed -n 's/^guardVersion=//p' | tr -d '\r')"
[ "$GV" = "$VER" ] || { echo "版本错配：二进制自报 $GV ≠ 单源 $VER （禁止发布）"; exit 1; }
echo "== 冒烟通过: guardVersion=$GV （= 单源） =="

# ---- 组装子包目录 ----
STAGE="dist/npm/$PKG_NAME"
rm -rf "$STAGE"; mkdir -p "$STAGE/bin"
cp "$SRC_BIN" "$STAGE/bin/$BIN_NAME" && chmod 755 "$STAGE/bin/$BIN_NAME"
# UI（Phase 1）：随包携带 ui-react（build-sea.sh 已产到 dist/sea/ui-react），
# SEA 运行态由 src/api/index.js 候选② <exe>/../ui-react 解析（pkg/bin/dsh-supervisor → pkg/ui-react）
if [ -d "$(dirname "$SRC_BIN")/ui-react" ]; then
  cp -r "$(dirname "$SRC_BIN")/ui-react" "$STAGE/ui-react"
  [ -f "$STAGE/ui-react/supervisor.html" ] || { echo "错误：ui-react 缺 supervisor.html"; exit 1; }
else
  echo "警告：未找到 dist/sea/ui-react（请先 npm run build:sea 产出 UI）"
fi
NODE_GEN="const fs=require('fs');const o={name:'$PKG_NAME',version:'$VER',description:'DSH lifecycle guard core (SEA single-file binary) for $OS_TAG-$ARCH — install-and-use, runs without Node.',license:'$MAIN_LICENSE',os:['$PLAT'],cpu:['$ARCH'],bin:{'dsh-supervisor':'bin/$BIN_NAME'},files:['bin','ui-react','README.md'],keywords:['dsh','guard','sea','core']};fs.writeFileSync('$STAGE/package.json',JSON.stringify(o,null,2)+'\n')"
node -e "$NODE_GEN"
cat > "$STAGE/README.md" <<EOF
# $PKG_NAME

DSH lifecycle guard core — SEA 单文件二进制（V8 字节码构建物，闭源口径）。本包仅面向 $OS_TAG-$ARCH （npm os/cpu 平台过滤）。

```bash
npm i -g $PKG_NAME
dsh-supervisor self-check   # guardVersion / node / platform 三段自检
```
EOF
echo "== 子包已组装: $STAGE/"
ls -lh "$STAGE/bin/" | tail -1

# ---- 发布（默认 dry-run 保护） ----
cd "$STAGE"
# dist-tag 规范（2026-09 定稿，与内核版本两档预览后缀对应）：
#   -BETA.n → tag beta；-RC.n → tag rc；无后缀（正式）→ tag latest（npm 默认，不显式传）
DIST_TAG=""
case "$VER" in
  *-BETA.*) DIST_TAG="--tag beta" ;;
  *-RC.*)   DIST_TAG="--tag rc" ;;
esac
# 发布到官方 npm registry（发布必须官方源；本机默认 npmmirror 只读消费不适配发布认证）
# token 经 ~/.npmrc 的 //registry.npmjs.org/:_authToken 或 NPM_TOKEN 环境变量提供。
REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
if [ "$PUBLISH" = 1 ]; then
  echo "== 发布 $PKG_NAME@$VER ${DIST_TAG:-（tag=latest）} → $REGISTRY =="
  npm publish --access public --registry="$REGISTRY" $DIST_TAG
else
  echo "== npm publish --dry-run（确认无误后加 --publish 真发）${DIST_TAG:+ → 将打 tag=${DIST_TAG#--tag }} → $REGISTRY =="
  npm publish --dry-run --registry="$REGISTRY" $DIST_TAG
fi