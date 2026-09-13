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

# 凭据库根：默认**绝对路径**（$HOME 被 DSH 重定向，不可用 ~）；
# 可用 DSH_CRED_DIR 覆盖（测试 / 换机 / 多套环境）。
STORE=${DSH_CRED_DIR:-/home/bowen/.dsh/credentials}
INDEX="$STORE/index.json"

[ -f "$INDEX" ] || { echo "凭据清单缺失: $INDEX" >&2; exit 1; }

# 用 node 读清单（无 jq 依赖；内核对运行时依赖为 0 的纪律一致）
idx() { node -e "
  const j=require('$INDEX');
  $1
"; }

entry_field() { # <name> <field>
  # ⚠ 字段名必须用**单引号**写 e['$2']：
  #   · e[$2]  → node 当成变量名（file is not defined）
  #   · e["$2"] → bash 在双引号串内遇到未转义的 " 会**提前结束字符串**，
  #               到 node 手里退化成 e[file] —— 同样是未定义变量。
  #   单引号在 bash 双引号串内是字面量，故 e['$2'] 是唯一正确形态。
  node -e "const j=require('$INDEX');const e=j.entries.find(x=>x.name==='$1');
    process.stdout.write(e && e['$2']!=null ? String(e['$2']) : '');"
}

file_of() { entry_field "$1" file; }

case "${1:-list}" in
  list)
    node -e "
      const j=require('$INDEX');
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
    [ -f "$f" ] || { echo "凭据文件不存在: $f（状态可能为 missing）" >&2; exit 1; }
    cat "$f"
    ;;

  put)
    f=$(file_of "$2");
    [ -n "$f" ] || { echo "未知条目: $2" >&2; exit 1; }
    umask 077; mkdir -p "$(dirname "$f")"; cat > "$f"; chmod 600 "$f";
    node -e "
      const fs=require('fs'),p='$INDEX';
      const j=JSON.parse(fs.readFileSync(p,'utf8'));
      const e=j.entries.find(x=>x.name==='$2'); if(e){e.status='active';}
      fs.writeFileSync(p, JSON.stringify(j,null,2)+String.fromCharCode(10));
    "
    echo "已写入 $f（0600），status->active"
    ;;

  verify)
    want="${2:-}"
    node -e "
      const j=require('$INDEX');
      for (const e of j.entries) {
        if ('$want' && e.name !== '$want') continue;
        console.log([e.name, e.status, (e.verify&&e.verify.url)||'', String((e.verify&&e.verify.expect)||'')].join('|'));
      }
    " | while IFS='|' read -r name status url expect; do
      [ -n "$url" ] || { printf '  %-13s %s（无 API 打点）\n' "$name" "$status"; continue; }
      # ⚠ 必须在此**重新解析**：循环体在管道右侧的子 shell 中，file_of 可用但
      #   entry_field 依赖的 $INDEX 在子 shell 里仍可用；此处显式再取一次以确保非空。
      f=$(node -e "const j=require('$INDEX');const e=j.entries.find(x=>x.name==='$name');process.stdout.write(e&&e.file?e.file:'')")
      if [ ! -f "$f" ]; then printf '  %-13s **缺凭据文件** %s\n' "$name" "$f"; continue; fi
      code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$f")" "$url" 2>/dev/null || echo 000)
      if [ "$code" = "$expect" ]; then printf '  %-13s OK  (HTTP %s)\n' "$name" "$code";
      else printf '  %-13s **异常** HTTP %s（期望 %s）\n' "$name" "$code" "$expect"; fi
    done
    ;;

  doctor)
    rc=0
    echo '== 1) 目录与文件权限 =='
    dm=$(stat -c %a "$STORE" 2>/dev/null || echo '?')
    if [ "$dm" = '700' ]; then echo "  OK   库目录 0700"; else echo "  FAIL 库目录权限 $dm（应为 700）"; rc=1; fi
    for f in "$STORE"/*.pat "$STORE"/*.json; do
      [ -e "$f" ] || continue
      m=$(stat -c %a "$f" 2>/dev/null || echo '?')
      if [ "$m" = '600' ]; then echo "  OK   $(basename "$f") 0600"; else echo "  FAIL $(basename "$f") 权限 $m（应为 600）"; rc=1; fi
    done
    echo '== 2) 清单内的文件是否都在库内 =='
    node -e "
      const j=require('$INDEX');
      for (const e of j.entries) {
        if (e.kind!=='github-pat') continue;
        const fs=require('fs');
        // ⚠ 必须用 $STORE（DSH_CRED_DIR 可覆盖），不可硬编码库根 —— 否则换库根就误报
        const ok = e.file && e.file.startsWith('$STORE/');
        console.log((ok?'  OK   ':'  FAIL ')+e.name+' -> '+(e.file||'(未设)'));
        if(!ok) process.exitCode=1;
      }
    " || rc=1
    echo '== 3) 缺项（状态非 active）=='
    node -e "
      const j=require('$INDEX');
      let bad=0;
      for (const e of j.entries) if (e.status!=='active' && e.status!=='external') { console.log('  **缺** '+e.name+' ('+e.kind+', '+e.account+') status='+e.status); bad++; }
      if(!bad) console.log('  OK   无缺项');
      if(bad) process.exitCode=1;
    " || rc=1
    # ⚠ 第 4 项是**真机检查**：别名/散落副本都锚定在真实库根。
    #   当 DSH_CRED_DIR 覆盖了库根（测试夹具）时，这些真机事实与本库无关，必须跳过 ——
    #   否则夹具模式会因"别名指向另一个库根"而误报（已踩过）。
    if [ "$STORE" != '/home/bowen/.dsh/credentials' ]; then
      echo '== 4) 失效散落副本（真机检查）=='
      echo '  SKIP  DSH_CRED_DIR 已覆盖库根 —— 该项只对真机库有意义'
      echo '== 5) 清单内不得含令牌值 =='
      if grep -qE 'github_pat_|ghp_' "$INDEX" 2>/dev/null; then echo '  FAIL 清单里出现了令牌值！'; rc=1; else echo '  OK   清单只有引用，无值'; fi
      exit $rc
    fi
    echo '== 4) 失效散落副本（已知的 ephemeral 位置）=='
    hits=0
    # 兼容别名为**符号链接**指向库内 -> 合规（单一副本）；普通文件 -> 散落副本
    LEGACY="/home/bowen/.dsh/github-pat-advgyxqamf"
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
    for d in /home/bowen/gh_token.txt /home/bowen/gh_token /home/bowen/.gh_token; do
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
