/**
 * ============================================================================
 * supervisor 宿主 — 领域类型（对齐 dsh-supervisor HTTP API 实契约）
 * ============================================================================
 * 来源：src/presentation/api.js 全路由 + ui/（core.js / views-* / app.js）消费字段 + 线上抽样。
 * 只放纯数据类型，不含任何实现。
 * ============================================================================
 */

// ── /status ──────────────────────────────────────────────
export type DshPhase =
  | "RUNNING" | "STOPPED" | "STARTING" | "RESTARTING"
  | "BACKOFF" | "OBSERVED" | string;

export type NativeInstallState =
  | "uninstalled" | "installing" | "installed" | "uninstalling" | string;

export interface NativeDshStatus {
  installed: boolean;
  version?: string | null;
  binPath?: string | null;
  executable?: boolean;
  state?: NativeInstallState;
  installLog?: string[];
  lastInstall?: { version?: string; error?: string } | null;
  lastUninstall?: unknown;
  task?: unknown;
}

export interface DshVersionInfo {
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  lastCheckAt?: string | null;
  checking?: boolean;
  error?: string | null;
}

export type UpgradeStateName = "idle" | "running" | "done" | "failed" | "rolling_back" | string;
export interface UpgradeState {
  state: UpgradeStateName;
  step?: string | null;
  targetVersion?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  rolledBack?: boolean;
  logTail?: string[];
}

export interface SupervisorStatus {
  desired?: "running" | "stopped";
  phase?: DshPhase;
  guardVersion?: string;
  dshPid?: number | null;
  dshPort?: number | null;
  adopted?: boolean;
  guardPid?: number;
  lastProbeAt?: string | null;
  lastProbeOk?: boolean;
  restartCount?: number;
  backoffLevel?: number;
  backoffUntil?: string | null;
  lastFailure?: string | null;
  upgradeHold?: boolean;
  commandMissing?: boolean;
  dshTokenCaptured?: boolean;
  native?: NativeDshStatus;
  version?: DshVersionInfo;
  upgrade?: UpgradeState;
  tasks?: unknown[];
  updatedAt?: string;
}

// ── /events ──────────────────────────────────────────────
export interface SupervisorEvent {
  seq?: number;
  type: string;
  ts: string;
  data?: {
    reason?: string;
    message?: string;
    pid?: number;
    desired?: string;
    model?: string;
    tokens?: number;
    key?: string;
    provider?: string;
    port?: number;
    version?: string;
    [k: string]: unknown;
  } | null;
}
export interface EventsPage { seq: number; events: SupervisorEvent[]; }

// ── /ports（端口注册表：对接后端的全部已注册端口）──
export interface PortRecord {
  port: number;
  role: string;
  owner: string;
  createdAt: number;
  /** 端口当前真实激活状态：正在监听=true（激活）；未监听=false（停用） */
  active?: boolean;
}
export interface PortsResponse { records?: PortRecord[]; }


// ── /instances ──────────────────────────────────────────
export type InstanceDomain = "native" | "sandbox";
export interface InstanceSandbox { privateTmp?: boolean; protectHome?: boolean; memoryMax?: string; cpuQuota?: string; }
export interface InstanceState {
  pid?: number | null;
  running: boolean;
  isDsh?: boolean;
  phase?: string;
  lifecyclePhase?: "STARTING" | "RUNNING" | "INSTALLING" | "BACKOFF" | "FAILED" | "STOPPED" | string;
  lastError?: string | null;
  /** 稳定性统计（与原生主卡一致，后端投影）：重启次数 / 最近故障原因 */
  restartCount?: number;
  lastFailure?: string | null;
  installing?: boolean;
  installOk?: boolean;
  installError?: string | null;
  installLog?: string[];
}
export interface InstanceUpdateJob {
  state: string;
  step?: string | null;
  errors?: number;
  error?: string | null;
}
export interface SupervisorInstance {
  id: string;
  name: string;
  port: number;
  domain: InstanceDomain;
  kind?: string;
  guardian: boolean;
  remoteEnabled?: boolean;
  unitName?: string;
  sandbox?: InstanceSandbox;
  version?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  updateJob?: InstanceUpdateJob | null;
  state?: InstanceState;
  authUrl?: string;
  lanUrl?: string | null;
  lanRunning?: boolean;
}
/** /instances 响应（概念清分）：instances[] 仅沙箱（管理对象）；native 为原生主干 main 的只读条目
 *  （横切视图如远程控制取用；其生命周期/升级不属沙箱 API——启停走 /lifecycle/dsh/*，安装/升级走 /native/*）。 */
export interface InstancesResponse {
  instances: SupervisorInstance[];
  native?: SupervisorInstance | null;
}

