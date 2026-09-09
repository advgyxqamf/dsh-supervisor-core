#!/usr/bin/env bash
# 本机凭据安全配置脚本：把令牌值从「环境变量」写入「系统级安全存储」，值绝不落入仓库/历史/日志。
# 用法（仓库根执行）：
#   bash release/scripts/configure-credentials.sh --npm     # NPM_TOKEN 环境变量 → ~/.npmrc（0600）
#   bash release/scripts/configure-credentials.sh --git     # GH_TOKEN 环境变量 → 配置 git credential helper
#   bash release/scripts/configure-credentials.sh --check   # 只读自检（不含任何值）
# 原则：本脚本不接收命令行明文参数、不打印 token、不写仓库内任何文件。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

NPMRC="$HOME/.npmrc"

write_npmrc() {
  [ -n "${NPM_TOKEN:-}" ] || { echo "❌ NPM_TOKEN 环境变量为空（请先 export NPM_TOKEN=...）"; exit 1; }
  # 原子写：先写临时文件再落位，权限 0600；不 echo 值
  TMP="$(mktemp)"
  # 保留用户已有非 token 行，仅替换/追加 token 行
  if [ -f "$NPMRC" ]; then
    grep -v '^//registry\.npmjs\.org/:_authToken=' "$NPMRC" > "$TMP" || true
  fi
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >> "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$NPMRC"
  chmod 600 "$NPMRC"
  echo "✅ NPM token 已写入 ~/.npmrc（权限 600）。验证：npm whoami"
  unset NPM_TOKEN
}

configure_git() {
  [ -n "${GH_TOKEN:-}" ] || { echo "❌ GH_TOKEN 环境变量为空（请先 export GH_TOKEN=...）"; exit 1; }
  # 用 credential helper store 保存（写入 ~/.git-credentials 0600）——不内嵌 remote URL
  git config --global credential.helper store
  CRED="$HOME/.git-credentials"
  TMP="$(mktemp)"
  # 已有行保留，仅替换 https://github.com 行
  if [ -f "$CRED" ]; then
    grep -v '^https://github.com' "$CRED" > "$TMP" || true
  fi
  # x-access-token 是 GitHub 对 PAT 作为口令的标准占位用户名
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" >> "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$CRED"
  chmod 600 "$CRED"
  echo "✅ GitHub token 已写入 git credential store（~/.git-credentials 0600）。验证：git ls-remote --heads origin"
  unset GH_TOKEN
}

check() {
  echo "=== 凭据自检（不含值） ==="
  if [ -f "$NPMRC" ] && grep -q '^//registry\.npmjs\.org/:_authToken=' "$NPMRC"; then
    echo "NPM: ~/.npmrc 含 token（权限 $(stat -c %a "$NPMRC" 2>/dev/null || stat -f %Lp "$NPMRC")）"
  else
    echo "NPM: ~/.npmrc 无 token（需 npm login 或 configure-credentials.sh --npm）"
  fi
  if [ -n "$(git config --get credential.helper 2>/dev/null)" ]; then
    echo "Git: credential helper = $(git config --get credential.helper)"
    [ -f "$HOME/.git-credentials" ] && echo "Git: ~/.git-credentials 存在（权限 $(stat -c %a "$HOME/.git-credentials" 2>/dev/null || stat -f %Lp "$HOME/.git-credentials")）"
  else
    echo "Git: 未配置 credential helper"
  fi
  if command -v gh >/dev/null 2>&1; then
    echo "gh: 已安装（gh auth status 查登录态）"
  else
    echo "gh: 未安装"
  fi
  # 绝不打印 remote（可能再含 token）；只确认 remote 是否已脱敏
  if git remote -v | grep -q 'github_pat_\|x-access-token:[^@]*@github' 2>/dev/null; then
    echo "⚠️ 警告：remote URL 疑似含明文 token，请立即脱敏"
  else
    echo "remote: 无明文 token（脱敏 OK）"
  fi
  echo "=== 自检完成 ==="
}

case "${1:-}" in
  --npm) write_npmrc ;;
  --git) configure_git ;;
  --check) check ;;
  *) echo "用法: configure-credentials.sh --npm | --git | --check"; exit 2 ;;
esac
