#!/usr/bin/env bash
# 本机凭据安全配置脚本：把令牌值从「环境变量」写入「系统级安全存储」，值绝不落入仓库/历史/日志。
# 用法（仓库根执行）：
#   bash release/scripts/configure-credentials.sh --npm     # NPM_TOKEN 环境变量 → ~/.npmrc（0600）
#
# 2026-09-13：已删除 --git 模式（原「GH_TOKEN -> git credential helper store」）。
#   理由：它与现行标准冲突且多余 ——
#     · 两仓 push 走 SSH 部署密钥（repo-local core.sshCommand），不用 https 凭据；
#     · GitHub 凭据的现行唯一标准是 CREDENTIALS-STANDARD.md + release/scripts/cred.sh
#       （规范库 0700/0600、清单化管理）。
#   保留旧机制会诱导「把令牌写进 ~/.git-credentials」—— 那正是标准要消灭的散落副本。
#   bash release/scripts/configure-credentials.sh --check   # 只读自检（不含任何值）
# 原则：本脚本不接收命令行明文参数、不打印 token、不写仓库内任何文件。
#
# 与发布链路的关系（2026-09-10 标准化）：本脚本与 publish-core.sh **共用** release/scripts/_npm-auth.sh
#   的同一份解析实现（单源）。本脚本负责**把 token 落到规范位置**，publish-core 负责**读**：
#     规范位置 = **真实用户 home** 下的 .npmrc（不是沙箱 $HOME）——见 _npm-auth.sh 的解析顺序。
#   之所以强调「真实 home」：DSH 沙箱会把 $HOME 指向实例数据目录，若写到 $HOME/.npmrc，
#   该 token 就只对「那一个沙箱」可见，换沙箱即 ENEEDAUTH（这正是此前的真实故障）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=./_npm-auth.sh
. "$ROOT/release/scripts/_npm-auth.sh"

REAL_HOME="$(dsh_real_home)"
NPMRC="$(dsh_canonical_npmrc)"          # 规范位置：真实 home/.npmrc
CRED="$REAL_HOME/.git-credentials"

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
  echo "✅ NPM token 已写入规范位置（权限 600）：$NPMRC"
  if [ "$HOME" != "$REAL_HOME" ]; then
    echo "   注意：当前 $HOME($HOME) 与真实 home 不同（沙箱环境）——写入的是真实 home，"
    echo "         故任何沙箱/shell 下的发布都能读到它。"
  fi
  echo "   验证：bash release/scripts/configure-credentials.sh --check"
  unset NPM_TOKEN
}

check() {
  echo "=== 凭据自检（不含值） ==="
  echo "真实 home: $REAL_HOME"
  if [ "$HOME" != "$REAL_HOME" ]; then echo "当前 \$HOME: ${HOME}（沙箱覆盖，不影响发布：解析以真实 home 为准）"; fi
  # 用与 publish-core 完全相同的解析器判定，避免「自检说没配、发布却成功」的错位
  if dsh_npm_auth_setup; then
    echo "NPM: ✅ 命中认证来源 → $(dsh_npm_auth_describe)"
    dsh_npm_auth_cleanup
  else
    echo "NPM: ❌ 无任何可用认证（需 configure-credentials.sh --npm 或 npm login）"
  fi
  if [ -f "$NPMRC" ]; then
    echo "NPM: 规范文件 ${NPMRC}（权限 $(stat -c %a "$NPMRC" 2>/dev/null || stat -f %Lp "$NPMRC")）"
  else
    echo "NPM: 规范文件 $NPMRC 不存在"
  fi
  # git 全局配置同样以真实 home 为准（沙箱 $HOME 会读到不同/空的全局配置）
  local gh_helper; gh_helper="$(HOME="$REAL_HOME" git config --get credential.helper 2>/dev/null || true)"
  if [ -n "$gh_helper" ]; then
    echo "Git: credential helper = $gh_helper"
    [ -f "$CRED" ] && echo "Git: $CRED 存在（权限 $(stat -c %a "$CRED" 2>/dev/null || stat -f %Lp "$CRED")）"
  else
    echo "Git: 未配置 credential helper（本仓 push 走 SSH，通常不需要）"
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
  --git) echo "❌ --git 模式已于 2026-09-13 删除（GitHub 凭据见 CREDENTIALS-STANDARD.md；本脚本只管 npm）。" >&2; exit 2 ;;
  --check) check ;;
  *) echo "用法: configure-credentials.sh --npm | --check"; exit 2 ;;
esac
