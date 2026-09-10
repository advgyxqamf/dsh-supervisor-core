/**
 * 设置 — 关于卡（产品信息，放设置页最底部）
 * 产品逻辑：像成熟产品一样，设置页底部是「关于」——版本信息 + 产品简介 + 检查更新。
 *
 * 2026-09-11 调整（用户要求）：
 *   1) 本产品由**两个独立组件**构成，各有独立版本线，须分别呈现：
 *        · 桌面壳（Tauri 壳，dsh-supervisor-gui）—— 承载窗口/托盘/引导
 *        · 内核（守卫，dsh-supervisor）—— 承载生命周期/路由/远程控制/实例
 *      「当前版本」只显示一个会产生歧义，故拆为两行明确呈现。
 *   2) 「检查更新」对**两者一起检测**（内核走 npm 子包；桌面壳走壳发布清单，同源 npm registry）。
 *   3) 版本号**不带 v 前缀**（直接显示纯版本号），与用户定稿一致。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../framework/ui/dialog";
import { supervisorApi } from "../../../services/supervisor";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle, Pill } from "../widgets";
import { cn } from "../../../framework/utils";

type VerInfo = {
  version?: string;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  ok?: boolean;
  error?: string | null;
  // 源码形态（git-repo）字段：A5 接线后经 /guard/version 与 /guard/version/check 携带
  upstream?: string;
  commit?: string;
};

/** 桌面壳版本与更新状态（/shell/status 取本地版本，/shell/check-update 取远端最新）。 */
type ShellInfo = {
  version?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  capable?: boolean;
  installKind?: string;
  error?: string | null;
};

const PRODUCT_NAME = "DeepSeek Harness 管家";
const PRODUCT_DESC =
  "独立于 Harness 运行的系统级守卫：负责启动、存活监测与故障自动重启被监管目标，" +
  "提供生命周期管理、智能路由、远程控制与多实例沙箱的运维面板。";

/** 版本号展示：去掉常见 v 前缀（用户定稿：直接显示版本号）。 */
const fmt = (s?: string | null) => (s ? String(s).replace(/^v/i, "") : "—");

