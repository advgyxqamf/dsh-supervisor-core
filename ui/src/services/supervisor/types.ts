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

// 会话生命周期（契约 §3）：与 phase 正交——phase 是 main 状态机相位，
// sessionState 是整个服务链的运行相位（退出中/已退出）。
export type SessionState = "starting" | "running" | "stopping" | "stopped" | "failed" | string;

export interface SupervisorStatus {
  desired?: "running" | "stopped";
  phase?: DshPhase;
  sessionState?: SessionState;
  guardVersion?: string;
  /** 安装标识（UUID v4）：灰度名单的匹配依据，面板底部外显供用户申请灰度（契约 §5.2）。 */
  installId?: string | null;
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
  /** 用户「退出管家」持久标记：退出后守卫重启不得凭看护把壳拉回（2026-09-18）。 */
  shellHalted?: boolean;
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
  owner: string | null;
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
  /** 后端实例装饰（src/api/instances.js:31）：loopback 时为 true；UI 未直读，属后端返回契约。 */
  tokenPresent?: boolean;
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
  /** 公网暴露（frp）：由 /lan/frp/expose 驱动；remotePort 为 frps 侧端口。 */
  frpEnabled?: boolean;
  frpRemotePort?: number | null;
  /** 访问令牌是否已设（布尔，后端不下发明文）——公网暴露的安全前置。 */
  tokenSet?: boolean;
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
  | "registering" | "frozen" | "banned" | "discarded" | "ready" | "normal" | string;
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
  // conflict?: boolean —— 已移除（后端从不产出，死字段；2026-09 审计）
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
// 插件任务进度（后端 /plugins/install-status?job= 派生自 TaskRegistry；前端轮询到 done/failed）
export type JobState = "running" | "done" | "failed";
export interface PluginJobStatus {
  id?: string;
  kind?: string;
  name?: string;
  target?: string;
  state?: JobState;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
  targets?: Array<{ name?: string; ok?: boolean; error?: string | null }>;
  error_?: never;
}
// 反代更新任务进度（/router/proxy/update/status；steps 逐实例，支持多实例依次更新可视化）
export interface ProxyUpdateStatus {
  state?: JobState;
  restarted?: number;
  errors?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  steps?: Array<{ name: string; state: string }>;
  taskId?: string;
  error?: string;
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
// ── 桌面壳（Tauri 壳）版本与更新 ──────────────────────────────
// 产品语义（2026-09-11）：关于卡需同时呈现「桌面壳版本」与「内核版本」，
// 且「检查更新」要对两者一起检测。壳版本来自壳启动时写入的 identity.json（经 /shell/status）。
export interface ShellIdentity {
  version?: string;
  platform?: string;
  arch?: string;
  /** 运行时安装形态：deb / rpm / appimage / msi / nsis / app */
  installKind?: string;
  /** 是否具备自更新能力（形态受支持且有提权通道） */
  selfUpdateCapable?: boolean;
  attempt?: number;
  phase?: string;
  pinned?: string[];
}
export interface ShellStatus {
  ok?: boolean;
  identity?: ShellIdentity | null;
  journal?: { to?: string | null; confirmed?: boolean; rolledBack?: boolean; pinnedVersions?: string[] } | null;
  state?: string;
  reason?: string | null;
  pinned?: string[];
  dir?: string;
}
export interface ShellUpdateCheck {
  ok: boolean;
  installed?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  error?: string | null;
}
// 平台能力矩阵（A1 接线）：三平台静态档位 × 实际工具探测；UI 据此灰化/提示不支持项。
export interface PlatformCapabilities {
  platform?: string;
  arch?: string;
  /** 多实例（沙箱）支持——仅 Linux + systemd-run */
  multiInstance?: boolean;
  /** 接管既有进程（端口/命令行反查） */
  pidAdoption?: boolean;
  /** 进程树终止（POSIX 组信号 / Windows taskkill /T） */
  processTreeKill?: boolean;
  /** 桌面通知（notify-send / osascript / powershell 气泡） */
  desktopNotify?: boolean;
  /** 开机自启（systemd --user + linger / LaunchAgent / schtasks） */
  autostart?: boolean;
  /** 公网暴露（frpc） */
  frpExpose?: boolean;
  /** 宿主服务形态 */
  hostService?: string;
}
export interface EnvStatus {
  node?: { detected?: string; runtime?: string | null; path?: string | null };
  npm?: { detected?: string };
  git?: { detected?: string };
  ok?: boolean;
  catalog?: { ready?: boolean; items?: Record<string, { label: string; required?: boolean; state: string; detail?: string }> };
  capabilities?: PlatformCapabilities | null;
  /** 桌面壳看护的观测快照（P2 接线 2026-09-12）：壳反复拉起失败时面板可见。 */
  shellWatchdog?: {
    enabled?: boolean;
    intervalMs?: number;
    graceMs?: number;
    updateGraceMs?: number;
    maxRestarts?: number;
    absentForMs?: number | null;
    restartsInWindow?: number;
    everSawAlive?: boolean;
    lastSkipReason?: string | null;
    expectedAbsence?: boolean;
  } | null;
}
/** Node.js 环境检测（GET /env/node-lts）。
 *
 *  ⚠ 2026-09-13 修正契约（此前声明了后端**从不产出**的字段）：
 *    旧声明含 latestLts / ltsName / updateAvailable，而内核
 *    `guard/supervisor/settings-view.js::nodeLtsStatus()` **明确不做远端查询**
 *    （避免守卫启动依赖网络），实返只有 { ok, current, major, ltsLine, suggested,
 *    fetchedAt, cached }。于是前端那两个分支恒不可达、类型声明与实现分叉。
 *    现按真实返回对齐。若产品确需「官方最新 LTS」，应另开端点或改走壳 env_status 契约。 */
export interface NodeLtsStatus {
  ok: boolean;
  /** 当前系统 Node 版本（如 26.7.0） */
  current?: string | null;
  /** 当前主版本号 */
  major?: number | null;
  /** 当前主版本是否为偶数（本地保守判定「通常为 LTS 线」，非远端断言） */
  ltsLine?: boolean | null;
  /** 后端生成的展示建议（含是否 LTS 线的说明） */
  suggested?: string | null;
  /** 本次探测时刻（ms） */
  fetchedAt?: number | null;
  /** 是否命中 6h 磁盘缓存 */
  cached?: boolean;
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
  // 无 restartCount：它是「用户意图被守护触发了几次」的语义（域 A），
  //   而本接口描述的是托管生命周期项的视图；域 A 计数在别处
  //   （/status 的 restartCount = dsh；instance.state.restartCount = 沙箱）。
  detail?: unknown;
}

