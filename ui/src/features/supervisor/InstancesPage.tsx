/**
 * 实例管理（supervisor）— 老 UI 实例管理域，按新 UI 标准重建
 * 数据：supervisorStore.instances（统一 2s 快照）
 * 动作：supervisorApi.instance* → refresh()
 */
import { useEffect, useState } from "react";
import {
  Activity, Box, ExternalLink, Power, Rocket, RotateCw, ShieldCheck, Square, Trash2, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../framework/ui/dialog";
import { Input } from "../../framework/ui/input";
import { Textarea } from "../../framework/ui/textarea";
import { Label } from "../../framework/ui/label";
import { Spinner } from "../../framework/ui/spinner";
import { supervisorApi, supervisorStore, useSupervisorData, type SupervisorInstance } from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { DomainBadge, Metric, Pill, Card, ToneDot } from "./widgets";
import { friendlyFailure, instancePhaseMeta } from "./nav";
import { cn } from "../../framework/utils";

export function InstancesPage({ onRegisterActions }: { onRegisterActions?: (a: { onAdd: () => void } | null) => void }) {
  const { snap } = useSupervisorData();
  const { busy: busyId, run } = useSupervisorAction();
  const [addOpen, setAddOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // 添加表单
  const [fName, setFName] = useState("");
  const [fPort, setFPort] = useState("");
  const [fCmd, setFCmd] = useState("");
  const [fMem, setFMem] = useState("4G");
  const [fCpu, setFCpu] = useState("150%");

  // 概念清分：后端 /instances 已把沙箱与原生拆分——instances[] 即沙箱（原生主干在 native 字段，
  // 由 Overview 主干卡呈现）。此处不再需要 domain 过滤。
  const items = snap.instances?.instances ?? [];

  // 顶部 Toolbar 动作注册（对齐原版：页面动作按钮渲染在置顶行，点击打开本页 dialog）
  useEffect(() => {
    onRegisterActions?.({ onAdd: () => setAddOpen(true) });
    return () => onRegisterActions?.(null);
  }, [onRegisterActions]);

  /** 动作（busy 键 = 实例 id；操作静默成功，仅刷新快照） */
  const act = (key: string, fn: () => Promise<unknown>) => run(key, fn);

  async function addInstance() {
    const port = parseInt(fPort, 10);
    if (!Number.isFinite(port) || port <= 0) { toast.error("请填写有效端口"); return; }
    const command = fCmd ? fCmd.split(/\n/).map((x) => x.trim()).filter(Boolean) : [];
    try {
      const r = await supervisorApi.instanceAdd({ name: fName.trim() || ("沙箱 " + port), port, command, memoryMax: fMem || "4G", cpuQuota: fCpu || "150%" });
      if (r && r.ok === false) { toast.error(r.error || "添加失败"); return; }
      toast.success("已添加实例");
      setAddOpen(false);
      setFName(""); setFPort(""); setFCmd(""); setFMem("4G"); setFCpu("150%");
      supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
  }

  async function checkUpdate(it: SupervisorInstance) {
    // 分支反馈（发现新版/已最新/失败）留在动作内；busy 与刷新由共享 run 管理
    await run(it.id, async () => {
      const r = await supervisorApi.instanceCheckUpdate(it.id);
      if (r.updateAvailable) { toast.success("发现新版 " + r.latest + "，可点「更新」升级"); setUpdOk((m) => new Map(m).set(it.id, true)); }
      else if (r.latest) toast.info("已是最新 " + r.latest);
      else toast.error(r.error || "版本检测失败");
    });
  }
  const [updOk, setUpdOk] = useState<Map<string, boolean>>(new Map());

  async function upgrade(it: SupervisorInstance) {
    if (!confirm("将升级该沙箱实例的 DSH 到最新版（实例会短暂重启，进行中的请求中断）。确定升级？")) return;
    await run(it.id, () => supervisorApi.instanceUpgrade(it.id), { success: "升级已开始…" });
  }

  const InstanceRow = ({ it }: { it: SupervisorInstance }) => {
    const running = it.state?.running ?? false;
    const lp = it.state?.lifecyclePhase;
    const pm = instancePhaseMeta(lp, running);
    const upd = it.updateJob;
    const updating = upd?.state === "running";
    const mem = it.sandbox?.memoryMax || "—";
    const cpu = it.sandbox?.cpuQuota || "—";
    const busy = busyId === it.id;
    return (
      <Card className="overflow-visible">
        {/* 信息区：左（身份/状态） / 右（资源指标） */}
        <div className="grid grid-cols-1 @min-[720px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex flex-col gap-4 border-b border-border px-6 py-5 md:border-b-0 md:border-r">
            {/* 身份行 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <strong className="truncate text-lg font-semibold tracking-[-0.01em] text-foreground">{it.name}</strong>
                {it.version ? (
                  <span className="font-mono text-sm text-muted-foreground">v{it.version}</span>
                ) : null}
              </div>
              {/* 版本检测/更新（随状态演化） */}
              {updOk.get(it.id) ? (
                <Button className="text-primary-foreground" onClick={() => void upgrade(it)} size="chip">
                  <RotateCw className="size-3" />更新
                </Button>
              ) : (
                <Button className="bg-primary/10 text-primary hover:bg-primary/15" disabled={busy || updating} onClick={() => void checkUpdate(it)} size="chip" variant="ghost">
                  <RotateCw className={cn("size-3", busy && "animate-spin")} />检测更新
                </Button>
              )}
            </div>

            {/* 运行状态 */}
            <div className="flex flex-wrap items-center gap-2">
              <ToneDot tone={pm.tone} ping={pm.tone === "ok"} />
              <span className="text-base font-semibold leading-none text-foreground">{pm.label}</span>
            </div>

            {/* 升级/安装进度 */}
            {updating ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                正在升级 DeepSeek Harness（{upd?.step || ""}）…
              </div>
            ) : null}
            {it.state?.installing ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />正在安装…
              </div>
            ) : null}
            {lp === "FAILED" ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <TriangleAlert className="size-3.5" />
                <span className="truncate">{it.state?.lastError || "失败"}</span>
              </div>
            ) : null}
          </div>

          {/* 右：运行指标（与原生主卡一致：端口/PID/重启次数/最近故障） */}
          <div className="flex items-center bg-[image:var(--panel-accent-gradient)] px-6 py-5">
            <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Metric icon={<Activity className="size-4" />} label="端口" value={String(it.port)} mono />
              <Metric icon={<Square className="size-4" />} label="PID" value={it.state?.pid ? String(it.state.pid) : "—"} mono />
              <Metric icon={<RotateCw className="size-4" />} label="重启次数" value={String(it.state?.restartCount ?? 0)} mono />
              <Metric icon={<TriangleAlert className="size-4" />} label="最近故障" value={it.state?.lastFailure ? friendlyFailure(it.state.lastFailure) : "无"} warn={Boolean(it.state?.lastFailure)} />
            </div>
          </div>
        </div>

        {/* 底栏操作行：左信息（环境检测位 → 内存/CPU）/ 右操作 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-3">
          {/* 左信息(沙箱/远程/内存CPU)——窄屏(内容区<860px)隐藏, 位置让给右侧操作按钮 */}
          <span className="hidden min-w-0 items-center lg:inline-flex gap-2 text-xs text-muted-foreground">
            <DomainBadge domain="sandbox" />
            <Pill tone={it.remoteEnabled ? "boot" : "off"}>{it.remoteEnabled ? "远程开启" : "远程关闭"}</Pill>
            <span className="whitespace-nowrap">内存 {mem} · CPU {cpu}</span>
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button disabled={!running} onClick={() => void act(it.id, () => supervisorApi.instanceOpenWeb(it.id))} size="sm" title="打开 DSH Web（自动带认证连接）" variant="outline" className="hidden md:inline-flex">
              <ExternalLink className="size-4" />DSH Web
            </Button>
            <Button disabled={updating} onClick={() => void act(it.id, () => (running ? supervisorApi.instanceStop(it.id) : supervisorApi.instanceStart(it.id)))} size="sm" variant="outline">
              {running ? <><Power className="size-4 text-status-error" />停止实例</> : <><Rocket className="size-4 text-primary" />启动实例</>}
            </Button>
            {/* 分割线(启停后) → 进程守护按钮(与主 DSH 卡同布局) */}
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <Button disabled={busy} onClick={() => void act(it.id, () => supervisorApi.instanceUpdate(it.id, { guardian: !it.guardian }))} size="sm" variant="outline">
              <ShieldCheck className={cn("size-4", it.guardian ? "text-status-ok" : "text-muted-foreground")} />
              {it.guardian ? "停止守护" : "启动守护"}
            </Button>
            {/* 守护后无分割线(2026-09 用户定稿, 与主 DSH 卡一致); 窄屏隐藏(只留启停+守护) */}
            <Button className="hidden h-[30px] md:inline-flex" disabled={busy} onClick={() => setConfirmId(it.id)} size="sm" variant="destructive">
              <Trash2 className="size-4" />删除
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="grid content-start gap-4">
      {!items.length ? (
        <div className="grid min-h-[220px] place-items-center rounded-lg border border-dashed border-border text-center">
          <div>
            <Box className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">尚未添加沙箱实例</p>
            <p className="mt-1 text-xs text-muted-foreground">点击顶部「添加实例」创建沙箱</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">{items.map((it) => <InstanceRow key={it.id} it={it} />)}</div>
      )}

      {/* 添加实例 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-[440px]">
          <DialogHeader><DialogTitle>添加 DSH 实例</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>实例名称</Label>
              <Input placeholder="如 沙箱二开" value={fName} onChange={(e) => setFName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>监听端口</Label>
              <Input inputMode="numeric" placeholder="如 3082" value={fPort} onChange={(e) => setFPort(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>启动命令（每项一参数，可留空用默认）</Label>
              <Textarea
                className="min-h-[72px] font-mono text-sm"
                placeholder={"node\n/home/bowen/.npm-global/bin/dsh\nweb"}
                value={fCmd}
                onChange={(e) => setFCmd(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>内存限额</Label>
                <Input placeholder="如 4G" value={fMem} onChange={(e) => setFMem(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>CPU 配额</Label>
                <Input placeholder="如 150%" value={fCpu} onChange={(e) => setFCpu(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setAddOpen(false)} variant="outline">取消</Button>
            <Button onClick={() => void addInstance()}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <DialogContent className="max-w-[380px]">
          <DialogHeader><DialogTitle>删除实例？</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">将彻底删除该沙箱实例（含配置与运行时数据）。此操作不可恢复。</p>
          <DialogFooter>
            <Button onClick={() => setConfirmId(null)} variant="outline">取消</Button>
            <Button
              className="h-[34px]"
              onClick={() => { if (confirmId) void act(confirmId, () => supervisorApi.instanceRemove(confirmId)); setConfirmId(null); }}
              variant="destructive"
            >删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
