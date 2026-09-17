'use strict';

// app/main/decide.js —— 主进程收敛的纯决策段（_mainStateSnapshot/_decideMainAction/_decideCrashRestart）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
const pidlook = require('../../platform/os/pidlookup');

module.exports = {
  methods: {
  _mainStateSnapshot() {
    const now = Date.now();
    return {
      phase: this.state.phase(),
      desired: this.state.desired(),
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
      // `_shouldRun()` 有两个否决位，快照必须建模（crashHalted/sessionHalting），否则影子每拍
      // 算出的应然与真实 tick 不一致，零 diff 门槛永久不可达。
      crashHalted: this._crashHalted === true, // guardian=false 崩溃后停靠：等显式启动
      sessionHalting: this.session.halting() === true, // 退出流程中：抑制一切自动拉起
      crashWindowStart: this._mCrashWindowStart(),
      crashWindowRestarts: this._mCrashWindowRestarts(),
      backoffLevel: this._mBackoffLevel(),
    };
  },

  /** 纯决策：按现有 tick 语义计算「应然下一步」。action 词表：
   *  none/start/stop/adopt/adoptObserved/enterRunning/restart/backoff。
   *  只读快照，零副作用（影子与收敛复用同一决策源）。 */
  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    // desired=stopped（正交于守护开关；显式用户意图永远生效）
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.probeOk) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    // 升级 hold：安装期间不拉起（超时自愈是业务钩子）
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    // 手动重启请求（守卫业务标志，本拍消费）
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', countCrash: false };
      if (s.phase === 'RESTARTING' || s.phase === 'BACKOFF') {
        // tick 语义：先清 backoff/restartAt 再立即拉起（!targetAlive）
        if (!targetAlive) return { action: 'start', reason: 'manual_retry' };
        // targetAlive 则落 switch（端口占用检查统一生效）
      }
      // phase===STOPPED 则落 switch
    }
    switch (s.phase) {
      case 'STOPPED': {
        // 顺序与 `_shouldRun()` 一致：两个否决位必须先于拉起判断，否则影子会算出 start
        // 而真实 tick 拒绝，永久 diff。
        if (s.sessionHalting) return { action: 'none', reason: 'session_halting' };
        if (s.crashHalted) return { action: 'none', reason: 'crash_halted_await_explicit_start' };
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
  },

  /** 崩溃类 restart 决策：与 _beginRestart(countCrash=true) 语义一致——动作统一 restart
   *  （_beginRestart 内部 _bumpCrashWindow 的退避记账/crash_loop_entered 属守卫业务，不改变动作词）。 */
  _decideCrashRestart(reason) {
    return { action: 'restart', reason, countCrash: true };
  }
  },
};
