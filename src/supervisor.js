'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile, execFileSync } = require('node:child_process');
const pidlook = require('./platform/os/pidlookup');
const { DaemonLifecycle } = require('./guard/proc/daemon-lifecycle');
const { LineBuffer } = require('./platform/log'); // 行缓冲工具（LogCore 已统一采集：logger/events/dshWriter/hub 见构造 init）
const platform = require('./platform/os/index'); // 平台抽象层：通知/进程/pid反查/浏览器/自启（三端同能力）
const { RouterService } = require('./domains/router/index');
const { LanManager } = require('./domains/relay/manager');
const { TaskRegistry } = require('./platform/tasks');
const { InstanceManager } = require('./domains/instance/index');
const { PluginManager } = require('./domains/plugin/plugins');
const { DistributionManager, semverCompare } = require('./domains/dist/index');
const { normalize, extractPortFromCommand } = require('./platform/config');
const { EnvCatalog } = require('./platform/env-catalog');
function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  extra.selfUpdate = cat.selfUpdateEntry();
  return cat.summary(extra);
}
const { guardVersion } = require('./platform/version');
const { Lifecycle } = require('./guard/lifecycle/guard-self');
const { Health } = require('./guard/health');
const { HostService } = require('./guard/host-service');
const monitor = require('./guard/monitor/index');
const guardian = require('./guard/guardian/index');
const native = require('./guard/native/index');
const { DshTokenService } = require('./platform/token');
const { NativeManager } = require('./guard/native/manager');
const { LifecycleManager } = require('./guard/lifecycle/index');
const { ManagedRegistry } = require('./guard/lifecycle/objects');
const { IntentLedger } = require('./guard/intent');
const deploy = require('./platform/deploy');
const { registerAll } = require('./guard/lifecycle/adapters');
const ports = require('./guard/lifecycle/ports').shared;


/**
 * 核心状态机（controller 模式）：
 * 期望状态 desired(running|stopped) × 观测（进程存活 + HTTP 健康）→ 调和。
 * 状态：STOPPED / STARTING / RUNNING / RESTARTING / BACKOFF
 */
class Supervisor {
  constructor(rawConfig, configPath) {
    this.config = normalize(rawConfig);
    this.configPath = typeof configPath === 'string' ? configPath : null;
    this._mSetChild(null);
    this._mSetAdoptPid(null);     // 接管的既有实例 pid（非本守卫 spawn）
    this._mSetPhase('STOPPED');
    this._mSetDesired('running');
    this._mSetRestartCount(0);
    this._mSetCrashWindowStart(null);
    this._mSetCrashWindowRestarts(0);
    this._mSetBackoffLevel(0);
    this._mSetBackoffUntil(null);
    this._mSetRestartAt(null);      // RESTARTING 状态下最早可重启时刻
    this._mSetStartDeadline(null);  // STARTING 状态下启动门截止
    this._mSetFailStreak(0);
    this._mSetLastProbeAt(null);
    this._mSetLastProbeOk(null);
    this._mSetLastFailure(null);
    this._mSetLastRestartAt(null);
    this._mSetAdopted(false);       // 观测到健康但非本守卫 spawn（接管既有实例）
    this._mSetObservedOnly(false);  // 期望停止下的仅观测接管（不强杀不拉起）
    this._mSetSpawnBlockedUntil(null); // 命令缺失（ENOENT）后的冷静期
    this._mSetMissingNotified(false);
    this.manualRestart = false; // POST /restart 待消费
    this._ticking = false;
    // 显式意图登记簿（RC2）：用户/系统动作发生处 register，收敛循环 consume——
    // 取代旧 _explicitAction 时间窗布尔（漏消费竞态已根治）。词表见 guard/intent.js。
    this.intents = new IntentLedger();
    this._selfUpdateExpectedVersion = null; // 自更新预期版本（A3：重启后校验达标才报成功）
    this._stopping = false;
    this._upgradeHold = false;      // 升级"先停后装"期间暂停自动拉起
    this._upgradeHoldSince = null;  // 兜底自愈：hold 卡死超时自动释放
    this._timer = null;
    this._heartbeatBusy = false; // 唯一心跳慢拍防重叠（C3-3b G3：on 模式收敛并入心跳后必防并发）
    this._killTimer = null;
    this._adoptKillTimer = null;
    this._initialCheckTimer = null;
    this._upgradeTimer = null;
    this._lastOccupiedWarn = 0;
    // ── 瞬态字段统一构造初始化（RC2.2 契约）：任何实例字段的首次赋值必须发生在此处。
    // `_maybeReclaimAdoptToken` 曾因 `_tokenReclaimAt` 未初始化（undefined !== null）
    // 绕过观察窗，adopt 后首拍即重建 DSH（审计 P1-1）。──
    this._tokenReclaimAt = null;     // adopt 令牌观察窗截止时刻
    this._tokenReclaimTried = false; // 本次接管是否已受控重建（防循环）
    this._lastMainPortRederive = 0;  // 端口再推导节流
    this._lastOrphanAuditAt = 0;     // 游离对象自检节流
    this._lastOrphanKey = null;
    this._lastOrphanAt = 0;
    this._actWindow = false;         // 收敛窗口（影子记账）
    this._mainTickActs = null;
    this._portActivesCache = null;   // 端口激活探测缓存
    this._lastLanStateJson = null;   // lan-state 内容去重
    this._routerFacade = null;       // router ctl 门面缓存
    this._lc = null;                 // DaemonLifecycle 惰性单例表
    this._dshMainLive = null;        // dsh-main.json live 缓存
    this._fallbackEntry = null;      // 目录 fallback 项
    this._lastStateBody = null;
    // ── C3-3b G1：main(dsh) 影子对比框架（并行不驱动）──
    // 旧 tick 仍为唯一驱动；影子只「纯计算应然下一步」并对比实际迁移，零行为变化。
    // 连续零 diff 拍数/累计 diff 拍数供 G3 切换判定（日志/事件观测，不进任何决策）。
    this._shadowSeq = 0;
    this._shadowConsistentBeats = 0;
    this._shadowDiffBeats = 0;
    this._shadowLast = null;   // 最近一拍影子记录 {seq,phase,shadow,actual,diff}
    this._shadowLoggedSeq = 0; // 已记账的事件拍号（心跳聚合去重）
    // 系统日志框架（docs/LOGGING-SINGLETON-AUDIT.md S2）：守卫经每进程唯一 LogCore 取
    // logger/events/dshWriter/EventHub（单例 init；消灭散落 new Events/createLogger/Rotator/EventHub）。
    const logCore = require('./platform/logcore').init({
      process: 'guard',
      logFile: this.config.supervisorLogFile,
      eventFile: this.config.logFile,
      dshLogFile: this.config.dshLogFile,
      upgradeLogFile: this.config.upgradeLogFile,
      logLevel: this.config.logLevel,
      logMaxBytes: this.config.logMaxBytes,
      eventsMaxBytes: this.config.eventsMaxBytes,
      enableHub: true,
      stateDir: path.dirname(this.config.stateFile),
      aggBase: path.basename(this.config.stateFile || 'state.json', '.json'),
      ctlPorts: { router: Number(this.config.routerCtlPort) || 43107, lan: 43108 },
      daemonLogs: {
        router: path.join(path.dirname(this.config.stateFile), 'log', 'router-daemon.log'),
        lan: path.join(path.dirname(this.config.stateFile), 'log', 'lan-daemon.log'),
      },
    });
    this.events = logCore.events;
    this.logger = logCore.logger;
    this.dshWriter = logCore.dshWriter;
    this.eventHub = logCore.hub; // 守卫侧聚合（可能为 null：hub 初始化失败降级）
    // ── 唯一令牌节点：全系统 DSH 访问令牌的统一获取/存储/分发（原生与沙箱共用同一服务，
    //    区别只在“源”：spawn=stdout 推送 / systemd=journald 拉取）。任何目标的令牌变化统一
    //    经 onChange 下发消费方（远程控制 relay 热换 cookie），不再分散接线。──
    this.tokenService = new DshTokenService({ logger: this.logger, events: this.events });
    // main 统一守卫 spawn（2026-09-06 废弃 systemd 托管）；纯 stdout 源 + 本地原文恢复文件
    // （0600；守卫重启后 token.js 从文件尾恢复令牌→免重建 main 的会话中断，2026-09 修复）
    this.tokenService.attach('main', { file: path.join(path.dirname(this.config.stateFile), 'dsh-main-token.log') });
    this.tokenService.onChange((id, token) => {
      if (this.lanDaemonEnabled()) { try { this._syncLanState(); } catch {} return; }
      if (this.lan) { try { this.lan.applyToken(id, token); } catch (e) { this.logger.warn && this.logger.warn('lan applyToken(' + id + '): ' + e.message); } }
    });
    // OpenCode 中转：多账号 Key 轮换代理（原生实现，替代退役的 opencode-switcher）
    const swDir = path.dirname(this.config.stateFile);
    // 统一「包发布/安装/更新」领域逻辑：全局镜像源配置 + 版本检查 + 安装执行。
    // DSH 自升级与反代子应用共用同一实例，镜像源配置全局一份（registry.json）。
    this.dist = new DistributionManager({
      registries: (this.config.registries && this.config.registries.length) ? this.config.registries : ['https://registry.npmjs.org'],
      registryFile: path.join(swDir, 'registry.json'),
      events: this.events,
      logger: this.logger,
    });
    // 统一安装/更新任务注册表：收敛 native/instance/plugin/router 的全部
    // 安装·升级·卸载·更新操作到同一个有状态任务模型（持久化历史 + 统一 API）。
    this.tasks = new TaskRegistry({
      stateDir: swDir,
      logger: this.logger,
      events: this.events,
    });
    // 智能路由底座：中转服务整体生命周期 + 直连/反代供应商 + 账号状态管理 + 统一切换
    this.router = new RouterService({
      config: this.config,
      providerFile: path.join(swDir, 'providers.json'),
      usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
      logger: this.logger,
      events: this.events,
      dist: this.dist,
      tasks: this.tasks,
    });
    // 端口注册表持久化与守卫状态同域（默认 ~/.dsh/supervisor/ports.json；自定义 stateFile 时跟随），
    // 测试可经自定义 stateFile 天然隔离，绝不污染生产记录。
    try { ports.configureFile(path.join(path.dirname(this.config.stateFile), 'ports.json')); } catch (e) { this.logger.warn && this.logger.warn('ports configure: ' + e.message); }
    this.instances = new InstanceManager({
      dir: path.dirname(this.config.stateFile),
      logger: this.logger,
      events: this.events,
      dist: this.dist, // 沙箱实例的 npm 安装与 DSH 自升级共用全局镜像源（dist 为唯一通道）
      tasks: this.tasks,
      tokenService: this.tokenService, // 唯一令牌节点（实例侧只登记源 + 触发捕获，不持有/转发令牌）
      dshBin: this.config.command && this.config.command[1] ? this.config.command[1] : 'dsh',
    });
    this.instances.load();
    // 概念清分迁移：instances.json 含历史 main 记录 → 元数据迁入 dsh-main.json（守卫核心存储）并剔除
    this._migrateMainRecord();
    // ── 控制平面 v3 R1：管家注册机（声明目录）──
    // 记录「管家直接负责」的受管对象(应然+所有权)；本阶段为影子(不驱动任何循环)，随 add/remove 实时申报。
    try {
      // 目录持久化文件按守卫状态文件派生（C3-3b G4 修测试隔离）：
      // 生产默认 stateFile=state.json → <dir>/managed-objects.json（与部署/文档一致）；
      // 测试用自定义 stateFile(如 state-3900.json) → <dir>/state-3900.managed-objects.json——
      // 同一 TMP 目录多守卫（smoke/upgrade 链）不再互相污染 desired/phase（G4 起目录为权威存储）。
      this.managedObjects = new ManagedRegistry({
        file: path.join(path.dirname(this.config.stateFile), this._registryFileName()),
        logger: this.logger,
        events: this.events,
        ports: ports,
      });
      this._syncManagedRegistry();
      // daemon 监督 adapter（v3 R3 C3-2）：heartbeat 驱动；节流 6 拍≈30s（原 L3 监督 tick 语义）
      if (this.managedObjects && typeof this.managedObjects.registerAdapter === 'function') {
        this.managedObjects.registerAdapter('router-daemon', { supervise: () => this._daemonSuperviseOnce('router'), tickEvery: 6, derivePhase: true });
        this.managedObjects.registerAdapter('lan-daemon', { supervise: () => this._daemonSuperviseOnce('lan'), tickEvery: 6, derivePhase: true });
        // main(dsh) adapter（C3-3a observe → C3-3b G1 supervise）：heartbeat 把 main 实然写入目录
        // (lastObserved)——不驱动（G3 前 tick 仍是唯一驱动）。supervise 内做影子对比（纯计算+日志），
        // 实然与 tick 同源(monitor.probe → lastProbeOk)。影子连续零 diff 后由 G3 切换接管。
        this.managedObjects.registerAdapter('dsh', { supervise: () => this._dshSuperviseOnce(), tickEvery: 1 });
        // sandbox-instance adapter（C3-4a observe → C3-4b supervise 接管）：heartbeat 逐实例监督
        // （InstanceManager.supervise 单实例收敛 + 目录应然/相位同步）——InstanceManager.startTimer 停。
        // 域业务（CRUD/安装/装配/systemd/持久化）仍在 InstanceManager。
        this.managedObjects.registerAdapter('sandbox-instance', { supervise: (entry) => this._sandboxSuperviseOnce(entry), tickEvery: 1 });
      }
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('managed registry init: ' + (e && e.message)); }
    // 远程控制子系统（relay + frpc）：2026-09 架构单写——daemon 模式下守卫【不创建】本地 LanManager
    //（relay 唯一由独立 lan-daemon 承载，注册表 ports-lan 独占）。仅非 daemon 模式（config.lanDaemon
    // 未启用）才经 get lan() 惰性创建本地实例。曾无条件 new → 守卫进程内始终存在完整 relay 能力，
    // 任何漏网调用即写 relay 到 ports.json（漂移族 ghost 根因，见 lanApi/996c8c3）。
    this._lan = null;
    // 桥接：实例 remoteEnabled 变化时同步远程代理
    // 实例事件 → 远程代理对账。L3b（config.lanDaemon）：守卫不再本地建 relay，只把实例清单写入
    // lan-state.json（daemon 轮询收敛：新增/启停/remoteEnabled 变化均经 reconcile 处理）。
    this.instances.onRemoteChange = (inst) => {
      if (this.lanDaemonEnabled()) { this._syncLanState(); return; }
      this.lan.syncProxy(inst).catch((e) => this.logger.warn && this.logger.warn('lan syncProxy: ' + e.message));
    };
    this.instances.onRemove = (id) => {
      if (this.lanDaemonEnabled()) { this._syncLanState(); return; }
      this.lan.removeProxyForInstance(id).catch((e) => this.logger.warn && this.logger.warn('lan removeProxy: ' + e.message));
    };
    // 实例启停时联动远程代理：启动→确保 relay 在跑；停止→停 relay（保留注册）
    // R3 C3-4b：启停动作同时申报目录（desired 随动作立即对齐——不用等下一拍心跳同步）
    this.instances.onInstanceStart = (inst) => {
      if (this.managedObjects) { try { this._upsertManaged(this._managedSandboxSpec(inst)); } catch {} }
      if (this.lanDaemonEnabled()) { this._syncLanState(); return; }
      this.lan.instanceStart(inst).catch((e) => this.logger.warn && this.logger.warn('lan instanceStart: ' + e.message));
    };
    this.instances.onInstanceStop = (inst) => {
      if (this.managedObjects) { try { this._upsertManaged(this._managedSandboxSpec(inst)); } catch {} }
      if (this.lanDaemonEnabled()) { this._syncLanState(); return; }
      try { this.lan.instanceStop(inst); } catch (e) { this.logger.warn && this.logger.warn('lan stop: ' + e.message); }
    };
    // 控制平面申报：沙箱实例创建/销毁 → 管家注册机登记/注销（R1）
    this.instances.onCreate = (inst) => { if (this.managedObjects) this._upsertManaged(this._managedSandboxSpec(inst)); };
    this.instances.onDestroy = (id) => this._unregisterManaged(id);
    this.pluginMarket = new (require('./domains/plugin/pluginmarket').PluginMarket)({
      stateFile: this.config.stateFile,
      logger: this.logger,
    });
    this.pluginManager = new PluginManager({
      dshBin: 'dsh',
      profileName: this.config.pluginsProfileName || 'web',
      profileDir: path.join(os.homedir(), '.dsh', 'profiles', this.config.pluginsProfileName || 'web'),
      overlayFile: path.join(path.dirname(this.config.stateFile), 'plugin-states.patch.yml'),
      dshPort: this.config.targetPort,
      instances: this.instances,
      tasks: this.tasks,
      logger: this.logger,
      events: this.events,
      dist: this.dist, // 插件安装/卸载与 DSH 自升级共用全局镜像源
      // 插件变更（卸载/启停）涉及原生目标时：统一走守卫生命周期重启（等价于面板重启按钮）
      onNativeRestart: () => {
        try { return this.requestRestart(); }
        catch (e) { this.logger.warn && this.logger.warn('plugin change → native restart: ' + e.message); return { ok: false, error: e.message }; }
      },
    });
    // 版本管理：单一版本源（package.json），交给 infra/version
    this.guardVersion = guardVersion();
    // 守卫自身生命周期 + 健康 + 遥测 + 主机服务对接（infra：与实例生命周期完全分离）
    this.lifecycle = new Lifecycle();
    // 统一生命周期管理器（2026-09 归一化架构）：全部模块生命周期的唯一注册表与统一启停入口。
    // 守卫持监测权——start/stop/状态统一经此；模块各自独立生命周期，守卫重启不停被管模块。
    this.lifecycleManager = new LifecycleManager({ logger: this.logger, events: this.events });
    this.health = new Health(this.lifecycle);
    this.hostService = new HostService({ logger: this.logger, events: this.events });
    this.api = null;
    this.notifyEnabled = this.config.notifyEnabled !== false;
    this.loadState();
    // 原生 DSH 生命周期管理器：安装/卸载/版本检测/升级（原生 DSH 的唯一管理门面，单通道）
    this.nativeManager = new NativeManager({
      config: this.config,
      dist: this.dist,
      events: this.events,
      logger: this.logger,
      stateDir: path.dirname(this.config.stateFile),
      tasks: this.tasks,
      // 守卫生命周期钩子：升级需停/起 DSH 时回调
      hooks: {
        isDshActive: () => ['STARTING', 'RUNNING', 'RESTARTING', 'BACKOFF'].includes(this._mPhase()),
        desiredRunning: () => this._mDesired() === 'running',
        stopForUpgrade: () => this._enterUpgradeHoldAsync(),
        resumeAfterUpgrade: () => this._exitUpgradeHold(true),
        verifyDeadlineMs: () => Math.max(2 * this.config.startTimeoutMs, 120000),
        notify: (t, b) => this.notify(t, b),
      },
    });
    // 概念清分（2026-09-06）：原生 DSH 是主干，软件本体由 NativeManager 独立管理（/native/* + /lifecycle/dsh/*）；
    // 沙箱实例由 InstanceManager 管理（/instances/*）。原生不挂进沙箱实例出口——不注入任何句柄/委托。
    // （EventHub 汇聚已由 LogCore.init 统一装配（docs/LOGGING-SINGLETON-AUDIT.md S2）；
    //  this.eventHub = logCore.hub，聚合文件按 stateFile 派生唯一。）
    // 系统级端口登记：固定端口统一注册，冲突启动即 fail-fast，杜绝各子系统各管各的端口
    this._registerFixedPorts();
  }

  /** 固定端口统一登记：主DSH / 守卫API / 中转服务。冲突即抛错（守卫启动失败，避免带病运行）。
   *  主程序端口动态注册：用户使用场景各异（可能先装 DSH 并自定义端口）——
   *  若配置端口无监听且检测到 DSH 进程，从进程实际参数解析端口并动态覆盖（绝不硬编码 3080）。 */
  _registerFixedPorts() {
    // 端口来源以配置为准（healthUrl / command --port，normalize 已统一）。
    // 注意：不做 pgrep 启发式猜端口——同一 bin 的其它实例/残留进程会劫持监管目标
    // （实测：残留 mock 的 "--port 3901" 让守卫从 3911 被导到 3901，接管错误对象）。
    ports.register('dsh-main', this.config.targetPort);
    ports.register('supervisor-api', this.config.apiPort);
  }

