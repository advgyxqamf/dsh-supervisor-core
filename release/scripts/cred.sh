#!/usr/bin/env bash
# 凭据库统一入口（**凭据管理的单一事实源**，2026-09-13 标准化）
#
# 解决的问题（真实事故）：
#   壳仓令牌原存于**实例附件目录**（.../instances/<id>/data/.dsh/attachments/...）——
#   那是 ephemeral 的，换个会话就找不到了。于是出现「下午能推壳、现在找不到壳令牌」。
#   本工具把「哪个仓用哪个凭据、值在哪、是否有效、缺什么」变成可查、可验证的事实。
#
# ⚠ $HOME 被 DSH 重定向到实例数据目录，故本工具**一律用绝对路径**，不依赖 ~。
#
# 用法：
#   cred.sh list                 列出全部条目与状态
#   cred.sh doctor               卫生检查：权限 / 失效散落副本 / 缺项 / 值泄漏
#   cred.sh verify [name]        实测连通性（API 打点），不打印令牌值
#   cred.sh get <name>           打印令牌值（**仅**给脚本消费；人不要看）
#   cred.sh path <name>          打印令牌文件路径
#   cred.sh put <name>           从 stdin 写入令牌值（0600），并把 status 置 active
#
set -u

# 真实用户 home：$HOME 被 DSH 重定向到实例数据目录，故经 _npm-auth.sh 的
#   dsh_real_home()（getent/dscl/USERPROFILE）解析 —— **不得硬编码任何机器路径**。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_npm-auth.sh
. "$SCRIPT_DIR/_npm-auth.sh"
REAL_HOME="$(dsh_real_home)"
# 归一为 /（Windows 路径含反斜杠）——必须与下方 STORE 的归一保持一致，
# 否则 IS_REAL 比较（STORE == CANON_STORE）在 Windows 上恒假 → 真机保护被绕过。
CANON_STORE="$(printf '%s' "$REAL_HOME/.dsh/credentials" | tr '\\' '/')"

# 凭据库根：默认 = 真实 home 下的规范位置；可用 DSH_CRED_DIR 覆盖（测试 / 换机 / 多套环境）。
STORE=${DSH_CRED_DIR:-$CANON_STORE}
#  2026-09-14 跨平台归一：Windows 传入路径可能含反斜杠，而本脚本多处把
#   $STORE / $INDEX 放进**双引号 shell 串**（反斜杠=转义，会被吃）；
#   node 在 Windows 上同样接受正斜杠。故统一归一为 /。
STORE=$(printf '%s' "$STORE" | tr '\\' '/')
INDEX="$STORE/index.json"
# ⚠ 导出供 node 子进程读取：**禁止**把路径插进 JS 源码字符串 ——
#   Windows 路径含反斜杠，在 JS 单引号串里是**无效转义**（\U \A 等被吃），
#   会导致 require 失败 / 行为错乱（本仓已在 arch-validation 踩过同类）。
export INDEX STORE

[ -f "$INDEX" ] || { echo "凭据清单缺失: $INDEX" >&2; exit 1; }

entry_field() { # <name> <field>
  # ⚠ 字段名必须用**单引号**写 e['$2']：
  #   · e[$2]  → node 当成变量名（file is not defined）
  #   · e["$2"] → bash 在双引号串内遇到未转义的 " 会**提前结束字符串**，
  #               到 node 手里退化成 e[file] —— 同样是未定义变量。
  #   单引号在 bash 双引号串内是字面量，故 e['$2'] 是唯一正确形态。
  node -e "const j=require(process.env.INDEX);const e=j.entries.find(x=>x.name==='$1');
    process.stdout.write(e && e['$2']!=null ? String(e['$2']) : '');"
}

file_of() { entry_field "$1" file; }