// ── /lan-access + /lan/frp ──────────────────────────────
export interface LanItem {
  id: string;
  name?: string;
  dshPort: number;
  wanPort?: number;
  token?: string;
  dshToken?: string;
  enabled: boolean;
  localPort?: number;
  running: boolean;
  /** 注入状态（后端白名单下发，不含任何令牌明文）：tokenSet/cookieReady + 最近成败。 */
  inject?: {
    tokenSet?: boolean;
    cookieReady?: boolean;
    lastOkAt?: number | null;
    lastError?: string | null;
    lastErrorAt?: number | null;
  } | null;
}
export interface LanAccessResponse { items: LanItem[]; addresses: string[]; }
export interface FrpSettings { enabled?: boolean; serverAddr: string; serverPort: number; authToken: string; user?: string; }
export interface FrpStatus {
  installed: boolean;
  running: boolean;
  pid?: number | null;
  settings: FrpSettings;
  logTail?: string[];
  instancesExposed?: Array<{ id?: string; name?: string; wanPort?: number; remotePort?: number }>;
}

// ── router ──────────────────────────────────────────────
export type ProviderKind = "direct" | "proxy";
export type AccountStatus =
  | "registering" | "review" | "frozen" | "banned" | "discarded" | "ready" | "normal" | string;
export interface QuotaWindow {
  status?: string;
  percent?: number;
  resetsAt?: string | number;
}
export interface AccountQuota {
  rolling?: QuotaWindow;
  weekly?: QuotaWindow;
  monthly?: QuotaWindow;
  monthlyRemaining?: number;
  /** 月额度随订阅续期重置时刻（epoch ms；Command /alpha/billing/subscriptions currentPeriodEnd 真实采样 2026-09）。 */
  monthlyResetAt?: number | null;
  /** Command /alpha/billing/credits 原体透传（真实采样 2026-09-04）：belowThreshold/creditThreshold 为上游低余额提醒 */
  credits?: {
    monthlyCredits?: number | null;
    purchasedCredits?: number | null;
    freeCredits?: number | null;
    belowThreshold?: boolean;
    creditThreshold?: number | null;
  } | null;
}
export interface ProviderAccount {
  keyId: string;
  maskedKey: string;
  status: AccountStatus;
  instanceStatus?: string;
  quota?: AccountQuota;
  quotaStatus?: string;
  usable?: boolean;
  /** 当前在用（= 显式锁定 或 自动在用 activeAccount）；账号行高亮依据 */
  selected?: boolean;
  /** 用户显式锁定（持久化 selectedAccountKeyId 指向本账号；区别于自动在用的 selected） */
  locked?: boolean;
  healthy?: boolean;
  requests?: number;
  totalTokens?: number;
  version?: string | null;
  updateAvailable?: boolean;
  registeredAt?: number;
  detectError?: string | null;
  nextResetAt?: number | null;
  /** 受限原因与恢复方式（window=到点恢复 / credits=充值后轮询恢复 / banned=人工复核） */
  limit?: {
    kind?: "window" | "credits" | "banned";
    since?: number;
    reason?: string | null;
    recovery?: { type?: "at" | "poll" | "manual"; at?: number | null; periodMs?: number | null } | null;
  } | null;
}
export interface RouterProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  proxyAppId?: string | null;
  activated?: boolean;
  active?: boolean;
  exhausted?: boolean;
  apiPort?: number;
  apiBase?: string;
  accounts?: ProviderAccount[];
  /** 持久化显式锁定账号（null=未手动锁，路由自动在用） */
  selectedAccountKeyId?: string | null;
  /** 显式锁定标志（区分自动在用） */
  locked?: boolean;
  /** 当前在用/锁定账号 keyId（列表/头部同源锚点） */
  activeKeyId?: string | null;
}
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl?: string;
  plan?: { per5hUsd?: number; weeklyUsd?: number; monthlyUsd?: number } | null;
  adapter?: unknown;
  pricing?: unknown;
  note?: string;
}
export interface ProxyAppInfo {
  id: string;
  name: string;
  registry?: unknown;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
}
export interface RouterStatus {
  running: boolean;
  autostart?: boolean;
  conflict?: boolean;
  activatedProviders?: number;
  usage: {
    requests: number;
    errors: number;
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number | null;
  };
  providers?: RouterProvider[];
}
export interface ProvidersResponse {
  presets?: ProviderPreset[];
  providers?: RouterProvider[];
  proxyApps?: ProxyAppInfo[];
}
// ── /tasks ──────────────────────────────────────────────
export type TaskKind = "native" | "instance" | "plugin" | "proxy-app";
export type TaskAction = "install" | "upgrade" | "uninstall" | "update";
export type TaskState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled" | string;
export interface TaskStep { name: string; state: string; ts?: number; }
export interface TaskRecord {
  id: string;
  kind: TaskKind;
  action: TaskAction;
  target: { id?: string; name: string };
  from?: string | null;
  to?: string | null;
  state: TaskState;
  error?: string | null;
  steps?: TaskStep[];
  logTail?: string[];
  startedAt?: number;
  finishedAt?: number | null;
  createdBy?: string;
  meta?: Record<string, unknown>;
}
export interface TasksResponse { tasks: TaskRecord[]; current?: unknown; }

