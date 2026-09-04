/**
 * 设置（supervisor settings）— 启动/局域网/版本与环境/镜像源
 * 与 skiff 清理 App 的 SettingsPage（语言/AI）是不同域：此为 dsh-supervisor 管家设置。
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Switch } from "../../framework/ui";
import { Input } from "../../framework/ui/input";
import {
  supervisorApi, type AccessKeyStatus, type EnvStatus, type RegistryInfo,
} from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { Card, CardTitle, Pill } from "./widgets";
import { cn } from "../../framework/utils";

/** 开关行（label 语义由调用处给 title；渲染用框架统一 Switch） */
function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className={cn("inline-flex items-center", disabled && "pointer-events-none opacity-50")} title={label}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </span>
  );
}

export function SettingsPage() {
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  const [lanOn, setLanOn] = useState<boolean | null>(null);
  const [ak, setAk] = useState<AccessKeyStatus | null>(null);
  const [akInput, setAkInput] = useState("");
  const [guardVer, setGuardVer] = useState<string>("—");
  const [su, setSu] = useState<{ ok: boolean; installed?: string; latest?: string; updateAvailable?: boolean; error?: string | null } | null>(null);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [reg, setReg] = useState<RegistryInfo | null>(null);
  const { busy, run } = useSupervisorAction();

  const load = useCallback(async () => {
    const [a, l, k, g, s, e, r] = await Promise.all([
      supervisorApi.autostart().catch(() => null),
      supervisorApi.lanPanel().catch(() => null),
      supervisorApi.accessKey().catch(() => null),
      supervisorApi.guardVersion().catch(() => null),
      supervisorApi.selfUpdateStatus().catch(() => null),
      supervisorApi.envStatus().catch(() => null),
      supervisorApi.registry().catch(() => null),
    ]);
    if (a) setAutoOn(a.on);
    if (l) setLanOn(l.enabled);
    if (k) setAk(k);
    if (g) setGuardVer(g.version || "—");
    setSu(s);
    setEnv(e);
    setReg(r);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggleAuto(v: boolean) {
    setAutoOn(v);
    try {
      const r = await supervisorApi.setAutostart(v);
      if (r.ok === false) { toast.error(r.error || "设置失败"); setAutoOn(!v); }
      else toast.success(v ? "已开启开机自启（整条服务链）" : "已关闭开机自启");
    } catch (e) { toast.error(String(e)); setAutoOn(!v); }
  }
  async function toggleLan(v: boolean) {
    setLanOn(v);
    try {
      const r = await supervisorApi.setLanPanel(v);
      if (r.ok === false) { toast.error(r.error || "设置失败"); setLanOn(!v); return; }
      toast.success(v ? "已开启局域网访问（0.0.0.0）" : "已关闭局域网访问（仅本机）");
    } catch (e) { toast.error(String(e)); setLanOn(!v); }
  }
  async function saveAccessKey() {
    const key = akInput.trim();
    if (key && key.length < 8) { toast.error("访问密钥至少 8 位（建议 16+ 位随机串）"); return; }
    await run("akk", () => supervisorApi.setAccessKey(key), {
      success: key ? "访问密钥已设置（出回环通道需携带）" : "访问密钥已清除（仅回环可访问）",
      refresh: false,
      onDone: () => { setAkInput(""); void load(); },
    });
  }
  const checkGuard = async () => {
    await run("gchk", async () => {
      const g = await supervisorApi.guardVersionCheck();
      if (g.updateAvailable) toast.success("检测到管家新版本 " + g.latest);
      else toast.success("管家已是最新（" + (g.version || "—") + "）");
      const lv = await supervisorApi.guardVersion();
      setGuardVer(lv.version || "—");
    });
  };
  const applySelfUpdate = async () => {
    await run("su", async () => {
      const r = await supervisorApi.selfUpdateApply();
      if (r.ok) toast.success("已更新到 v" + r.installed + (r.restartRequired ? "，重启守卫生效" : ""));
      else toast.error(r.error || "应用失败");
    }, { refresh: false, onDone: () => void load() });
  };

  // 镜像源编辑器
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [manualOrigin, setManualOrigin] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  useEffect(() => {
    if (!reg) return;
    setMode(reg.mode || "auto");
    setCandidates((reg.candidates ?? []).map((c) => c.origin));
    setManualOrigin(reg.manualOrigin || "");
  }, [reg]);
  const addCandidate = () => {
    const v = newOrigin.trim();
    if (!/^https?:\/\//.test(v)) { toast.error("请输入合法的镜像 URL"); return; }
    if (candidates.includes(v)) { toast.info("已在列表中"); return; }
    setCandidates((c) => [...c, v]); setNewOrigin("");
  };
  async function saveReg() {
    const body: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string } = { mode, origins: candidates };
    if (mode === "manual") {
      if (!/^https?:\/\//.test(manualOrigin.trim())) { toast.error("手动模式需提供合法镜像 URL"); return; }
      body.manualOrigin = manualOrigin.trim();
    }
    await run("reg", () => supervisorApi.registrySet(body), { success: "已保存镜像配置", refresh: false, onDone: () => void load() });
  }
  async function refreshReg() {
    await run("regr", () => supervisorApi.registryRefresh(), { success: "已探测镜像", refresh: false, onDone: () => void load() });
  }

  const envItems = env?.catalog?.items;
  return (
    <div className="grid content-start gap-4">
      {/* 启动 */}
      <Card>
        <CardTitle title="启动" subtitle="开机行为与偏好" />
        <div className="grid gap-4 px-5 py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">开机自动启动管家</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">开机登录后自动启动 DeepSeek Harness 管家（本程序）。不会自动启动任何单个实例——实例是否被自动拉起，由各自「进程守护」开关决定。</p>
            </div>
            {autoOn !== null ? <Toggle checked={autoOn} onChange={(v) => void toggleAuto(v)} label="开机自启" /> : <span className="text-xs text-muted-foreground">…</span>}
          </div>
        </div>
      </Card>

      {/* 访问 */}
      <Card>
        <CardTitle title="访问" />
        <div className="grid gap-4 px-5 py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">管家局域网访问</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">开启后，局域网内设备可通过 http://&lt;本机IP&gt;:3100 访问本面板与 API（仅限局域网/本机主机名）；关闭后仅本机 127.0.0.1 可访问。</p>
            </div>
            {lanOn !== null ? <Toggle checked={lanOn} onChange={(v) => void toggleLan(v)} label="局域网访问" /> : <span className="text-xs text-muted-foreground">…</span>}
          </div>

          <div className="flex items-start justify-between gap-6 border-t border-border/60 pt-4">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">出回环访问密钥（apiAccessKey）</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                设置后，局域网 / 公网通道（0.0.0.0 或 FRP 暴露）访问本 API 必须携带
                <code className="mx-1 font-mono">Authorization: Bearer &lt;key&gt;</code>或
                <code className="mx-1 font-mono">?access_key=&lt;key&gt;</code>，否则 401；
                本机回环（127.0.0.1）请求不受影响。留空保存 = 清除密钥。
                {ak?.configured ? <span className="mt-1 block text-status-ok">当前：已设置（未回显明文）</span> : <span className="mt-1 block text-muted-foreground">当前：未设置（仅受局域网白名单约束）</span>}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              type="password" autoComplete="new-password" placeholder="输入 ≥8 位访问密钥（建议随机长串）"
              value={akInput} onChange={(e) => setAkInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveAccessKey(); }}
              className="flex-1"
            />
            <Button variant="outline" onClick={() => setAkInput("")} disabled={!akInput && !ak?.configured}>清除</Button>
            <Button disabled={busy === "akk"} onClick={() => void saveAccessKey()}>
              {ak?.configured ? "更新密钥" : "设置密钥"}
            </Button>
          </div>
        </div>
      </Card>

      {/* 版本与环境 */}
      <Card>
        <CardTitle
          title="版本与环境"
          subtitle="管家自身版本/更新与运行环境"
          actions={
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === "gchk"} onClick={() => void checkGuard()} variant="outline">检测更新</Button>
              {su?.ok && su.updateAvailable ? (
                <Button size="sm" disabled={busy === "su"} onClick={() => void applySelfUpdate()}>应用更新</Button>
              ) : null}
            </div>
          }
        />
        <div className="grid gap-3 px-5 py-4">
          <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3">
            <span className="text-xs text-muted-foreground">管家当前版本</span>
            <strong className="font-mono text-sm text-foreground">{guardVer}</strong>
          </div>
          {su ? (
            <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3">
              <span className="text-xs text-muted-foreground">守卫自更新</span>
              <span className="text-sm text-foreground">
                {su.ok ? (<>当前 v{su.installed}{su.updateAvailable ? <Pill tone="warn" className="ml-2">可更新 v{su.latest}</Pill> : <Pill tone="ok" className="ml-2">已是最新</Pill>}</>) : <span className="text-muted-foreground">{su.error || "未配置自更新源"}</span>}
              </span>
            </div>
          ) : null}
          {envItems ? (
            <div className="mt-1 grid gap-2 border-t border-border/60 pt-3">
              {Object.entries(envItems).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3">
                  <span className="text-xs text-muted-foreground">{v.label}</span>
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <Pill tone={v.state === "ok" ? "ok" : v.state === "unconfigured" ? "off" : "warn"}>{v.state}</Pill>
                    <span className="truncate text-xs text-muted-foreground">{v.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      {/* 镜像源 */}
      <Card>
        <CardTitle title="镜像源" subtitle="DSH 升级与反代应用的更新检测 / npx 安装会共用这套镜像源，自动探测可达且延迟最低的镜像，也可手动固定。此配置全局生效。" />
        <div className="grid gap-3 px-5 py-4">
          <div className="flex gap-3">
            {(["auto", "manual"] as const).map((m) => (
              <label key={m} className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
                <input type="radio" className="accent-primary" checked={mode === m} onChange={() => setMode(m)} />
                {m === "auto" ? "自动（按延迟选最快）" : "手动（固定指定）"}
              </label>
            ))}
          </div>
          {mode === "manual" ? (
            <div className="grid gap-1.5">
              <div className="flex gap-2">
                <Input placeholder="https://registry.npmmirror.com" value={manualOrigin} onChange={(e) => setManualOrigin(e.target.value)} className="flex-1" />
                <Button variant="outline" onClick={() => void testLatency(manualOrigin)}>测试</Button>
              </div>
            </div>
          ) : null}
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">候选镜像列表：</span>
            <div className="max-h-[180px] overflow-auto rounded-md border border-border/70">
              {candidates.map((o, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {reg?.origin === o ? <Pill tone="ok">当前</Pill> : null}
                    <code className="truncate font-mono text-xs text-muted-foreground">{o}</code>
                  </div>
                  <Button size="chip" variant="ghost" onClick={() => setCandidates((c) => c.filter((x) => x !== o))}><Trash2 className="size-3.5 text-destructive" /></Button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Input placeholder="https://… 添加自定义镜像" value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }} />
            <Button variant="outline" onClick={addCandidate}><Plus className="size-4" />添加</Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="w-full text-xs text-muted-foreground">常用预设：</span>
            {(reg?.presets ?? []).map((p) => (
              <Button key={p.origin} size="chip" variant="outline" className="text-muted-foreground hover:bg-muted hover:text-foreground"
                disabled={candidates.includes(p.origin)} onClick={() => setCandidates((c) => [...c, p.origin])} type="button">
                {p.label}{candidates.includes(p.origin) ? <Check className="ml-1 size-3 text-success" /> : null}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {reg?.origin ? <>当前使用: <code className="font-mono">{reg.origin}</code>{reg.manual ? "（手动固定）" : "（自动）"}</> : null}
              {reg?.latencyMs ? <span className="ml-2">延迟 {reg.latencyMs}ms</span> : null}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === "regr"} onClick={() => void refreshReg()} variant="outline"><RefreshCw className={cn("size-3.5", busy === "regr" && "animate-spin")} />重新探测</Button>
              <Button disabled={busy === "reg"} onClick={() => void saveReg()}>保存</Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** 测试手动镜像可达性（直连 fetch，不改配置） */
async function testLatency(url: string) {
  if (!/^https?:\/\//.test(url)) { toast.error("请输入合法镜像 URL"); return; }
  toast.info("测试中…");
  try {
    const start = Date.now();
    const res = await fetch(url.replace(/\/+$/, "") + "/-/ping", { signal: AbortSignal.timeout(4000) });
    const ms = Date.now() - start;
    if (res.ok) toast.success("可达，延迟 " + ms + " ms");
    else toast.error("不可达");
  } catch { toast.error("探测失败"); }
}

