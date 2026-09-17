#!/usr/bin/env bash
# 内核 npm 子包发布（构建物 = Node launcher；版本 = 单源注入，裸版本——npm 强制不带 v 前缀）。
# 用法（由 ci-core.sh 调用；按本机 platform/arch 或 DSH_*_OVERRIDE 识别）：
#   release/scripts/publish-core.sh                  # 组装 + npm publish --dry-run（本地验证；推荐先跑）
#   release/scripts/publish-core.sh --publish        # 真发布（**仅 GitHub CI 内**；本地 exit 2）
#   release/scripts/publish-core.sh --all-platforms  # 一律拒绝（已废弃；四平台由 CI 各 runner 各自发布）
#   release/scripts/publish-core.sh --scope @acme    # 指定 scope（不传则读 npmPublish.scope / DSH_CORE_SCOPE）
#
# ── 防误发保护（默认 dry-run；须两道显式条件才真发）──
#   ① 默认 PUBLISH=0：不传 --publish 即 npm publish --dry-run —— 本地跑一遍只做组装/校验，
#      绝不触网写 registry。这是**默认值**，不是靠调用方记得加 --dry-run。
#   ② 传 --publish 后还有第二道门：GITHUB_ACTIONS 必须为 true（下面的硬标准，本地 exit 2）。
#   两道都满足才会执行真发布（且发布后按版本补打通道标签，见文件末尾）。
#   tag 策略见下方「dist-tag 规范」；rollback/canary **不由本脚本设置**（人工运维，契约 §4）。
#
# 硬标准（2026-09-13）：所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。
# 版本规范：version 从仓库根 package.json 注入（禁手写）；发布前强制校验 launcher self-check 自报版本
#  === 单源版本（防产物错配发布）；产物命名 dsh-supervisor-<ver>-<plat>-<arch>。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"

# ---- 参数：--publish / --scope <val> / --scope=<val> ----
PUBLISH=0
ALL=0
SCOPE="$(node -p "try{const p=require('./package.json');(p.npmPublish&&p.npmPublish.scope)||''}catch(e){''}")"
MAIN_LICENSE="$(node -p "require('./package.json').license")"
[ -n "$SCOPE" ] || SCOPE="${DSH_CORE_SCOPE:-}"
[ -n "$SCOPE" ] || SCOPE="@dsh-sup"   # 产品 scope（2026-09 用户定稿：@dsh-sup/dsh-core-<os>-<arch>）
while [ $# -gt 0 ]; do case "$1" in
  --publish) PUBLISH=1 ;;
  --all-platforms)
    # 硬标准（2026-09-13）：**发布也经 GitHub CI**。曾可本机一次发四平台 —— 那正是本地残留的发布侧。
    echo '拒绝：--all-platforms 已废弃（2026-09-13 硬标准）。' >&2
    echo '  四平台子包由 CI 各平台 runner 各自发布（tag 触发）；本地不得全平台发布。' >&2
    exit 2 ;;
  --dry-run) PUBLISH=0 ;;   # 显式 dry-run（默认即 dry-run；供编排脚本语义清晰传递）
  --scope) SCOPE="${2:?--scope 需要值}"; shift ;;
  --scope=*) SCOPE="${1#*=}" ;;
  *) echo "未知参数: $1（支持 --publish / --dry-run / --all-platforms / --scope <val>）"; exit 2 ;;
esac; shift; done

