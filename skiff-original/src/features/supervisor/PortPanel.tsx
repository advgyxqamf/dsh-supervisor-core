/**
 * 端口管理面板（Overview 左侧）：
 * 展示后端 /ports 端口注册表 —— 对接后端全部已注册端口 + 归属/角色/状态。
 * 归属语义着色：system(核心服务) / inst(实例) / relay(隧道) / dynamic(动态)。
 */
import { useMemo } from "react";
import { CircleDot } from "lucide-react";
import { useSupervisorData, type PortRecord, type RouterProvider } from "../../services/supervisor";
import { Card, CardTitle, Pill } from "./widgets";
import { cn } from "../../framework/utils";

function roleTone(role: string, owner: string): "ok" | "boot" | "warn" | "off" {
  if (role === "dsh-main" || role === "supervisor-api") return "boot";
  if (owner.startsWith("inst:")) return "ok";
  if (role === "relay") return "warn";
  return "off";
}
function roleLabel(r: PortRecord): string {
  const map: Record<string, string> = {
    "dsh-main": "DSH 主实例",
    "supervisor-api": "管家 API",
    relay: "隧道",
    user: "用户实例",
  };
  return map[r.role] ?? r.role;
}
/** 归属标签化：不暴露账号/内部 id。反代(proxy)归属 → 所属供应商名；其余 → 语义类别。 */
function resolveOwner(r: PortRecord, providers: RouterProvider[]): string {
  const o = r.owner || "";
  if (r.role === "proxyInstance") {
    // proxy:<keyId掩码尾4> → 匹配该供应商下账号，显示供应商名称
    const tail = o.split(":").pop() || "";
    const tail4 = tail.slice(-4);
    const prov = (providers ?? []).find((p) => (p.accounts ?? []).some((a) => (a.maskedKey || "").endsWith(tail4)));
    return prov ? prov.name : "反代";
  }
  if (o.startsWith("inst:")) return "沙箱实例";
  if (o.startsWith("system:")) return "系统";
  if (o.startsWith("relay:")) return "主隧道";
  if (o.startsWith("dynamic:")) return "动态";
  if (o.startsWith("providerApi:")) return "供应商";
  if (o.startsWith("oauth:")) return "登录回调";
  // 兜底：任何未识别前缀一律不给原始 owner（防泄露内部 id/凭据），按角色给通用归属
  if (r.role === "oauthCallback") return "登录回调";
  return r.role;
}

export function PortPanel({ providers = [] }: { providers?: RouterProvider[] }) {
  // R4 修复：/ports 已并入全局 2s 统一心跳快照（polling.ts syncAll），
  // 本组件直接消费 snap.ports —— 移除独立 5s setInterval（消除双数据源节奏重叠与写操作后的数据错位）。
  const { snap } = useSupervisorData();
  const raw = snap.ports?.records ?? null;
  const records = useMemo<PortRecord[] | null>(() => {
    if (!raw) return null;
    // 排序：激活(监听中)在上，停用(未监听)在下；组内按端口号升序
    return [...raw].sort((a, b) => {
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      return a.port - b.port;
    });
  }, [raw]);

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardTitle title="端口管理" subtitle="对接后端全部已注册端口" actions={records ? <span className="font-mono text-xs text-muted-foreground">{records.length}</span> : null} />
      {!records ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">加载中…</div>
      ) : (
        <div className="flex min-h-0 flex-col">
          <div className="grid grid-cols-[56px_minmax(0,1fr)_auto_66px] items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>端口</span><span>角色</span><span className="text-right">归属</span><span className="text-right">状态</span>
          </div>
          <div className="max-h-[340px] overflow-y-auto overscroll-contain">
            {records.map((r, i) => (
              <div key={r.port + "-" + r.owner} className={cn("grid grid-cols-[56px_minmax(0,1fr)_auto_66px] items-center gap-2 px-4 py-2 hover:bg-muted/40", i > 0 && "border-t border-border/50")}>
                <code className="font-mono text-sm tabular-nums text-foreground">{r.port}</code>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs text-foreground">{roleLabel(r)}</span>
                </div>
                <div className="flex justify-end"><Pill tone={roleTone(r.role, r.owner)}>{resolveOwner(r, providers)}</Pill></div>
                <div className="flex justify-end">
                  {r.active === true ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-status-ok"><CircleDot className="size-3" />激活</span>
                  ) : r.active === false ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"><CircleDot className="size-3 opacity-50" />停用</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"><CircleDot className="size-3 opacity-40" />状态未知</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