export function AboutCard() {
  const [ver, setVer] = useState<VerInfo | null>(null);          // 内核
  const [shell, setShell] = useState<ShellInfo | null>(null);    // 桌面壳
  const [logOpen, setLogOpen] = useState(false);
  const [logKind, setLogKind] = useState<"dsh" | "guard">("dsh");
  const [logText, setLogText] = useState("");
  const { busy, run } = useSupervisorAction();

  // 更新日志（A4）：按需拉取文本，失败给出明确提示而非静默。
  const openLog = useCallback(async (kind: "dsh" | "guard") => {
    setLogKind(kind);
    setLogText("");
    setLogOpen(true);
    try {
      const text = kind === "dsh" ? await supervisorApi.dshChangelog() : await supervisorApi.guardChangelog();
      setLogText(text || "（无内容）");
    } catch (e) {
      setLogText("加载失败：" + String(e));
    }
  }, []);

  // ── 本地版本（无网络 I/O，进卡即显示）──
  // 内核：/guard/version（守卫自身版本，编译期常量）
  // 桌面壳：/shell/status → identity.version（壳启动时写入 ~/.dsh/shell/identity.json）
  const load = useCallback(async () => {
    const [core, sh] = await Promise.all([
      supervisorApi.guardVersion().catch(() => null),
      supervisorApi.shellStatus().catch(() => null),
    ]);
    setVer(core || {});
    setShell(sh ? {
      version: sh.identity?.version || null,
      capable: sh.identity?.selfUpdateCapable === true,
      installKind: sh.identity?.installKind,
    } : {});
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 挂载后台权威检查（非阻塞）：本地 GET 恒不联网，若不校验则「可更新」徽标永不自发出现。
  // 2026-09-11：**内核与桌面壳各查一次**（用户要求「一起检测」）。
  useEffect(() => {
    let alive = true;
    (async () => {
      const [core, sh] = await Promise.all([
        supervisorApi.selfUpdateStatus().catch(() => null),
        supervisorApi.shellCheckUpdate().catch(() => null),
      ]);
      if (!alive) return;
      if (core && core.ok !== false) setVer((prev) => ({ ...(prev || {}), ...core }));
      if (sh) setShell((prev) => ({ ...(prev || {}), latest: sh.latest || null, updateAvailable: sh.updateAvailable === true, error: sh.error || null }));
    })();
    return () => { alive = false; };
  }, []);

  // ── 检查更新（内核 + 桌面壳一起检测）──
  // 内核两条通道：① 标准形态 → /self-update/status（npm）；② 源码形态 → /guard/version/check（git）。
  const check = async () => {
    await run("chk", async () => {
      // ① 内核
      let coreMsg = "内核：状态未知";
      const r = await supervisorApi.selfUpdateStatus().catch(() => null);
      if (r && r.ok !== false) {
        setVer(r || {});
        coreMsg = r.updateAvailable && r.latest
          ? "内核有新版本 " + fmt(r.latest) + "（当前 " + fmt(r.installed) + "）"
          : "内核已是最新（" + fmt(r.installed) + "）";
      } else {
        const local = await supervisorApi.guardVersion().catch(() => null);
        if (local?.upstream === "git-repo") {
          const g = await supervisorApi.guardVersionCheck().catch(() => null);
          setVer({ ...(local || {}), ...(g || {}) });
          coreMsg = g?.updateAvailable
            ? "内核源码仓库有上游更新（当前提交 " + (g.commit || local?.commit || "—") + "）"
            : "内核源码仓库已是最新（提交 " + (local?.commit || g?.commit || "—") + "）";
        } else {
          coreMsg = "内核：" + ((r && r.error) || "自更新未配置");
        }
      }
      // ② 桌面壳
      const sh = await supervisorApi.shellCheckUpdate().catch(() => null);
      let shellMsg = "桌面壳：状态未知";
      if (sh && sh.ok !== false) {
        setShell((prev) => ({ ...(prev || {}), latest: sh.latest || null, updateAvailable: sh.updateAvailable === true, error: null }));
        shellMsg = sh.updateAvailable && sh.latest
          ? "桌面壳有新版本 " + fmt(sh.latest) + "（当前 " + fmt(sh.installed) + "）"
          : "桌面壳已是最新（" + fmt(sh.installed) + "）";
      } else {
        setShell((prev) => ({ ...(prev || {}), error: (sh && sh.error) || "检测失败" }));
        shellMsg = "桌面壳：" + ((sh && sh.error) || "检测失败");
      }
      // 汇总提示：任一有更新用警示色，否则成功色
      const anyUpdate = Boolean((r?.updateAvailable && r?.latest) || (sh?.updateAvailable && sh?.latest));
      if (anyUpdate) toast.warning(coreMsg + "；" + shellMsg);
      else toast.success(coreMsg + "；" + shellMsg);
    }, { refresh: false });
  };

  // 内核更新（无跳过，用户定稿 2026-09）：npm 装新内核后重启守卫
  const applyCoreUpdate = async () => {
    if (!window.confirm("发现内核新版本 " + fmt(ver?.latest) + "，是否立即更新？")) return;
    await run("upd", async () => {
      const r = await supervisorApi.selfUpdateApply();
      if (r?.ok === false) { toast.error(r.error || "更新失败"); return; }
      if (r?.restartRequired) {
        toast.success("内核已更新至 " + fmt(r.installed || r.latest) + "，正在重启守卫…");
        const rs = await supervisorApi.selfUpdateRestart().catch(() => null);
        if (rs?.ok === false) toast.warning("更新完成，请手动重启守卫：" + (rs.error || ""));
      } else { toast.success("内核已是最新，无需更新"); }
    }, { refresh: true });
  };

  // 桌面壳更新：壳的自更新发生在**启动时**（门 0：查清单 → 下载 → 验签 → 安装 → 重启）。
  // 因此「应用壳更新」= 重启桌面壳，新进程的门 0 会把它升到新版本。
  const applyShellUpdate = async () => {
    if (!window.confirm("将重启桌面壳以应用更新 " + fmt(shell?.latest) + "。\n\n桌面壳窗口会关闭并重新打开；内核与被管实例不受影响。是否继续？")) return;
    await run("shupd", async () => {
      const r = await supervisorApi.shellRestart();
      if (r?.ok === false) { toast.error(r.error || "重启桌面壳失败"); return; }
      toast.success("桌面壳正在重启，将在启动时自动更新至 " + fmt(shell?.latest));
    }, { refresh: false });
  };

  const coreUpdate = Boolean(ver?.updateAvailable && ver?.latest && ver.latest !== ver?.installed);
  const shellUpdate = Boolean(shell?.updateAvailable && shell?.latest && shell.latest !== shell?.version);
  // 桌面壳不可自更新（如无提权通道）时，明确说明原因而非静默隐藏
  const shellUncapable = shell?.capable === false;

  return (
    <Card>
      <CardTitle
        title="关于"
        subtitle={PRODUCT_NAME}
        actions={
          <Button size="sm" disabled={busy === "chk"} onClick={() => void check()} variant="outline">
            <RefreshCw className={cn("size-3.5", busy === "chk" && "animate-spin")} />
            检查更新
          </Button>
        }
      />
      <div className="grid gap-3 px-5 py-4">
        {/* 桌面壳版本（本产品对外呈现的「当前版本」） */}
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">桌面壳版本</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {fmt(shell?.version)}
            {shell?.installKind ? <span className="text-xs font-normal text-muted-foreground">（{shell.installKind}）</span> : null}
            {shellUpdate ? (
              <>
                <Pill tone="warn">可更新 {fmt(shell?.latest)}</Pill>
                <Button size="chip" disabled={busy === "shupd"} onClick={() => void applyShellUpdate()} variant="outline">
                  <RefreshCw className={cn("size-3", busy === "shupd" && "animate-spin")} />重启并更新
                </Button>
              </>
            ) : null}
            {shellUncapable ? <Pill tone="off">当前形态不支持自更新</Pill> : null}
            {shell?.error ? <span className="text-xs font-normal text-muted-foreground">{shell.error}</span> : null}
          </span>
        </div>
        {/* 内核版本（守卫自身） */}
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">内核版本</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {fmt(ver?.installed || ver?.version)}
            {coreUpdate ? (
              <>
                <Pill tone="warn">可更新 {fmt(ver?.latest)}</Pill>
                <Button size="chip" disabled={busy === "upd"} onClick={() => void applyCoreUpdate()} variant="outline">
                  <RefreshCw className={cn("size-3", busy === "upd" && "animate-spin")} />更新
                </Button>
              </>
            ) : null}
          </span>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          {PRODUCT_DESC}
        </p>
        {/* A4 断点修复：更新日志入口（后端 /changelog 与 /guard/changelog 此前无任何 UI 接线） */}
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Button size="chip" variant="outline" onClick={() => void openLog("dsh")}>
            DSH 更新日志
          </Button>
          <Button size="chip" variant="outline" onClick={() => void openLog("guard")}>
            管家更新日志
          </Button>
        </div>
      </div>
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{logKind === "dsh" ? "DeepSeek Harness 更新日志" : "管家更新日志"}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
            {logText || "加载中…"}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}