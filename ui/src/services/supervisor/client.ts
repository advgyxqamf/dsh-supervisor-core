/**
 * ============================================================================
 * supervisor HTTP API 客户端（同源 fetch，生产由 dsh-supervisor :3100 托管）
 * ============================================================================
 * - 唯一允许直接 fetch 的模块（页面通过 services 层间接使用）
 * - GET 纯读；写操作方法名后缀 Post/Action 显式标注
 * - 错误统一 throw Error（含后端 error/message）
 * - 生产同源（/…），开发跨端口用 vite proxy 转发（去掉 Origin 走回环）
 * ============================================================================
 */
import type {
  AccessKeyResult, AccessKeyStatus, AutostartStatus, CloseActionStatus, EnvStatus, EventsPage, FrpStatus, GenericOk,
  GuardVersion, InstancesResponse, InstalledPluginsResponse, LanAccessResponse,
  LanPanelStatus, LifecycleModuleId, LifecycleModuleState, MarketResponse, NodeLtsStatus, PluginUpdatesResponse,
  PortsResponse, ProvidersResponse, RegistryInfo, RouterStatus,
  SelfUpdateStatus, SupervisorInstance, SupervisorStatus, TasksResponse,
} from "./types";

// API 根（分体架构 + 动态端口 2026-09-07 定稿）：面板始终由守卫内核 HTTP 同源托管
// （壳 go_panel 按 config.apiPort 动态给 URL，页面与守卫 API 同源直连，无硬编码端口/无透传）。
const BASE = "";

/** 默认请求超时（R2 修复）：此前全部 fetch 无超时/无取消，后端挂起时按钮永久 busy。
 *  轮询 read 与本地写操作均应在该窗口内完成；慢网下由轮询层 in-flight 守卫兜底。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 长耗时端点的超时覆盖（如 proxyLoginWait 本身就是服务端轮询等待，需留足等待窗口） */
export const LONG_TIMEOUT_MS = 210_000;

export interface HttpOptions { timeoutMs?: number; }

/** AbortController 计时器：超时即 abort 并附可读错误；finally 里 clear 防泄漏 */
function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(new DOMException("请求超时", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(id) };
}

