#!/usr/bin/env bash
# 内核发布产线（CI 核心逻辑单源）——供 .github/workflows/build.yml 的 mac/win 矩阵调用，
# 同时是**本地 Linux 生产**的实际构建+发布体（由 release-core.sh 编排调用）。
# 用法: release/scripts/ci-core.sh [--publish] [--all-platforms]
#   - 无 --publish      = 只验证（verify:versions → build-ui → npm test → build:launcher → 子包 dry-run）
#   - --publish         = 验证通过后追加真发布（**本机平台**子包 → 官方 registry）
#   - --all-platforms   = 构建并（可选）发布**全部 4 个平台**。
#                         launcher 是纯 JS 产物（0 依赖、0 个 .node），平台差异仅在 npm 元数据，
#                         故可在单一机器上完成全部平台 —— 这是「内核发布零 GitHub 额度」的实现路径。
#                         平台清单来自 package.json#npmPublish.packages（单一事实源）。
#                         ⚠ CI 的 mac/win 矩阵**不要**用此选项（会与其它 job 形成同平台重复发布）。
# 版本：从仓库根 package.json 单源注入；launcher 自报版本错配即拒绝（publish-core.sh 内置强制）。
# 2026-09 定案：全平台弃 SEA（macOS Node SEA 注入后段错误铁证），统一 Node launcher 形态。
# 2026-09 平台分工：linux-x64 本地生产 / win+darwin 由 GitHub CI 生产（额度优化）。
#
# 认证（2026-09 修复）：本脚本**不再改动用户全局 npm 配置**。
#   原实现执行 `npm config set registry` + `npm config set //registry.npmjs.org/:_authToken`
#   ——前者把开发机的默认 registry 永久改成官方源（用户平时用镜像源），
#   后者把 token **明文写入 ~/.npmrc**。现改为：有 NPM_TOKEN 就写进**临时 userconfig**
#   并以 NPM_CONFIG_USERCONFIG 传给子进程（进程结束即删）；无 token 则沿用既有登录态。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
ALL_PLATFORMS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --all-platforms) ALL_PLATFORMS=1 ;;
    *) echo "未知参数: $1（支持 --publish / --all-platforms）"; exit 2 ;;
  esac
  shift
done
PLAT_ARGS=()
if [ "$ALL_PLATFORMS" = 1 ]; then PLAT_ARGS=(--all-platforms); fi

echo "=== [0/5] 版本自洽校验（内核 package.json 单源；壳版本互锁已随壳仓剥离） ==="
npm run verify:versions

echo "=== [1/5] 构建前端 UI 产物（build-ui.sh → ui-react/；npm test 面板响应头断言与 launcher 携带均依赖） ==="
bash release/scripts/build-ui.sh

echo "=== [2/5] 内核回归测试（npm test） ==="
npm test

echo "=== [3/5] 构建内核 launcher（build:launcher：esbuild bundle + node 启动脚本，全平台统一） ==="
npm run build:launcher -- ${PLAT_ARGS[@]+"${PLAT_ARGS[@]}"}

echo "=== [4/5] 内核子包 dry-run（组装 + 打包审计，不发） ==="
npm run publish:core -s -- ${PLAT_ARGS[@]+"${PLAT_ARGS[@]}"}
ls -lh dist/npm/

if [ "$PUBLISH" = 1 ]; then
  echo "=== [5/5] 真发布内核子包（官方 registry；认证由 publish-core.sh 单源处理） ==="
  export DSH_PUBLISH_REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
  npm run publish:core -- --publish ${PLAT_ARGS[@]+"${PLAT_ARGS[@]}"}
else
  echo "=== [5/5] （跳过真发布：加 --publish 即发官方 registry） ==="
fi

echo "=== 内核发布产线完成 ==="