# ── 硬标准（2026-09-13）：真发布只允许在 GitHub CI 内 —— **单平台也不例外** ──
#   原漏洞：--all-platforms 被拒绝，但单平台 --publish 仍可本机直发 npm。
if [ "$PUBLISH" = 1 ] && [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：真发布（--publish）只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  echo '  硬标准：所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。' >&2
  echo '  本地只允许 dry-run（不带 --publish）。' >&2
  exit 2
fi


# ── 全平台模式：自递归（每个平台各跑一遍「单平台」路径）──
# 为什么自递归而非循环内联：单平台路径已包含「冒烟 + 版本核对 + 组装 + 幂等发布 + 认证」全套逻辑，
# 内联会把这些复制一份（双份维护，正是本项目反复出现的缺陷模式）。递归只多一层进程，换来单一路径。
if [ "$ALL" = 1 ]; then
  # shellcheck source=./_platforms.sh
  . "$ROOT/release/scripts/_platforms.sh"
  MATRIX="$(dsh_platform_matrix_assert)"
  TOTAL="$(printf "%s\n" "$MATRIX" | grep -c .)"
  echo "=== 全平台发布：$TOTAL 个平台 ==="
  INNER=(--scope "$SCOPE")
  if [ "$PUBLISH" = 1 ]; then INNER=(--publish --scope "$SCOPE"); fi
  FAILED=()
  while read -r P_OS P_PLAT P_ARCH; do
    [ -n "${P_PLAT:-}" ] || continue
    echo ""
    echo "──────── $P_OS-$P_ARCH ────────"
    if DSH_PLATFORM_OVERRIDE="$P_PLAT" DSH_ARCH_OVERRIDE="$P_ARCH" \
        bash "$ROOT/release/scripts/publish-core.sh" "${INNER[@]}"; then
      echo "  ✅ $P_OS-$P_ARCH 完成"
    else
      echo "  ❌ $P_OS-$P_ARCH 失败"
      FAILED+=("$P_OS-$P_ARCH")
    fi
  done <<< "$MATRIX"
  echo ""
  if [ "${#FAILED[@]}" -gt 0 ]; then
    echo "=== 全平台结果：$((TOTAL - ${#FAILED[@]}))/$TOTAL 成功；失败：${FAILED[*]} ==="
    echo "    可只重跑失败平台（幂等：已成功平台会自动跳过）："
    echo "      DSH_PLATFORM_OVERRIDE=<plat> DSH_ARCH_OVERRIDE=<arch> npm run publish:core -- --publish"
    exit 1
  fi
  echo "=== 全平台结果：$TOTAL/$TOTAL 全部成功 ==="
  exit 0
fi
# ---- 平台识别与产物定位 ----
PLAT="$(node -p "process.platform")"   # linux | darwin | win32
ARCH="$(node -p "process.arch")"       # x64 | arm64
# 平台/架构覆盖（2026-09）：launcher 架构无关，GitHub macos-14 现为 arm64——用
# DSH_PLATFORM_OVERRIDE/DSH_ARCH_OVERRIDE 在任意 runner 产指定平台包（元数据 os/cpu 区分）。
PLAT="${DSH_PLATFORM_OVERRIDE:-$PLAT}"
ARCH="${DSH_ARCH_OVERRIDE:-$ARCH}"
case "$PLAT" in linux) OS_TAG=linux;; darwin) OS_TAG=darwin;; win32) OS_TAG=win;;
  *) echo "不支持的平台: $PLAT"; exit 1;; esac
case "$ARCH" in x64|arm64) ;; *) echo "不支持的架构: $ARCH （子包仅 x64/arm64）"; exit 1;; esac
PKG_NAME="$SCOPE/dsh-core-$OS_TAG-$ARCH"
SRC_DIR="dist/launcher/dsh-supervisor-$VER-$PLAT-$ARCH"
[ -d "$SRC_DIR" ] || {
  echo "缺少构建产物: $SRC_DIR"
  if [ "${ALL:-0}" = 1 ]; then
    echo "  全平台发布需先构建全部平台：npm run build:launcher:all"
  else
    echo "  请先构建：npm run build:launcher（本机平台）或 npm run build:launcher:all（全平台）"
  fi
  exit 1
}
[ -f "$SRC_DIR/bin/dsh-supervisor" ] || { echo "产物缺 bin/dsh-supervisor: $SRC_DIR"; exit 1; }
[ -f "$SRC_DIR/core.cjs" ] || { echo "产物缺 core.cjs: $SRC_DIR"; exit 1; }
# launcher 形态：node 启动脚本（win 亦无 .exe——由 npm bin shim 生成）

# ---- 冒烟 + 版本核对（防产物错配） ----
GV="$(node "$SRC_DIR/bin/dsh-supervisor" self-check | sed -n 's/^guardVersion=//p' | tr -d '\r')"
[ "$GV" = "$VER" ] || { echo "版本错配：launcher 自报 $GV ≠ 单源 $VER （禁止发布）"; exit 1; }
echo "== 冒烟通过: guardVersion=$GV （= 单源） =="

# ---- 组装子包目录（launcher 目录整体入包） ----
STAGE="dist/npm/$PKG_NAME"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -r "$SRC_DIR/bin" "$STAGE/bin"
cp "$SRC_DIR/core.cjs" "$STAGE/core.cjs"
if [ -d "$SRC_DIR/ui-react" ]; then
  cp -r "$SRC_DIR/ui-react" "$STAGE/ui-react"
  [ -f "$STAGE/ui-react/supervisor.html" ] || { echo "错误：ui-react 缺 supervisor.html"; exit 1; }
