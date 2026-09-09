/**
 * 远程控制（supervisor lan + frp）
 * - 每个实例行：远程控制开关（联动：实例运行中 ∧ remoteEnabled ∧ relay 监听）
 * - FRP 公网访问卡：状态 + 配置 + 安装/保存
 */
import { useEffect, useState } from "react";
import { ExternalLink, Save, Wrench } from "lucide-react";
import QRCode from "react-qr-code";
import { Button, Switch } from "../../framework/ui";
import { Input } from "../../framework/ui/input";
import { Label } from "../../framework/ui/label";
import { supervisorApi, useSupervisorData } from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { Card, CardTitle, DomainBadge, Pill } from "./widgets";

import { cn } from "../../framework/utils";

export function LanPage() {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  // 远程控制是横切能力：主干(main, native 字段)与沙箱(instances[])都是可远程的受管 DSH。
  const instances = [
    ...(snap.instances?.native ? [snap.instances.native] : []),
    ...(snap.instances?.instances ?? []),
  ];
  const lanItems = snap.lan?.items ?? [];
  const addr = (snap.lan?.addresses ?? [])[0] || "";
  const frp = snap.frp;

  // FRP 表单（只在数据加载后填充一次）
  const [frpAddr, setFrpAddr] = useState("");
  const [frpPort, setFrpPort] = useState("7000");
  const [frpToken, setFrpToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!frp || loaded) return;
    setFrpAddr(frp.settings.serverAddr || "");
    setFrpPort(String(frp.settings.serverPort || 7000));
    setFrpToken(frp.settings.authToken || "");
    setLoaded(true);
  }, [frp, loaded]);

  async function saveFrp() {
    await run("frp-save", () => supervisorApi.frpSettings({ serverAddr: frpAddr, serverPort: parseInt(frpPort, 10) || 7000, authToken: frpToken }), { success: "已保存 FRP 配置" });
  }

  return (
    <div className="grid content-start gap-4">
      <div className="grid items-start gap-4 @min-[900px]:grid-cols-[minmax(0,1fr)_420px]">
      {/* 实例远程控制列表 */}
      <Card>
        <CardTitle title="局域网远程控制" subtitle="为本地 DSH 实例开启局域网反向代理访问（需实例运行中）" />
        <div className="grid">
          {!instances.length ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">暂无实例（在「实例管理」添加后将出现在这里）</div>
          ) : instances.map((it) => {
            const running = it.state?.running ?? false;
            const proxy = lanItems.find((p) => p.dshPort === it.port);
            const relayRunning = Boolean(proxy?.running);
            const proxyEnabled = Boolean(proxy?.enabled);
            const url = running && proxyEnabled && relayRunning && addr ? ("http://" + addr + ":" + proxy?.wanPort + "/") : null;
            // 远程可用性单一标签（2026-09 简化）：只显示「远程就绪 / 远程停止」——
            // 语义 = 实例运行 ∧ 代理启用 ∧ relay 监听 ∧ cookie 就绪 才算「就绪」，否则一律「停止」。
            // 不再分开展示 实例运行中/已停止、代理停止/未就绪/未启用、正在注入/令牌缺失 等多标签。
            const inj = relayRunning ? proxy?.inject : null;
            const remoteReady = Boolean(running && proxyEnabled && relayRunning && inj?.cookieReady);
            // 非就绪的具体原因放进 title（悬停可见），不占标签位
            const remoteHint = !running ? '实例未运行'
              : !proxyEnabled ? '远程未开启（点右侧开关开启）'
              : !relayRunning ? '远程服务未就绪'
              : !inj?.cookieReady ? (inj?.tokenSet ? (inj?.lastError || '正在注入…') : '令牌缺失')
              : 'DSH 会话 cookie 已注入，远程访问已认证';
            const remotePill = remoteReady
              ? <Pill tone="ok">远程就绪</Pill>
              : <span title={remoteHint}><Pill tone="off">远程停止</Pill></span>;
            return (
              <div key={it.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch gap-4 border-b border-border/60 px-5 py-4 last:border-b-0">
                {/* 二维码（左） */}
                {url ? (
                  <div className="flex shrink-0 items-center rounded-lg border border-border bg-white p-1.5" title="扫码访问该实例远程地址">
                    <QRCode value={url} size={88} />
                  </div>
                ) : (
                  <div className="grid size-[96px] shrink-0 place-items-center rounded-lg border border-dashed border-border/70 text-[11px] leading-tight text-muted-foreground/60">{running ? "代理就绪后生成二维码" : "启动后可用"}</div>
                )}
                {/* 中列：标题(右侧, 顶比二维码略低) 在上；端口/IP 贴二维码底 */}
                <div className="flex min-w-0 flex-col">
                  <div className="pt-2.5 flex flex-wrap items-center gap-2">
                    <DomainBadge domain={it.domain} />
                    <strong className="truncate text-sm font-semibold text-foreground">{it.name}</strong>
                    {remotePill}
                  </div>
                  <div className="mt-auto grid content-end gap-1.5 pb-1">
                    <div className="text-xs text-muted-foreground">端口 {it.port}{it.remoteEnabled ? " · 远程已开" : " · 远程未开"}</div>
                    {url ? (
                      <a className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline" href={url} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3 shrink-0" />{url}
                      </a>
                    ) : (
                      <div className="text-xs text-muted-foreground/70">{running ? "等待代理就绪…" : "实例未运行，启动后可开启远程"}</div>
                    )}
                  </div>
                </div>
                {/* 远程开关（右，整行垂直居中） */}
                <div className={cn("flex items-center gap-2", !running && "pointer-events-none opacity-50")}>
                  <span className="text-xs font-medium text-muted-foreground">远程控制</span>
                  <Switch
                    checked={it.remoteEnabled ?? false}
                    disabled={!running}
                    onCheckedChange={(v) => void run(it.id, () => (
                      it.domain === "native"
                        ? supervisorApi.nativeSettings({ remoteEnabled: v }) // 概念清分：main 设置走主干 /native/settings
                        : supervisorApi.instanceUpdate(it.id, { remoteEnabled: v })
                    ), { success: v ? "已开启远程控制" : "已关闭远程控制" })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {/* FRP 卡 */}
      <Card>
        <CardTitle
          title="公网访问（FRP 内网穿透）"
          subtitle="通过 frpc 暴露本机端口到公网"
          actions={<Pill tone={frp?.running ? "ok" : frp?.installed ? "warn" : "off"}>{frp?.running ? "frpc 运行中" : frp?.installed ? "已安装 · 未运行" : "未安装"}</Pill>}
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4">
          <div className="grid gap-1.5"><Label>frps 地址</Label><Input placeholder="如 1.2.3.4" value={frpAddr} onChange={(e) => setFrpAddr(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>frps 端口</Label><Input inputMode="numeric" placeholder="7000" value={frpPort} onChange={(e) => setFrpPort(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>auth token</Label><Input placeholder="frps 的 auth.token" value={frpToken} onChange={(e) => setFrpToken(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-4">
          <span className="text-xs text-muted-foreground">
            {frp?.installed ? "" : "需安装 frpc"}{(frp?.instancesExposed?.length ?? 0) > 0 ? " · 公网暴露 " + frp?.instancesExposed?.length + " 个实例" : " · 无公网暴露实例"}
          </span>
          <div className="flex items-center gap-2">
            <Button disabled={busy === "frp-inst"} onClick={() => void run("frp-inst", () => supervisorApi.frpInstall(), { success: "frpc 安装完成" })} variant="outline"><Wrench className="size-4" />安装 frpc</Button>
            <Button disabled={busy === "frp-save"} onClick={() => void saveFrp()}><Save className="size-4" />保存并应用</Button>
          </div>
        </div>
        {frp?.logTail?.length ? (
          <pre className="mx-5 mb-4 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">{frp.logTail.join("\n")}</pre>
        ) : null}
      </Card>
      </div>

    </div>
  );
}
