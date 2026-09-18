'use strict';

// app/assembly/compose/core.js —— 组装第一步：宿主初始化 + 基础设施服务。
//
// 按「切面组」分离：core（宿主字段/日志/令牌/分发/任务/端口）
//   -> domains（各域构造）-> observers（事件接线/注册）。
// 三段均为具名函数、以 host 显式入参，零 this。

const path = require('node:path');
const platform = require('../../../platform/os/index');
const { normalize } = require('../../../platform/service/config');
const { extension: domainConfigExtension } = require('../../../app/settings/domain-config');
const logcore = require('../../../platform/service/log/logcore');
const { DshTokenService } = require('../../../platform/service/token');
const { DistributionManager } = require('../../../platform/distribution/index');
const shellDomain = require('../../../domains/shell/index');
const { TaskRegistry } = require('../../../platform/service/tasks');
const { IntentLedger } = require('../../../app/state/intents');
// DS-G4（§4.2 反转法）：日志汇聚业务源名单 / 令牌分类的唯一声明处，require 即注入 platform。
// 必须在 LogCore.init（构造 EventHub）与 new DshTokenService 之前。
require('../log-sources');
const { TOKEN_FILE_NAME } = require('../../../app/settings/token-kinds');

function composeCore(host, rawConfig, configPath) {
    host.config = normalize(rawConfig, domainConfigExtension());
    host.configPath = typeof configPath === 'string' ? configPath : null;
    // 数据目录访问保护（目录级一次，覆盖全部新建/既有子文件）。
    //   Unix    ：chmod 0700（他人无法穿越目录，内部文件即使 0644 也不可达）。
    //   Windows ：icacls 移除继承 (/inheritance:r) + 仅当前用户 (OI)(CI)；POSIX mode 在
    //             Windows 被忽略，而本目录含 config.json(apiAccessKey)、
    //             dsh-main.json(remoteToken)、dsh-main-token.log(DSH 会话令牌)、frpc.toml(auth.token) 等敏感文件。
    //   NTFS 继承是动态的：对父目录设置继承 ACE 会同时作用于既有子项与后续新建子项，
    //   故无需对每个热写文件（state.json 每拍）做 icacls，那会造成显著写放大。
    host._fileProtectStatus = null;
    try {
      const fp = platform.fileProtect;
      const swDir = path.dirname(host.config.stateFile);
      const targets = new Set([swDir]);
      try { targets.add(platform.supervisorDir()); } catch {}
      const results = [];
      for (const d of targets) {
        const pr = fp.ensurePrivateDir(d);
        results.push({ dir: d, ...pr });
      }
      host._fileProtectStatus = results;
      const bad = results.filter((r) => !r.ok);
      if (bad.length) { try { console.warn('[supervisor] 数据目录保护未完全成功: ' + bad.map((b) => b.dir + '(' + b.mode + ':' + (b.reason || '') + ')').join('; ')); } catch {} }
    } catch (e) { try { console.warn('[supervisor] 数据目录保护异常: ' + (e && e.message)); } catch {} }
    host._mSetChild(null);
    host._mSetAdoptPid(null);     // 接管的既有实例 pid（非本守卫 spawn）
    host._mSetPhase('STOPPED');
    host._mSetDesired('running');
    host._mSetRestartCount(0);
    host._mSetCrashWindowStart(null);
    host._mSetCrashWindowRestarts(0);
    host._mSetBackoffLevel(0);
    host._mSetBackoffUntil(null);
    host._mSetRestartAt(null);      // RESTARTING 状态下最早可重启时刻
    host._mSetStartDeadline(null);  // STARTING 状态下启动门截止
    host._mSetFailStreak(0);
    host._mSetLastProbeAt(null);
    host._mSetLastProbeOk(null);
    host._mSetLastFailure(null);
    host._mSetLastRestartAt(null);
    host._mSetAdopted(false);       // 观测到健康但非本守卫 spawn（接管既有实例）
    host._mSetObservedOnly(false);  // 期望停止下的仅观测接管（不强杀不拉起）
    host._mSetSpawnBlockedUntil(null); // 命令缺失（ENOENT）后的冷静期
    host._mSetMissingNotified(false);
    host.manualRestart = false; // POST /lifecycle/dsh/restart 待消费
    host._ticking = false;
    // 显式意图登记簿：用户/系统动作发生处 register，收敛循环 consume，
    // 取代旧 _explicitAction 时间窗布尔（漏消费竞态已根治）。
    host.intents = new IntentLedger();
    host._stopping = false;
    // 会话生命周期（契约 ARCHITECTURE-CONTRACT-phase0 §3）：
    //   starting -> running -> stopping -> stopped；stopping/stopped 期间抑制一切自动拉起（INV-S1）。
    //   唯一入口 /session/stop；唯一读取口 /session/status（INV-S2/S4）。
    host._sessionState = 'starting';
    // 未守护崩溃停靠标记（意图单源，瞬态不持久）：guardian=false 时进程崩溃则置 true，
    // 使「desired=running 无条件拉起」不违背守护语义（崩溃不自救）；任何显式启动/重启/进入运行清除。
    // 不持久化：守卫重启后按 desired 恢复运行（desired 是持久用户意图，契约 §5）。
    host._crashHalted = false;
    // 用户「退出管家」的持久标记（2026-09-18 修）：退出后若守卫被外部/登录**重新拉起**，
    //   内存会话态会遗忘退出意图 -> 看护 90s 后把刚退出的桌面壳拉回（"很久以后又启动"）。
    //   退出时落盘本标记，boot 经 loadState 继承；看护**只在观测到壳已在线**时清除
    //   （用户重新打开了壳）。只抑制看护，不影响 desired/main 恢复语义（契约 §5/§6）。
    host._shellHalted = false;
    host._upgradeHold = false;      // 升级"先停后装"期间暂停自动拉起
    host._upgradeHoldSince = null;  // 兜底自愈：hold 卡死超时自动释放
    host._timer = null;
    host._heartbeatBusy = false; // 唯一心跳慢拍防重叠（C3-3b G3：on 模式收敛并入心跳后必防并发）
    host._killTimer = null;
    host._adoptKillTimer = null;
    host._initialCheckTimer = null;
    host._upgradeTimer = null;
    host._shellWatchdogTimer = null;   // 桌面壳看护定时器
    host._lastOccupiedWarn = 0;
    // 瞬态字段统一构造初始化：任何实例字段的首次赋值必须发生在此处。
    // 令牌状态不得驱动进程生命周期（DSH-TOKEN-CONTRACT TK-1/TK-2）：
    //   令牌恒存在，「拿不到」是捕捉链路 bug，故不保留令牌观察窗字段。
    host._lastMainPortRederive = 0;  // 端口再推导节流
    host._lastOrphanAuditAt = 0;     // 游离对象自检节流
    host._lastOrphanKey = null;
    host._lastOrphanAt = 0;
    host._actWindow = false;         // 收敛窗口（影子记账）
    host._mainTickActs = null;
    host._portActivesCache = null;   // 端口激活探测缓存
    host._lastLanStateJson = null;   // lan-state 内容去重
    host._routerFacade = null;       // router ctl 门面缓存
    host._lc = null;                 // DaemonLifecycle 惰性单例表
    host._dshMainLive = null;        // dsh-main.json live 缓存
    host._fallbackEntry = null;      // 目录 fallback 项
    host._lastStateBody = null;
    // main(dsh) 影子对比框架（并行不驱动）：影子只纯计算应然下一步并对比实际迁移，零行为变化；
    // 连续零 diff 拍数/累计 diff 拍数仅供日志/事件观测，不进任何决策。
    host._shadowSeq = 0;
    host._shadowConsistentBeats = 0;
    host._shadowDiffBeats = 0;
    host._shadowLast = null;   // 最近一拍影子记录 {seq,phase,shadow,actual,diff}
    host._shadowLoggedSeq = 0; // 已记账的事件拍号（心跳聚合去重）
    // 系统日志框架：守卫经每进程唯一 LogCore 取 logger/events/dshWriter/EventHub
    // （单例 init；消灭散落 new Events/createLogger/Rotator/EventHub）。
    const logCore = logcore.init({
      process: 'guard',
      logFile: host.config.supervisorLogFile,
      eventFile: host.config.logFile,
      dshLogFile: host.config.dshLogFile,
      upgradeLogFile: host.config.upgradeLogFile,
      logLevel: host.config.logLevel,
      logMaxBytes: host.config.logMaxBytes,
      eventsMaxBytes: host.config.eventsMaxBytes,
      enableHub: true,
      stateDir: path.dirname(host.config.stateFile),
      aggBase: path.basename(host.config.stateFile || 'state.json', '.json'),
      ctlPorts: { router: Number(host.config.routerCtlPort) || 43107, lan: Number(host.config.lanCtlPort) || 43108 },
      daemonLogs: {
        router: path.join(path.dirname(host.config.stateFile), 'log', 'router-daemon.log'),
        lan: path.join(path.dirname(host.config.stateFile), 'log', 'lan-daemon.log'),
      },
    });
    host.events = logCore.events;
    host.logger = logCore.logger;
    host.dshWriter = logCore.dshWriter;
    // 守卫侧聚合读路径（契约 §3.6）：真实 hub 或 EventReader 降级适配器，永不为 null，
    // 消费方（api/lifecycle.js）无需再写 if(hub)...else... 双语义分支。
    host.eventHub = logCore.reader || logCore.hub;
    // 唯一令牌节点：全系统 DSH 访问令牌的统一获取/存储/分发（原生与沙箱共用同一服务，
    // 区别只在“源”：spawn=stdout 推送 / systemd=journald 拉取）。任何目标的令牌变化统一
    // 经 onChange 下发消费方（远程控制 relay 热换 cookie），不再分散接线。
    host.tokenService = new DshTokenService({ logger: host.logger, events: host.events });
    // main 统一守卫 spawn（已废弃 systemd 托管）；纯 stdout 源 + 本地原文恢复文件（0600）：
    // 守卫重启后从文件尾恢复令牌，免重建 main 的会话中断。
    host.tokenService.attach('main', { file: path.join(path.dirname(host.config.stateFile), TOKEN_FILE_NAME) });
    host.tokenService.onChange((id, token) => {
      if (host.lanDaemonEnabled()) { try { host._syncLanState(); } catch {} return; }
      if (host.lan) { try { host.lan.applyToken(id, token); } catch (e) { host.logger.warn && host.logger.warn('lan applyToken(' + id + '): ' + e.message); } }
    });
    // OpenCode 中转：多账号 Key 轮换代理（原生实现）。
    const swDir = path.dirname(host.config.stateFile);
    // 统一「包发布/安装/更新」领域逻辑：全局镜像源配置 + 版本检查 + 安装执行。
    // DSH 自升级与反代子应用共用同一实例，镜像源配置全局一份（registry.json）。
    host.dist = new DistributionManager({
      registries: (host.config.registries && host.config.registries.length) ? host.config.registries : ['https://registry.npmjs.org'],
      registryFile: path.join(swDir, 'registry.json'),
      events: host.events,
      logger: host.logger,
      // 灰度名单事实（契约 §5）：本机配置 canary:true。仅对 @dsh-sup/* 生效。
      canary: host.config.canary === true,
    });
    // 桌面壳更新安全网门面（状态/账本/健康/审计）。纯函数式模块：
    // **不持有 dist、不调用任何安装执行器** —— 与内核更新机制完全隔离（D6）。
    host.shellDomain = shellDomain;
    // 统一安装/更新任务注册表：收敛 native/instance/plugin/router 的全部
    // 安装-升级-卸载-更新操作到同一个有状态任务模型（持久化历史 + 统一 API）。
    host.tasks = new TaskRegistry({
      stateDir: swDir,
      logger: host.logger,
      events: host.events,
    });
}

module.exports = { composeCore };
