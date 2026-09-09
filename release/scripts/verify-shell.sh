#!/usr/bin/env bash
# 壳无头冒烟（CI/本地快速验证，不启动 GUI）：编译 + --node-plan（环境探针 + 官方 LTS 清单）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
echo '[0/3] 版本一致性校验 (package.json = Cargo.toml = tauri.conf.json)'
node release/scripts/verify-versions.js
cd "$ROOT/src-tauri"
echo '[1/3] cargo build (debug)'
cargo build 2>&1 | tail -2
echo '[2/3] --node-plan 冒烟（真实网络：官方 index.json）'
OUT=$(./target/debug/dsh-supervisor-gui --node-plan)
echo "$OUT"
grep -q '^node=present' <<<"$OUT" || { echo 'node-plan 异常：未探测到系统 Node'; exit 1; }
echo '[3/3] 全量 npm 测试摘要'
(cd "$ROOT" && npm test >/tmp/vs-nt.log 2>&1 && echo 'npm test: PASS') || { echo 'npm test: FAIL（详见 /tmp/vs-nt.log）'; exit 1; }
echo '=== 壳冒烟全部通过 ==='