/**
 * 设置 — 关于卡（产品信息，放设置页最底部）
 * 产品逻辑：像成熟产品一样，设置页底部是「关于」——当前版本 + 产品简介 + 检查更新。
 * 不再展示构建 commit/upstream 等技术噪声，不做花哨大字（样式与整页协调）。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../framework/ui";
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
};

const PRODUCT_NAME = "DeepSeek Harness 管家";
const PRODUCT_DESC =
  "独立于 Harness 运行的系统级守卫：负责启动、存活监测与故障自动重启被监管目标，" +
  "提供生命周期管理、智能路由、远程控制与多实例沙箱的运维面板。";

export function AboutCard() {
  const [ver, setVer] = useState<VerInfo | null>(null);
  const { busy, run } = useSupervisorAction();

  // 本地当前版本（无网络 I/O，进卡即显示）
  const load = useCallback(async () => {
    const v = await supervisorApi.guardVersion().catch(() => null);
    setVer(v || {});
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 检查更新：内核自更新走 npm 通道(selfUpdateStatus)——全更新语义(任一更高即提示)
  const check = async () => {
    await run("chk", async () => {
      const r = await supervisorApi.selfUpdateStatus();
      if (r?.ok === false) { toast.error(r.error || "内核自更新未配置"); return; }
      setVer(r || {});
      if (r?.updateAvailable && r.latest) {
        toast.warning("发现内核新版本 v" + r.latest + "（当前 v" + r.installed + "），需更新后重启守卫");
      } else {
        toast.success("内核已是最新版本（v" + (r?.installed || "—") + "）");
      }
    }, { refresh: false });
  };

  // 强制更新(无跳过, 用户定稿 2026-09)：npm 装新内核后重启守卫
  const applyUpdate = async () => {
    if (!window.confirm("发现内核新版本 v" + (ver?.latest || "") + "，是否立即更新？")) return;
    await run("upd", async () => {
      const r = await supervisorApi.selfUpdateApply();
      if (r?.ok === false) { toast.error(r.error || "更新失败"); return; }
      if (r?.restartRequired) {
        toast.success("内核已更新至 v" + (r.installed || r.latest || "") + "，正在重启守卫…");
        const rs = await supervisorApi.selfUpdateRestart().catch(() => null);
        if (rs?.ok === false) toast.warning("更新完成，请手动重启守卫：" + (rs.error || ""));
      } else { toast.success("内核已是最新，无需更新"); }
    }, { refresh: true });
  };

  const hasUpdate = Boolean(ver?.updateAvailable && ver?.latest && ver.latest !== ver?.installed);
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
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">当前版本</span>
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            v{ver?.installed || ver?.version || "—"}
            {hasUpdate ? (
              <>
                <Pill tone="warn">可更新 v{ver?.latest}</Pill>
                <Button size="chip" disabled={busy === "upd"} onClick={() => void applyUpdate()} variant="outline">
                  <RefreshCw className={cn("size-3", busy === "upd" && "animate-spin")} />更新
                </Button>
              </>
            ) : null}
          </span>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          {PRODUCT_DESC}
        </p>
      </div>
    </Card>
  );
}