case "${1:-list}" in
  list)
    node -e "
      const j=require(process.env.INDEX);
      const pad=(s,n)=>String(s).padEnd(n);
      console.log(pad('名称',15)+pad('类型',12)+pad('账号',14)+pad('状态',10)+'文件');
      for (const e of j.entries) console.log(pad(e.name,15)+pad(e.kind,12)+pad(e.account,14)+pad(e.status,10)+(e.file||''));
    "
    ;;

  path)
    f=$(file_of "$2"); [ -n "$f" ] && echo "$f" || { echo "未知条目: $2" >&2; exit 1; }
    ;;

  get)
    f=$(file_of "$2");
    [ -n "$f" ] || { echo "未知条目: $2" >&2; exit 1; }
    [ -f "$f" ] || { echo "凭据文件不存在: ${f}（状态可能为 missing）" >&2; exit 1; }
    cat "$f"
    ;;

  put)
    f=$(file_of "$2");
    [ -n "$f" ] || { echo "未知条目: $2" >&2; exit 1; }
    # ══════════════════════════════════════════════════════════════════════════
    # ⚠⚠ 覆盖保护（2026-09-13，**事后加固** —— 起因是一次真实事故）
    #
    # 事故：做门禁的注入验证时，先注入了「移除 DSH_CRED_DIR」以破坏夹具模式，
    #   然后脚本里的 put 步骤**回落到真机库根**执行，把测试串写进了
    #   **真实的内核令牌文件** —— 93B 真令牌被 16B 的 'new-secret-value' 覆盖。
    #   又因为迁移时把旧路径改成了**符号链接**，覆盖立刻生效、**无第二份副本可恢复**。
    #
    # 两条加固：
    #   ① 默认（真机库）下 put 必须显式确认：--yes 或 DSH_CRED_ALLOW_OVERWRITE=1；
    #      若目标文件已存在，再要求 DSH_CRED_FORCE=1。测试用 DSH_CRED_DIR 不受此限。
    #   ② 旧值先备份到 <file>.bak-<时间戳>（0600），使覆盖**不再不可逆**。
    # ══════════════════════════════════════════════════════════════════════════
    IS_REAL=0
    [ "$STORE" = "$CANON_STORE" ] && IS_REAL=1
    if [ "$IS_REAL" = '1' ] && [ "${DSH_CRED_ALLOW_OVERWRITE:-}" != '1' ] && [ "${3:-}" != '--yes' ]; then
      echo "拒绝写入真机凭据库：put 会**覆盖**已有凭据，必须显式确认。" >&2
      echo "  · 真机写入：DSH_CRED_ALLOW_OVERWRITE=1 bash $0 put $2" >&2
      echo "  · 测试/夹具：DSH_CRED_DIR=<tmpdir> bash $0 put $2" >&2
      echo "（本保护来自一次真实事故：注入验证中 put 回落真机库，覆盖了内核令牌。）" >&2
      exit 2
    fi
    if [ "$IS_REAL" = '1' ] && [ -f "$f" ] && [ "${DSH_CRED_FORCE:-}" != '1' ]; then
      echo "拒绝覆盖已存在的真机凭据：$f" >&2
      echo "  如确需轮换，设 DSH_CRED_FORCE=1（会自动备份旧值到 .bak-<时间戳>）。" >&2
      exit 2
    fi
    if [ -f "$f" ]; then
      cp -p "$f" "$f.bak-$(date +%Y%m%d%H%M%S)" && chmod 600 "$f".bak-* 2>/dev/null
    fi
    umask 077; mkdir -p "$(dirname "$f")"; cat > "$f"; chmod 600 "$f";
    node -e "
      const fs=require('fs'),p=process.env.INDEX;
      const j=JSON.parse(fs.readFileSync(p,'utf8'));
      const e=j.entries.find(x=>x.name==='$2'); if(e){e.status='active';}
      fs.writeFileSync(p, JSON.stringify(j,null,2)+String.fromCharCode(10));
    "
    echo "已写入 ${f}（0600），status->active"
    ;;

  backup)
    # 持久化保障：把规范库整份复制到**操作者指定的**持久位置。
    # ⚠ 默认**必须显式给目录**：不给默认值，避免又写进实例子目录（那正是本仓踩过的坑）。
    # ⚠ 在 case 分支里 $1 是**子命令名**（"backup"），目标目录是 $2。
    DEST="${2:-}"
    [ -n "$DEST" ] || DEST="${DSH_CRED_BACKUP_DIR:-}"
    [ -n "$DEST" ] || { echo "用法: cred.sh backup <目标目录>（或设 DSH_CRED_BACKUP_DIR）" >&2
      echo "  拒绝用默认值：历史事故就是把凭据放进了**实例目录**（ephemeral，换会话即失效）。" >&2; exit 2; }
    case "$DEST" in
      */.dsh/supervisor/instances/*|*/instances/inst-*) 
        echo "拒绝：目标在**实例目录**内（${DEST}）—— 那是 ephemeral 的，备份无意义。" >&2; exit 2;;
    esac
    STAMP=$(date +%Y%m%d%H%M%S)
    OUT="$DEST/dsh-credentials-$STAMP"
    umask 077
    mkdir -p "$OUT" && chmod 700 "$OUT"
    cp "$INDEX" "$OUT/" && chmod 600 "$OUT/index.json"
    n=0
    for p in "$STORE"/*.pat; do
      [ -e "$p" ] || continue
      cp "$p" "$OUT/" && chmod 600 "$OUT/$(basename "$p")" && n=$((n + 1))
    done
    echo "已备份到 ${OUT}（目录 0700，$((n + 1)) 个文件均 0600）"
    echo "  ⚠ 该副本含**明文令牌**：请置于加密卷/密码管理器，勿入版本库与聊天工具。"
    ;;
  verify)
    want="${2:-}"
    node -e "
      const j=require(process.env.INDEX);
      for (const e of j.entries) {
        if ('$want' && e.name !== '$want') continue;
        console.log([e.name, e.status, (e.verify&&e.verify.url)||'', String((e.verify&&e.verify.expect)||'')].join('|'));
      }
    " | while IFS='|' read -r name status url expect; do
      [ -n "$url" ] || { printf '  %-13s %s（无 API 打点）\n' "$name" "$status"; continue; }
      # ⚠ 必须在此**重新解析**：循环体在管道右侧的子 shell 中，file_of 可用但
      #   entry_field 依赖的 $INDEX 在子 shell 里仍可用；此处显式再取一次以确保非空。
      f=$(node -e "const j=require(process.env.INDEX);const e=j.entries.find(x=>x.name==='$name');process.stdout.write(e&&e.file?e.file:'')")
      if [ ! -f "$f" ]; then printf '  %-13s **缺凭据文件** %s\n' "$name" "$f"; continue; fi
      code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$f")" "$url" 2>/dev/null || echo 000)
      if [ "$code" = "$expect" ]; then printf '  %-13s OK  (HTTP %s)\n' "$name" "$code";
      else printf '  %-13s **异常** HTTP %s（期望 %s）\n' "$name" "$code" "$expect"; fi
    done
    ;;

  doctor)
    rc=0
    echo '== 1) 目录与文件权限 =='
    # ⚠ 2026-09-14 跨平台修复：原实现用 `stat -c %a`（**GNU 专有**）——
    #   macOS 的 BSD stat 不支持 -c，Windows 根本没有 stat → 权限判定在这些平台必然失效。
    #   该缺陷长期隐藏，因为**四平台构建矩阵此前被 need_build 跳过**（只在 ubuntu 上跑过）。
    #   现改用 node（脚本已依赖 node 读清单）—— 三平台通用；并用 IS_WIN 判定跳过 POSIX 权限断言。
    IS_WIN=$(node -e "process.stdout.write(process.platform==='win32'?'1':'0')")
    perm_of() { node -e "try{process.stdout.write((require('fs').statSync(process.argv[1]).mode & 0o777).toString(8).padStart(3,'0'))}catch(e){process.stdout.write('?')}" "$1"; }
    if [ "$IS_WIN" = '1' ]; then
      echo '  SKIP  Windows 无 POSIX 权限位（chmod 仅切换只读位）—— 权限断言不适用'
    else
      dm=$(perm_of "$STORE")
      if [ "$dm" = '700' ]; then echo "  OK   库目录 0700"; else echo "  FAIL 库目录权限 ${dm}（应为 700）"; rc=1; fi
      for f in "$STORE"/*.pat "$STORE"/*.json; do
        [ -e "$f" ] || continue
        m=$(perm_of "$f")
        if [ "$m" = '600' ]; then echo "  OK   $(basename "$f") 0600"; else echo "  FAIL $(basename "$f") 权限 ${m}（应为 600）"; rc=1; fi
      done
    fi
    echo '== 2) 清单内的文件是否都在库内 =='
    node -e "
      const j=require(process.env.INDEX);
      for (const e of j.entries) {
        if (e.kind!=='github-pat') continue;
        const fs=require('fs');
        // ⚠ 必须用 ${STORE}（DSH_CRED_DIR 可覆盖），不可硬编码库根 —— 否则换库根就误报
        // 两侧都归一为 / 再比：Windows 的 e.file 可能是反斜杠形式，
        // 而 STORE 已被启动时归一为 /（否则恒不匹配 -> doctor 误报缺项，exit 1）。
        const norm = (x) => String(x).split(String.fromCharCode(92)).join('/');
        const ok = e.file && norm(e.file).startsWith(norm(process.env.STORE) + '/');
        console.log((ok?'  OK   ':'  FAIL ')+e.name+' -> '+(e.file||'(未设)'));
        if(!ok) process.exitCode=1;
      }
    " || rc=1
    echo '== 3) 缺项（状态非 active）=='
    node -e "
      const j=require(process.env.INDEX);
      let bad=0;
      for (const e of j.entries) if (e.status!=='active' && e.status!=='external') { console.log('  **缺** '+e.name+' ('+e.kind+', '+e.account+') status='+e.status); bad++; }
      if(!bad) console.log('  OK   无缺项');
      if(bad) process.exitCode=1;
    " || rc=1
    # ⚠ 第 4 项是**真机检查**：别名/散落副本都锚定在真实库根。
    #   当 DSH_CRED_DIR 覆盖了库根（测试夹具）时，这些真机事实与本库无关，必须跳过 ——
    #   否则夹具模式会因"别名指向另一个库根"而误报（已踩过）。
    if [ "$STORE" != "$CANON_STORE" ]; then
      echo '== 4) 失效散落副本（真机检查）=='
      echo '  SKIP  DSH_CRED_DIR 已覆盖库根 —— 该项只对真机库有意义'
      echo '== 5) 清单内不得含令牌值 =='
      if grep -qE 'github_pat_|ghp_' "$INDEX" 2>/dev/null; then echo '  FAIL 清单里出现了令牌值！'; rc=1; else echo '  OK   清单只有引用，无值'; fi
      exit $rc
    fi
    echo '== 4) 失效散落副本（已知的 ephemeral 位置）=='
    hits=0
    # 兼容别名为**符号链接**指向库内 -> 合规（单一副本）；普通文件 -> 散落副本
    LEGACY="$REAL_HOME/.dsh/github-pat-advgyxqamf"
    if [ -L "$LEGACY" ]; then
      tgt=$(readlink -f "$LEGACY" 2>/dev/null || echo '')
      case "$tgt" in
        "$STORE"/*) echo "  OK   $LEGACY 是指向库内的符号链接（单一副本）";;
        *) echo "  FAIL $LEGACY 符号链接指向库外: $tgt"; rc=1;;
      esac
    elif [ -e "$LEGACY" ]; then
      echo "  FAIL $LEGACY 是**独立副本**（应迁入库并改为符号链接）"; rc=1
    else
      echo "  OK   $LEGACY 不存在（已迁移）"
    fi
    for d in "$REAL_HOME/gh_token.txt" "$REAL_HOME/gh_token" "$REAL_HOME/.gh_token"; do
      [ -e "$d" ] && { echo "  FAIL 发现散落令牌副本 $d"; rc=1; hits=1; }
    done
    [ "$hits" = '0' ] && echo '  OK   无 $HOME 根下的散落副本'
    echo '== 5) 清单内不得含令牌值 =='
    if grep -qE 'github_pat_|ghp_' "$INDEX" 2>/dev/null; then echo '  FAIL 清单里出现了令牌值！'; rc=1; else echo '  OK   清单只有引用，无值'; fi
    exit $rc
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \?//';
    exit 1
    ;;
esac
