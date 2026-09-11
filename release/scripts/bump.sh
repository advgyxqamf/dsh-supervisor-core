#!/usr/bin/env bash
# 版本提升（双轨独立——DESIGN §16.4：双仓库拆分后发布通道解耦，内核/壳各自版本号互不 bump）。
# 用法:
#   release/scripts/bump.sh --core <ver>     内核版本（唯一事实源=package.json）→ launcher/npm 子包/tag v<ver>（manifest 已废，D1 定案 2026-09）
#   release/scripts/bump.sh --shell <ver>    壳版本（Cargo.toml + tauri.conf.json 两处互锁同号）→ 公开仓 tag v<ver>
#     壳源码在独立仓（双仓拆分后）——本仓无 src-tauri；用 DSH_SHELL_DIR 或 .shell-work 指定壳 checkout。
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
    echo "  2) git add -A && git commit -m 【release: v$NEW 】 && git tag v$NEW && git push origin HEAD --tags（⚠ 必须同时推分支与 tag，否则 CI 不触发）"
    echo "  3) npm run build:launcher（本机内核 launcher）"
    echo "  4) npm run publish:core -- --publish（对应平台）"
    ;;
  --shell)
    # 壳仓根定位（2026-09-11 修复）：开发时壳仓是内核仓内的 .shell-work checkout，
    # 而非 CWD 本身。原先硬编码 ./src-tauri 要求「在壳仓根执行」，但本项目的实际工作流
    # 是在内核仓根执行（壳仓由 export-shell.sh 同步出去），于是该分支必然报
    # Cannot find module ./src-tauri/tauri.conf.json。现两处都支持。
    if [ -f "src-tauri/tauri.conf.json" ]; then SHELL_ROOT=".";
    elif [ -f ".shell-work/src-tauri/tauri.conf.json" ]; then SHELL_ROOT=".shell-work";
    else echo "❌ 未找到壳仓（试过 ./src-tauri 与 ./.shell-work/src-tauri）"; exit 1; fi
    echo "  壳仓根: $SHELL_ROOT"
    CUR="$(node -p "require('./'+'$SHELL_ROOT'+'/src-tauri/tauri.conf.json').version")"
    ver_lt "$NEW" "$CUR" && { echo "拒绝回退：$NEW < 当前壳 $CUR"; exit 1; }
    sed -i -E "s/^version = .*/version = \"$NEW\"/" "$SHELL_ROOT/src-tauri/Cargo.toml"
    # Cargo.lock 里的本包版本也需同步（否则 cargo 会把它当依赖变更）
    sed -i -E "/^name = \"dsh-supervisor-gui\"$/{n;s/^version = .*/version = \"$NEW\"/}" "$SHELL_ROOT/src-tauri/Cargo.lock"
    NEW="$NEW" SHELL_ROOT="$SHELL_ROOT" node -e "const fs=require('fs');const p=process.env.SHELL_ROOT+'/src-tauri/tauri.conf.json';const j=JSON.parse(fs.readFileSync(p));j.version=process.env.NEW;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --shell
    echo "=== 壳版本已提升: $CUR → $NEW ==="
    echo "  1) bash release/scripts/export-shell.sh <publicRepoUrl>（同步公开仓 dsh-supervisor-launcher）"
    echo "  2) 公开仓 tag v$NEW （触发 launcher-build.yml → 三平台 bundle 挂 Release）"
    ;;
  *) echo "未知模式: $MODE （支持 --core | --shell）"; exit 2;;
esac