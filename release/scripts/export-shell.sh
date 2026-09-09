#!/usr/bin/env bash
# 导出公开壳仓库（dsh-supervisor-launcher）：壳源码 + 产品主页 README + MIT LICENSE + 公开仓 CI。
# 用法: release/scripts/export-shell.sh [publicRepoUrl]   # URL 缺省=只组装到 dist/export-shell/，不推送
#   publicRepoUrl 示例: git@github.com:<you>/dsh-supervisor-launcher.git
# 内容全部来自 src-tauri/（壳=开源面）；内核资产（bin/src/ui/systemd...）绝不进入公开仓。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${1:-}"
OUT="dist/export-shell"
rm -rf "$OUT"; mkdir -p "$OUT/src-tauri"

# 1) 壳源码（排除 target 构建物）
for f in Cargo.toml build.rs tauri.conf.json; do
  [ -f "src-tauri/$f" ] && cp "src-tauri/$f" "$OUT/src-tauri/"
done
for d in src capabilities bootstrap icons; do
  [ -d "src-tauri/$d" ] && cp -r "src-tauri/$d" "$OUT/src-tauri/"
done
# 公开壳 = 引导器形态（Phase 3 定案）：frontendDist 改回 bootstrap（仅引导页，MIT 可独立编译）。
# 完整面板壳（内嵌闭源 UI 产物）仅在内核仓本地构建（release/scripts/build-shell-frontend.sh 组装 frontend/）。
python3 - "$OUT/src-tauri/tauri.conf.json" "$OUT/src-tauri/Cargo.toml" <<'PY'
import json, sys, re
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
c['build']['frontendDist'] = 'bootstrap'
json.dump(c, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')
cargo_p = sys.argv[2]
# 公开壳无默认 embedded-panel feature（引导器模式）
s = open(cargo_p, encoding='utf-8').read()
s = re.sub(r'default = \["embedded-panel"\]\n', '', s)
open(cargo_p, 'w', encoding='utf-8').write(s)
print('[export-shell] frontendDist → bootstrap + Cargo.toml 去默认 embedded-panel（引导器形态）')
PY

# 2) 产品主页 README / MIT LICENSE / gitignore / 公开仓 CI
cp src-tauri/LAUNCHER_README.md "$OUT/README.md"
cp src-tauri/LICENSE "$OUT/LICENSE"
cp src-tauri/.gitignore.shell "$OUT/.gitignore"
mkdir -p "$OUT/.github/workflows"
cp src-tauri/launcher-build.yml "$OUT/.github/workflows/build.yml"

# 3) 冒烟自检（确保公开仓内容不含内核资产）
for p in "$OUT/src-tauri"/*; do
  case "$(basename "$p")" in src|capabilities|bootstrap|icons|Cargo.toml|build.rs|tauri.conf.json) ;;
    *) echo "警告: 意外文件进入导出: $p";; esac
done
[ -d "$OUT/src-tauri/target" ] && { echo "错误: target 误入导出"; exit 1; }
echo "== 公开壳仓库已组装: $OUT/（$(du -sh "$OUT" | awk '{print $1}')） =="
ls "$OUT" "$OUT/src-tauri"

if [ -n "$URL" ]; then
  cd "$OUT"
  git init -q -b main
  git add -A
  git -c user.name=dsh-supervisor-launcher -c user.email=dev@local.dsh commit -qm "shell export $(date +%F)"
  git remote add origin "$URL" 2>/dev/null || true
  echo "推送: cd $OUT && git push -u origin main"
else
  echo "（未给 URL：仅组装。推送命令样例: bash release/scripts/export-shell.sh git@github.com:<you>/dsh-supervisor-launcher.git）"
fi