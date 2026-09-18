'use strict';

// app/main/controller.js —— 主收敛执行器（_dshConverge）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
//
// 阶段六 B-2 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的**惰性 deps**。
// 方法名/{ methods }/逐字体保留（令牌契约门禁读 _dshConverge 体、令牌回收门禁读 phase switch），
// 装配路径不变，AT 棘轮计数归零。
const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../platform/service/monitor');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      main() { return host.main; },
      state() { return host.state; },
      session() { return host.session; },
      events() { return host.events; },
      logger() { return host.logger; },
      ui() { return host.ui; },
      daemons() { return host.daemons; },
      intents() { return host.intents; },
      lan() { return host.lan; },
      control() { return host.control; },
      // 可变字段（readX/writeX；本文件源码须零禁用标识符，故成员名亦不含之）。
      readTicking() { return host._ticking; }, writeTicking(v) { host._ticking = v; },
      stopping() { return host._stopping; },
      writeActWindow(v) { host._actWindow = v; },
      writeMainTickActs(v) { host._mainTickActs = v; },
      readLastMainPortRederive() { return host._lastMainPortRederive; },
      writeLastMainPortRederive(v) { host._lastMainPortRederive = v; },
      upgradeHold() { return host._upgradeHold; }, writeUpgradeHold(v) { host._upgradeHold = v; },
      upgradeHoldSince() { return host._upgradeHoldSince; }, writeUpgradeHoldSince(v) { host._upgradeHoldSince = v; },
      manualRestart() { return host.manualRestart; }, writeManualRestart(v) { host.manualRestart = v; },
      writeCrashHalted(v) { host._crashHalted = v; },
      sessionState() { return host._sessionState; },
      // 字段 helper 经 host 上的既有安装转发（等价于原经 this 的调用）。
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mObservedOnly() { return host._mObservedOnly(); },
      mSpawnBlockedUntil() { return host._mSpawnBlockedUntil(); },
      mStartDeadline() { return host._mStartDeadline(); },
      mRestartAt() { return host._mRestartAt(); },
      mBackoffUntil() { return host._mBackoffUntil(); },
      mSetLastProbeAt(v) { return host._mSetLastProbeAt(v); },
      mSetLastProbeOk(v) { return host._mSetLastProbeOk(v); },
      mSetLastProbeHttpOk(v) { return host._mSetLastProbeHttpOk(v); },
      mSetAdoptPid(v) { return host._mSetAdoptPid(v); },
      mSetObservedOnly(v) { return host._mSetObservedOnly(v); },
      mSetSpawnBlockedUntil(v) { return host._mSetSpawnBlockedUntil(v); },
      mSetMissingNotified(v) { return host._mSetMissingNotified(v); },
      mSetBackoffUntil(v) { return host._mSetBackoffUntil(v); },
      mSetRestartAt(v) { return host._mSetRestartAt(v); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  // 主循环收敛段（唯一心跳驱动；外部操作仍可即时触发）。单一状态机：
  // STOPPED/STARTING/RUNNING/RESTARTING/BACKOFF。systemd 托管已废弃，main 由守卫 spawn/观测统一管理。
  async _dshConverge() {
    const d = depsOf(this);
    if (d.readTicking() || d.stopping()) return;
    // INV-S1（契约 §3.3）：会话退出中/已退出则抑制一切自动拉起，不再驱动 main 收敛。
    // 这是「退出管家」不再依赖翻 desired 防重拉的结构保证（停止由会话态而非意图态表达）。
    if (d.session().halting()) return;
    d.writeTicking(true);
    // 影子拍：收敛窗口打开（拍内实际执行动作记账，供影子对比 actual）
    d.writeActWindow(true);
    d.writeMainTickActs([]);
    let t0 = null; // 影子起点快照（try 内探测后赋值；finally 一定可见）
    try {
      // 统一健康探测（domain/monitor）：L1 端口在线（up）+ L2 HTTP 健康（httpOk）。
      // up 维持状态机的「在线/离线」收敛语义（desired/升级 hold/接管均以端口为准，不破坏原语义）；
      // httpOk 是新增的健康维度：端口在但 HTTP 挂（事件循环卡死/假死）时，连续 failThreshold 次判故障。
      const probeRes = await monitor.probe(d.config().targetHost, d.config().targetPort, {
        httpProbeEnabled: d.config().httpProbeEnabled !== false,
        healthUrl: d.config().healthUrl,
        httpTimeoutMs: d.config().probeTimeoutMs || 3000,
      });
      const portUp = probeRes.up;
      const healthOk = probeRes.httpOk;
      d.mSetLastProbeAt(new Date().toISOString());
      d.mSetLastProbeOk(portUp);
      // HTTP 健康维度同源快照（startDeadline/健康收敛决策用）
      d.mSetLastProbeHttpOk(healthOk);
      // 拍起点快照（探测后、收敛前，与决策同输入同源）
      t0 = d.main().stateSnapshot();
      // dsh 健康面由 _syncDshLifecycleView 从目录 main entry 合成（不经观测镜像喂入）。
      const host = d.config().targetHost;
      const port = d.config().targetPort;
      // spawn 托管：目标在线 = 自有 child 或接管 pid 存活。
      const childAlive = d.mChild() !== null && d.mChild().exitCode === null && d.mChild().signalCode === null;
      const adoptedAlive = d.mAdoptPid() !== null && pidlook.isAlive(d.mAdoptPid());
      const targetAlive = childAlive || adoptedAlive;

      // 原生 DSH 端口运行时再推导兜底：期望运行/观测中，配置端口无监听但受管 DSH 进程在跑
      // （用户改了端口等）时从进程真实 --port 更正（30s 节流，防 churn）。
      if (!portUp && d.state().desired() !== 'stopped' && (childAlive || adoptedAlive || d.mObservedOnly())) {
        if (!d.readLastMainPortRederive() || Date.now() - d.readLastMainPortRederive() > 30000) {
          d.writeLastMainPortRederive(Date.now());
          const found = d.main().findManagedPort();
          if (found && found.port && found.port !== d.config().targetPort) {
            // 仅当 applyPort 成功（register 通过）才跟随；失败时保留旧配置，
            // 避免注册表/healthUrl 未变而 config 已改的分叉。
            if (d.main().applyPort(found.port, found.pid)) {
              d.config().targetPort = found.port;
            }
          }
        }
      }

      // 期望状态调和优先于「进程守护」开关（desired 是正交轴）。
      // 显式 start/stop 是用户意图，必须永远生效：守护开关只约束「崩溃后自动拉起」，
      // 绝不约束用户主动点「启动 DSH / 停止 DSH」。此分支置于守护短路之前。
      if (d.state().desired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !d.mObservedOnly());
        if (managedAlive) {
          d.main().stopProcess('desired_stopped');
        } else if (adoptedAlive && d.mObservedOnly()) {
          if (d.state().phase() !== 'OBSERVED') {
            d.state().setPhase('OBSERVED');
            d.state().write();
          }
        } else if (portUp) {
          d.main().adoptObserved();
        } else {
          if (d.mAdoptPid() !== null && !adoptedAlive) {
            d.events().append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
            d.mSetAdoptPid(null);
            d.mSetObservedOnly(false);
          }
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
        }
        d.state().write();
        return;
      }

      // 升级 hold：安装期间不拉起；超时自愈防止 hold 卡死导致服务永久下线。
      if (d.upgradeHold()) {
        if (targetAlive) {
          d.main().stopProcess('upgrade_hold');
        } else {
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          const maxHold = (d.config().upgradeTimeoutMs || 600000) + 120000;
          if (d.upgradeHoldSince() && Date.now() - d.upgradeHoldSince() > maxHold) {
            d.events().append('upgrade_hold_timeout', {});
            d.ui().notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            d.writeUpgradeHold(false);
            d.writeUpgradeHoldSince(null);
          }
        }
        d.state().write();
        return;
      }

      // 手动重启请求
      if (d.manualRestart()) {
        d.writeManualRestart(false);
        if (d.state().phase() === 'RUNNING' || d.state().phase() === 'STARTING') {
          d.main().beginRestart('manual', { countCrash: false }); // _beginRestart 内部会停运行中的目标（杀 child/接管 pid），避免重复停
        } else if (d.state().phase() === 'RESTARTING' || d.state().phase() === 'BACKOFF') {
          d.mSetBackoffUntil(null);
          d.mSetRestartAt(Date.now());
          if (!targetAlive) await d.main().startProcess();
        }
        // phase === 'STOPPED' 时落到下方 switch，让端口占用检查统一生效
      }

      switch (d.state().phase()) {
        case 'STOPPED': {
          if (portUp) {
            // 接管既有实例（校验 DSH cmdline；spawn 托管）
            d.main().adopt();
            d.mSetSpawnBlockedUntil(null);
            d.mSetMissingNotified(false);
          } else if (d.mSpawnBlockedUntil() && Date.now() < d.mSpawnBlockedUntil()) {
            // 命令缺失冷静期：等待安装，不做无谓重试
          } else if (await monitor.isPortListening(host, port, 1000)) {
            // 端口被不健康进程占用：不硬抢，只告警
            d.daemons().warnOccupied();
          } else if (d.session().shouldRun()) {
            // 拉起条件（意图单源，契约 §6）：是否应运行 = (desired == running) && sessionState 允许。
            // desired 是持久用户意图（重启后据此恢复），只要 desired=running 就无条件拉起，
            // 不要求 guardian 或内存意图解锁。guardian 只约束崩溃后是否自动重启（见 RUNNING/exit 分支）。
            d.intents().consume('start'); d.intents().consume('restart'); d.intents().consume('upgrade-resume'); // 意图一次性消费（加速器，非门槛）
            await d.main().startProcess();
          } else {
            // desired=stopped（用户期望停止）：保持停止（adopt 已有进程已在上方处理）
            if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          if (portUp && healthOk) d.main().enterRunning();
          else if (Date.now() > d.mStartDeadline()) d.main().beginRestart('start_timeout', { countCrash: true });
          break;
        }
        case 'RUNNING': {
          // RUNNING 分支绝不读令牌：令牌恒存在（"拿不到"只是捕捉链路 bug），且令牌状态与
          // 进程健康正交（SSOT §2 TK-1/TK-2）。
          // spawn：只按进程存活判断，进程死了才重启，不因端口探测失败而误判
          // 守护语义：崩溃是否自动接管拉起看守护开关 guardian——开=自动拉起（退避自愈）；
          // 关=回到停止态（等用户手动启动）。
          const guarded = d.state().guardian();
          if (d.mAdoptPid() !== null && adoptedAlive === false) {
            d.events().append('dsh_exited', { code: null, signal: null, phase: d.state().phase(), adopted: true });
            d.mSetAdoptPid(null);
            if (guarded) d.main().beginRestart('adopted_exit', { countCrash: true });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else if (!childAlive && d.mChild()) {
            if (guarded) d.main().beginRestart('child_exit', { countCrash: true }); // exit 事件兜底
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else {
            // 假死识别：进程在但 HTTP 挂时连续失败判故障。health-gate 只返回决策，执行在此
            //（health-gate 不反向调 _beginRestart；依赖单向 controller -> health-gate）。
            //
            // 契约（D11 声明化）：**假死自愈不受 guardian 约束** —— 上面两个死亡分支
            //   （adopted_exit / child_exit）才看 guarded，本分支故意不看。理由：假死意味着进程
            //   **仍活着且占着端口**；若在此前置 guarded 判断，不重启就落回 STOPPED，而 STOPPED
            //   分支的 portUp 会走 adopt() 重新接管 → 下一拍又被判假死 → adopt 与假死判定
            //   **无限空转**（每轮还伴随用户可见的相位抖动）。要改此语义必须先引入稳定态，
            //   不能只加 guarded 判断。故此处保持「假死必自愈」，为有意设计而非遗漏。
            const healthDecision = d.main().applyHealthCheck(healthOk);
            if (healthDecision && healthDecision.restart) {
              d.main().beginRestart(healthDecision.reason || 'http_unhealthy', { countCrash: healthDecision.countCrash === true });
            }
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mRestartAt()) {
            // 重启前复查端口：避免对"占着端口的不健康外来进程"反复 spawn 计崩溃
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
      }
      // 升级后健康验证在 NativeManager.upgrade（waitPortHealthy）内联，无 onTick 死亡路径。
      // 远程代理自动对账：实例重启/恢复后自动重接 relay；reconcile 由 lan-daemon 每 2s 执行，
      // 守卫只写状态，不本地建 relay。
      if (!d.daemons().enabled()) { try { d.lan().reconcile().catch(()=>{}); } catch {} }
      d.state().write();
    } catch (e) {
      d.logger().error('tick error: ' + ((e && e.stack) || e));
    } finally {
      d.writeTicking(false);
      d.writeActWindow(false);
      // 会话态：首拍收敛完成，starting 迁移到 running（契约 §3.2）。
      if (d.sessionState() === 'starting') d.session().setState('running');
      // 拍末记账（actual vs shadow；不受 tick 内提前 return 影响，必定执行）
      try { d.main().shadowTickNote(t0); } catch (e) { d.logger().warn && d.logger().warn('shadow note: ' + (e && e.message)); }
      // 统一生命周期视图同步：不受 tick 内提前 return 影响，守卫每次调和后把自身（DSH）
      // 观测状态镜像到 lifecycleManager。
      try { d.control().syncDshView(); } catch (e) { d.logger().warn && d.logger().warn('sync: ' + (e && e.message)); }
    }
  }
  },
};