else
  echo "警告：launcher 产物缺 ui-react"
fi
NODE_GEN="const fs=require('fs');const o={name:'$PKG_NAME',version:'$VER',description:'DSH lifecycle guard core (Node launcher) for $OS_TAG-$ARCH — requires Node >=18.',license:'$MAIN_LICENSE',os:['$PLAT'],cpu:['$ARCH'],bin:{'dsh-supervisor':'bin/dsh-supervisor'},files:['bin','core.cjs','ui-react','README.md'],keywords:['dsh','guard','launcher','core']};fs.writeFileSync('$STAGE/package.json',JSON.stringify(o,null,2)+'\n')"
node -e "$NODE_GEN"
cat > "$STAGE/README.md" <<EOF
# $PKG_NAME

DSH lifecycle guard core — Node launcher 形态（esbuild bundle + node 启动脚本，需 Node ≥18）。
本包仅面向 $OS_TAG-$ARCH （npm os/cpu 平台过滤）。

\`\`\`bash
# 正式版（latest 跟随 RC）
npm i -g $PKG_NAME
# 测试版（BETA）
npm i -g $PKG_NAME@beta
# 显式指定版本（推荐：与桌面壳的安装语义一致，避免依赖标签状态）
npm i -g $PKG_NAME@<version>

dsh-supervisor self-check   # guardVersion / node / platform 三段自检
\`\`\`

> 本包由桌面壳（Dsh Supervisor GUI）自动安装与升级：壳按 registry 的**全量最高版本**选版，
> 并显式安装 \`$PKG_NAME@<version>\`，不依赖 dist-tag。手工安装仅供排障。
EOF
echo "== 子包已组装: $STAGE/"
ls -lh "$STAGE/bin/" | tail -1

# ---- 发布（默认 dry-run 保护） ----
cd "$STAGE"
# dist-tag 规范（2026-09-16 修正）——产品只有两档：BETA（测试版）/ RC（正式版）。
#
#   -BETA.n  → tag beta              测试版：用户须显式 @beta 才装到
#   -RC.n    → tag latest（主）+ rc  正式版：latest 必须跟随；rc 作为附加标签在发布后补
#
#   ⚠ npm publish **只接受一个 --tag**（默认 latest）——多标签必须发布后用
#     `npm dist-tag add` 补（见本脚本末尾的 RC 附加标签步骤）。
#
#   ⚠ 以下两个 tag **刻意不由本脚本设置**（它们是人工运维操作，见契约 §4）：
#     · rollback —— 紧急回退开关，全量最高优先级；仅回退时人工
#                   `npm dist-tag add <pkg>@<ver> rollback`，解除用 `npm dist-tag rm <pkg> rollback`。
#                   发布脚本若自动写它，等于把「发布」和「回退」两种意图混在一起。
#     · canary   —— 灰度通道，仅灰度名单内机器可见；由灰度发布时人工设置（脚本无从得知名单）。
#
# ⚠ 2026-09-16 修正的背景（公开发行审计发现）：
#   原策略把 RC 只标 rc、**从不更新 latest**，于是 latest 永久停留在历史 SEA 形态
#   （实证：四平台 latest 分别停在 0.1.1/0.1.2/0.1.2/0.1.2，且描述仍是已废弃的 SEA）
#   ——「我们发布什么，latest 就该是什么」被打破，且四平台版本不一致。
#   现按产品模型修正：RC 即正式版 —— 发布时占 latest（主标签），并补打 rc 别名。
DIST_TAG=""
case "$VER" in
  *-BETA.*) DIST_TAG="--tag beta" ;;
  *-RC.*)   DIST_TAG="--tag latest" ;;   # 正式版占 latest（rc 标签发布后补）
esac
# 发布到官方 npm registry（发布必须官方源；本机默认 npmmirror 只读消费不适配发布认证）
#
# 认证（2026-09-10 **标准化**）：解析逻辑**单源**收敛到 release/scripts/_npm-auth.sh——
# 本脚本与 configure-credentials.sh 共用同一份实现（此前各写一套，行为不一致）。
# 解析顺序：DSH_NPMRC → NPM_CONFIG_USERCONFIG → NPM_TOKEN(临时 userconfig) → 真实 home ~/.npmrc → 沙箱 $HOME/.npmrc。
# 关键点：「真实 home」经 getent/dscl/~user 解析，**不受沙箱 $HOME 覆盖影响**——
# 否则同一台机器上会「A 沙箱能发版、B 沙箱报 ENEEDAUTH」。
REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
# shellcheck source=./_npm-auth.sh
. "$ROOT/release/scripts/_npm-auth.sh"
trap 'dsh_npm_auth_cleanup' EXIT
if dsh_npm_auth_setup; then
  echo "== 认证：$(dsh_npm_auth_describe) =="
else
  if [ "$PUBLISH" = 1 ]; then
    echo "❌ 未找到任何 npm 发布认证（真发布必需）。任选其一后重试："
    echo "   a) bash release/scripts/configure-credentials.sh --npm   # NPM_TOKEN → 真实 home ~/.npmrc(0600)，一次性"
    echo "   b) export NPM_TOKEN=<automation token>                    # 仅本次会话，不落盘"
    echo "   c) npm login --registry=https://registry.npmjs.org/"
    exit 1
  fi
  echo "== 认证：无（dry-run 不校验认证；真发布需先配置） =="
fi
if [ "$PUBLISH" = 1 ]; then
  # ── 幂等发布（2026-09-11）──
  # 为什么需要：npm **不允许覆盖同版本**，而发布流水线可能「部分平台成功、部分失败」
  # （实测 v0.1.3-BETA.1：linux-x64 已发，mac/win 因 CI 失败未发）。此时重跑，
  # 已成功的平台会 403 报错，而 npm 又没有「只补发缺失平台」的入口 ——
  # 结果就是重跑永远无法自愈。故：同版本已存在 → 视为成功（幂等），并做内容一致性核对。
  # ⚠ 必须 `|| true`：版本不存在时 `npm view` 返回非零，而本脚本是 `set -euo pipefail`，
  #   管道失败会让**赋值语句本身**失败并中止脚本 —— 即「首次发布必然失败」。
  #   （实测：v0.1.3-BETA.2 发布时脚本在认证后静默终止，正是此处。）
  EXISTING_SIZE="$(npm view "$PKG_NAME@$VER" dist.unpackedSize --registry="$REGISTRY" 2>/dev/null | tr -d '"' | tr -d "\r" || true)"
  EXISTING_SIZE="$(printf '%s' "$EXISTING_SIZE" | tr -d '[:space:]')"
  if [ -n "$EXISTING_SIZE" ]; then
    LOCAL_SIZE="$(npm pack --dry-run --json --registry="$REGISTRY" 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(b);console.log((j[0]&&j[0].unpackedSize)||"")}catch(e){console.log("")}})' || true)"
    echo "== $PKG_NAME@$VER 已存在于 $REGISTRY → 跳过发布（幂等：视为成功）=="
    echo "   远端 unpackedSize=$EXISTING_SIZE  本地 unpackedSize=${LOCAL_SIZE:-未知}"
    if [ -n "$LOCAL_SIZE" ] && [ "$EXISTING_SIZE" != "$LOCAL_SIZE" ]; then
      echo "   ⚠ 体积不一致：远端与本地产物可能不同源。请人工确认后再决定是否升版本重发。"
      echo "     （不自动失败：体积差异也可能来自 npm 打包细节，误判会阻断正常补发）"
    else
      echo "   ✅ 体积一致，内容可信"
    fi
    exit 0
  fi
  echo "== 发布 $PKG_NAME@$VER ${DIST_TAG:-（tag=latest）} → $REGISTRY =="
  npm publish --access public --registry="$REGISTRY" $DIST_TAG
  # RC（正式版）的**附加** rc 标签：npm publish 只接受一个 --tag，故发布后补打。
  #   语义：latest=正式版（用户不写标签装到它）；rc=同一版本的显式别名，便于按通道安装/回滚。
  case "$VER" in
    *-RC.*)
      echo "== 补打 rc 标签：$PKG_NAME@$VER =="
      npm dist-tag add "$PKG_NAME@$VER" rc --registry="$REGISTRY" 2>&1 | tail -1
      ;;
  esac
else
  echo "== npm publish --dry-run（确认无误后加 --publish 真发）${DIST_TAG:+ → 将打 tag=${DIST_TAG#--tag }} → $REGISTRY =="
  npm publish --dry-run --registry="$REGISTRY" $DIST_TAG
fi