'use strict';

// §7（步骤 7）拆分：app/main/controller.js —— 主收敛执行器（_dshConverge）。
// 逐字搬迁自 src/app/main/converge-view.js（原型 mixin），仅做两件事：
//   1) 导出形态规范化：Object.getOwnPropertyDescriptors(X.prototype) → { methods: { ... } }（契约 §2）；
//   2) 方法体与注释逐字未改（含缩进）；方法内部继续以 this 协作（契约 §2：本步不做 ctor 注入）。
// 装配：app/assembly/compose.js 以 Object.assign(host, mod.methods) 注入（DS-G3）。
const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../platform/service/monitor');

module.exports = {
  methods: {
  // ---- 主循环收敛段（C3-3b G3 起由唯一心跳驱动；外部操作仍可即时触发）----
  // 单一状态机：STOPPED/STARTING/RUNNING/RESTARTING/BACKOFF。
  // systemd 托管已废弃——main 由守卫 spawn/观测统一管理。
  async _dshConverge() {
    if (this._ticking || this._stopping) return;
    // INV-S1（契约 §3.3）：会话退出中/已退出 → 抑制一切自动拉起，不再驱动 main 收敛。
    // 这是「退出管家」不再依赖翻 desired 防重拉的结构保证（停止由会话态而非意图态表达）。
    if (this.session.halting()) return;
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
      t0 = this.main.stateSnapshot();
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
      if (!portUp && this.state.desired() !== 'stopped' && (childAlive || adoptedAlive || this._mObservedOnly())) {
        if (!this._lastMainPortRederive || Date.now() - this._lastMainPortRederive > 30000) {
          this._lastMainPortRederive = Date.now();
          const found = this.main.findManagedPort();
          if (found && found.port && found.port !== this.config.targetPort) {
            this.main.applyPort(found.port, found.pid);
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
      if (this.state.desired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !this._mObservedOnly());
        if (managedAlive) {
          this.main.stopProcess('desired_stopped');
        } else if (adoptedAlive && this._mObservedOnly()) {
          if (this.state.phase() !== 'OBSERVED') {
            this.state.setPhase('OBSERVED');
            this.state.write();
          }
        } else if (portUp) {
          this.main.adoptObserved();
        } else {
          if (this._mAdoptPid() !== null && !adoptedAlive) {
            this.events.append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
            this._mSetAdoptPid(null);
            this._mSetObservedOnly(false);
          }
          if (this.state.phase() !== 'STOPPED') this.state.setPhase('STOPPED');
        }
        this.state.write();
        return;
      }

      // 升级 hold：安装期间不拉起；兜底超时自愈防止 hold 卡死导致服务永久下线
      // （systemd 托管专属的进程守护开关 gate 已随死分支移除——spawn 托管守卫天然负责拉起）
      if (this._upgradeHold) {
        if (targetAlive) {
          this.main.stopProcess('upgrade_hold');
        } else {
          if (this.state.phase() !== 'STOPPED') this.state.setPhase('STOPPED');
          const maxHold = (this.config.upgradeTimeoutMs || 600000) + 120000;
          if (this._upgradeHoldSince && Date.now() - this._upgradeHoldSince > maxHold) {
            this.events.append('upgrade_hold_timeout', {});
            this.ui.notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            this._upgradeHold = false;
            this._upgradeHoldSince = null;
          }
        }
        this.state.write();
        return;
      }

      // 手动重启请求
      if (this.manualRestart) {
        this.manualRestart = false;
        if (this.state.phase() === 'RUNNING' || this.state.phase() === 'STARTING') {
          this.main.beginRestart('manual', { countCrash: false }); // _beginRestart 内部会停运行中的目标（systemd 或杀接管 pid），避免重复停
        } else if (this.state.phase() === 'RESTARTING' || this.state.phase() === 'BACKOFF') {
          this._mSetBackoffUntil(null);
          this._mSetRestartAt(Date.now());
          if (!targetAlive) await this.main.startProcess();
        }
        // phase === 'STOPPED' 时落到下方 switch，让端口占用检查统一生效
      }

      switch (this.state.phase()) {
        case 'STOPPED': {
          if (portUp) {
            // 接管既有实例（校验 DSH cmdline；spawn 托管）
            this.main.adopt();
            this._mSetSpawnBlockedUntil(null);
            this._mSetMissingNotified(false);
          } else if (this._mSpawnBlockedUntil() && Date.now() < this._mSpawnBlockedUntil()) {
            // 命令缺失冷静期：等待安装，不做无谓重试
          } else if (await monitor.isPortListening(host, port, 1000)) {
            // 端口被不健康进程占用：不硬抢，只告警
            this.daemons.warnOccupied();
          } else if (this.session.shouldRun()) {
            // 拉起条件（阶段 2 意图单源，契约 §6 判定规则）：
            //   是否应运行 = (desired == running) && sessionState 允许
            // desired 是**持久用户意图**（重启后据此恢复）——只要 desired=running 就无条件拉起，
            // 不再要求 guardian 或内存意图解锁（旧门 `guardian || intents.any()` 导致「退出后
            // 重开壳 desired=running 却不拉起」）。guardian 只约束「崩溃后是否自动重启」（见 RUNNING/exit 分支）。
            this.intents.consume('start'); this.intents.consume('restart'); this.intents.consume('upgrade-resume'); // 意图一次性消费（加速器，非门槛）
            await this.main.startProcess();
          } else {
            // desired=stopped（用户期望停止）：保持停止（adopt 已有进程已在上方处理）
            if (this.state.phase() !== 'STOPPED') this.state.setPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          if (portUp && healthOk) this.main.enterRunning();
          else if (Date.now() > this._mStartDeadline()) this.main.beginRestart('start_timeout', { countCrash: true });
          break;
        }
        case 'RUNNING': {
          // 此处原有一步「令牌空置 → 观察窗后重建」的令牌回收决策：依 SSOT §2 TK-1/TK-2 删除——
          // 令牌恒存在（"拿不到"只是捕捉链路 bug），且令牌状态与进程健康正交，本 phase 迁移
          // switch 绝不读令牌。详见 supervise-view.js 的删除点注释。
          // spawn：只按进程存活判断，进程死了才重启，不因端口探测失败而误判
          // 守护语义（2026-09 收敛定稿，与沙箱对齐）：崩溃是否自动接管拉起看守护开关 guardian——
          // 开=自动拉起（退避自愈）；关=回到停止态（DSH 是什么状态就什么状态，等用户手动启动，不做过度设计）。
          const guarded = this.state.guardian();
          if (this._mAdoptPid() !== null && adoptedAlive === false) {
            this.events.append('dsh_exited', { code: null, signal: null, phase: this.state.phase(), adopted: true });
            this._mSetAdoptPid(null);
            if (guarded) this.main.beginRestart('adopted_exit', { countCrash: true });
            else { this._crashHalted = true; this.events.append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); this.state.setPhase('STOPPED'); }
          } else if (!childAlive && this._mChild()) {
            if (guarded) this.main.beginRestart('child_exit', { countCrash: true }); // exit 事件兜底
            else { this._crashHalted = true; this.events.append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); this.state.setPhase('STOPPED'); }
          } else {
            // 假死识别：进程在但 HTTP 挂 → 连续失败判故障。health-gate 只返回决策，执行在此
            //（消解 SCC②：health-gate 不再反向调 _beginRestart；依赖单向 controller → health-gate）。
            const healthDecision = this.main.applyHealthCheck(healthOk);
            if (healthDecision && healthDecision.restart) {
              this.main.beginRestart(healthDecision.reason || 'http_unhealthy', { countCrash: healthDecision.countCrash === true });
            }
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this.main.adopt();
          } else if (!targetAlive && Date.now() >= this._mRestartAt()) {
            // 重启前复查端口：避免对"占着端口的不健康外来进程"反复 spawn 计崩溃
            if (await monitor.isPortListening(host, port, 1000)) {
              this.daemons.warnOccupied();
            } else {
              await this.main.startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!this._mChild() && !adoptedAlive)) {
            this.main.adopt();
          } else if (!targetAlive && Date.now() >= this._mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              this.daemons.warnOccupied();
            } else {
              await this.main.startProcess();
            }
          }
          break;
        }
      }
      // 注：升级后健康验证已内联到 NativeManager.upgrade（waitPortHealthy），onTick 死亡路径已移除
      // 远程代理自动对账（每 tick 幂等）：实例重启/恢复后自动重接 relay——
      // 开关开启时只要目标活着反代即通（不再依赖前端拉取触发）
      // L3b：reconcile 由 lan-daemon 每 2s 执行（守卫只写状态，不本地建 relay）
      if (!this.daemons.enabled()) { try { this.lan.reconcile().catch(()=>{}); } catch {} }
      this.state.write();
    } catch (e) {
      this.logger.error('tick error: ' + ((e && e.stack) || e));
    } finally {
      this._ticking = false;
      this._actWindow = false; // C3-3b G1：收敛窗口关闭
      // 会话态：首拍收敛完成 → starting 迁移到 running（契约 §3.2）。
      if (this._sessionState === 'starting') this.session.setState('running');
      // C3-3b G1 影子：拍末记账（actual vs shadow；100% 执行——不受 tick 内提前 return 影响）
      try { this.main.shadowTickNote(t0); } catch (e) { this.logger.warn && this.logger.warn('shadow note: ' + (e && e.message)); }
      // 统一生命周期视图同步（归一化架构）：finally 100% 执行——不受 tick 内提前 return 影响，
      // 守卫每次调和后把自身（DSH）观测状态镜像到 lifecycleManager。
      try { this.control.syncDshView(); } catch (e) { this.logger.warn && this.logger.warn('sync: ' + (e && e.message)); }
    }
  }
  },
};
