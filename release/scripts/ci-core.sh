#!/usr/bin/env bash
# 内核发布产线（CI 核心逻辑单源）——供 .github/workflows/build.yml 逐平台矩阵调用，亦可本地复跑。
# 用法: release/scripts/ci-core.sh [--publish]
#   - 无 --publish = 只验证（verify-versions → 壳前端组装 → 壳集成冒烟 → npm test → build:sea → 子包 dry-run）
#   - --publish    = 验证通过后追加真发布（需 NPM_TOKEN / ~/.npmrc 官方 registry token）
#   - 平台由本机 node process.platform/arch 自动识别（矩阵各 runner 各自跑自己的平台）
# 版本：从仓库根 package.json 单源注入；SEA 自报版本错配即拒绝（publish-core.sh 内置强制）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

echo "=== [0/6] 版本自洽校验（内核 package.json 单源 + 壳 Cargo/tauri 两处互锁） ==="
npm run verify:versions

echo "=== [1/6] 壳前端组装（generate_context 前置：ui-react → src-tauri/frontend） ==="
bash release/scripts/build-shell-frontend.sh

echo "=== [2/6] 壳集成冒烟（cargo build + --node-plan，不发布；需对应平台 Rust 工具链） ==="
if command -v cargo >/dev/null 2>&1; then
  (cd src-tauri && cargo build 2>&1 | tail -20)
  ./src-tauri/target/debug/dsh-supervisor-gui --node-plan || true
else
  echo "  （cargo 不存在：跳过壳集成冒烟——CI 矩阵环境安装；本地仅跑内核链路）"
fi

echo "=== [3/6] 内核回归测试（npm test） ==="
npm test

echo "=== [4/6] 构建内核 SEA（build:sea：esbuild → V8 code cache → postject → 冒烟） ==="
npm run build:sea

echo "=== [5/6] 内核子包 dry-run（组装 + 打包审计，不发） ==="
npm run publish:core -s
ls -lh dist/npm/

if [ "$PUBLISH" = 1 ]; then
  echo "=== [6/6] 真发布内核子包（官方 registry，需 NPM_TOKEN） ==="
  npm config set registry https://registry.npmjs.org
  if [ -n "${NPM_TOKEN:-}" ]; then
    npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN"
  fi
  npm run publish:core -- --publish
else
  echo "=== [6/6] （跳过真发布：加 --publish 即发官方 registry） ==="
fi

echo "=== 内核发布产线完成 ==="