  /** lan 惰性访问（2026-09 架构单写）：daemon 模式（config.lanDaemon=true）返回 null——
   *  relay 由独立 lan-daemon 承载；仅非 daemon 模式首次访问创建本地 LanManager。 */
  get lan() {
    if (this.lanDaemonEnabled()) return null; // daemon 模式：守卫无本地 relay 能力（结构性排除）
    if (!this._lan) {
      this._lan = new LanManager({
        configPath: this.configPath || '', // 端口回收精确匹配（RC6）
        stateDir: path.dirname(this.config.stateFile),
        logger: this.logger,
        events: this.events,
        instances: this.instances,
        // 概念清分(2026-09-06)：main 由守卫核心持有(live 元数据)——LanManager 经 mainOf 合成受管清单，
        // persist 路由：沙箱→instances.save()，main 变更(wanPort 等)→ 守卫落盘 dsh-main.json
        mainOf: () => {
          const m = this._readDshMain();
          m.id = 'main';
          m.name = '主实例';
          m.port = Number(this.config.targetPort || 3080);
          m.domain = 'native';
          m.kind = 'native';
          return m;
        },
        persist: () => {
          try { if (this.instances && this.instances.save) this.instances.save(); } catch {}
          this._writeDshMain({}); // live 变更(wanPort/remoteToken/frp*)落盘 dsh-main.json
        },
        tokenOf: (id) => this.tokenService.get(id),
      });
    }
    return this._lan;
  }
  set lan(v) { this._lan = v; } // 测试注入 mock 用；生产 daemon 模式守卫不主动 set（getter 恒 null）