// ── plugins ─────────────────────────────────────────────
export type PluginSource = "npm" | "github" | "community" | "official";
export interface MarketPlugin {
  name: string;
  description?: string;
  source: PluginSource;
  category: string;
  version?: string;
  stars?: number;
  author?: string;
}
export interface MarketResponse {
  plugins: MarketPlugin[];
  indexedAt?: string;
  sources?: { npm?: number; github?: number; community?: number; official?: number };
}
export interface PluginTargetInfo { id: string; name: string; kind: string; }
export interface InstalledPlugin {
  name: string;
  version?: string;
  bundle?: boolean;
  source?: string;
  description?: string;
  enabled?: boolean;
  targets?: string[];
  targetNames?: string[];
  /** 插件目录体积（字节，后端统计首目标安装目录） */
  size?: number;
}
export interface InstalledPluginsResponse {
  ok?: boolean;
  inventoryReachable?: boolean;
  profile?: string;
  targets?: PluginTargetInfo[];
  rows?: unknown[];
  thirdParty?: InstalledPlugin[];
  builtinBundles?: Array<{ name: string; readonly?: boolean }>;
  installationOwned?: string[];
}
export interface PluginUpdatesResponse {
  plugins?: Array<{ name: string; updateAvailable?: boolean; targets?: Array<{ name: string; updateAvailable?: boolean; latest?: string }> }>;
  checkedAt?: string;
}
// ── settings / env / guard / registry / self-update ─────
export interface AutostartStatus { on: boolean; unit?: string; gui?: boolean; }
export interface LanPanelStatus { enabled: boolean; host?: string; port?: number; urls?: string[]; }
export interface AccessKeyStatus { configured: boolean; host?: string; }
export type CloseAction = "hide" | "exit";
export interface CloseActionStatus { closeAction: CloseAction; }
export interface AccessKeyResult extends AccessKeyStatus { ok: boolean; error?: string; }
export interface RegistryInfo {
  ok?: boolean;
  mode: "auto" | "manual";
  origin?: string;
  manual?: boolean;
  manualOrigin?: string;
  candidates?: Array<{ origin: string }>;
  presets?: Array<{ label: string; origin: string }>;
  latencyMs?: number;
  checkedAt?: number;
  probes?: Array<{ origin: string; ok: boolean; latencyMs: number }>;
}
export interface SelfUpdateStatus {
  ok: boolean;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  error?: string | null;
  restartRequired?: boolean;
}
export interface GuardVersion { version?: string; commit?: string; latest?: string; updateAvailable?: boolean; upstream?: string; }
export interface EnvStatus {
  node?: { detected?: string; runtime?: string | null; path?: string | null };
  npm?: { detected?: string };
  git?: { detected?: string };
  ok?: boolean;
  catalog?: { ready?: boolean; items?: Record<string, { label: string; required?: boolean; state: string; detail?: string }> };
}
/** Node.js 环境检测：当前版本 vs 官方最新 LTS（GET /env/node-lts） */
export interface NodeLtsStatus {
  ok: boolean;
  /** 当前系统 Node 版本（去 v 前缀，如 26.7.0） */
  current?: string | null;
  /** 官方最新 LTS 版本（如 24.20.0）；探测失败时为 null */
  latestLts?: string | null;
  /** LTS 代号（如 Krypton） */
  ltsName?: string | null;
  /** 当前版本 < 最新 LTS 时为 true */
  updateAvailable?: boolean;
  checkedAt?: string;
  error?: string | null;
}

export interface GenericOk { ok?: boolean; error?: string | null; [k: string]: unknown; }

// ── /lifecycle（2026-09 归一化：统一生命周期 API）────────────────────────────
export type LifecycleModuleId = "dsh" | "router" | "lan" | "instances" | "plugins";
export interface LifecycleModuleState {
  id: string;
  kind?: string;
  name?: string;
  phase: string;
  desired: string;
  healthy?: boolean;
  guardian?: boolean;
  monitoring?: boolean;
  error?: string | null;
  startedAt?: string | null;
  restartCount?: number;
  detail?: unknown;
}

