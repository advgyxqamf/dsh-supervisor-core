#!/usr/bin/env bash
# 版本提升（双轨独立——DESIGN §16.4：双仓库拆分后发布通道解耦，内核/壳各自版本号互不 bump）。
# 用法:
#   release/scripts/bump.sh --core <ver>     内核版本（唯一事实源=package.json）→ SEA/npm 子包/tag v<ver>（manifest 已废，D1 定案 2026-09）
#   release/scripts/bump.sh --shell <ver>    壳版本（Cargo.toml + tauri.conf.json 两处互锁同号）→ 公开仓 tag v<ver>
# 只允许递增（>= 当前）；派生处由各自构建脚本读取单源，禁止手改。
set -euo pipefail
# SemVer 逐段数值比较（RC6：字符串比较在 0.10 vs 0.2 场景双向失效）。
ver_lt() {  # ver_lt A B → A < B 时返回 0。Node 实现（bump.sh 本就依赖 node）——
            # SemVer 完整语义：三段数值 + 预发布后缀（BETA<RC<正式），awk 转义版曾因后缀段错位失效。
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ $# -eq 2 ] || { echo "用法: release/scripts/bump.sh <--core|--shell> <version>"; exit 2; }
MODE="$1"; NEW="${2:?}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(BETA|RC)\.[0-9]+)?$ ]] || { echo "非法版本号（SemVer 主.次.补丁，可带 -BETA.n/-RC.n 预发布后缀——与 verify-versions.js 单源规范一致）: $NEW"; exit 1; }
case "$MODE" in
  --core)
    CUR="$(node -p "require('./package.json').version")"
    ver_lt "$NEW" "$CUR" && { echo "拒绝回退：$NEW < 当前内核 $CUR"; exit 1; }
    node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --core
    echo "=== 内核版本已提升: $CUR → $NEW ==="
    echo "  1) CHANGELOG.md：整理 [未发布] 段为 [$NEW] 并新开 [未发布]"
    echo "  2) git add -A && git commit -m 【release: v$NEW】 && git tag v$NEW && git push --tags（私有仓 build.yml → SEA + npm 子包 --publish）"
    echo "  3) npm run build:sea（本机内核 SEA）"
    echo "  4) npm run publish:core -- --publish（对应平台）"
    ;;
  --shell)
    CUR="$(node -p "require('./src-tauri/tauri.conf.json').version")"
    ver_lt "$NEW" "$CUR" && { echo "拒绝回退：$NEW < 当前壳 $CUR"; exit 1; }
    sed -i -E "s/^version = .*/version = \"$NEW\"/" src-tauri/Cargo.toml
    NEW="$NEW" node -e "const fs=require('fs');const p='src-tauri/tauri.conf.json';const j=JSON.parse(fs.readFileSync(p));j.version=process.env.NEW;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --shell
    echo "=== 壳版本已提升: $CUR → $NEW ==="
    echo "  1) bash release/scripts/export-shell.sh <publicRepoUrl>（同步公开仓 dsh-supervisor-launcher）"
    echo "  2) 公开仓 tag v$NEW（触发 launcher-build.yml → 三平台 bundle 挂 Release）"
    ;;
  *) echo "未知模式: $MODE（支持 --core | --shell）"; exit 2;;
esac