  // ---- 启动 / 关闭 ----
  start() {
    this.events.append('guard_started', {
      pid: process.pid,
      version: this.guardVersion,
      healthUrl: this.config.healthUrl,
      api: this.config.apiHost + ':' + this.config.apiPort,
    });
    // 守卫自身生命周期：已启动
    this.lifecycle.markStarted();
    const { createServer } = require('./api/index');
    // 端口自动避让（2026-09-07）：apiPort 为高位段默认(36360)但用户本机可能已占用
    // （3100 常用端口冲突问题的根治——不硬编码常用口）。目标端口被占则顺延 +1 探测
    // 空闲端口（最多 +50），选定后若与配置不同则持久化 config.json，重启沿用。
    const self = this;
    const maxSkew = 50;
    const attempt = (port, skew) => {
      const server = createServer(this);
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && skew < maxSkew) {
          // 端口占用：顺延下一个
          const next = this.config.apiPort + skew + 1;
          this.events.append('api_port_skew', { from: this.config.apiPort, to: next, reason: err.message });
          this.logger.warn('api port ' + port + ' occupied, trying ' + next + ': ' + err.message);
          return attempt(next, skew + 1);
        }
        this.events.append('api_error', { message: err ? err.message : String(err) });
        this.logger.error('api error: ' + (err ? err.message : String(err)));
      });
      server.listen(port, this.config.apiHost, () => {
        this.api = server;
        // 实际端口 ≠ 配置端口 → 持久化（重启沿用选定端口）
        if (port !== this.config.apiPort) {
          this.config.apiPort = port;
          if (this.configPath) this.persistConfigPatch({ apiPort: port });
        }
        this.events.append('api_listening', { host: this.config.apiHost, port });
        this.logger.info('api listening on ' + this.config.apiHost + ':' + port);
      });
      return server;
    };
    this.api = attempt(this.config.apiPort, 0);
    this.logger.info('guard started v' + this.guardVersion + ' pid=' + process.pid);
    // 统一生命周期管理器注册（归一化架构）：把全部模块注册为 ManagedLifecycle。
    // 注册后：前端启停/状态统一走 /lifecycle/*（见 api.js），不再直调模块对象。
    try {
      registerAll(this.lifecycleManager, {
        router: this.router, lan: this.lan, instances: this.instances,
        supervisor: this, pluginManager: this.pluginManager, logger: this.logger,
      });
      if (this.logger && this.logger.info) this.logger.info('[lifecycle] 已注册模块: ' + this.lifecycleManager.all().map((l) => l.id).join(','));
      this._syncDshLifecycleView(); // 注册后立即同步 DSH 视图（不等首个 tick）
      try { this._syncInstancesLifecycleView(); } catch (e) {} // C3-5b：instances 聚合视图初始真实化
    } catch (e) { this.logger.warn && this.logger.warn('[lifecycle] 注册失败: ' + (e && e.message)); }
    this.tick(); // 首拍立即收敛
    // main(dsh) 收敛驱动源（C3-3b G3 接管 → C3-5 终态）：唯一心跳（registry heartbeat →
    // dsh supervise → _dshConverge）是唯一周期驱动——tick 定时器不再创建；
    // 仅 registry 不可用（极罕见）时保留 tick 定时器兜底（保证 main 不被放养）。
    this._timer = this.managedObjects ? null : setInterval(() => this.tick(), this.config.probeIntervalMs);
    // 唯一心跳（v3 R3 C3-2/C3-3b G3）：daemon 监督(router/lan-daemon, 节流≈30s) +
    // main 收敛(on 模式) 都收进 ManagedRegistry.heartbeat。
    // _heartbeatBusy 防慢拍重叠（probe 超时/长 I/O 时心跳不并发，防 daemon 双监督/main 双收敛）。
    this._heartbeatTimer = setInterval(() => {
      if (this._heartbeatBusy) return;
      this._heartbeatBusy = true;
      Promise.resolve(this.managedObjects ? this.managedObjects.heartbeat(this.config.probeIntervalMs || 5000) : null)
        .catch(() => {})
        .finally(() => { this._heartbeatBusy = false; });
    }, this.config.probeIntervalMs || 5000);
    // 远程控制：为已开启远程控制的实例补建代理（幂等）
    // L3b：relay/frpc 由独立 lan-daemon 承载——守卫只写状态并拉起/监督 daemon，不在本地建 relay
    if (this.lanDaemonEnabled()) {
      this._syncLanState();
      const lrt = this._ensureLanRuntime(true);
      if (this.logger && this.logger.info) this.logger.info('[lan] L3b 模式：lan-daemon ' + (lrt.mode === 'daemon' ? ('已就绪 pid=' + (lrt.spawned || '(既有)')) : ('未就绪 mode=' + lrt.mode)));
    } else {
      this.lan.reconcile();
      this.lan.syncFrpc();
    }
    // 沙箱实例监督（R3 C3-4b）：并入唯一心跳 sandbox-instance adapter（heartbeat 逐实例
    // supervise → InstanceManager.supervise）；registry 不可用（极罕见）时兜底自持定时器。
    if (!this.managedObjects) this.instances.startTimer(this.config.probeIntervalMs || 5000);
    // 注意：守卫启动只是守卫自身的生命周期，绝不在启动时去注册/拉起/切换任何实例（含 main）。
    // main 是否纳管/拉起，由各实例自己的［进程守护 guardian］开关 + 实例自身生命周期决定，不因守卫启动而改变。
    // 为已开启远程控制的实例补建代理（幂等；L3b 下由 lan-daemon reconcile 收敛）
    if (!this.lanDaemonEnabled()) {
      for (const inst of this.instances.instances || []) { if (inst.remoteEnabled) this.lan.syncProxy(inst).catch(() => {}); }
    }
    if (this.config.routerAutostart === true) {
      // 统一生命周期视图同步：router 期望运行 → 注册项纳入监测
      const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc._setPhase && rlc._setPhase('starting'); }
      // L3 进程解耦：独立 router-daemon 优先——daemon 在跑则监督它（不再内嵌启动双占 43011）；
      // daemon 未跑则拉起独立 daemon（detached，守卫重启不影响）；daemon 不可用（脚本缺失）退回内嵌。
      // 接管既有 daemon（守护重启/手动拉起）→ 先落管理锁（本守卫目录），监督/启停权归属本守卫。
      if (this._routerDaemonActive()) this._writeRouterDaemonLock();
      const rt = this._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        // 状态文件写权归 daemon（防双写覆盖：守卫只读，providers.json 由 daemon 独占持久化）
        if (this.router && typeof this.router.setPersistEnabled === 'function') { try { this.router.setPersistEnabled(false); } catch {} }
        if (rt.spawned) {
          // 刚拉起：等待 daemon 就绪（短轮询 43011）
          setTimeout(() => {
            const up = pidlook.findListeningPid(43011);
            if (rlc) { if (up) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('starting'); } /* healthy 由 _supervise mirror 观测置位 */ }
          }, 3000);
        } else if (rt.active) {
          // daemon 已在跑：监督模式
          if (rlc) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } /* healthy 由 _supervise mirror 观测置位 */
        }
        return; // 已由独立 daemon 承担，不执行下方内嵌启动
      }
      // daemon 不可用 → 内嵌 router（回退路径，保持原行为）
      this.router.start().then((r) => {
        if (rlc) { if (r && r.ok !== false) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('stopped'); rlc.error = (r && r.error) || 'start 失败'; } /* healthy 由 _supervise mirror 观测置位 */ }
        if (r && r.ok === false) this.logger.warn('中转服务启动失败：' + (r.error || '未知错误'));
      });
    } else {
      const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; }
    }
    if (this.config.updateCheckEnabled !== false) {
      this._initialCheckTimer = setTimeout(() => {
        this.nativeManager.checkUpdate();
      }, this.config.initialCheckDelayMs || 20000);
      this._upgradeTimer = setInterval(() => {
        this.nativeManager.checkUpdate();
      }, this.config.updateCheckIntervalMs || 3600000);
    }
  }

  shutdown() {
    if (this._stopping) return;
    this._stopping = true;
    this.lifecycle.beginShutdown();
    this.events.append('guard_exit', {});
    this.logger.info('guard shutting down');
    this.writeState(true);
    if (this._timer) clearInterval(this._timer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._killTimer) clearTimeout(this._killTimer);
    if (this._adoptKillTimer) clearTimeout(this._adoptKillTimer);
    if (this._initialCheckTimer) clearTimeout(this._initialCheckTimer);
    if (this._upgradeTimer) clearInterval(this._upgradeTimer);
    if (this.api) {
      try {
        this.api.close();
      } catch {}
    }
    // ── 统一生命周期停止（2026-09 归一化架构）──
    // 过渡态：进程解耦（L3）完成前，router/lan 仍驻守卫进程——shutdown 必须停它们防孤儿
    // （反代实例进程、relay/frpc、41000+ 端口残留）。解耦后此段改为「只停观测，不停进程」：
    // 守卫重启不应影响任何被管模块（它们独立生命周期，由 systemd/自身 supervisor 维持）。
    // 统一经 lifecycleManager 出口（而非直调模块对象），保证启停路径收敛到一处。
    try {
      if (this.lifecycleManager) {
        // L3 解耦：router 若为独立 daemon（detached）→ 守卫退出不停它（daemon 独立生命周期继续服务）；
        // 仅内嵌 router/lan（仍驻守卫进程的）需停防孤儿。实现：先把 daemon 型 router 项从 stopAll 豁免。
        try {
          const rlc = this.lifecycleManager.get('router');
          if (rlc && this._routerDaemonActive()) {
            rlc._monitoring = false; // 守卫退出不再监督该 daemon（daemon 自身继续运行）
          }
        } catch {}
        this.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] }); // 守卫退出绝不动 DSH（RC2 契约，不再依赖 exit 竞态）
      } else {
        // 兜底（lifecycleManager 未初始化时保持原行为防孤儿）
        try { if (this.lan) this.lan.shutdown(); } catch (e) { this.logger.warn && this.logger.warn('lan shutdown: ' + (e && e.message)); }
        try { if (this.router) this.router.stop(); } catch (e) { this.logger.warn && this.logger.warn('router stop: ' + (e && e.message)); }
      }
    } catch (e) { this.logger.warn && this.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
    // 守护语义：守卫退出不动 DSH，恢复后幂等调和
  }

  // ---- 状态持久化 ----
  statusSummary() {
    // 原生 DSH 端口自检测：端口是「实际运行态」属性，而非静态配置值——
    // 仅当目标在线（有 pid）时返回其实际监听端口，未启动/离线返回 null（前端显示横杠）。
    const dshPidNow = this._mChild() ? this._mChild().pid : this._mAdoptPid();
    return {
      desired: this._mDesired(),
      phase: this._mPhase(),
      guardVersion: this.guardVersion,
      dshPid: dshPidNow,
      dshPort: dshPidNow ? (this.config.targetPort || null) : null,
      adopted: this._mAdopted(),
      guardPid: process.pid,
      lastProbeAt: this._mLastProbeAt(),
      lastProbeOk: this._mLastProbeOk(),
      restartCount: this._mRestartCount(),
      crashWindowStart: this._mCrashWindowStart(),
      crashWindowRestarts: this._mCrashWindowRestarts(),
      backoffLevel: this._mBackoffLevel(),
      backoffUntil: this._mBackoffUntil(),
      lastFailure: this._mLastFailure(),
      lastRestartAt: this._mLastRestartAt(),
      updatePending: this._selfUpdatePending(), // A3：更新已安装待重启生效
      upgradeHold: this._upgradeHold,
      commandMissing: !!(this._mSpawnBlockedUntil() && Date.now() < this._mSpawnBlockedUntil()),
      dshTokenCaptured: !!(this.tokenService && this.tokenService.get('main')),
      tasks: this.tasks ? this.tasks.running().map((t) => ({ id: t.id, kind: t.kind, action: t.action, target: t.target, state: t.state })) : [],
      native: this.nativeManager ? this.nativeManager.status() : null,
      version: this.nativeManager ? this.nativeManager.versionInfo() : null,
      upgrade: this.nativeManager ? this.nativeManager.upgradeBrief() : null,
      updatedAt: new Date().toISOString(),
    };
  }

  writeState(force) {
    try {
      const snap = this.statusSummary();
      const updatedAt = snap.updatedAt;
      snap.updatedAt = null;
      const body = JSON.stringify(snap, null, 2);
      if (!force && body === this._lastStateBody) return; // 内容未变不写盘
      this._lastStateBody = body;
      snap.updatedAt = updatedAt;
      const dir = path.dirname(this.config.stateFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.config.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.config.stateFile);
    } catch (e) {
      this.logger.error('state write failed: ' + e.message);
    }
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      if (raw.desired === 'stopped' || raw.desired === 'running') this._mSetDesired(raw.desired);
      if (typeof raw.restartCount === 'number') this._mSetRestartCount(raw.restartCount);
      if (typeof raw.backoffLevel === 'number') this._mSetBackoffLevel(raw.backoffLevel);
      // 崩溃窗口跨守卫重启保持（否则"DSH 反复崩 + 守卫被拉起"会重置退避保护）
      if (typeof raw.crashWindowStart === 'number' || raw.crashWindowStart === null) {
        this._mSetCrashWindowStart(raw.crashWindowStart);
      }
      if (typeof raw.crashWindowRestarts === 'number') this._mSetCrashWindowRestarts(raw.crashWindowRestarts);
      if (typeof raw.lastFailure === 'string' || raw.lastFailure === null) this._mSetLastFailure(raw.lastFailure);
      if (typeof raw.lastRestartAt === 'string' || raw.lastRestartAt === null) this._mSetLastRestartAt(raw.lastRestartAt);
      // 升级 hold 跨守卫重启保持：防止"安装途中守卫被拉起 → 用半新半旧的文件 spawn"
      if (raw.upgradeHold === true) {
        this._upgradeHold = true;
        if (!this._upgradeHoldSince) this._upgradeHoldSince = Date.now();
      }
    } catch {}
    // C3-3b G4：boot 相位不继承（进程句柄不持久化——守卫重启后无 child/adoptedPid）。
    // 若目录恢复 running/starting 等，首拍会误判"已在运行"而永不 adopt/调和；复位 STOPPED
    // 让首拍按真实探测收敛（port up → adopt；down → spawn），与 legacy「启动相位=STOPPED」一致。
    try { this._mSetPhase('STOPPED'); } catch {}
  }

  // ---- 外部控制（API / CLI）----
  setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    // 显式「启动」是用户意图，不受「进程守护(自动拉起)」开关短路限制：
    // 守护开关只约束「崩溃后自动拉起」，绝不约束用户主动点启动。
    if (v === 'running') this.intents.register('start'); // 显式意图（RC2）
    if (v === 'running' && this._mPhase() === 'OBSERVED') {
      // 从观测模式转正：同一实例无缝纳管
      this._mSetObservedOnly(false);
      this._mSetPhase('STOPPED'); // 交给 switch 立即重新调和（healthOk → 正式接管）
    }
    if (v === 'stopped' && this._mPhase() === 'OBSERVED' && this._mObservedOnly()) {
      // 显式停止观测中的实例：已有 pid，可安全终止
      this.stopProcess('desired_stopped');
    }
    if (this._mDesired() !== v) {
      this._mSetDesired(v);
      this.events.append('desired_changed', { desired: v });
      // 启动/停止 DSH 与「进程守护开关」完全独立：desired 只改运行状态，不改守护(自动拉起)开关。
      // 守护开关仅由用户显式操作 /instances/update {guardian} 改变；watchdog 在 desired==='stopped' 时绝不拉起。
      this.writeState();
    }
    this.tick();
    return { ok: true, desired: this._mDesired() };
  }

  requestRestart() {
    if (this._mDesired() === 'stopped') {
      this.events.append('manual_restart_requested', { ignored: 'desired=stopped' });
      return { ok: false, error: 'desired=stopped，请先 /start' };
    }
    this.manualRestart = true;
    this.intents.register('restart'); // /restart 也是显式操作：守护开关不挡（RC2）
    this.events.append('manual_restart_requested', {});
    this.tick();
    return { ok: true };
  }

  /** 把补丁合并写回守卫自己的配置文件（原子写；仅限本产品配置，绝不触碰 DSH）。 */
  persistConfigPatch(patch) {
    if (!this.configPath) return;
    try {
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch {}
      Object.assign(cur, patch);
      delete cur.switcherAutoStart; // 旧键随持久化收敛删除（迁移完成态）
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 }); // config 含 lanToken → 0600（工业级敏感文件权限）
      fs.renameSync(tmp, this.configPath);
    } catch (e) {
      this.logger.warn('config persist failed: ' + e.message);
    }
  }

  // ---- 智能路由门面：presets/providers/proxyApps 经 sup 接口取数（消除 api 的 constructor hack）----
  // L3 监督模式（2026-09）：router-daemon 在跑时，providers/proxyApps 一律经 ctl 转发到 daemon
  // （唯一事实源，读即最新）；daemon 未跑回退守卫本地实例（内嵌模式）。返回可能是 Promise（远程），
  // 调用方统一 Promise.resolve()。
  routerProviders() {
    const presets = this.router.constructor.presets();
    // 阶段三：local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本——见 PHASE3 设计）
    const local = () => ({ presets, providers: this.router.listProviders(), proxyApps: this.router.proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!this.routerDaemonActive()) return local();
    const rt = this.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (this.logger && this.logger.warn) this.logger.warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  }

  // ---- L3 监督模式：router 控制通道（daemon 唯一事实源，2026-09）----
  // 守卫 API/视图统一从 routerApi() 取 router 门面：daemon 在跑 → 方法调用转发 ctl
  // （POST /ctl {method,args}，见 src/service-daemon/router-ctl.js）——写即 daemon 生效、
  // 读即 daemon 最新（消除此前「守卫本地副本视图陈旧 / 写不生效」的双脑不一致，HANDOFF #4）；
  // daemon 未跑 → 守卫本地实例（内嵌回退路径，行为不变）。
  routerApi() {
    if (this.routerDaemonActive()) {
      if (!this._routerFacade) this._routerFacade = this._makeRouterFacade();
      return this._routerFacade;
    }
    return this.router;
  }

  routerDaemonActive() {
    // 仅当本守卫「期望 daemon 运行（routerAutostart）」且「管理锁在手（本守卫写过的 lock）」且
    // 43011 监听者为 router-daemon 时，才视为「daemon 监督模式」（routerApi/门面/ctl 生效）。
    // 关键：绝不因全局 43011 被占就把任意 Supervisor 实例（含测试内嵌实例，乃至运行中把
    // routerAutostart 置真的测试/内嵌路径）误判为监督模式——否则测试 api 调用会经 ctl 打到
    // 线上 daemon（2026-09 实测 p2p-api-test 误接生产路由：/router/start 置 autostart=true 后
    // 后续全部 provider 视图/写操作打到生产 daemon）。
    try {
      if (!this.config || this.config.routerAutostart !== true) return false;
      if (!this._daemonManaged()) return false;
      return this._routerDaemonActive();
    } catch { return false; }
  }

  /** 通用 ctl 调用（router 43107 / lan 43108 共用）。 */
  _ctlCall(port, method, args, timeoutMs) {
    const http = require('node:http');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, args: Array.isArray(args) ? args : [] });
      const req = http.request({
        host: '127.0.0.1', port, path: '/ctl', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs || 120000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf || '{}');
            if (j && j.ok) return resolve(j.value);
            const err = new Error((j && j.error) || ('ctl:' + port + ' ' + method + ' failed'));
            err.ok = false;
            err.error = (j && j.error) || null;
            return reject(err);
          } catch { return reject(new Error('ctl:' + port + ' 响应解析失败')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('ctl:' + port + ' 超时')));
      req.on('error', reject);
      req.end(body);
    });
  }

  _makeRouterFacade() { return this._makeCtlFacade(Number((this.config && this.config.routerCtlPort)) || 43107); }

  _makeCtlFacade(port) {
    const self = this;
    const cache = new Map();
    const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BANNED.has(prop)) return undefined;
        if (cache.has(prop)) return cache.get(prop);
        const fn = (...args) => self._ctlCall(port, prop, args);
        cache.set(prop, fn);
        return fn;
      },
      has() { return true; },
    });
  }

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
  async routerStatusView() {
    if (this.routerDaemonActive()) {
      try {
        const st = await this.routerApi().status();
        return { running: !!(st && st.running), autostart: this.config.routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return this.routerStatus();
  }

  // ---- 端口管理门面：统一端口 registry 清单经 sup 接口暴露（presentation 不直连 infra）----
  // 2026-09 修复：原实现 records 恒缺 active → 前端端口管理「状态」列全部显示停用（接线断裂）。
  // 现为每条记录补 active（端口当前真实监听中）。探测按「端口集合」整批缓存 3s TTL，
  // 避免前端 2s 心跳每次触发全量同步扫 /proc 挤占事件循环。
  async listPorts() {
    // 归一化收拢（2026-09）：系统端口登记分散在 3 个注册表文件（同 stateDir）——
    //   ports.json（守卫共享：system/inst/oauth/managed-ctl）
    //   ports-lan.json（lan-daemon 独占：relay 隧道 40000+ —— 远程控制/局域网暴露端口）
    //   ports-router.json（router-daemon 独占：proxyInstance 反代 41000+ / providerApi 43000+ —— 智能路由实例）
    // /ports 必须聚合三文件去重合并，才是「整个系统的运行状态」；此前只返回守卫共享段，
    // 导致智能路由反代/供应商 API、relay 隧道端口在前端缺失（结构失衡）。
    try { ports.reload(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('ports reload: ' + (e && e.message)); }
    const swDir = path.dirname(this.config.stateFile);
    const byPort = new Map();
    const adopt = (rec) => {
      if (!rec || !Number.isInteger(rec.port) || !rec.role || byPort.has(rec.port)) return;
      byPort.set(rec.port, {
        port: rec.port, role: rec.role, owner: rec.owner || null,
        createdAt: Number.isInteger(rec.createdAt) ? rec.createdAt : Date.now(),
      });
    };
    for (const r of ports.list()) adopt(r);
    for (const f of ['ports-lan.json', 'ports-router.json']) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(swDir, f), 'utf8'));
        for (const r of (Array.isArray(doc.records) ? doc.records : [])) adopt(r);
      } catch {}
    }
    // 运行状态视图归一化: oauthCallback 是登录瞬态回调(非服务)不进常驻列表; supervisor-api 历史残留段保留供 active 筛选
    const merged = [...byPort.values()].filter((r) => r.role !== "oauthCallback");
    const activeByPort = await this._portActives(merged.map((r) => r.port));
    const records = merged.map((r) => ({
      port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt,
      active: !!(activeByPort && activeByPort[r.port]) || false,
    }));
    const snap = ports.snapshotAll();
    // supervisor-api 多端口历史残留(3100/36360/36361): 只保留正在监听者, 废弃端口不占位
    const apiAct = records.filter((r) => r.role === "supervisor-api" && r.active);
    const out = apiAct.length ? records.filter((r) => r.role !== "supervisor-api" || r.active) : records;
    return { records: out, snapshot: snap };
  }

  /** 端口集合激活探测（整批 3s TTL 缓存）。active=true 表示该端口当前有进程在监听。
   *  2026-09 复检根治：改为纯 TCP connect 探测（probe.portListening）——不再依赖 pid 映射。
   *  背景：findListeningPing 需读 /proc/<pid>/fd 反查 socket→pid，对本机「守卫管理树外/孙进程」
   *  （router-daemon 的反代子进程）常因读取权限返回 null → 端口明明在监听却恒报 inactive（前端端口
   *  管理「无任何实例激活」失真，实测 41038 在听而 active=false）。TCP connect 与端口是否被监听
   *  直接等价（同 infra/ports 判占用语义），无需任何 /proc 权限，三平台一致。 */
  async _portActives(portsList) {
    const now = Date.now();
    const key = portsList.join(',');
    if (this._portActivesCache && this._portActivesCache.key === key && now - this._portActivesCache.at < 3000) {
      return this._portActivesCache.map;
    }
    const probe = require('./guard/monitor/probe');
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    this._portActivesCache = { key, at: now, map };
    return map;
  }

  // ---- L3b：lan(relay) daemon 解耦（config.lanDaemon=true，2026-09，见 docs/L3-process-decoupling.md）----
  // 门控默认关：关闭时行为与历史一致（LanManager 驻守卫）。开启后：
  //   - relay/frpc 由独立 lan-daemon 承载（守卫重启不影响远程控制）
  //   - 守卫写 lan-state.json（实例清单+令牌）供 daemon 轮询；本守卫不再本地建 relay
  //   - 全部 lan 读/写经 43108 ctl 委托 daemon；守卫 30s 监督 tick 拉起失联 daemon
  lanDaemonEnabled() { return !!(this.config && this.config.lanDaemon === true); }

  _lanDaemonActive() {
    try {
      const pid = pidlook.findListeningPid(43108);
      if (!pid) return false;
      const cmd = pidlook.readCmdline(pid) || '';
      return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
    } catch { return false; }
  }

  /** 统一受管进程生命周期实例（懒加载单例；lan/router 共用 DaemonLifecycle 核心，2026-09 架构定稿）。
   *  身份文件（owner 连续：守卫重启=接管既有 daemon）+ spawn latch + 换代停旧→等死→等端口释放 全在核心内。 */
  _daemonLifecycle(kind) {
    if (!this.configPath) return null; // 非守卫实例（测试）绝不管理独立 daemon
    if (!this._lc) this._lc = {};
    if (this._lc[kind]) return this._lc[kind];
    const root = path.join(__dirname, '..');
    const cfgPath = this.configPath;
    const isLan = kind === 'lan';
    const script = isLan ? path.join(root, 'src', 'domains', 'relay', 'daemon.js') : path.join(root, 'src', 'domains', 'router', 'daemon.js');
    if (!fs.existsSync(script)) return null;
    const dir = path.dirname(this.config.stateFile);
    this._lc[kind] = new DaemonLifecycle({
      name: kind,
      script,
      args: ['-c', cfgPath],
      ctlPort: isLan ? 43108 : 43011,
      cmdMark: isLan ? 'lan-daemon' : 'router-daemon',
      identityFile: path.join(dir, kind + '-daemon.identity.json'),
      spawnEnv: () => ({ DSH_SUPERVISOR_CONFIG: cfgPath }),
      logger: this.logger,
      events: this.events,
    });
    return this._lc[kind];
  }

  /** ensure 结果 → 旧调用方契约翻译（adopted 不带 spawned：避免监督误报“失联重拉”）。 */
  _daemonEnsureResult(lc, writeOwnerLock) {
    const rr = lc.ensureRunning();
    if (rr.mode === 'started' || rr.mode === 'adopted') {
      if (writeOwnerLock) writeOwnerLock();
      return rr.mode === 'started'
        ? { active: true, mode: 'daemon', spawned: rr.pid }
        : { active: true, mode: 'daemon' }; // adopted：既有进程，owner 连续
    }
    if (rr.mode === 'barrier') return { active: false, mode: 'barrier', reason: '生命周期窗口内' };
    if (rr.mode === 'reclaiming') return { active: false, mode: 'reclaiming', stale: rr.stale };
    return { active: false, mode: 'error', error: 'unexpected lifecycle mode: ' + rr.mode };
  }

  _lanLockPath() { try { return path.join(path.dirname(this.config.stateFile), 'lan-daemon.lock'); } catch { return null; } }
  _lanManaged() { try { const p = this._lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } }
  _writeLanLock() { try { const p = this._lanLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {} }
  _clearLanLock() { try { const p = this._lanLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {} }

  _lanCtlCall(method, args, timeoutMs) { return this._ctlCall(43108, method, args, timeoutMs); }

  /** lan 门面（2026-09 端口权威修复）：daemon 模式【已启用】即一律走 ctl（daemon 事实源）——
   *  【绝不退回本地 LanManager】。daemon 换代/启动窗口不可达时也绝不退回本地路径——否则
   *  前端轮询/内部路径会触发本地 syncProxy 建 relay（漂移族 ghost 40000 等，
   *  与 daemon 注册表正确族并存 = 用户反复"40000 仍可访问/端口混乱"根因）。
   *  daemon 暂不可达 → ctl 调用失败返回空/错误（不建本地 relay），等 daemon 恢复由监督拉起。 */
  /** 实例清单+令牌 → lan-state.json（原子 0600；daemon 轮询消费）。hash 相同不落盘。 */
  _syncLanState() {
    if (!this.lanDaemonEnabled()) return;
    try {
      const dir = path.dirname(this.config.stateFile);
      const file = path.join(dir, 'lan-state.json');
      // main(原生主干)由守卫核心持有(dsh-main.json)，不再在沙箱数组——lan-state 合成两者(协议不变)
      const instances = [
        ...((this.instances && this.instances.instances) || []),
        ...(this.dshMainView ? [this.dshMainView()] : []),
      ];
      const tokens = {};
      for (const inst of instances) {
        try {
          const t = this.tokenService && this.tokenService.get(inst.id);
          if (t) tokens[inst.id] = t;
        } catch {}
      }
      // 稳定性（2026-09）：哈希用稳定内容（无易变时间戳）——否则 30s 监督 tick 每次重写 lan-state，
      // lan-daemon 每轮视为「变化」→ 对全部实例重复 applyToken/重换 cookie（实测每 30s 全员重换）。
      // 文件保持顶层 {instances, tokens} 与 lan-daemon 解析兼容；仅当内容真变化才落盘。
      // 2026-09 端口权威修复：同步实例【不含 wanPort】——relay 端口唯一权威是端口注册表
      // (ports-lan.json, daemon claimSlot byOwner 复用)，lan-state 只传实例身份/开关。
      // 曾含 wanPort → 守卫把 instances.json 的历史写死值(如 main=40000 漂移)传播给 daemon，
      // 与注册表(40002)分裂 → ghost 双族并存（用户反复 40000 可访问/端口混乱根因）。
      const body = JSON.stringify({ instances: instances.map((i) => ({
        id: i.id, name: i.name, port: i.port, remoteEnabled: !!i.remoteEnabled,
        remoteToken: i.remoteToken || '', frpEnabled: !!i.frpEnabled,
        frpRemotePort: i.frpRemotePort || null,
      })), tokens }, null, 1);
      if (body === this._lastLanStateJson) return;
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
      this._lastLanStateJson = body;
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('_syncLanState: ' + (e && e.message));
    }
  }

  /** L3b：拉起独立 lan-daemon（detached；幂等：43108 已被本守卫管理 daemon 占用则不重复拉起）。 */
  _ensureLanRuntime(desiredRunning) {
    try {
      const active = this._lanDaemonActive();
      const managed = this._lanManaged();
      if (desiredRunning !== false && active && managed) return { active: true, mode: 'daemon' };
      if (desiredRunning !== false && active && !managed) return { active: false, mode: 'external' }; // 异主不接管
      if (desiredRunning === false) {
        if (active && managed) {
          const pid = pidlook.findListeningPid(43108);
          if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
          this._clearLanLock();
          const lcS = this._daemonLifecycle('lan');
          if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
          return { active: false, mode: 'daemon', stopping: true };
        }
        return { active: false, mode: 'none' };
      }
      // ══ 统一进程生命周期（2026-09 架构定稿）：spawn 一次性 + 换代停旧→等死→等端口释放，
      //  身份文件 owner 连续（守卫重启=接管）——全部收敛在 DaemonLifecycle，此处只做契约翻译 ══
      const lc = this._daemonLifecycle('lan');
      if (!lc) return { active: false, mode: 'none', error: 'lan-daemon 脚本缺失' };
      return this._daemonEnsureResult(lc, () => this._writeLanLock());
    } catch (e) {
      return { active: false, mode: 'error', error: e.message };
    }
  }

  /** 沙箱实例监督单拍（v3 R3 C3-4a observe → C3-4b supervise 接管）：heartbeat 经 adapter
   *  对每个沙箱实例执行监督收敛（InstanceManager.supervise 单实例状态机，语义=旧 tick per-instance），
   *  并把目录项与实例域状态对齐（desired/phase/guardian——目录=真实视图，防 ghost/死登记）。
   *  域业务 CRUD/安装/装配/systemd/持久化保留 InstanceManager；本方法只做心跳驱动 + 目录同步。
   *  @returns {ok:boolean} 实例当前在线（heartbeat 统一写目录 lastObserved） */
  async _sandboxSuperviseOnce(entry) {
    if (this._stopping) return { ok: false, error: 'guard stopping' };
    if (entry && this.instances && typeof this.instances.supervise === 'function') {
      try {
        await this.instances.supervise(entry.id);
      } catch (e) {
        this.logger && this.logger.warn && this.logger.warn('sandbox supervise(' + entry.id + '): ' + ((e && e.message) || e));
      }
    }
    let st = null;
    try {
      if (entry && this.instances && typeof this.instances.probeInstance === 'function') {
        st = this.instances.probeInstance(entry.id);
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('sandbox probe(' + (entry && entry.id) + '): ' + ((e && e.message) || e));
    }
    const running = !!(st && st.running);
    try { this._syncSandboxRegistryEntry(entry); } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox entry sync: ' + ((e && e.message) || e)); }
    return { ok: running, error: running ? null : '沙箱实例未运行' };
  }

  /** 目录项 ← 实例域状态对齐（heartbeat 监督拍后调用）：实例已删 → 注销（防死登记）；
   *  实例存在 → desired/guardian/name/ownership 经 _managedSandboxSpec 申报，phase 落目录唯一词表。 */
  _syncSandboxRegistryEntry(entry) {
    if (!entry || !this.managedObjects || !this.instances) return;
    if (this.managedObjects.get(entry.id) !== entry) return; // 条目已被替换/注销
    const inst = (this.instances.instances || []).find((i) => i.id === entry.id);
    if (!inst) {
      this._unregisterManaged(entry.id); // 实例已不存在：目录注销（heartbeat 不再空转）
      return;
    }
    try { this._upsertManaged(this._managedSandboxSpec(inst)); } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox upsert: ' + ((e && e.message) || e)); }
    const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'backoff', FAILED: 'failed' };
    const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
    try {
      if (entry.phase !== ph) this.managedObjects.setPhase(entry.id, ph);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox setPhase: ' + ((e && e.message) || e)); }
  }

  /** 唯一心跳驱动的 daemon 监督单拍（v3 R3 C3-2）：
   *  router/lan-daemon 的「期望运行 + 失联守护拉起」，由 ManagedRegistry.heartbeat 经 adapter 调用
   *  （节流≈30s，与原 L3 监督 tick 等价）。守卫重启不影响 daemon（进程独立）。
   *  @returns {ok:boolean} daemon 当前在线（heartbeat 统一写入目录实然）。 */
  async _daemonSuperviseOnce(kind) {
    if (this._stopping) return { ok: false };
    try {
      if (kind === 'router') {
        const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
        const wantRunning = this.config.routerAutostart === true || (rlc && rlc.desired === 'running');
        if (!wantRunning) return { ok: this._routerDaemonActive() };
        if (!this._daemonManaged()) return { ok: this._routerDaemonActive() }; // 异主隔离：监督不介入
        if (this._routerDaemonActive()) {
          try { this._syncRouterLifecycleView({ ok: true }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          // R4 域摘要入目录（黑盒摘要引用，只读缓存；拉取失败仅降级——不影响监督）
          try {
            if (this.routerDaemonActive() && this.managedObjects) {
              const s = await this.routerApi().domainSummary();
              const e = this.managedObjects.get('router-daemon');
              if (e && s && typeof s === 'object') {
                e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
              }
            }
          } catch (e2) { this.logger && this.logger.debug && this.logger.debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
          return { ok: true };
        }
        if (rlc && rlc.guardian !== true) {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联但守护开关关闭，不自动拉起（仅观测）');
          this._guardianEvent('router', 'skip-guardian-off');
          return { ok: false };
        }
        if (rlc) rlc.restartCount = (rlc.restartCount || 0) + 1;
        const rt = this._ensureRouterRuntime(true);
        if (rt.mode === 'daemon' && rt.spawned) {
          this.events.append('router_daemon_supervised', { pid: rt.spawned });
          this._guardianEvent('router', 'pull', { pid: rt.spawned });
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联，已重新拉起 pid=' + rt.spawned);
          if (rlc) { rlc._setPhase('starting'); }
          setTimeout(() => {
            const up = pidlook.findListeningPid(43011);
            try { this._syncRouterLifecycleView({ ok: !!up, error: up ? null : 'router-daemon 拉起后未就绪' }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          }, 3000);
        } else if (rt.mode === 'error') {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督拉起失败: ' + (rt.error || '未知'));
        }
        return { ok: false };
      }
      // kind === 'lan'
      if (!this.lanDaemonEnabled()) return { ok: this._lanDaemonActive() };
      this._syncLanState();
      const activeNow = this._lanDaemonActive();
      if (activeNow) return { ok: true };
      const entry = (this.managedObjects && typeof this.managedObjects.get === 'function') ? this.managedObjects.get('lan-daemon') : null;
      if (entry && entry.guardian !== true) {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督：lan-daemon 失联但守护开关关闭，不自动拉起（仅观测）');
        this._guardianEvent('lan', 'skip-guardian-off');
        return { ok: false };
      }
      if (entry) entry.restartCount = (entry.restartCount || 0) + 1;
      const rt = this._ensureLanRuntime(true);
      if (rt.mode === 'daemon' && rt.spawned) {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督：lan-daemon 失联，已重新拉起 pid=' + rt.spawned);
        this._guardianEvent('lan', 'pull', { pid: rt.spawned });
      } else if (rt.mode === 'error') {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督拉起失败: ' + (rt.error || '未知'));
      }
      return { ok: false };
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('[' + kind + '] 监督异常: ' + (e && e.message));
      return { ok: false };
    }
  }


  // ---- 远程控制委托：全部转发给 LanManager（system-services/relay/manager.js）----
  // L3b：daemon 监督模式 → 经 43108 ctl 委托（异步）；本地模式 → LanManager（同步）
  // 令牌收敛（2026-09，docs/token-management.md P1）：listLan 输出剔除 token/dshToken——
  // /lan-access 允许 LAN/私网 Host 访问，直出 dshToken 会把 DSH 会话令牌泄漏给局域网；
  // 权威仍在 DshTokenService（relay 经 tokenOf 内部读取，无需经此透传）。返回形如 {items,addresses}。
  listLan() {
    // 白名单外显（2026-09 可诊断层）：只放行结构字段与注入状态 inject；任何令牌字段都不外传。
    const sanitize = (r) => {
      if (!r || !r.items) return r;
      return { items: r.items.map((it) => {
        const out = {
          id: it.id, name: it.name, dshPort: it.dshPort, wanPort: it.wanPort,
          enabled: !!it.enabled, localPort: it.localPort || null, running: !!it.running,
        };
        if (it.inject) {
          out.inject = {
            tokenSet: !!it.inject.tokenSet,
            cookieReady: !!it.inject.cookieReady,
            lastOkAt: it.inject.lastOkAt || null,
            lastError: it.inject.lastError || null,
            lastErrorAt: it.inject.lastErrorAt || null,
          };
        }
        return out;
      }), addresses: r.addresses || [] };
    };
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('list').then(sanitize).catch(() => ({ items: [], addresses: [] }));
    try { return sanitize(this.lan.list()); } catch { return { items: [], addresses: [] }; }
  }

  setLanFrp(id, frpEnabled, frpRemotePort) {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('setFrp', [id, frpEnabled, frpRemotePort]);
    return this.lan.setFrp(id, frpEnabled, frpRemotePort);
  }

  frpStatus() {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('frpStatus');
    return this.lan.frpStatus();
  }
  lanFrpc(action, body) {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('frpAction', [action, body]);
    return this.lan.frpAction(action, body);
  }

  syncFrpc() {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) { this._lanCtlCall('syncFrpc').catch(() => {}); return; }
    this.lan.syncFrpc();
  }
  // ---- 智能路由开关管理 ----
  async setRouterRunning(on) {
    // 统一生命周期视图同步：router 启停状态镜像到 lifecycleManager（归一化：启停路径收敛）
    const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (on) {
      // L3：优先独立 router-daemon（detached，守卫重启不影响）；daemon 不可用退回内嵌
      const rt = this._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        this.config.routerAutostart = true;
        this.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting'); /* healthy 由 _supervise mirror 观测置位 */ }
        return { ok: true, mode: rt.mode, ...this.routerStatus() };
      }
      const r = await this.router.start();
      this.config.routerAutostart = true;
      this.persistConfigPatch({ routerAutostart: true });
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; } /* healthy 由 _supervise mirror 观测置位 */ }
      return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...this.routerStatus() };
    }
    // 停止：若 daemon 在跑 → 停 daemon；否则停内嵌 router
    const rt = this._ensureRouterRuntime(false);
    if (rt.mode === 'daemon' && rt.stopping) {
      this.config.routerAutostart = false;
      this.persistConfigPatch({ routerAutostart: false });
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
      return { ok: true, mode: 'daemon', ...this.routerStatus() };
    }
    const r = this.router.stop();
    this.config.routerAutostart = false;
    this.persistConfigPatch({ routerAutostart: false });
    if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
    return { ok: r.ok !== false, already: !!r.already, mode: 'embedded', ...this.routerStatus() };
  }

  routerStatus() {
    const st = this.router.status();
    return { running: !!st.running, autostart: this.config.routerAutostart === true, ...st };
  }

  /** R4 域摘要（目录合成视图）：daemon 监督模式 → 目录 router-daemon 项 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式 → 本地 RouterService 实时摘要。 */
  routerDomainSummary() {
    if (this.routerDaemonActive()) {
      try {
        const e = this.managedObjects && typeof this.managedObjects.get === 'function' ? this.managedObjects.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const s = this.router && typeof this.router.domainSummary === 'function' ? this.router.domainSummary() : null;
      return { ok: true, source: 'embedded', summary: s };
    } catch (e2) {
      return { ok: false, source: 'embedded', error: (e2 && e2.message) || String(e2) };
    }
  }

  /** router 生命周期视图同步（C3-5b：取代旧观测镜像层——视图数据并入目录/本拍实然）。
   *  契约：desired 只表达「应运行」（由启停动作设置）；healthy/error/lastProbeAt 只由真实观测写入；
   *  phase 收敛为守卫视角期望视图（desired=running→running；stopped→stopped）。
   *  红线：不读取/不写入 router 业务状态（回收/切换/预热/冻结仍归资源自治）。
   *  @param o { ok?:boolean, error?:string } 本拍实然（缺省回退目录 router-daemon lastObserved） */
  _syncRouterLifecycleView(o) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (!lc) return;
    const e = (this.managedObjects && typeof this.managedObjects.get === 'function') ? this.managedObjects.get('router-daemon') : null;
    const ob = (e && e.lastObserved) || null;
    const ok = !!(o && o.ok !== undefined) ? !!(o && o.ok) : !!(ob && ob.ok);
    const err = (o && o.error !== undefined) ? o.error : ((ob && ob.error) || 'router-daemon 未就绪');
    const at = (o && o.at) || (ob && ob.at) || new Date().toISOString();
    const wantRunning = lc.desired === 'running' || lc._monitoring === true;
    lc.lastProbeAt = at;
    if (!wantRunning) {
      // 期望停止：phase=stopped、healthy=false（观测无意义）
      if (lc.phase !== 'stopped') lc._setPhase('stopped');
      lc.healthy = false;
      return;
    }
    if (lc.phase !== 'running') lc._setPhase('running');
    lc.healthy = ok;
    if (ok) { lc.error = null; } else { lc.error = err; }
  }

  /** instances 聚合视图真实化（C3-5b）：lifecycle 的 instances 项表示「实例管理服务」（驻守卫进程，
   *  恒 running/healthy），不再是无观测的死登记。每心跳刷新一次（_dshSuperviseOnce 调用）。 */
  _syncInstancesLifecycleView() {
    const lc = this.lifecycleManager ? this.lifecycleManager.get('instances') : null;
    if (!lc) return;
    lc.wantRunning();
    lc._monitoring = true;
    lc.healthy = true;
    lc.error = null;
    lc.lastProbeAt = new Date().toISOString();
    if (lc.phase !== 'running') {
      lc._setPhase('running');
      lc.startedAt = lc.startedAt || new Date().toISOString();
    }
  }

  /** 守护动作事件（阶段四，事件脊）：统一记录守护决策/动作，带资源关联键，供审计回放。
   *   action: pull(拉起) | skip-guardian-off(守护关闭仅观测)。只读统一状态机 restartCount，不碰业务。 */
  _guardianEvent(resource, action, extra) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get(resource) : null;
    const e = Object.assign({ resource, action }, extra || {});
    if (lc) e.restartCount = lc.restartCount || 0;
    if (this.events && this.events.append) { try { this.events.append('guardian_action', e); } catch (err) { this.logger && this.logger.warn && this.logger.warn('guardian_action event: ' + (err && err.message)); } }
    return e;
  }



  // ---- 开机自启（整条服务链）：systemd 单元 + linger + GUI 自启——交给 infra/host-service ----
  autostartStatus() {
    return this.hostService.autostartStatus();
  }

  setAutostart(on) {
    return this.hostService.setAutostart(on);
  }

  // ---- 环境状态（Phase1 壳写 runtime.json；EnvCatalog 声明式探测）----
  envStatus() {
    const rt = {};
    try { const f = path.join(path.dirname(this.config.stateFile), 'runtime.json'); if (fs.existsSync(f)) Object.assign(rt, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
    const cat = new EnvCatalog(this.config).probe();
    const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function' ? this.nativeManager.checkEnvironment() : null;
    return {
      node: { detected: cat.node.detail || null, runtime: rt.nodeVersion || null, path: rt.nodePath || null },
      npm: { detected: cat.npm.detail || null },
      git: { detected: cat.git.detail || null },
      installedAt: rt.installedAt || null,
      source: rt.source || null,
      ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
      npmRoot: en ? en.npmRoot : null,
      // EnvCatalog 声明式视图（面板环境卡演进用）
      catalog: (envCatalogSummary(this)),
    };
  }

  /** Node LTS 在线检查（6h 缓存 + 失败降级）：探测当前 node 运行版本并给出 LTS 建议。
   *  实现不做远端查询（避免守卫启动依赖网络）——本地判定 + 可刷新缓存；
   *  失败返回 { ok:false, error } 由前端降级展示，绝不抛异常。 */
  async nodeLtsStatus() {
    try {
      const cacheFile = path.join(path.dirname(this.config.stateFile), 'node-lts-cache.json');
      const now = Date.now();
      let cache = null;
      try { if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
      if (cache && now - (cache.fetchedAt || 0) < 6 * 3600 * 1000) {
        return { ok: true, ...cache, cached: true };
      }
      const ver = process.versions.node || '';
      const major = parseInt(String(ver).split('.')[0], 10) || 0;
      // LTS 建议：Node 偶数主版本为 LTS 线（保守本地判定，不作远端断言）
      const ltsLine = major % 2 === 0;
      const data = {
        current: ver,
        major,
        ltsLine,
        suggested: '当前 ' + ver + (ltsLine ? '（偶数主版本线，通常为 LTS）' : '（奇数主版本非 LTS 线，建议偶数主版本）'),
        fetchedAt: now,
      };
      try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {}
      return { ok: true, ...data, cached: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 守卫自更新「重启生效」衔接：仅当配置 guardRestartAllowed=true 且存在 systemd 用户单元才执行；
   *  否则返回明确指引（避免误杀/误起守卫）。 */
  /** 自更新后的守卫重启（A2）：能力按部署形态自动判定（SEA=systemd 重启闭环；源码形态=拒绝），
   *  去掉 guardRestartAllowed 人工配置门槛。重启前落盘「预期版本」，重启后 /status 校验自报版本
   *  达标才算更新成功——闭环可观测，不再出现"装了没生效"的静默失败。 */
  guardSelfUpdateRestart() {
    const dep = deploy.detect();
    if (!dep.updatable) {
      return { ok: false, error: dep.reason || '当前部署形态不支持自动重启', form: dep.form };
    }
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'dsh-supervisor.service');
    if (!fs.existsSync(unit)) return { ok: false, error: '系统未启用 systemd 用户单元，请手动重启守卫' };
    // 预期版本落盘：最近一次 apply 的目标版本（restart 后 status 校验用）
    const swDir = path.dirname(this.config.stateFile);
    try { fs.writeFileSync(path.join(swDir, 'self-update-expected.json'), JSON.stringify({ expectedVersion: this._selfUpdateExpectedVersion || null, at: Date.now() }), { mode: 0o600 }); } catch {}
    try {
      execFileSync('systemctl', ['--user', 'restart', 'dsh-supervisor'], { stdio: 'ignore', timeout: 20000 });
      if (this.events) this.events.append('guard_self_update_restart', { expectedVersion: this._selfUpdateExpectedVersion || null });
      return { ok: true, restarted: true };
    } catch (e) { return { ok: false, error: 'systemctl restart 失败: ' + e.message }; }
  }

  // ---- 守卫自更新（2026-09 收敛：npm 通道取代 manifest/目录翻转）----
  guardSelfUpdateDir() {
    return this.config.selfUpdateDir || null;
  }

  /** 内核 npm 子包名（按当前平台/架构）。corePackageName 可为显式常量或含 {os}/{arch} 占位的模板。 */
  guardCorePkg() {
    const raw = this.config.corePackageName;
    if (!raw) return null;
    const map = { win32: 'win', linux: 'linux', darwin: 'darwin' };
    return String(raw).replace(/{os}/g, map[process.platform] || process.platform).replace(/{arch}/g, String(process.arch)) || null;
  }

  /** 守卫自更新（2026-09 收敛：npm 通道）——查 @dsh-sup/dsh-core-<os>-<arch> 全 tag 最高版本（全更新：
   *  BETA/RC/正式都算更新，任一更高即提示可更新），对本机 guardVersion 比较。 */
  async guardSelfUpdateStatus() {
    const pkg = this.guardCorePkg();
    if (!pkg) return { ok: false, error: '未配置内核自更新包（corePackageName）' };
    if (!this.dist || typeof this.dist.fetchLatestVersion !== 'function') return { ok: false, error: '发布服务未初始化' };
    // 部署形态判定（A1）：npm 自更新仅适用于标准产品形态（SEA 单文件二进制）。
    // 源码开发形态（bin 壳 require 源码目录）装新二进制永远不生效——显式拒绝，面板不再假装成功。
    const dep = deploy.detect();
    if (!dep.updatable) {
      return { ok: false, error: dep.reason, form: dep.form, updatable: false };
    }
    try {
      // authoritative：内核自更新查官方 registry——镜像同步延迟会把新版本误判为『已是最新』
      // （实测：npmmirror 对 @dsh-sup scope 包同步滞后，发布后面板『检查更新』漏报）。
      const latest = await this.dist.fetchLatestVersion(pkg, this.config.releaseChannel || 'npm', { authoritative: true });
      // 双版本口径（A3）：running = 进程启动时固化的编译期常量；disk = 磁盘二进制实况。
      // 运行中进程不可能装后即变——restartRequired/更新待重启以此判定，不再自相矛盾。
      const installed = this.guardVersion;
      if (!latest) return { ok: false, error: '官方源不可达或未查询到版本' };
      const updateAvailable = semverCompare(latest, installed) > 0;
      if (this.events) this.events.append('guard_self_update_checked', { installed, latest, updateAvailable });
      return { ok: true, pkg, installed, latest, updateAvailable, form: dep.form, updatable: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 应用内核更新（npm 通道，全更新强制语义）：`npm i -g <pkg>@<latest>`。
   *  安装后由调用方（壳/面板）据 restartRequired 调 /self-update/restart-guard（或手动重启）生效。 */
  async guardSelfUpdateApply() {
    const pkg = this.guardCorePkg();
    if (!pkg) return { ok: false, error: '未配置内核自更新包（corePackageName）' };
    if (!this.dist || typeof this.dist.runNpmInstall !== 'function') return { ok: false, error: '发布服务未初始化' };
    if (!this.config.installCommandTemplate || !Array.isArray(this.config.installCommandTemplate)) return { ok: false, error: '未配置安装命令模板（installCommandTemplate）' };
    // 部署形态门槛（A1）：status 已含判定；updatable=false 直接拒绝（源码形态装 SEA 永不生效）
    const latest = await this.guardSelfUpdateStatus();
    if (!latest.ok || !latest.latest) return { ok: false, error: (latest && latest.error) || '版本查询失败' };
    if (latest.updatable === false) return { ok: false, error: latest.error || '当前部署形态不支持自更新', form: latest.form };
    if (!latest.updateAvailable) return { ok: true, upToDate: true, version: this.guardVersion }; // 已最新，无需更
    // 全更新语义：latest > 当前即强制安装（无跳过）
    const target = latest.latest;
    try {
      // 下载源强制官方 registry（B）：内核自更新是「真相源+下载源统一」的闭环——
      // 镜像 tarball 曾出现 stale（拉到旧版本二进制），官方源才有版本一致性保证。
      // 沙箱安装等大流量场景仍走 selectRegistry 镜像。
      const registry = 'https://registry.npmjs.org';
      const r = await this.dist.runNpmInstall({
        pkg,
        version: target,
        commandTemplate: this.config.installCommandTemplate,
        registry,
        onLine: (l) => { if (this.logger && this.logger.info) this.logger.info('[self-update] ' + l); },
      });
      if (r && r.ok) {
        // 安装结果校验（A1 闭环）：磁盘上的二进制必须真的变成目标版本——
        // 防「npm i 成功但装到与运行位无关的位置/镜像 stale」类静默失败（本次生产实测）。
        let diskVersion = null;
        try { diskVersion = deploy.detect().runningTarget ? this._readBinarySelfVersion() : null; } catch {}
        const verified = diskVersion === target;
        this._selfUpdateExpectedVersion = verified ? target : null; // 重启后 status 校验用（A3）
        const restartRequired = true;
        if (this.events) {
          this.events.append('guard_self_update_applied', { from: this.guardVersion, version: target, pkg, diskVersion, verified });
        }
        if (!verified) {
          return { ok: true, from: this.guardVersion, version: target, diskVersion, verified: false, restartRequired,
            warn: '已安装但磁盘版本校验未通过（装到非运行位/镜像 stale），请检查部署形态' };
        }
        return { ok: true, from: this.guardVersion, version: target, diskVersion, verified: true, restartRequired };
      }
      return { ok: false, error: (r && r.error) || 'npm 安装失败' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 自更新「已安装待重启生效」判定（A3）：最近一次 apply 落盘的预期版本存在、
   *  且进程运行版本仍低于它 → updatePending=true（面板显示重启提示；重启达标后自动清除）。 */
  _selfUpdatePending() {
    try {
      const swDir = path.dirname(this.config.stateFile);
      const f = path.join(swDir, 'self-update-expected.json');
      if (!fs.existsSync(f)) return false;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const expected = j && j.expectedVersion;
      if (!expected) return false;
      if (this.guardVersion === expected) { // 已达标：清除标记（一次性）
        try { fs.unlinkSync(f); } catch {}
        if (this.events) this.events.append('guard_self_update_verified', { version: expected });
        return false;
      }
      return semverCompare(expected, this.guardVersion) > 0; // 预期更新才叫 pending；回退场景不标
    } catch { return false; }
  }

  /** 读磁盘上运行位二进制的自报版本（A1 校验用）：spawn --version，解析 guardVersion= 行。
   *  仅 SEA 二进制支持（source-shell 形态在读 package.json，与 npm 安装无关）。 */
  _readBinarySelfVersion() {
    const dep = deploy.detect();
    if (dep.form !== 'sea-binary' || !dep.runningTarget) return null;
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(dep.runningTarget, ['--version'], { timeout: 20000, encoding: 'utf8' });
      const m = /dsh-supervisor v([^s]+)/.exec(out);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // ---- DSH 即安即用：本体安装状态判定（命令指向的 bin 可执行 + 已管实例版本）----
  dshenvStatus() {
    let bin = null, binOk = false, installed = null, cmdOk = false;
    try {
      const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
      cmdOk = cmd0.length > 0;
      bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
      if (bin) binOk = fs.existsSync(bin);
    } catch {}
    try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
    // main = 守卫核心服务(概念清分)：受管状态以 config.command 有效为准（不再依赖沙箱实例登记）
    return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this._mPhase() || null };
  }

  // ---- 管家自身版本检查（与 DSH 更新解耦）：本地仓库 git 视角，配了远程才 fetch 比对 ----
  /** VCS 根解析：从 dsh-supervisor/ 上溯找最近的「外层」.git（排除自身嵌套仓）。
   *  修复（2026-09）：原 path.resolve(__dirname,'..') 命中 dsh-supervisor/.git 嵌套仓，
   *  其 HEAD 与真实外层仓脱节（嵌套仓 06:29 早于外层 07:15 提交）→ UI 版本/commit 失真。
   *  找不到外层仓时回退自身目录（行为与历史一致，commit 解析失败仍为 null）。 */
  _vcsRoot() {
    let dir = path.resolve(__dirname, '..'); // dsh-supervisor/
    const innerGit = path.join(dir, '.git');
    let parent = path.dirname(dir);
    while (parent !== path.dirname(parent)) {
      const cand = path.join(parent, '.git');
      if (cand !== innerGit && fs.existsSync(cand)) return parent; // 最近的外层仓
      parent = path.dirname(parent);
    }
    return dir; // 无外层仓：回退自身（嵌套仓/部署态）
  }

  /** 本地视角（无网络 I/O，同步安全）：commit + 是否配了 upstream。 */
  guardVersionLocal() {
    const root = this._vcsRoot();
    let commit = null;
    try { commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    let upstream = 'local';
    try {
      const up = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}'], { encoding: 'utf8' }).trim();
      if (up) upstream = 'git-repo';
    } catch {}
    // version = 进程运行版本（启动时固化，SEA 为编译期常量）——语义明确标注（A3）。
    // 磁盘实况版本（runningVersion vs diskVersion 的 updatePending 判定）在 async guardVersionCheck。
    return { version: this.guardVersion, runningVersion: this.guardVersion, commit, updateAvailable: false, upstream, latest: this.guardVersion };
  }

  /**
   * 完整版本检查（async）：本地 commit + 远端 fetch 比对。
   * 关键架构约束：git fetch 是网络 I/O，绝不能同步执行（会冻结整个事件循环，守卫假死且无法自愈）。
   * 这里用 execFile（异步）+ 10s 超时；fetch 失败/超时只降级为「本地视图」，不抛错。
   */
  async guardVersionCheck() {
    const base = this.guardVersionLocal();
    if (base.upstream !== 'git-repo') return base;
    const root = this._vcsRoot();
    const fetchOk = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const child = execFile('git', ['-C', root, 'fetch', '--quiet'], { timeout: 10000 }, (err) => done(!err));
        child.on('error', () => done(false));
      } catch { done(false); }
    });
    if (!fetchOk) return base; // fetch 失败：保持本地视图，不误报
    let updateAvailable = false;
    try {
      const ahead = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}'], { encoding: 'utf8' }).trim();
      updateAvailable = parseInt(ahead, 10) > 0;
    } catch {}
    // A3：磁盘运行位实况版本 vs 进程运行版本——不一致 = 「更新已安装、待重启生效」
    const dep = deploy.detect();
    let diskVersion = null;
    if (dep.form === 'sea-binary') diskVersion = this._readBinarySelfVersion();
    const updatePending = !!(diskVersion && diskVersion !== this.guardVersion);
    return { ...base, diskVersion, updatePending };
  }

  // ---- 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）----
  lanPanelStatus() {
    const enabled = this.config.apiHost === '0.0.0.0';
    const port = this.config.apiPort;
    // 真实可访问地址（2026-09 用户指正）：只给局域网内设备真正能访问的地址——
    // 取「走默认路由的真实出口网卡」的 IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
    const ips = [];
    if (enabled) {
      try {
        const { execFileSync } = require('node:child_process');
        // 1) 先找默认路由关联的出口网卡名
        let dev = null;
        try {
          const def = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
          dev = (def.match(/dev\s+(\S+)/) || [])[1] || null;
        } catch {}
        // 2) 枚举各网卡 IPv4（记录 secondary/dynamic 标志——DHCP 动态地址优先排除）
        const out = execFileSync('ip', ['-o', 'addr', 'show'], { encoding: 'utf8' }).trim();
        const collected = {}; // iface -> [{ addr, dyn }]
        for (const line of out.split('\n')) {
          const m = line.match(/^\d+:\s+(\S+?)(@\S+)?\s+inet\s+([0-9.]+)\//);
          if (!m) continue;
          const iface = m[1];
          const addr = m[3];
          const dyn = /(?:secondary|dynamic)/.test(line);
          if (addr.startsWith('127.') || addr.startsWith('169.254.')) continue;
          if (/^(virbr|veth|docker|vmnet|br-|lo)/.test(iface)) continue;
          (collected[iface] = collected[iface] || []).push({ addr, dyn });
        }
        // 3) 每网卡取 1 个首选地址（静态优先；无静态才用 DHCP）；默认路由网卡排最前。
        const firstOf = (arr) => {
          const stat = arr.find((x) => !x.dyn);
          return (stat || arr[0]).addr;
        };
        if (dev && collected[dev]) {
          ips.push(firstOf(collected[dev]));
          delete collected[dev];
        }
        for (const iface of Object.keys(collected)) ips.push(firstOf(collected[iface]));
      } catch (e) { this.logger && this.logger.warn && this.logger.warn('lan ips: ' + e.message); }
    } else {
      ips.push('127.0.0.1');
    }
    // 去重保持稳定顺序
    const unique = [...new Set(ips)];
    return { enabled, host: this.config.apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
  }

  /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
  setLanPanel(enabled) {
    try {
      const host = enabled ? '0.0.0.0' : '127.0.0.1';
      const changed = this.config.apiHost !== host;
      this.config.apiHost = host;
      if (this.configPath) {
        try {
          const doc = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
          doc.apiHost = host;
          const ctmp = this.configPath + '.tmp';
          fs.writeFileSync(ctmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
          fs.renameSync(ctmp, this.configPath); // 原子 + 0600
        } catch (e) { this.logger.error('persist apiHost: ' + e.message); }
      }
      if (changed && this.api && typeof this.api.close === 'function') this._rebindApiHost();
      if (this.events) this.events.append('lan_panel_changed', { enabled });
      if (this.logger && this.logger.info) this.logger.info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
      return { ok: true, ...this.lanPanelStatus() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 出回环访问密钥（F2 定案）：状态查询 + 设置/清除（api.js 路由引用此门面；
  // 2026-09 修复：此前 api.js:493 调 sup.accessKeyStatus() 但 Supervisor 从未实现该门面 →
  // 设置页每次 GET 抛 uncaughtException → 守卫 60s 3 次异常自杀重启 → 设置页长时间无响应。）----
  /** 状态（不回显明文）：configured + host。 */
  accessKeyStatus() {
    const cfg = this.config || {};
    return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
  }

  /** 设置/清除出回环访问密钥（空串=清除）。原子持久化到守卫 config。 */
  setAccessKey(key) {
    try {
      const cfg = this.config || {};
      const k = typeof key === 'string' ? key.trim() : '';
      if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
      cfg.apiAccessKey = k || null;
      if (this.configPath) this.persistConfigPatch({ apiAccessKey: k || null });
      if (this.events) this.events.append('access_key_changed', { configured: !!k });
      return { ok: true, configured: !!k };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 关闭窗口行为（2026-09 用户定稿）：隐藏至托盘 / 退出管家（壳读取执行；系统级配置）----
  /** 当前关闭行为：'hide' | 'exit'。 */
  closeActionStatus() {
    const cfg = this.config || {};
    const v = cfg.closeAction;
    return { closeAction: (v === 'exit') ? 'exit' : 'hide' };
  }

  /** 设置关闭行为（'hide'=关闭隐藏至托盘，服务继续；'exit'=关闭=退出管家，停止全部服务链）。 */
  setCloseAction(v) {
    try {
      const val = (v === 'exit') ? 'exit' : 'hide';
      const cfg = this.config || {};
      cfg.closeAction = val;
      if (this.configPath) this.persistConfigPatch({ closeAction: val });
      if (this.events) this.events.append('close_action_changed', { closeAction: val });
      return { ok: true, closeAction: val };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 退出管家（2026-09 用户定稿）：完全关闭 = 停全部服务链 + 守卫自身退出 ----------------
  /** 停掉被监管的 DSH 主实例（spawn/adopt 目标），并将期望状态持久化为 stopped——
   *  「退出管家」= 用户显式要求全部停止：若只杀进程不翻 desired，systemd Restart=always
   *  拉起守卫后收敛循环会按 desired=running 重新拉起 DSH，与服务链全停意图相悖。 */
  _stopMainDsh() {
    try {
      if (this._mDesired() !== 'stopped') this.setDesired('stopped'); // 显式意图：持久化期望状态
      if (this._mChild() || this._mAdoptPid()) { this.stopProcess('main'); }
    } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop main: ' + e.message); }
  }

  /** 停掉全部沙箱实例（systemctl stop dsh-web@*）。 */
  _stopAllSandboxes() {
    try {
      execFileSync('systemctl', ['--user', 'stop', 'dsh-web@*'], { stdio: 'ignore', timeout: 20000 });
    } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop sandboxes: ' + e.message); }
  }

  /** 退出管家：停止全部服务链（DSH 主实例 + 沙箱 + 路由/远程 daemon），随后守卫自身退出
   *  （systemd 单元 Stop 不触发 Restart=always；无单元则直接 exit）。供壳「退出管家」/托盘退出调用。 */
  async shutdownAll() {
    this.logger.info('[shutdown] 退出管家：停止全部服务链…');
    this.events && this.events.append('shutdown_all', {});
    // 1) 停 DSH 主实例
    this._stopMainDsh();
    // 2) 停全部沙箱
    this._stopAllSandboxes();
    // 3) 停路由/远程 daemon（独立进程；DaemonLifecycle.stop 串行换代语义）
    try { const rl = this._daemonLifecycle('router'); if (rl) await rl.stop(); } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop router: ' + e.message); }
    try { const ll = this._daemonLifecycle('lan'); if (ll) await ll.stop(); } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop lan: ' + e.message); }
    // 4) 守卫自身退出：优先 systemd stop（Stop 后不再 Restart=always 拉起）；无单元直接 exit
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'dsh-supervisor.service');
    const selfExit = () => { try { this.shutdown(); } catch {} process.exit(0); };
    if (fs.existsSync(unit)) {
      try {
        this.logger.info('[shutdown] systemctl --user stop dsh-supervisor（防 Restart=always）');
        execFileSync('systemctl', ['--user', 'stop', 'dsh-supervisor'], { stdio: 'ignore', timeout: 15000 });
        return { ok: true };
      } catch (e) { this.logger.warn && this.logger.warn('shutdownAll stop guard unit failed: ' + e.message); }
    }
    selfExit();
    return { ok: true };
  }

  /** 平滑重绑 API host：旧 server close + 强制断连释放端口，新 server 重试 listen。
   *  关键：旧 keep-alive 连接未断时端口不会释放，直接 listen 会 EADDRINUSE 把 API 打死。
   *  这里 closeAllConnections() 立即断开空闲连接，并带重试（最多 10 次 × 300ms）。 */
  _rebindApiHost() {
    const { createServer } = require('./api/index');
    const old = this.api;
    if (old) {
      try { old.close(); } catch {}
      try { if (typeof old.closeAllConnections === 'function') old.closeAllConnections(); } catch {}
    }
    const bind = () => {
      const server = createServer(this);
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // 端口仍被旧连接占用：短暂等待后重试；10 次后降级为 30s 慢重试（持续自愈，绝不永久下线）
          const tries = bind._tries || 0;
          if (tries < 10) {
            bind._tries = tries + 1;
            setTimeout(bind, 300);
          } else {
            bind._tries = 0;
            setTimeout(bind, 30000);
            this.events.append('api_error', { message: 'API 重绑端口持续被占用，30s 后自动重试: ' + err.message });
            this.logger.error('api rebind degraded (30s slow retry): ' + err.message);
          }
          return;
        }
        this.events.append('api_error', { message: err.message });
        this.logger.error('api error: ' + err.message);
      });
      server.listen(this.config.apiPort, this.config.apiHost, () => {
        bind._tries = 0;
        this.api = server;
        this.events.append('api_listening', { host: this.config.apiHost, port: this.config.apiPort });
        this.logger.info('api listening on ' + this.config.apiHost + ':' + this.config.apiPort);
      });
    };
    bind._tries = 0;
    this.api = null;
    bind();
  }

  /** 桌面通知（平台层最佳努力）：关键事件即使面板没开也能触达用户。
   *  三端同能力（Linux notify-send / macOS osascript / Windows 气泡）；环境缺失时停用。 */
  notify(title, body) {
    if (!this.notifyEnabled) return;
    platform.notify(title, body, () => {
      this.notifyEnabled = false; // 环境无通知工具，静默停用
      this.logger.warn('桌面通知不可用（' + process.platform + '），已停用');
    });
  }

  // ---- 升级流程挂钩（先停后装，消除运行中替换文件的混合版本窗口）----
  _enterUpgradeHold() {
    this._upgradeHold = true;
    this._upgradeHoldSince = Date.now();
    const targetAlive =
      (this._mChild() && this._mChild().exitCode === null && this._mChild().signalCode === null) ||
      (this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid()));
    if (targetAlive) {
      this.stopProcess('upgrade'); // systemd 下 stopProcess → stopInstance('main')，落实“先停后装”
    } else if (this._mPhase() !== 'STOPPED') {
      this._mSetPhase('STOPPED');
      this.writeState();
    }
  }

  /** 升级前停目标并【等待其真正退出】（先停后装的完整语义，消除混合版本窗口）。
   *  - spawn 模式：stopProcess 只发 SIGTERM 即返回（SIGKILL 兜底在 stopGraceMs 后）——
   *    若不等 exit 就开始 npm install，旧进程存活期间文件被替换。这里等待 child.exit / pid 消亡，
   *    超时上限 = stopGraceMs + 5s 兜底（届时 SIGKILL 兜底定时器已触发）。
   *  - systemd 模式：stopInstance 是同步 systemctl stop，返回时已停完。 */
  async _enterUpgradeHoldAsync() {
    // 先捕获目标引用：_enterUpgradeHold 内部 stopProcess 会清空 child/adoptedPid，
    // 必须在调用前保存，否则无法等待旧进程退出。
    const refs = { child: this._mChild(), adoptedPid: this._mAdoptPid() };
    this._enterUpgradeHold();
    // 等待目标进程退出（有句柄的 child 或仅有 pid 的接管实例）
    if (refs.child && refs.child.exitCode === null && refs.child.signalCode === null) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        refs.child.once('exit', done);
        setTimeout(done, this.config.stopGraceMs + 5000);
      });
      return;
    }
    if (refs.adoptedPid && pidlook.isAlive(refs.adoptedPid)) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        // stopProcess 的 _killAdopted 同样有 SIGKILL 兜底定时器
        const check = () => {
          if (!pidlook.isAlive(refs.adoptedPid)) return done();
          if (Date.now() > start + this.config.stopGraceMs + 5000) return done();
          setTimeout(check, 200);
        };
        const start = Date.now();
        check();
      });
      return;
    }
  }

  _exitUpgradeHold(explicit) {
    this._upgradeHold = false;
    this._upgradeHoldSince = null;
    // 升级完成后恢复运行 = 用户显式意图（点升级即意图）：登记后由收敛循环消费——
    // 守护开关（guardian 默认关）不再拦截升级恢复（审计 P1-3：升级后 DSH 不自动拉起）。
    if (explicit) this.intents.register('upgrade-resume');
    this.tick();
  }

  // ══ C3-3b G1：main(dsh) 影子对比框架（先建，纯新增；并行不驱动）══
  // 定位（C3-3b G1 影子框架）：旧 tick 仍是唯一驱动，
  // 本框架只按现有 tick 语义「纯计算应然下一步」并把实际迁移记入事件——绝不执行。
  // heartbeat dsh adapter 由 observe 升级为 supervise（G3 复用同一 supervise 驱动点）；
  // supervise 调 _shadowCompute() 产出 action 与旧 tick 实际 phase 迁移对比（diff 时 warn，
  // 连续 5 拍零 diff 才允许 G3 切换）。影子与 actual 对比在 tick 同步域内完成
  // （t0 快照→拍末对比），消除「双定时器异步竞态」的假 diff；心跳拍只做聚合记账/日志。

  /** dsh adapter 监督单拍（C3-3b G1 observe → supervise 接管；C3-5 终态：唯一心跳驱动 main）。
   *  每拍先调 _dshConverge()（=原 tick 收敛段；端口再推导/hold/manualRestart/adopt令牌/假死
   *  业务钩子全在收敛段内）驱动 main，再做实例聚合视图刷新与影子记账（自洽校验日志）。
   *  返回实然观测（ok 与探测同源），heartbeat 统一写入目录 lastObserved。 */
  async _dshSuperviseOnce() {
    try {
      if (this._stopping) return { ok: false, error: 'guard stopping' };
      await this._dshConverge(); // 唯一心跳驱动 main 收敛
      try { this._syncInstancesLifecycleView(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('instances view sync: ' + ((e && e.message) || e)); } // C3-5b：聚合视图随心跳刷新
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[dsh] supervise 异常: ' + ((e && e.message) || e));
    }
    this._shadowHeartbeatBeat(); // 影子聚合（每拍对新 tick 记录记账/事件）
    // R5 游离对象自检（低频 ~60s，只告警）：目录/期望之外的受管族进程与端口
    try {
      const now = Date.now();
      if (!this._lastOrphanAuditAt || now - this._lastOrphanAuditAt > 60000) {
        this._lastOrphanAuditAt = now;
        this._orphanAudit();
      }
    } catch (e) { this.logger && this.logger.debug && this.logger.debug('orphan audit: ' + ((e && e.message) || e)); }
    // 系统日志框架（P1b）：守卫 EventHub 每拍聚合 guard + daemon(ctl 拉尾, 节流 ~6 拍) 事件
    if (this.eventHub) { try { await this.eventHub.sync(); } catch (e) { this.logger && this.logger.debug && this.logger.debug('eventHub sync: ' + ((e && e.message) || e)); } }
    // C3-3a 观测语义保留：ok 与 tick 探测同源（lastProbeOk = L1 端口在线）
    return {
      ok: this._mLastProbeOk() === true,
      error: this._mLastProbeOk() ? null : (this._mPhase() === 'STOPPED' ? '未运行' : '端口未监听/不健康'),
    };
  }

  /** main(dsh) 当前状态快照（tick 探测后采样；纯读零副作用）。
   *  probeOk/probeHttpOk 即本拍真实探测（与旧 tick 决策同源）——影子与 actual 用同一输入。 */
  _mainStateSnapshot() {
    const now = Date.now();
    return {
      phase: this._mPhase(),
      desired: this._mDesired(),
      probeOk: this._mLastProbeOk() === true,
      probeHttpOk: this._mLastProbeHttpOk() === true,
      childAlive: !!(this._mChild() && this._mChild().exitCode === null && this._mChild().signalCode === null),
      adoptedAlive: !!(this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid())),
      adoptedPidSet: this._mAdoptPid() !== null,
      childPresent: this._mChild() !== null,
      adopted: this._mAdopted() === true,
      observedOnly: this._mObservedOnly() === true,
      upgradeHold: this._upgradeHold === true,
      manualRestart: this.manualRestart === true,
      spawnBlocked: !!(this._mSpawnBlockedUntil() && now < this._mSpawnBlockedUntil()),
      startDeadlinePassed: !!(this._mStartDeadline() && now > this._mStartDeadline()),
      restartDue: this._mRestartAt() === null || now >= this._mRestartAt(),
      backoffDue: this._mBackoffUntil() === null || now >= this._mBackoffUntil(),
      crashWindowStart: this._mCrashWindowStart(),
      crashWindowRestarts: this._mCrashWindowRestarts(),
      backoffLevel: this._mBackoffLevel(),
    };
  }

  /** 纯决策：按现有 tick 语义计算「应然下一步」。action 词表：
   *  none/start/stop/adopt/adoptObserved/enterRunning/restart/backoff。
   *  只读快照，零副作用（G1 影子 → G3 收敛复用同一决策源）。 */
  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    // ── desired=stopped（正交于守护开关；显式用户意图永远生效）──
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.probeOk) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    // ── 升级 hold：安装期间不拉起（超时自愈是业务钩子）──
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    // ── 手动重启请求（守卫业务标志，本拍消费）──
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', countCrash: false };
      if (s.phase === 'RESTARTING' || s.phase === 'BACKOFF') {
        // tick 语义：先清 backoff/restartAt 再立即拉起（!targetAlive）
        if (!targetAlive) return { action: 'start', reason: 'manual_retry' };
        // targetAlive → 落 switch（端口占用检查统一生效）
      }
      // phase===STOPPED → 落 switch
    }
    switch (s.phase) {
      case 'STOPPED': {
        if (s.probeOk) return { action: 'adopt', reason: 'adopt' };
        if (s.spawnBlocked) return { action: 'none', reason: 'command_missing_cooloff' };
        return { action: 'start', reason: 'spawn' }; // 端口占用复查在执行期（isPortListening）
      }
      case 'STARTING': {
        if (s.probeOk && s.probeHttpOk) return { action: 'enterRunning', reason: 'healthy' };
        if (s.startDeadlinePassed) return this._decideCrashRestart('start_timeout');
        return { action: 'none', reason: 'starting_wait' };
      }
      case 'RUNNING': {
        // adopt 令牌重建/假死识别是守卫业务钩子（adapter 外，G3 由 _dshConverge 保留）——纯决策不含
        if (s.adoptedPidSet && !s.adoptedAlive) return this._decideCrashRestart('adopted_exit');
        if (s.childPresent && !s.childAlive) return this._decideCrashRestart('child_exit');
        return { action: 'none', reason: 'running_steady' };
      }
      case 'RESTARTING': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'restart_adopt' };
        if (!targetAlive && s.restartDue) return { action: 'start', reason: 'restart_spawn' };
        return { action: 'none', reason: 'restart_wait' };
      }
      case 'BACKOFF': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'backoff_adopt' };
        if (!targetAlive && s.backoffDue) return { action: 'start', reason: 'backoff_spawn' };
        return { action: 'none', reason: 'backoff_wait' };
      }
      case 'OBSERVED': return { action: 'none', reason: 'observed_steady' };
    }
    return { action: 'none', reason: 'unknown_phase:' + s.phase };
  }

  /** 崩溃类 restart 决策：与 _beginRestart(countCrash=true) 语义一致——动作统一 restart
   *  （_beginRestart 内部 _bumpCrashWindow 的退避记账/crash_loop_entered 属守卫业务，不改变动作词）。 */
  _decideCrashRestart(reason) {
    return { action: 'restart', reason, countCrash: true };
  }

  /** 实际执行动作记账（拍窗口内）。仅在 tick 收敛窗口内生效（_actWindow）；
   *  窗口外的外部动作（child exit / 升级钩子）不记账——其迁移由后续拍相位对分类覆盖。 */
  _actNote(action, reason) {
    if (!this._actWindow) return;
    if (!this._mainTickActs) this._mainTickActs = [];
    this._mainTickActs.push({ action, reason });
  }

  /** 本拍实际执行的迁移动作：优先拍内执行器记录（最精确含 reason），否则按相位对分类。 */
  _mainActualAction(t0) {
    const acts = this._mainTickActs || [];
    if (acts.length > 0) return acts[acts.length - 1];
    const from = t0.phase;
    const to = this._mPhase();
    if (from === to) return { action: 'none', reason: 'steady' };
    const p = from + '>' + to;
    if (p === 'STOPPED>STARTING') return { action: 'start', reason: 'spawn' };
    if (p === 'STOPPED>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'adopt' } : { action: 'start', reason: 'spawn+enterRunning' };
    if (p === 'STOPPED>OBSERVED') return { action: 'adoptObserved', reason: 'observe' };
    if (p === 'STARTING>RUNNING') return { action: 'enterRunning', reason: 'healthy' };
    if (p === 'STARTING>RESTARTING') return { action: 'restart', reason: 'start_timeout' };
    if (p === 'STARTING>BACKOFF') return { action: 'restart', reason: 'start_crash' };
    if (p === 'RUNNING>RESTARTING') return { action: 'restart', reason: 'in_tick_restart' };
    if (p === 'RUNNING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'RESTARTING>STARTING') return { action: 'start', reason: 'restart_spawn' };
    if (p === 'RESTARTING>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'restart_adopt' } : { action: 'enterRunning', reason: 'restart_enter' };
    if (p === 'RESTARTING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'BACKOFF>STARTING') return { action: 'start', reason: 'backoff_spawn' };
    if (p === 'BACKOFF>RUNNING') return this._mAdopted() === true ? { action: 'adopt', reason: 'backoff_adopt' } : { action: 'enterRunning', reason: 'backoff_enter' };
    if (p === 'OBSERVED>RUNNING') return { action: 'adopt', reason: 'observed_promote' };
    // desired=stopped / 升级 hold 的收敛停止迁移
    if (this._mDesired() === 'stopped' || this._upgradeHold) {
      return { action: 'stop', reason: this._upgradeHold ? 'upgrade_hold' : 'desired_stopped' };
    }
    return { action: 'none', reason: 'unclassified:' + p };
  }

  /** 影子 diff 排除集：异步事件/守卫业务钩子触发（非主循环收敛决策可比范畴），
   *  不计入 diff 与零 diff 门槛。升级钩子 / child exit / spawn error / 假死 / adopt 令牌重建。 */
  _shadowExcluded(reason) {
    if (!reason) return false;
    const r = String(reason);
    return /^(exit:|spawn_error|http_unhealthy|adopt_token_reclaim|upgrade|upgrade_hold|port_occupied)/.test(r);
  }

  /** 拍末影子记账（tick finally 调用：本拍实际迁移已收敛完成）。 */
  _shadowTickNote(t0) {
    try {
      if (this._stopping) return;
      const actual = this._mainActualAction(t0);
      const shadow = this._decideMainAction(t0);
      const exActual = this._shadowExcluded(actual && actual.reason);
      const diff = !!(actual && shadow) && (actual.action !== shadow.action) && !exActual;
      const rec = {
        seq: ++this._shadowSeq,
        t0phase: t0.phase,
        phase: this._mPhase(),
        shadow: shadow.action + (shadow.reason ? ':' + shadow.reason : ''),
        actual: actual.action + (actual.reason ? ':' + actual.reason : ''),
        diff: !!diff,
        excluded: !!exActual,
      };
      this._shadowLast = rec;
      if (diff && this.logger && this.logger.warn) {
        this.logger.warn('[shadow] dsh 影子 vs 实际不一致: shadow=' + rec.shadow + ' actual=' + rec.actual + '（phase ' + rec.t0phase + '→' + rec.phase + '）');
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[shadow] 拍末记账异常: ' + ((e && e.message) || e));
    }
  }

  /** 心跳拍聚合（dsh adapter supervise 调用）：有新 tick 记录才记账/发事件；无则不刷。
   *  连续 5 拍零 diff 记 info（G3 切换门槛观测）。 */
  _shadowHeartbeatBeat() {
    try {
      const rec = this._shadowLast;
      if (!rec) return;
      if (this._shadowLoggedSeq === rec.seq) return; // 已记账
      this._shadowLoggedSeq = rec.seq;
      if (rec.excluded) {
        if (this.logger && this.logger.debug) this.logger.debug('[shadow] 拍#' + rec.seq + ' 业务钩子迁移(不计 diff): ' + rec.actual);
        return;
      }
      if (rec.diff) {
        this._shadowConsistentBeats = 0;
        this._shadowDiffBeats += 1;
      } else {
        this._shadowConsistentBeats += 1;
      }
      const ev = {
        seq: rec.seq,
        phase: rec.t0phase + '>' + rec.phase,
        shadow: rec.shadow,
        actual: rec.actual,
        diff: rec.diff,
        consistentBeats: this._shadowConsistentBeats,
        diffBeats: this._shadowDiffBeats,
      };
      if (this.events && this.events.append) { try { this.events.append('shadow_dsh_action', ev); } catch {} }
      if (!rec.diff && this._shadowConsistentBeats > 0 && this._shadowConsistentBeats % 5 === 0 && this.logger && this.logger.info) {
        this.logger.info('[shadow] dsh 影子与实际迁移连续 ' + this._shadowConsistentBeats + ' 拍零 diff——满足 G3 切换门槛');
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[shadow] 心跳记账异常: ' + ((e && e.message) || e));
    }
  }

  // ---- 主循环收敛段（C3-3b G3 起由唯一心跳驱动；外部操作仍可即时触发）----
  // 单一状态机：STOPPED/STARTING/RUNNING/RESTARTING/BACKOFF。
  // systemd 托管已废弃——main 由守卫 spawn/观测统一管理。
  async _dshConverge() {
    if (this._ticking || this._stopping) return;
    this._ticking = true;
    // C3-3b G1 影子拍：收敛窗口打开（拍内实际执行动作记账，供影子对比 actual）
    this._actWindow = true;
    this._mainTickActs = [];
    let t0 = null; // C3-3b G1 影子起点快照（try 内探测后赋值；finally 100% 可见）
    try {
      // 统一健康探测（domain/monitor）：L1 端口在线（up）+ L2 HTTP 健康（httpOk）。
      // up 维持状态机的「在线/离线」收敛语义（desired/升级 hold/接管均以端口为准，不破坏原语义）；
      // httpOk 是新增的健康维度：端口在但 HTTP 挂（事件循环卡死/假死）→ 连续 failThreshold 次判故障。
      const probeRes = await monitor.probe(this.config.targetHost, this.config.targetPort, {
        httpProbeEnabled: this.config.httpProbeEnabled !== false,
        healthUrl: this.config.healthUrl,
        httpTimeoutMs: this.config.probeTimeoutMs || 3000,
      });
      const portUp = probeRes.up;
      const healthOk = probeRes.httpOk;
      this._mSetLastProbeAt(new Date().toISOString());
      this._mSetLastProbeOk(portUp);
      // C3-3b G1 影子：HTTP 健康维度同源快照（startDeadline/健康收敛决策用）
      this._mSetLastProbeHttpOk(healthOk);
      // C3-3b G1 影子：拍起点快照（探测后、收敛前——与旧 tick 决策同输入同源）
      t0 = this._mainStateSnapshot();
      // C3-3b G5：dsh 健康面改由 _syncDshLifecycleView 从目录 main entry 合成（不再经观测镜像喂入）
      // systemd 托管已废弃（C3-3b G4：托管死分支整体移除）：main 由守卫 spawn/adopt 统一管理。
      const host = this.config.targetHost;
      const port = this.config.targetPort;
      // spawn 托管：目标在线 = 自有 child 或接管 pid 存活。
      const childAlive = this._mChild() !== null && this._mChild().exitCode === null && this._mChild().signalCode === null;
      const adoptedAlive = this._mAdoptPid() !== null && pidlook.isAlive(this._mAdoptPid());
      const targetAlive = childAlive || adoptedAlive;

      // 原生 DSH 端口运行时再推导兜底（2026-09）：期望运行/观测中，配置端口无监听但受管 DSH
      // 进程在跑（用户改了端口等）→ 从进程真实 --port 更正（30s 节流，防 churn）。
      if (!portUp && this._mDesired() !== 'stopped' && (childAlive || adoptedAlive || this._mObservedOnly())) {
        if (!this._lastMainPortRederive || Date.now() - this._lastMainPortRederive > 30000) {
          this._lastMainPortRederive = Date.now();
          const found = this._findManagedDshPort();
          if (found && found.port && found.port !== this.config.targetPort) {
            this._applyMainPort(found.port, found.pid);
            // 更正后本 tick 重探一次，让状态机立即看到新端口在线
            this.config.targetPort = found.port;
          }
        }
      }

      // systemd 托管下记录观测到的 pid（展示用 + 停止路径的目标识别）。
      // 必须早于 desired=stopped 分支执行：否则停止时 adoptedPid 尚未填充，
      // stopProcess 会因「无 systemd 单元可停、无 adoptedPid 可杀」而静默无效。
      // ── 期望状态调和优先于「进程守护」开关（desired 是正交轴）──
      // 显式 start/stop 是用户意图，必须永远生效：守护开关只约束「崩溃后自动拉起」，
      // 绝不约束用户主动点「启动 DSH / 停止 DSH」。此分支置于守护短路之前。
      if (this._mDesired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !this._mObservedOnly());
        if (managedAlive) {
          this.stopProcess('desired_stopped');
        } else if (adoptedAlive && this._mObservedOnly()) {
          if (this._mPhase() !== 'OBSERVED') {
            this._mSetPhase('OBSERVED');
            this.writeState();
          }
        } else if (portUp) {
          this._adoptObserved();
        } else {
          if (this._mAdoptPid() !== null && !adoptedAlive) {
            this.events.append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
            this._mSetAdoptPid(null);
            this._mSetObservedOnly(false);
          }
          if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
        }
        this.writeState();
        return;
      }

      // 升级 hold：安装期间不拉起；兜底超时自愈防止 hold 卡死导致服务永久下线
      // （systemd 托管专属的进程守护开关 gate 已随死分支移除——spawn 托管守卫天然负责拉起）
      if (this._upgradeHold) {
        if (targetAlive) {
          this.stopProcess('upgrade_hold');
        } else {
          if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
          const maxHold = (this.config.upgradeTimeoutMs || 600000) + 120000;
          if (this._upgradeHoldSince && Date.now() - this._upgradeHoldSince > maxHold) {
            this.events.append('upgrade_hold_timeout', {});
            this.notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            this._upgradeHold = false;
            this._upgradeHoldSince = null;
          }
        }
        this.writeState();
        return;
      }

      // 手动重启请求
      if (this.manualRestart) {
        this.manualRestart = false;
        if (this._mPhase() === 'RUNNING' || this._mPhase() === 'STARTING') {
          this._beginRestart('manual', { countCrash: false }); // _beginRestart 内部会停运行中的目标（systemd 或杀接管 pid），避免重复停
        } else if (this._mPhase() === 'RESTARTING' || this._mPhase() === 'BACKOFF') {
          this._mSetBackoffUntil(null);
          this._mSetRestartAt(Date.now());
          if (!targetAlive) await this._startProcess();
        }
        // phase === 'STOPPED' 时落到下方 switch，让端口占用检查统一生效
      }

      switch (this._mPhase()) {
        case 'STOPPED': {
          if (portUp) {
            // 接管既有实例（校验 DSH cmdline；spawn 托管）
            this._adopt();
            this._mSetSpawnBlockedUntil(null);
            this._mSetMissingNotified(false);
          } else if (this._mSpawnBlockedUntil() && Date.now() < this._mSpawnBlockedUntil()) {
            // 命令缺失冷静期：等待安装，不做无谓重试
          } else if (await monitor.isPortListening(host, port, 1000)) {
            // 端口被不健康进程占用：不硬抢，只告警
            this._warnOccupied();
          } else if (this._mGuardian() || this.intents.any()) {
            // 拉起条件（2026-09 收敛，与沙箱对齐）：守护开关开（恢复/接管自愈）或用户显式启动
            // （刚点「启动 DSH」/restart——显式意图永生效）；守护关且非显式 → 停留不拉，尊重 DSH 状态。
            this.intents.consume('start'); this.intents.consume('restart'); this.intents.consume('upgrade-resume'); // 意图一次性消费
            await this._startProcess();
          } else {
            // 守护关 + 非显式：保持停止（DSH 不在就不拉；adopt 已有进程已在上方处理）
            if (this._mPhase() !== 'STOPPED') this._mSetPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          if (portUp && healthOk) this._enterRunning();
          else if (Date.now() > this._mStartDeadline()) this._beginRestart('start_timeout', { countCrash: true });
          break;
        }
        case 'RUNNING': {
          // adopt 令牌接管（2026-09 第四轮）：被接管主 DSH 令牌不可达 → 观察窗后受控重建一次
          try { this._maybeReclaimAdoptToken(); } catch {}
          // spawn：只按进程存活判断，进程死了才重启，不因端口探测失败而误判
          // 守护语义（2026-09 收敛定稿，与沙箱对齐）：崩溃是否自动接管拉起看守护开关 guardian——
          // 开=自动拉起（退避自愈）；关=回到停止态（DSH 是什么状态就什么状态，等用户手动启动，不做过度设计）。
          const guarded = this._mGuardian();
          if (this._mAdoptPid() !== null && adoptedAlive === false) {
            this.events.append('dsh_exited', { code: null, signal: null, phase: this._mPhase(), adopted: true });
            this._mSetAdoptPid(null);
            if (guarded) this._beginRestart('adopted_exit', { countCrash: true });
            else { this.events.append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); this._mSetPhase('STOPPED'); }
          } else if (!childAlive && this._mChild()) {
            if (guarded) this._beginRestart('child_exit', { countCrash: true }); // exit 事件兜底
            else { this.events.append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); this._mSetPhase('STOPPED'); }
          } else {
            this._applyHealthCheck(healthOk); // 假死识别：进程在但 HTTP 挂 → 连续失败判故障
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this._adopt();
          } else if (!targetAlive && Date.now() >= this._mRestartAt()) {
            // 重启前复查端口：避免对"占着端口的不健康外来进程"反复 spawn 计崩溃
            if (await monitor.isPortListening(host, port, 1000)) {
              this._warnOccupied();
            } else {
              await this._startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this._adopt();
          } else if (!targetAlive && Date.now() >= this._mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              this._warnOccupied();
            } else {
              await this._startProcess();
            }
          }
          break;
        }
      }
      // 注：升级后健康验证已内联到 NativeManager.upgrade（waitPortHealthy），onTick 死亡路径已移除
      // 远程代理自动对账（每 tick 幂等）：实例重启/恢复后自动重接 relay——
      // 开关开启时只要目标活着反代即通（不再依赖前端拉取触发）
      // L3b：reconcile 由 lan-daemon 每 2s 执行（守卫只写状态，不本地建 relay）
      if (!this.lanDaemonEnabled()) { try { this.lan.reconcile(); } catch {} }
      this.writeState();
    } catch (e) {
      this.logger.error('tick error: ' + ((e && e.stack) || e));
    } finally {
      this._ticking = false;
      this._actWindow = false; // C3-3b G1：收敛窗口关闭
      // C3-3b G1 影子：拍末记账（actual vs shadow；100% 执行——不受 tick 内提前 return 影响）
      try { this._shadowTickNote(t0); } catch (e) { this.logger.warn && this.logger.warn('shadow note: ' + (e && e.message)); }
      // 统一生命周期视图同步（归一化架构）：finally 100% 执行——不受 tick 内提前 return 影响，
      // 守卫每次调和后把自身（DSH）观测状态镜像到 lifecycleManager。
      try { this._syncDshLifecycleView(); } catch (e) { this.logger.warn && this.logger.warn('sync: ' + (e && e.message)); }
    }
  }

  /** tick 保留为 _dshConverge 别名（C3-3b G3）：外部收敛触发点（start 首拍 / setDesired /
   *  requestRestart / _exitUpgradeHold）调用；shadow 模式下定时器也驱动此别名。
   *  on 模式下 main 每拍收敛由 heartbeat 的 dsh supervise 调用 _dshConverge（无独立 tick 定时器）。 */
  async tick() {
    return this._dshConverge();
  }

  /** 把守卫对 DSH 的观测状态合成到 lifecycleManager 的 dsh 项（C3-3b G5：仅视图，不驱动守卫逻辑）。
   *  数据源 = registry.get('main') 目录项：desired/phase 取应然与受管相位；
   *  healthy/error/lastProbeAt 由观测合成（收敛探测镜像 process.lastProbe* 优先——与心跳
   *  lastObserved 同源同义：L1 端口在线 + L2 HTTP 健康），不再经观测镜像喂入。 */
  _syncDshLifecycleView() {
    if (!this.lifecycleManager) return;
    const dsh = this.lifecycleManager.get('dsh');
    if (!dsh) return;
    const e = this._dshEntry();
    const ph = String(this._mPhase() || '');
    const desiredRunning = this._mDesired() === 'running';
    const ob = (e && e.lastObserved) || null;
    const proc = (e && e.process) || null;
    const portUp = !!(proc && proc.lastProbeOk) || !!(ob && ob.ok);
    const httpOk = !(proc && proc.lastProbeHttpOk === false);
    const healthy = portUp && httpOk;
    const errText = !portUp ? '端口未监听' : (httpOk ? null : 'HTTP 不健康');
    const at = (proc && proc.lastProbeAt) || (ob && ob.at) || null;
    if (desiredRunning) {
      dsh.wantRunning();
      dsh._monitoring = true;
      if (at) dsh.lastProbeAt = at;
      if (ph === 'RUNNING') {
        dsh._setPhase('running');
        dsh.startedAt = dsh.startedAt || new Date().toISOString();
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'STARTING' || ph === 'RESTARTING') {
        dsh._setPhase('starting');
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'BACKOFF') {
        dsh._setPhase('starting');
        dsh.error = '启动退避中';
      } else {
        dsh._setPhase('stopped');
        dsh.healthy = false;
        dsh.error = errText;
      }
    } else {
      dsh.desired = 'stopped';
      dsh._monitoring = false;
      dsh._setPhase('stopped');
      dsh.healthy = false;
    }
    // guardian 唯一来源 = A 平面(dsh-main.json)：B 平面只读同步，不持有独立守护策略（2026-09 收敛）
    dsh.guardian = this._mGuardian();
  }

  /** 独立 router-daemon 是否在运行（探测 43011 监听者 cmdline 是否 router-daemon，2026-09 L3）。
   *  守卫与 router-daemon 解耦后：守卫探测到 daemon 在跑 → 不再内嵌启动 router（避免双占 43011），
   *  只做监督（lifecycleManager 周期探活 43011，异常时拉起 daemon）。 */
  _routerDaemonActive() {
    try {
      const pid = pidlook.findListeningPid(43011);
      if (!pid) return false;
      const cmd = pidlook.readCmdline(pid) || '';
      return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
    } catch { return false; }
  }

  /** R5 游离对象自检（低频只告警，不自动处理；异主隔离红线：绝不强杀/释放）。
   *   覆盖：① daemon 族(43011/43108) 被监听但本守卫期望停止且无管理锁（异主/残留）；
   *   ② 端口登记 owner=inst:* 但实例已不存在（正常应被 _syncInstancePorts 即时清理的残留）；
   *   ③ 目录项期望 running/starting 但观测长期失联（幽灵/死登记——监督介入前的观测线索）。
   *   结果只写日志 + orphan_audit 事件（同指纹 10min 抑制），供审计排查。 */
  _orphanAudit() {
    if (this._stopping) return;
    const now = Date.now();
    const reg = this.managedObjects;
    const issues = [];
    try {
      // ① daemon 族：在监听但目录/期望不认可（异主 daemon 或残留进程）
      const daemons = [
        { kind: 'router-daemon', port: 43011, active: () => this._routerDaemonActive(), managed: () => this._daemonManaged(), want: () => this.config.routerAutostart === true || !!(reg && reg.get('router-daemon') && reg.get('router-daemon').desired === 'running') },
        { kind: 'lan-daemon', port: 43108, active: () => this._lanDaemonActive(), managed: () => this._lanManaged(), want: () => this.lanDaemonEnabled() || !!(reg && reg.get('lan-daemon') && reg.get('lan-daemon').desired === 'running') },
      ];
      for (const d of daemons) {
        if (!d.active()) continue;
        if (!d.want() && !d.managed()) {
          issues.push({ kind: d.kind, port: d.port, why: '端口被监听但本守卫期望停止且无管理锁（异主/残留 daemon）' });
        }
      }
      // ② 端口登记残留（owner=inst:* → 实例已不存在）
      try {
        const ids = new Set(((this.instances && this.instances.instances) || []).map((i) => i.id));
        for (const rec of ports.list()) {
          if (!String(rec.owner || '').startsWith('inst:')) continue;
          const id = String(rec.owner).slice(5);
          if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
        }
      } catch {}
      // ③ 幽灵登记观测线索：期望运行但实然长期失联（main 由收敛接管，跳过避免噪声）
      try {
        const staleMs = Math.max(3 * (this.config.probeIntervalMs || 5000), 30000);
        for (const e of (reg && typeof reg.list === 'function') ? reg.list() : []) {
          if (e.id === 'main') continue;
          if (e.phase !== 'running' && e.phase !== 'starting') continue;
          const ob = e.lastObserved;
          if (ob && ob.ok === false && ob.at && now - new Date(ob.at).getTime() > staleMs) {
            issues.push({ kind: e.kind, id: e.id, why: '期望运行但观测长期失联（幽灵登记）' });
          }
        }
      } catch {}
      if (issues.length === 0) return;
      const key = issues.map((i) => i.kind + ':' + (i.id || i.port || i.owner)).join('|');
      if (this._lastOrphanKey === key && this._lastOrphanAt && now - this._lastOrphanAt < 10 * 60 * 1000) return; // 同指纹抑制
      this._lastOrphanKey = key;
      this._lastOrphanAt = now;
      if (this.events && this.events.append) { try { this.events.append('orphan_audit', { issues, at: new Date().toISOString() }); } catch {} }
      const detail = issues.map((i) => i.kind + (i.id ? ':' + i.id : '') + (i.port ? ':' + i.port : '') + (i.owner ? ':' + i.owner : '') + ' ' + i.why).join(' | ');
      this.logger && this.logger.warn && this.logger.warn('[orphan] 游离对象自检: ' + detail);
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[orphan] 自检异常: ' + ((e && e.message) || e));
    }
  }

  // ── router-daemon 管理权锁（2026-09 L3 监督）──
  // 关键语义：只有「本守卫目录写过管理锁」的 Supervisor 实例才可接管/停止/拉起独立 router-daemon。
  // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存于同一主机）经全局 43011 探测
  // 误接管/误杀生产 daemon（2026-09 实测 p2p-api-test 曾把测试调用经 ctl 打到线上路由）。
  _routerDaemonLockPath() {
    try { return path.join(path.dirname(this.config.stateFile), 'router-daemon.lock'); } catch { return null; }
  }

  _daemonManaged() {
    try { const p = this._routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
  }

  _writeRouterDaemonLock() {
    try { const p = this._routerDaemonLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {}
  }

  _clearRouterDaemonLock() {
    try { const p = this._routerDaemonLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {}
  }

  /** 拉起独立 router-daemon（detached 子进程——守卫退出不影响它；幂等：43011 已被占则不重复拉起）。
   *  @returns { active:boolean, mode:'daemon'|'embedded'|'error', error? } */
  _ensureRouterRuntime(desiredRunning) {
    try {
      const daemonActive = this._routerDaemonActive();
      const managed = this._daemonManaged();
      if (desiredRunning !== false && daemonActive && managed) {
        // daemon 已在跑且为本守卫管理：监督模式（守卫不再内嵌启动）
        return { active: true, mode: 'daemon' };
      }
      if (desiredRunning !== false && daemonActive && !managed) {
        // 有 daemon 在跑但非本守卫管理（异主/测试环境）：绝不接管，退回内嵌语义
        // （测试内嵌 RouterService 用独立 TMP 状态，不触碰 43011/ctl）
        return { active: false, mode: 'embedded' };
      }
      if (desiredRunning === false) {
        // 停止语义：仅停「本守卫管理」的 daemon；异主 daemon 不碰；否则由调用方停内嵌 router
        if (daemonActive && managed) {
          const pid = pidlook.findListeningPid(43011);
          if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
          this._clearRouterDaemonLock();
          const lcS = this._daemonLifecycle('router');
          if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
          return { active: false, mode: 'daemon', stopping: true };
        }
        return { active: false, mode: 'embedded' };
      }
      // 非守卫实例（测试 Supervisor 等无配置文件构造）绝不拉起/接管独立 daemon——纯内嵌语义，
      // 防测试进程在探测不可见宿主 daemon 的环境下把 router-daemon 拉出一堆 stray（2026-09 实证）。
      if (!this.configPath) {
        return { active: false, mode: 'embedded', reason: 'non-guard' };
      }
      // ══ 统一进程生命周期（2026-09 架构定稿，与 lan 对称）：见 DaemonLifecycle ══
      const lc = this._daemonLifecycle('router');
      if (!lc) return { active: false, mode: 'embedded' };
      return this._daemonEnsureResult(lc, () => this._writeRouterDaemonLock());
    } catch (e) {
      return { active: false, mode: 'error', error: e.message };
    }
  }

  /** L3 监督（30s tick，见 start()）：router 期望运行但 daemon 失联 → 重新拉起（幂等）。
   *  纯进程/端口检查（无业务探活）。守卫退出不影响 daemon；本方法只补「期望运行时的异常拉起」。 */

  /** adopt 令牌接管（2026-09 第四轮修复，见 CHANGELOG「adopt 令牌接管」；曾因工作区回滚丢失，2026-09-04 依回归测试重建）：
   *  守卫重启后新守卫 _adopt() 接管的是旧守卫 spawn 的主 DSH——被接管进程非本守卫 spawn，
   *  其启动令牌只打印在旧守卫已断开的 stdout 管道里（令牌服务不落盘）→ 主令牌永久不可达 →
   *  relay 无法用令牌向回环 DSH 换 dsh-auth cookie → 远程控制 401。
   *  语义（RUNNING tick 每周期调用，幂等）：
   *   - 非「被接管且主令牌空置」→ 复位观察并返回（本守卫 spawn 有 child 管道 / 令牌已就绪）
   *   - 观察窗（config.tokenReclaimGraceMs，默认 20s）内令牌迟到（journald/补获）→ 复位观察不干预
   *   - 窗口过仍空置 → 受控重建一次（_beginRestart('adopt_token_reclaim', {countCrash:false})：
   *     杀 adopt 进程 → RESTARTING → 自 spawn 建新 stdout 管道 → 令牌必然可捕获）
   *   - _tokenReclaimTried 保证每次接管仅重建一次，防重启循环 */
  _maybeReclaimAdoptToken() {
    try {
      const tokenOk = !!(this.tokenService && this.tokenService.get('main'));
      const adoptedUnmanaged = this._mAdopted() === true && !!this._mAdoptPid() && !this._mChild();
      if (this._mPhase() !== 'RUNNING' || !adoptedUnmanaged || tokenOk) {
        // 令牌已就绪 / 自 spawn / 非 RUNNING：复位观察（若曾启动）并清重建标记
        if (this._tokenReclaimAt !== null || this._tokenReclaimTried) {
          this._tokenReclaimAt = null;
          this._tokenReclaimTried = false;
        }
        return;
      }
      if (this._tokenReclaimTried) return; // 本次接管已重建过：防循环
      const grace = Number((this.config && this.config.tokenReclaimGraceMs)) || 20000;
      if (this._tokenReclaimAt === null) {
        this._tokenReclaimAt = Date.now() + grace; // 启动观察窗
        return;
      }
      if (Date.now() < this._tokenReclaimAt) return; // 窗口未满：继续观察
      // 窗口已过且主令牌仍空置：受控重建一次
      this._tokenReclaimAt = null;
      this._tokenReclaimTried = true;
      if (this.events && this.events.append) this.events.append('adopt_token_reclaim_started', { pid: this._mAdoptPid() });
      if (this.logger && this.logger.warn) this.logger.warn('[token] adopt 主令牌观察窗过期仍空置，受控重建接管进程（一次）');
      this._beginRestart('adopt_token_reclaim', { countCrash: false });
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('_maybeReclaimAdoptToken: ' + ((e && e.message) || e));
    }
  }

  _warnOccupied() {
    const now = Date.now();
    if (now - this._lastOccupiedWarn > 60000) {
      this._lastOccupiedWarn = now;
      this.events.append('port_occupied_unhealthy', { host: this.config.targetHost, port: this.config.targetPort });
    }
  }

  /** 假死识别（健康维度判定）：进程/端口在但 HTTP 不健康 → 连续 failThreshold 次判故障重启。
   *  单次抖动不清零（failStreak 单调累积直到达到阈值或恢复健康），达到阈值即触发。
   *  httpProbeEnabled=false 时 healthOk 恒为 true（monitor.probe 已退化），此处天然不触发。 */
  _applyHealthCheck(healthOk) {
    if (healthOk) {
      this._mSetFailStreak(0);
      return;
    }
    this._mSetFailStreak(this._mFailStreak() + 1);
    const threshold = this.config.failThreshold || 2;
    if (this._mFailStreak() >= threshold) {
      this.events.append('unhealthy', { reason: 'http_unhealthy', streak: this._mFailStreak() });
      this._beginRestart('http_unhealthy', { countCrash: true });
    }
  }

  // ══ 原生 DSH = 守卫核心服务：main 元数据自足（2026-09-06 概念清分）══
  // main 不再登记为沙箱实例（instances.json 只含沙箱）；其元数据(守护开关/远程控制/公网暴露)
  // 落守卫核心存储 <stateDir>/dsh-main.json。进程生命周期事实源 = config.targetPort(守卫 spawn/观测)。
  _dshMainFile() {
    try { return path.join(path.dirname(this.config.stateFile), 'dsh-main.json'); } catch { return null; }
  }

  /** 受管对象目录持久化文件名（按守卫 stateFile 派生，隔离同目录多守卫；生产 state.json → managed-objects.json）。 */
  _registryFileName() {
    try {
      const b = path.basename(this.config.stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  /** 读 main 元数据(无文件则默认：守护关、远程关)。结果缓存到 _dshMainLive（LanManager 等修改后经 _persistDshMainLive 回写）。 */
  _readDshMain() {
    if (this._dshMainLive) return this._dshMainLive;
    this._dshMainLive = this._readDshMainFile();
    return this._dshMainLive;
  }

  _readDshMainFile() {
    try {
      const f = this._dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return {
          guardian: j.guardian === true,
          remoteEnabled: j.remoteEnabled === true,
          remoteToken: String(j.remoteToken || ''),
          frpEnabled: j.frpEnabled === true,
          frpRemotePort: j.frpRemotePort || null,
          wanPort: j.wanPort || null,
        };
      }
    } catch {}
    return { guardian: false, remoteEnabled: false, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort: null };
  }

  /** 写 main 元数据(白名单字段，原子写 0600)。更新 live 缓存。 */
  _writeDshMain(meta) {
    // live 稳定引用原地修改（LanManager mainOf 持有同一对象；替换引用会使其失效）
    if (!this._dshMainLive) this._dshMainLive = this._readDshMainFile();
    Object.assign(this._dshMainLive, meta || {});
    const f = this._dshMainFile();
    if (!f) return;
    try {
      const cur = this._readDshMain();
      const merged = Object.assign({}, cur, meta || {});
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        guardian: merged.guardian === true,
        remoteEnabled: merged.remoteEnabled === true,
        remoteToken: String(merged.remoteToken || ''),
        frpEnabled: merged.frpEnabled === true,
        frpRemotePort: merged.frpRemotePort || null,
        wanPort: merged.wanPort || null,
      }, null, 2);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_writeDshMain: ' + (e && e.message)); }
  }

  /** main 的统一只读视图（守卫核心服务；端口事实源 = config.targetPort）。 */
  dshMainView() {
    const m = this._readDshMain();
    const cmd = Array.isArray(this.config.command) ? this.config.command.slice() : [];
    return {
      id: 'main',
      name: '主实例',
      port: Number(this.config.targetPort || 3080),
      command: cmd,
      domain: 'native',
      kind: 'native',
      guardian: m.guardian,
      remoteEnabled: m.remoteEnabled,
      remoteToken: m.remoteToken,
      frpEnabled: m.frpEnabled,
      frpRemotePort: m.frpRemotePort,
      wanPort: m.wanPort,
      unitName: null, // systemd 托管已废弃(2026-09-06)：main 由守卫 spawn/观测
      // 实时运行态（2026-09 修 UI 脱节）：native 条目缺 state 导致远程控制页误判「实例已停止」
      state: {
        running: Boolean(this._mChild() || this._mAdoptPid()),
        phase: typeof this._mPhase === 'function' ? this._mPhase() : undefined,
        pid: this._mChild() ? this._mChild().pid : this._mAdoptPid(),
      },
    };
  }

  /** main 元数据补丁(白名单: guardian/remoteEnabled/remoteToken/frpEnabled/frpRemotePort)。 */
  patchDshMain(patch) {
    const p = patch || {};
    const meta = this._readDshMain();
    const prev = { ...meta };
    if (p.guardian !== undefined) meta.guardian = !!p.guardian;
    if (p.remoteEnabled !== undefined) meta.remoteEnabled = !!p.remoteEnabled;
    if (p.remoteToken !== undefined) meta.remoteToken = String(p.remoteToken || '');
    if (p.frpEnabled !== undefined) meta.frpEnabled = !!p.frpEnabled;
    if (p.frpRemotePort !== undefined) meta.frpRemotePort = p.frpRemotePort ? Number(p.frpRemotePort) : null;
    if (p.wanPort !== undefined) meta.wanPort = p.wanPort ? Number(p.wanPort) : null;
    this._writeDshMain(meta);
    if (this.lanDaemonEnabled()) { try { this._syncLanState(); } catch {} }
    // 开关变更事件（2026-09 收敛：所有 main 开关记录进事件日志，可审计回放）
    try {
      if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
        this.events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
      }
      if (p.remoteEnabled !== undefined && prev.remoteEnabled !== meta.remoteEnabled) {
        this.events.append('dsh_remote_changed', { enabled: meta.remoteEnabled === true });
      }
      if (p.frpEnabled !== undefined && prev.frpEnabled !== meta.frpEnabled) {
        this.events.append('dsh_frp_changed', { enabled: meta.frpEnabled === true });
      }
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
    return { ok: true, main: this.dshMainView() };
  }

  // ══ 控制平面 v3：受管对象申报（R1 影子阶段；注册机只登记应然+所有权，不驱动）══
  /** main(dsh) 申报为管家注册项。 */
  _managedMainSpec() {
    const m = this._readDshMain();
    return {
      kind: 'dsh', id: 'main', name: '主实例',
      desired: this._mDesired() === 'stopped' ? 'stopped' : 'running',
      guardian: m.guardian === true,
      ownership: {
        ports: [{ role: 'dsh-main', port: Number(this.config.targetPort || 3080) }],
        rootPath: path.join(os.homedir(), '.dsh'),
        processMode: 'spawn', // systemd 托管已废弃：main 由守卫 spawn/adopt
      },
    };
  }

  /** 单个沙箱实例申报。 */
  _managedSandboxSpec(inst) {
    if (!inst || !inst.id) return null;
    const phase = inst.state && inst.state.phase;
    const running = phase === 'RUNNING' || phase === 'STARTING' || phase === 'INSTALLING';
    let rootPath = null;
    try { if (this.instances && typeof this.instances.sandboxRoot === 'function') rootPath = this.instances.sandboxRoot(inst); } catch {}
    return {
      kind: 'sandbox-instance', id: inst.id, name: String(inst.name || inst.id),
      desired: running ? 'running' : 'stopped',
      guardian: inst.guardian === true,
      ownership: {
        ports: [{ role: 'inst', port: Number(inst.port) }],
        rootPath,
        unit: 'dsh-web@' + inst.id,
        processMode: 'systemd',
      },
    };
  }

  /** 启动对齐：main + 全部沙箱申报入册（幂等：已注册则 update 应然）。 */
  _syncManagedRegistry() {
    const reg = this.managedObjects;
    if (!reg) return;
    try {
      this._upsertManaged(this._managedMainSpec());
      const sandboxes = (this.instances && this.instances.instances) || [];
      for (const inst of sandboxes) {
        if (inst.id === 'main' || inst.domain === 'native') continue; // main 已单独申报
        this._upsertManaged(this._managedSandboxSpec(inst));
      }
      // daemon 类申报（影子阶段；进程独立，目录只登记应然/所有权，不驱动）
      this._upsertManaged({
        kind: 'router-daemon', id: 'router-daemon', name: '智能路由 daemon',
        desired: this.config.routerAutostart === true ? 'running' : 'stopped',
        guardian: true,
        ownership: {
          daemonScript: path.join(__dirname, 'domains', 'router', 'daemon.js'),
          ports: [{ role: 'ctl', port: 43011 }],
          processMode: 'daemon',
        },
      });
      this._upsertManaged({
        kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon',
        desired: this.lanDaemonEnabled() ? 'running' : 'stopped',
        guardian: true,
        ownership: {
          daemonScript: path.join(__dirname, 'domains', 'relay', 'daemon.js'),
          ports: [{ role: 'ctl', port: 43108 }],
          processMode: 'daemon',
        },
      });
      if (this.logger && this.logger.info) this.logger.info('[registry] 受管对象已申报: ' + reg.list().map((o) => o.kind + ':' + o.id).join(','));
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_syncManagedRegistry: ' + (e && e.message)); }
  }

  /** 申报或更新（存在→update 应然；否则 register）。 */
  _upsertManaged(spec) {
    const reg = this.managedObjects;
    if (!reg || !spec) return;
    try {
      const existing = reg.get(spec.id);
      if (existing) reg.update(spec.id, { desired: spec.desired, guardian: spec.guardian, name: spec.name, ownership: spec.ownership });
      else reg.register(spec);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_upsertManaged(' + (spec && spec.id) + '): ' + (e && e.message)); }
  }

  _unregisterManaged(id) {
    const reg = this.managedObjects;
    if (!reg || !id) return;
    try { reg.unregister(id); } catch (e) { this.logger && this.logger.warn && this.logger.warn('_unregisterManaged(' + id + '): ' + (e && e.message)); }
  }

  // ══ C3-3b G4：main(dsh) 状态唯一存储 = 目录 main entry（this.* 并行字段已删除）══
  // 存储图（C3-3b G4）：
  //   phase → entry.phase（唯一词表小写；OBSERVED 由 process.observedOnly/adopted 位合成呈现）
  //   desired → entry.desired（registry.update 持久化，managed-objects.json 与 state.json 一致）
  //   child/adoptedPid/adopted/observedOnly/startDeadline/restartAt/spawnBlockedUntil/missingNotified
  //     /failStreak/lastProbe*/lastFailure/lastRestartAt → entry.process（句柄/瞬态，不持久化）
  //   crashWindow*/backoff*/restartCount → entry 退避字段（registry 持久化 + state.json 双份恢复）
  // 读写口：守卫内一律经 _m*/_mSet*（本组 helper 是全部读写口，无 this.<字段> 残留）；
  //   类上另保留 get/set phase|desired|child|adoptedPid|adopted|observedOnly|restartCount|
  //   spawnBlockedUntil|missingNotified 兼容访问器（外部/测试经统一状态读写口）。

  /** 目录 main 项（未初始化/异常 → null）。 */
  _dshEntry() {
    if (!this.managedObjects || typeof this.managedObjects.get !== 'function') return null;
    try { return this.managedObjects.get('main') || null; } catch { return null; }
  }

  /** 构造期 fallback 存储（目录初始化前/异常时的统一读写口；目录就绪后不再使用）。 */
  _mainFallbackEntry() {
    if (!this._fallbackEntry) {
      this._fallbackEntry = {
        kind: 'dsh', id: 'main', name: '主实例',
        desired: 'running', guardian: true,
        ownership: { ports: [], rootPath: null, unit: null, daemonScript: null, processMode: 'spawn', meta: null },
        phase: 'stopped', lastObserved: null,
        backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0,
        restartCount: 0, startedAt: null, lastTransitionAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        process: null,
      };
    }
    return this._fallbackEntry;
  }

  /** 状态存储解析（唯一读写口基座）：目录 main 项，缺省回退构造期 fallback。 */
  _mStore() {
    return this._dshEntry() || this._mainFallbackEntry();
  }

  /** 通用 entry 字段读写（变化才写）。phase/desired 走专属口（registry 事件/持久化）。 */
  _mField(name, v) {
    const e = this._mStore();
    if (arguments.length >= 2) { if (e[name] !== v) e[name] = v; return e; }
    return e[name];
  }

  /** entry.process 字段读写（进程句柄/运行期瞬态；首建播种默认值，不持久化）。 */
  _mProcField(name, v) {
    const e = this._mStore();
    let p = e.process;
    if (!p) {
      p = e.process = {
        child: null, adoptedPid: null, adopted: false, observedOnly: false,
        startDeadline: null, restartAt: null, spawnBlockedUntil: null, missingNotified: false,
        failStreak: 0, lastProbeAt: null, lastProbeOk: null, lastProbeHttpOk: null,
        lastFailure: null, lastRestartAt: null,
      };
    }
    if (arguments.length >= 2) { if (p[name] !== v) p[name] = v; return p; }
    return p[name];
  }

  // ── 唯一 phase 词表（R3 C3-5 命名统一；目录 canonical 全表见 guard/lifecycle/objects.js PHASES）──
  // 守卫 legacy（大写，语义保留给 statusSummary 门面）→ 目录 canonical（小写）映射：
  //   STOPPED→stopped / STARTING→starting / RUNNING→running / RESTARTING→restarting /
  //   BACKOFF→backoff / OBSERVED→stopped(+process.observedOnly+adopted 位合成呈现)。
  // 沙箱域(instance state)映射在 _syncSandboxRegistryEntry：INSTALLING→installing / FAILED→failed。
  /** 守卫 legacy 大写 phase → 目录唯一词表（小写）。OBSERVED 由 process.observedOnly 表达，phase=stopped。 */
  _legacyToEntryPhase(ph) {
    return { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', RESTARTING: 'restarting', BACKOFF: 'backoff', OBSERVED: 'stopped' }[ph] || 'stopped';
  }

  /** 目录小写 phase → 守卫 legacy 大写。 */
  _entryToLegacyPhase(ph) {
    return { stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', restarting: 'RESTARTING', backoff: 'BACKOFF' }[ph] || 'STOPPED';
  }

  /** 读守卫视角 phase（大写；OBSERVED 按 observedOnly+adopted 合成）。守卫内唯一 phase 读口。 */
  _mPhase() {
    const e = this._mStore();
    const p = e.process || null;
    const upper = this._entryToLegacyPhase(e.phase || 'stopped');
    if (upper === 'STOPPED' && p && p.observedOnly && p.adopted) return 'OBSERVED';
    return upper;
  }

  /** 写守卫视角 phase（大写→目录 canonical 经 registry.setPhase：事件/持久化/迁移由 registry 负责）。 */
  _mSetPhase(upper) {
    const e = this._mStore();
    const ph = this._legacyToEntryPhase(upper);
    const reg = this.managedObjects;
    try {
      if (reg && typeof reg.setPhase === 'function' && this._dshEntry() === e) {
        if (e.phase !== ph) reg.setPhase('main', ph);
      } else if (e.phase !== ph) {
        e.phase = ph;
      }
    } catch (e2) { this.logger && this.logger.warn && this.logger.warn('_mSetPhase: ' + ((e2 && e2.message) || e2)); }
    return this;
  }

  /** 读守护开关（dsh-main.json meta.guardian；守卫内唯一 guardian 读口——与 _managedMainSpec 申报同源）。
   *  true=运行中崩溃自动接管拉起；false=崩溃后保持停止（等用户手动启动）。 */
  _mGuardian() {
    try { return this._readDshMain().guardian === true; } catch { return false; }
  }

  /** 公开门面：main 守护开关（供 adapters/lifecycle 读取，A 平面同源）。 */
  mainGuardian() { return this._mGuardian(); }

  /** 读 desired（running|stopped）。守卫内唯一 desired 读口。 */
  _mDesired() {
    return this._mStore().desired === 'stopped' ? 'stopped' : 'running';
  }

  /** 写 desired（registry.update 持久化；state.json 经 writeState 同源）。 */
  _mSetDesired(v) {
    const want = v === 'stopped' ? 'stopped' : 'running';
    const e = this._mStore();
    const reg = this.managedObjects;
    try {
      if (reg && typeof reg.update === 'function' && this._dshEntry() === e) {
        if (e.desired !== want) reg.update('main', { desired: want });
      } else if (e.desired !== want) {
        e.desired = want;
      }
    } catch (e2) { this.logger && this.logger.warn && this.logger.warn('_mSetDesired: ' + ((e2 && e2.message) || e2)); }
    return this;
  }


  // ---- C3-3b G4 兼容访问器（外部/测试经统一读写口；守卫内部一律 _m*，不出现 this.<字段>uff09----
  // 例：adopt-token-reclaim-test / precheck-test / api 直接置读 phase/desired/child 等——经此落到 entry。
  get phase() { return this._mPhase(); }
  set phase(v) { this._mSetPhase(v); }
  get desired() { return this._mDesired(); }
  set desired(v) { this._mSetDesired(v); }
  get child() { return this._mProcField('child'); }
  set child(c) { this._mProcField('child', c); }
  get adoptedPid() { return this._mProcField('adoptedPid'); }
  set adoptedPid(v) { this._mProcField('adoptedPid', v); }
  get adopted() { return this._mProcField('adopted') === true; }
  set adopted(v) { this._mProcField('adopted', v === true); }
  get observedOnly() { return this._mProcField('observedOnly') === true; }
  set observedOnly(v) { this._mProcField('observedOnly', v === true); }
  get restartCount() { const v = this._mField('restartCount'); return typeof v === 'number' ? v : 0; }
  set restartCount(v) { this._mField('restartCount', v); }
  get spawnBlockedUntil() { const v = this._mProcField('spawnBlockedUntil'); return v === undefined ? null : v; }
  set spawnBlockedUntil(v) { this._mProcField('spawnBlockedUntil', v); }
  get missingNotified() { return this._mProcField('missingNotified') === true; }
  set missingNotified(v) { this._mProcField('missingNotified', v === true); }

  /** 概念清分迁移（2026-09-06）：instances.json 若仍含历史 main 记录 → 元数据迁入 dsh-main.json 并剔除。 */
  _migrateMainRecord() {
    try {
      const im = this.instances;
      if (!im || !Array.isArray(im.instances)) return;
      const idx = im.instances.findIndex((i) => i.id === 'main');
      if (idx < 0) return;
      const main = im.instances[idx];
      const f = this._dshMainFile();
      if (f && !fs.existsSync(f)) {
        this._writeDshMain({
          guardian: main.guardian === true,
          remoteEnabled: main.remoteEnabled === true,
          remoteToken: String(main.remoteToken || ''),
          frpEnabled: main.frpEnabled === true,
          frpRemotePort: main.frpRemotePort || null,
          wanPort: main.wanPort || null,
        });
      }
      im.instances.splice(idx, 1);
      if (im.save) { try { im.save(); } catch {} }
      if (this.logger && this.logger.info) this.logger.info('[main] 概念清分：main 记录已迁出 instances.json → dsh-main.json');
      if (this.events) this.events.append('main_meta_migrated', {});
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('_migrateMainRecord: ' + (e && e.message)); }
  }


  /** 组装 DSH 启动命令（原生专属，交给 guard/native）。 */
  spawnCommand() {
    return native.nativeCommand(this.config, this.pluginManager);
  }

  // ---- 生命周期动作 ----
  async _startProcess() {
    this._actNote('start', 'spawn'); // C3-3b G1 影子 actual 记账
    // 前置条件：原生 DSH 必须已安装才尝试启动。未安装 → 进入「未安装」状态：
    // 不启动、不重试、不计数崩溃；一次性通知引导安装（与"启动失败"严格区分）。
    const nst = this.nativeManager ? this.nativeManager.status() : { installed: true };
    if (!nst.installed) {
      this.events.append('dsh_not_installed', { bin: nst.binPath });
      if (!this._mMissingNotified()) {
        this._mSetMissingNotified(true);
        this.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
      }
      this._mSetSpawnBlockedUntil(Date.now() + 60000); // 冷静期：装好前不再无谓重试
      this._mSetPhase('STOPPED');
      this._mSetFailStreak(0);
      this.writeState();
      return;
    }
    this.events.append('spawn', { command: this.spawnCommand() });
    const [cmd, ...args] = this.spawnCommand();
    let child;
    try {
      // detached：独立进程组，便于按组发信号（DSH 派生的子进程一并收到）。
      // 插件 --patch 覆盖层由 spawnCommand()/native.nativeCommand() 统一附加（顶层位置），此处不再重复拼接。
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true });
    } catch (err) {
      this.events.append('spawn_failed', { message: err.message });
      this.logger.error('spawn failed: ' + err.message);
      this._beginRestart('spawn_error', { countCrash: true });
      return;
    }
    this.logger.info('spawn pid=' + child.pid + ' cmd=' + this.spawnCommand().join(' '));
    this._mSetChild(child);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this._mSetPhase('STARTING');
    this._mSetStartDeadline(Date.now() + this.config.startTimeoutMs);
    // DSH 输出落盘专用日志（行缓冲还原完整行），同时镜像 stderr 供 journald 收敛
    // 先捕获令牌（原文），落盘前对启动 URL 的 ?token= 段脱敏——dsh.log/journald 不复留会话令牌明文
    const sanitizeToken = (l) => String(l).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    const outBuf = new LineBuffer((line) => {
      this.tokenService.feedLine('main', line); // 唯一令牌节点：stdout 源逐行推送（最新行优先）

      const clean = sanitizeToken(line);
      this.dshWriter.write(clean);
      // 实时镜像同样走脱敏后的完整行——dsh-supervisor 单元 journald 不再残留 token 明文
      // （docs/token-management.md P3：原 raw chunk 镜像会把 ?token= 明文写进 journald）
      process.stdout.write('[dsh] ' + clean + '\n');
    });
    const errBuf = new LineBuffer((line) => {
      const clean = sanitizeToken('[stderr] ' + line);
      this.dshWriter.write(clean);
      process.stderr.write(clean + '\n');
    });
    child.stdout.on('data', (d) => { outBuf.push(d); });
    child.stderr.on('data', (d) => { errBuf.push(d); });
    child.on('error', (err) => {
      this.events.append('spawn_error', { message: err.message });
      if (this._mChild() === child && this._mPhase() === 'STARTING') {
        this._mSetChild(null);
        if (err.code === 'ENOENT') {
          // 命令不存在（如 DSH 未安装）：进入冷静期，等面板一键安装，不刷崩溃
          this.events.append('dsh_command_missing', { command: this.config.command[0] });
          this.logger.warn('command missing: ' + this.config.command.join(' ') + ' — 60s 冷静期内不再尝试');
          if (!this._mMissingNotified()) {
            this._mSetMissingNotified(true);
            this.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
          }
          this._mSetSpawnBlockedUntil(Date.now() + 60000);
          this._mSetPhase('STOPPED');
          this.writeState();
          return;
        }
        this._beginRestart('spawn_error:' + (err.code || 'unknown'), { countCrash: true });
      }
    });
    child.on('exit', (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      if (this._mChild() !== child) return; // 已被 stopProcess 接管
      this.events.append('dsh_exited', { code, signal, phase: this._mPhase() });
      this._mSetChild(null);
      if (this._stopping) return;
      if (this._mDesired() !== 'running') return;
      if (this._mPhase() === 'RUNNING' || this._mPhase() === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        // 守护语义（2026-09 收敛，与 RUNNING 收敛分支同 gate）：RUNNING 崩溃看守护开关——
        // guardian=false 不自动拉起（转 STOPPED 等用户手动）；STARTING(用户启动流程)保留重试。
        if (this._mPhase() === 'STARTING' || this._mGuardian()) {
          this._beginRestart('exit:' + why, { countCrash: true });
        } else {
          this.events.append('guardian_off_exit', { reason: 'child_exit:' + why + ' 未守护，保持停止' });
          this._mSetPhase('STOPPED');
        }
      }
    });
    this.events.append('spawned', { pid: child.pid });
    this.writeState();
  }

  _enterRunning() {
    this._actNote('enterRunning', 'healthy'); // C3-3b G1 影子 actual 记账
    const wasRunning = this._mPhase() === 'RUNNING';
    this._mSetPhase('RUNNING');
    this._mSetAdopted(false);
    // 只在真正「进入/恢复到运行中」时重置崩溃窗口/退避并记一次事件；稳态(RUNNING)不再每探测周期重置/刷屏
    if (!wasRunning) {
      this._mSetFailStreak(0);
      this._mSetBackoffLevel(0);
      this._mSetBackoffUntil(null);
      this._mSetCrashWindowStart(null);
      this._mSetCrashWindowRestarts(0);
      const pid = this._mChild() ? this._mChild().pid : null;
      this.events.append('running', { pid });
      this.logger.info('RUNNING pid=' + pid);
      // 进入运行：统一令牌服务按源（spawn=stdout）退避重试捕获最新令牌，
      // 有变化即经 onChange 下发 relay 热换 cookie（覆盖重启后令牌轮换/旧令牌未清空的边界）。
      this.tokenService.scheduleCapture('main');
    }
    this.writeState();
  }

  /** 原生 DSH 端口运行时再推导（2026-09 架构补齐）：
   *  DSH 端口由用户可改（config 默认 3080 只是默认）——进程真实端口以 cmdline --port 为准。
   *  在配置端口无监听但 DSH 进程在跑时，找出受管 DSH 进程的真实端口并更正注册（dsh-main /
   *  main 实例 / relay 目标 / healthUrl / 状态），让系统跟随用户改动而非卡死在旧配置。 */
  _findManagedDshPort() {
    // 候选：配置 bin 精确匹配（config.command[1]）优先；兼容手动标准 DSH（isDshCmdline）
    const bins = [];
    const cmd = this.config.command || [];
    if (typeof cmd[1] === 'string' && cmd[1]) bins.push(cmd[1]);
    const { execFileSync } = require('node:child_process');
    let candidates = [];
    try {
      const out = execFileSync('pgrep', ['-af', 'dsh'], { encoding: 'utf8', timeout: 3000 }).toString();
      for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+)\s+(.*)$/.exec(line.trim());
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid) continue;
        const c = m[2];
        if (c.indexOf('/instances/') >= 0) continue; // 排除沙箱实例 dsh-web@inst-*
        // 精确归属：cmdline 必须含本守卫配置的启动 bin；isDshCmdline 兜底仅用于
        // "config bin 缺失（手动标准安装）"且 cmdline 带 ' web' 子命令特征的场景——
        // 绝不把同机其它 dsh 实例误认作受管目标（宽匹配曾把监管端口劫持到生产实例端口）。
        const binMatch = bins.some((b) => b && c.indexOf(b) >= 0);
        const genericDsh = !bins.length && pidlook.isDshCmdline(pid) && /(^|\s)web(\s|$)/.test(c);
        const owned = binMatch || genericDsh;
        if (!owned) continue;
        // 复用 config.extractPortFromCommand（同一解析实现，消除 config/supervisor 双份）
        const port = extractPortFromCommand(c.split(' '));
        if (port) candidates.push({ pid, port, cmdline: c.slice(0, 120) });
      }
    } catch {}
    // 多个候选：选正在监听其端口者（真在跑的实例），否则取第一个
    for (const c of candidates) { try { if (pidlook.findListeningPid(c.port) === c.pid) return c; } catch {} }
    return candidates[0] || null;
  }

  /** 应用原生 DSH 真实端口：更正 dsh-main 注册 / main 实例 / relay 目标 / healthUrl（五处跟随）。 */
  _applyMainPort(newPort, pid) {
    const oldPort = this.config.targetPort;
    if (!Number.isInteger(newPort) || newPort <= 0 || newPort === oldPort) return false;
    // dsh-main 固定注册：release 旧 → register 新（同一 role 不同端口）
    try { ports.release(oldPort); } catch {}
    try { ports.register('dsh-main', newPort); } catch (e) { this.logger.warn && this.logger.warn('register dsh-main ' + newPort + ': ' + (e.message || e)); }
    this.config.targetPort = newPort;
    try { this.config.healthUrl = 'http://' + this.config.targetHost + ':' + newPort + '/'; } catch {}
    // 概念清分(2026-09-06)：main 不再登记于沙箱 instances——端口唯一事实源 = config.targetPort，
    // 无 per-instance 记录可跟随；dshMain 端口由 dshMainView() 动态读 config.targetPort。
    try { if (this.lanDaemonEnabled()) this._syncLanState(); } catch {}
    this.events.append('main_port_adopted', { from: oldPort, to: newPort, pid });
    this.logger.warn && this.logger.warn('[main] DSH 真实端口 ' + newPort + '（原配置 ' + oldPort + '），已更正注册与 relay 目标');
    try { this._syncLanState(); } catch {}
    return true;
  }

  /** 期望停止下发现无主健康实例：仅观测（拿 pid、如实展示），不强杀不拉起。 */
  _adoptObserved() {
    this._actNote('adoptObserved', 'observe'); // C3-3b G1 影子 actual 记账
    this._mSetPhase('OBSERVED');
    this._mSetAdopted(true);
    this._mSetObservedOnly(true);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    if (this._mAdoptPid() === null) {
      const found = this._findManagedDshPort();
      if (found && found.port && found.port !== this.config.targetPort && this._applyMainPort(found.port, found.pid)) {
        this.config.targetPort = found.port;
        this._mSetAdoptPid(found.pid);
      }
    }
    this.events.append('adopted_observed', { pid: this._mAdoptPid() });
    this.logger.info('observed unmanaged instance pid=' + this._mAdoptPid() + ' (desired=stopped)');
    this.writeState();
  }

  _adopt() {
    this._actNote('adopt', 'adopt'); // C3-3b G1 影子 actual 记账
    this._mSetPhase('RUNNING');
    this._mSetAdopted(true);
    this._mSetObservedOnly(false);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetBackoffLevel(0);
    this._mSetBackoffUntil(null);
    // 发现接管目标的 pid：使 stop/升级/存活观测对既有实例同样生效
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    // 原生 DSH 端口可被用户改动（config 默认只是默认）→ 配置端口无监听时，从受管 DSH 进程
    // 推导真实端口并更正注册（2026-09 架构补齐），再以其 pid 接管。
    if (this._mAdoptPid() === null) {
      const found = this._findManagedDshPort();
      if (found && found.port && found.port !== this.config.targetPort) {
        if (this._applyMainPort(found.port, found.pid)) {
          this.config.targetPort = found.port;
          this._mSetAdoptPid(found.pid);
        }
      }
    }
    // 校验：接管目标必须是我们管理的进程（启动命令匹配），否则不接管、只告警
    if (this._mAdoptPid() === null || !this._isManagedProcess(this._mAdoptPid())) {
      this._mSetAdoptPid(null);
      this._mSetPhase('STOPPED');
      this._warnOccupied();
      this.writeState();
      return;
    }
    this.events.append('adopted', { pid: this._mAdoptPid() });
    this.logger.info('adopted existing instance pid=' + this._mAdoptPid());
    // 接管既有实例：统一令牌服务从已登记源（journald / stdout 行缓冲）取最新令牌并下发
    this.tokenService.scheduleCapture('main');
    this.writeState();
  }

  /** 校验 pid 进程是否属于本守卫管理：cmdline 含配置的启动 bin，或符合 DSH 特征（兼容外部手动起的标准 DSH）。
   *  精确匹配避免"路径碰巧含 dsh 就误接管"与"安装路径不含 dsh 就漏接管"。 */
  _isManagedProcess(pid) {
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = this.config.command && this.config.command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    return pidlook.isDshCmdline(pid);
  }

  _beginRestart(reason, opts) {
    const countCrash = !!(opts && opts.countCrash);
    this._mSetLastFailure(reason);
    this._mSetLastRestartAt(new Date().toISOString());
    this.events.append('restart_triggered', { reason });
    this.logger.warn('restart triggered: ' + reason);
    // 实例重启 = DSH 启动令牌轮换：清空已捕获令牌，使进入运行后统一令牌服务重新捕获新令牌
    // （旧令牌随旧进程失效，relay 若继续持有只会换取失败；先清空避免「新旧令牌混淆」）
    this.tokenService.clear('main');
    if (countCrash) {
      this._mSetRestartCount(this._mRestartCount() + 1);
      this._bumpCrashWindow();
    }
    this._mSetPhase('RESTARTING');
    this._mSetFailStreak(0);
    this._mSetRestartAt(Date.now() + this.config.portReleaseWaitMs);
    const child = this._mChild();
    if (child && child.exitCode === null) this._killSequence(child);
    // 重启前停掉仍运行中的目标，保证 RESTARTING → 重拉路径畅通：
    //  - spawn 托管下被接管的存活实例（如假死触发 http_unhealthy 时进程还活着）→ 杀其 pid；
    //  （adopted_exit 场景 adopted 已死，此处 isAlive 为 false 自然跳过，不误杀。）
    if (this._mAdoptPid() && pidlook.isAlive(this._mAdoptPid())) {
      try { this._killAdopted(this._mAdoptPid()); } catch (e) { this.logger.warn('adopt kill during restart: ' + e.message); }
    }
    this._actNote('restart', reason); // C3-3b G1 影子 actual 记账（bump 退避记账不改变 restart 动作）
    this.writeState();
  }

  _bumpCrashWindow() {
    const now = Date.now();
    // 崩溃窗口 + 退避决策统一交 domain/guardian（对原生与实例共用）
    const d = guardian.bumpCrashWindow(
      { start: this._mCrashWindowStart(), restarts: this._mCrashWindowRestarts() },
      now,
      { crashWindowMs: this.config.crashWindowMs, crashBurst: this.config.crashBurst, backoff: this.config.backoff, backoffLevel: this._mBackoffLevel() }
    );
    this._mSetCrashWindowStart(d.start);
    this._mSetCrashWindowRestarts(d.restarts);
    this._mSetBackoffLevel(d.backoffLevel);
    if (d.backoffEntered) {
      this._mSetBackoffUntil(d.backoffUntil);
      this._mSetPhase('BACKOFF');
      this.events.append('crash_loop_entered', {
        level: d.backoffLevel,
        waitMs: this.config.backoff[d.backoffLevel],
      });
      this.logger.error('crash loop entered: level=' + d.backoffLevel + ' waitMs=' + this.config.backoff[d.backoffLevel]);
      this.notify('DSH 反复崩溃', '已进入第 ' + d.backoffLevel + ' 级退避（' + Math.round(this.config.backoff[d.backoffLevel] / 1000) + 's），请查看 dsh-supervisor 面板');
    }
  }

  /** 向进程组发信号（detached spawn 的子进程是组长）；组信号失败退回单进程（平台层封装：
   *  POSIX 组信号；Windows 无组语义 → 单进程信号，树语义由 taskkill /T 提供）。 */
  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  }

  _killSequence(child) {
    this.events.append('sigterm_sent', { pid: child.pid });
    this._signalChild(child, 'SIGTERM');
    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      if (child.exitCode === null && child.signalCode === null) {
        this._signalChild(child, 'SIGKILL');
        this.events.append('sigkill_sent', { pid: child.pid });
      }
    }, this.config.stopGraceMs);
  }

  /** 杀无句柄的接管实例（仅知 pid）。 */
  _killAdopted(pid) {
    this.events.append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    this._adoptKillTimer = setTimeout(() => {
      this._adoptKillTimer = null;
      if (pidlook.isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        this.events.append('sigkill_sent', { pid, adopted: true });
      }
    }, this.config.stopGraceMs);
  }

  stopProcess(reason) {
    this._actNote('stop', reason); // C3-3b G1 影子 actual 记账
    this.events.append('stop', { reason });
    this.logger.info('stop: ' + reason);
    const child = this._mChild();
    const adoptedPid = this._mAdoptPid();
    this._mSetPhase('STOPPED');
    this._mSetChild(null);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this._mSetFailStreak(0);
    if (child && child.exitCode === null) this._killSequence(child);
    else if (adoptedPid) this._killAdopted(adoptedPid);
    this.writeState();
  }
}

// ══ C3-3b G4：每字段 _mX()/_mSetX() 读写 helper 生成（entry/process 唯一存储口）══
// 配合 codemod 产生的调用点：守卫内 this.<字段> 全部转换为 this._mXxx()/this._mSetXxx()。
(function installMainFieldHelpers(proto) {
  const ENTRY = [
    // [读写 helper 后缀, entry 字段]
    ['CrashWindowStart', 'crashWindowStart'],
    ['CrashWindowRestarts', 'crashWindowRestarts'],
    ['BackoffLevel', 'backoffLevel'],
    ['BackoffUntil', 'backoffUntil'],
    ['RestartCount', 'restartCount'],
  ];
  const PROC = [
    // [读写 helper 后缀, process 字段, 是否布尔]
    ['Child', 'child', false],
    ['AdoptPid', 'adoptedPid', false],
    ['Adopted', 'adopted', true],
    ['ObservedOnly', 'observedOnly', true],
    ['FailStreak', 'failStreak', false],
    ['RestartAt', 'restartAt', false],
    ['StartDeadline', 'startDeadline', false],
    ['SpawnBlockedUntil', 'spawnBlockedUntil', false],
    ['MissingNotified', 'missingNotified', true],
    ['LastProbeAt', 'lastProbeAt', false],
    ['LastProbeOk', 'lastProbeOk', false],
    ['LastProbeHttpOk', 'lastProbeHttpOk', false],
    ['LastFailure', 'lastFailure', false],
    ['LastRestartAt', 'lastRestartAt', false],
  ];
  for (const [suf, field] of ENTRY) {
    proto['_m' + suf] = function () { return this._mField(field); };
    proto['_mSet' + suf] = function (v) { this._mField(field, v); return this; };
  }
  for (const [suf, field, isBool] of PROC) {
    proto['_m' + suf] = function () { return this._mProcField(field); };
    proto['_mSet' + suf] = function (v) { this._mProcField(field, isBool ? v === true : v); return this; };
  }
  // 兼容访问器（phase/desired 已在类体内定义）
})(Supervisor.prototype);

module.exports = { Supervisor, normalize };