/** 统一错误提取：后端约定 {error|message}，缺省 HTTP 状态 */
async function http<T>(method: string, path: string, body?: unknown, opts?: HttpOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 同源/壳内直连 fetch（守卫托管同源或壳 asset 源走 CORS 白名单）；统一浏览器 fetch 路径
  const { signal, clear } = withTimeout(timeoutMs);
  const init: RequestInit = { method, headers: {}, signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${path}`, { cause: e });
    }
    throw e;
  } finally {
    clear();
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 文本/空响应 */ }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new Error(d?.error || d?.message || `HTTP ${res.status} ${path}`);
  }
  return data as T;
}
const get = <T>(p: string, opts?: HttpOptions) => http<T>("GET", p, undefined, opts);
const post = <T>(p: string, body?: unknown, opts?: HttpOptions) => http<T>("POST", p, body ?? {}, opts);

/** 查询参数拼接 */
function qs(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? base + "?" + s : base;
}

export const supervisorApi = {
  // ── 运行态 ──
  status: () => get<SupervisorStatus>("/status"),
  events: (after = 0, limit = 60) => get<EventsPage>(qs("/events", { after, limit })),
  instances: () => get<InstancesResponse>("/instances"),
  lanAccess: () => get<LanAccessResponse>("/lan-access"),
  frp: () => get<FrpStatus>("/lan/frp"),
  routerStatus: () => get<RouterStatus>("/router/status"),
  providers: () => get<ProvidersResponse>("/router/providers"),
  tasks: () => get<TasksResponse>("/tasks"),
  ports: () => get<PortsResponse>("/ports"),
  // ── 统一生命周期（2026-09 归一化：模块启停/状态单一控制路径 /lifecycle/{id}/…，
  //    取代分散的 /start|/stop|/router/start|/router/stop —— 后端语义等价且 daemon 监督感知）──
  lifecycleStart: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/start"),
  lifecycleStop: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/stop"),
  lifecycleGet: (id: LifecycleModuleId) => get<LifecycleModuleState>("/lifecycle/" + id),

  // ── native DSH ──
  nativeCheckUpdate: () => post<GenericOk>("/native/check-update"),
  nativeInstall: () => post<GenericOk>("/native/install"),
  nativeUpgrade: (version?: string) => post<GenericOk>("/native/upgrade", version ? { version } : {}),
  nativeUninstall: () => post<GenericOk>("/native/uninstall"),
  // 原生主干(main)设置（概念清分：main 设置不走 /instances 沙箱域，统一 /native/settings）
  nativeSettings: (patch: { guardian?: boolean; remoteEnabled?: boolean; frpEnabled?: boolean; frpRemotePort?: number }) =>
    post<GenericOk & { main?: SupervisorInstance }>("/native/settings", patch),

  // ── instances ──
  instanceAdd: (p: { name: string; port: number; command?: string[]; memoryMax?: string; cpuQuota?: string }) =>
    post<GenericOk>("/instances/add", p),
  instanceUpdate: (id: string, patch: { guardian?: boolean; remoteEnabled?: boolean }) =>
    post<GenericOk>("/instances/update", { id, ...patch }),
  instanceRemove: (id: string) => post<GenericOk>("/instances/remove", { id }),
  instanceStart: (id: string) => post<GenericOk>("/instances/start", { id }),
  instanceStop: (id: string) => post<GenericOk>("/instances/stop", { id }),
  instanceOpenWeb: (id: string) => post<GenericOk & { url?: string }>("/instances/open-web", { id }),
  instanceCheckUpdate: (id: string) => post<GenericOk & { updateAvailable?: boolean; latest?: string; installed?: string }>("/instances/check-update", { id }),
  instanceUpgrade: (id: string) => post<GenericOk>("/instances/upgrade", { id }),

  // ── router（模块启停已并入 /lifecycle/router/…；下方为供应商/账号管理端点）──
  providerAdd: (p: { name?: string; presetId?: string; kind?: string; appId?: string; keys?: string[] }) =>
    post<GenericOk & { id?: string }>("/router/providers/add", p),
  providerRemove: (id: string) => post<GenericOk>("/router/providers/remove", { id }),
  providerActivate: (id: string) => post<GenericOk>("/router/providers/activate", { id }),
  providerDeactivate: (id: string) => post<GenericOk>("/router/providers/deactivate", { id }),
  providerRefresh: (id: string) => post<GenericOk>("/router/providers/refresh", { id }),
  providerKeysSet: (id: string, p: { removeMasked?: string[]; add?: string[] }) =>
    post<GenericOk & { added?: number; removed?: number }>("/router/providers/keys/set", { id, ...p }),
  providerKeyUse: (id: string, fingerprint: string) =>
    post<GenericOk & { active?: string }>("/router/providers/key/use", { id, fingerprint }),
  providerAccountConfirm: (id: string, keyId: string) => post<GenericOk>("/router/providers/account/confirm", { id, keyId }),
  providerAccountDiscard: (id: string, keyId: string) => post<GenericOk>("/router/providers/account/discard", { id, keyId }),
  proxyAddKey: (id: string, key: string) => post<GenericOk>("/router/providers/proxy/key", { id, key }),
  proxyRemoveKey: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/key/remove", { id, keyId }),
  proxySelect: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/select", { id, keyId }),
  proxyLoginStart: () => post<GenericOk & { authUrl?: string; waitMs?: number }>("/router/proxy/login/start"),
  // 服务端轮询等待（最长可 waitMs≈180s）：请求超时需覆盖等待窗口 + 网络余量
  proxyLoginWait: (timeoutMs: number) => post<GenericOk & { apiKey?: string }>("/router/proxy/login/wait", { timeoutMs }, { timeoutMs: Math.max(LONG_TIMEOUT_MS, timeoutMs + 30_000) }),
  proxyUpdateCheck: () => post<GenericOk>("/router/proxy/update/check"),
  proxyUpdateApply: (appId: string) => post<GenericOk>("/router/proxy/update/apply", { appId }),

  // ── plugins ──
  market: (force = false) => get<MarketResponse>("/plugins/market" + (force ? "?refresh=1" : "")),
  pluginsInstalled: () => get<InstalledPluginsResponse>("/plugins/installed"),
  pluginsCheckUpdates: (force = false) => get<PluginUpdatesResponse>("/plugins/check-updates" + (force ? "?refresh=1" : "")),
  pluginInstall: (spec: string, target: string) => post<GenericOk & { jobId?: string }>("/plugins/install", { spec, target }),
  pluginEnable: (name: string) => post<GenericOk>("/plugins/enable", { name, target: "all" }),
  pluginDisable: (name: string) => post<GenericOk>("/plugins/disable", { name, target: "all" }),
  pluginUpdate: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/update", { name, target: "all" }),
  pluginUninstall: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/uninstall", { name, target: "all" }),

  // ── lan / frp ──
  frpSettings: (s: { serverAddr: string; serverPort: number; authToken: string }) =>
    post<GenericOk>("/lan/frp/settings", s),
  frpInstall: () => post<GenericOk>("/lan/frp/install"),

  // ── settings / env / guard / registry ──
  autostart: () => get<AutostartStatus>("/autostart"),
  setAutostart: (enabled: boolean) => post<GenericOk>("/autostart", { enabled }),
  lanPanel: () => get<LanPanelStatus>("/settings/lan"),
  setLanPanel: (enabled: boolean) => post<GenericOk & LanPanelStatus>("/settings/lan", { enabled }),
  accessKey: () => get<AccessKeyStatus>("/settings/access-key"),
  setAccessKey: (key: string) => post<AccessKeyResult>("/settings/access-key", { key }),
  closeAction: () => get<CloseActionStatus>("/settings/close-action"),
  setCloseAction: (closeAction: "hide" | "exit") => post<GenericOk & CloseActionStatus>("/settings/close-action", { closeAction }),
  registry: () => get<RegistryInfo>("/dist/registry"),
  registrySet: (p: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string }) =>
    post<GenericOk & RegistryInfo>("/dist/registry/set", p),
  registryRefresh: () => post<GenericOk & RegistryInfo>("/dist/registry/refresh"),
  selfUpdateStatus: () => get<SelfUpdateStatus>("/self-update/status"),
  selfUpdateApply: () => post<SelfUpdateStatus>("/self-update/apply"),
  selfUpdateRestart: () => post<SelfUpdateStatus>("/self-update/restart-guard"),
  guardVersion: () => get<GuardVersion>("/guard/version"),
  guardVersionCheck: () => post<GuardVersion & { ok?: boolean }>("/guard/version/check"),
  envStatus: () => get<EnvStatus>("/env/status"),
  nodeLts: () => get<NodeLtsStatus>("/env/node-lts"),
};
