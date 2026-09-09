#!/usr/bin/env bash
# 内核发布产线（CI 核心逻辑单源）——供 .github/workflows/build.yml 逐平台矩阵调用，亦可本地复跑。
# 用法: release/scripts/ci-core.sh [--publish]
#   - 无 --publish = 只验证（verify-versions --core → npm test → build:launcher → 子包 dry-run）
#   - --publish    = 验证通过后追加真发布（需 NPM_TOKEN / ~/.npmrc 官方 registry token）
#   - 平台由本机 node process.platform/arch 自动识别（矩阵各 runner 各自跑自己的平台）
# 版本：从仓库根 package.json 单源注入；launcher 自报版本错配即拒绝（publish-core.sh 内置强制）。
# 2026-09 定案：全平台弃 SEA（macOS Node SEA 注入后段错误铁证），统一 Node launcher 形态。
# 2026-09 双仓拆分：壳已剥离至公开仓 dsh-supervisor-launcher（src-tauri 不在本仓）——
#   壳前端组装/壳集成冒烟为壳仓 CI（launcher-build.yml）职责，核仓产线只管内核 npm 子包。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

echo "=== [0/4] 版本自洽校验（内核 package.json 单源；壳版本互锁已随壳仓剥离） ==="
npm run verify:versions

echo "=== [1/4] 内核回归测试（npm test） ==="
npm test

echo "=== [2/4] 构建内核 launcher（build:launcher：esbuild bundle + node 启动脚本，全平台统一） ==="
npm run build:launcher

echo "=== [3/4] 内核子包 dry-run（组装 + 打包审计，不发） ==="
npm run publish:core -s
ls -lh dist/npm/

if [ "$PUBLISH" = 1 ]; then
  echo "=== [4/4] 真发布内核子包（官方 registry，需 NPM_TOKEN） ==="
  npm config set registry https://registry.npmjs.org
  if [ -n "${NPM_TOKEN:-}" ]; then
    npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN"
  fi
  npm run publish:core -- --publish
else
  echo "=== [4/4] （跳过真发布：加 --publish 即发官方 registry） ==="
fi

echo "=== 内核发布产线完成 ==="
