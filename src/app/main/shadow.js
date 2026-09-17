'use strict';

// app/main/shadow.js —— 影子记账（_actNote/_mainActualAction/_shadowExcluded/_shadowTickNote/_shadowHeartbeatBeat）。
// 影子对照真实收敛动作，连续零 diff 是收敛切换门槛的观测依据。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。

module.exports = {
  methods: {
  /** 实际执行动作记账（拍窗口内）。仅在 tick 收敛窗口内生效（_actWindow）；
   *  窗口外的外部动作（child exit / 升级钩子）不记账——其迁移由后续拍相位对分类覆盖。 */
  _actNote(action, reason) {
    if (!this._actWindow) return;
    if (!this._mainTickActs) this._mainTickActs = [];
    this._mainTickActs.push({ action, reason });
  },

  /** 本拍实际执行的迁移动作：优先拍内执行器记录（最精确且含 reason），否则按相位对分类。 */
  _mainActualAction(t0) {
    const acts = this._mainTickActs || [];
    if (acts.length > 0) return acts[acts.length - 1];
    const from = t0.phase;
    const to = this.state.phase();
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
    if (this.state.desired() === 'stopped' || this._upgradeHold) {
      return { action: 'stop', reason: this._upgradeHold ? 'upgrade_hold' : 'desired_stopped' };
    }
    return { action: 'none', reason: 'unclassified:' + p };
  },

  /** 影子 diff 排除集：异步事件/守卫业务钩子触发（非主循环收敛决策可比范畴），
   *  不计入 diff 与零 diff 门槛。升级钩子 / child exit / spawn error / 假死。
   *  排除项的意义是豁免异步事件触发的迁移，而不是给凭据驱动的重启开后门。 */
  _shadowExcluded(reason) {
    if (!reason) return false;
    const r = String(reason);
    return /^(exit:|spawn_error|http_unhealthy|upgrade|upgrade_hold|port_occupied)/.test(r);
  },

  /** 拍末影子记账（tick finally 调用：本拍实际迁移已收敛完成）。 */
  _shadowTickNote(t0) {
    try {
      if (this._stopping) return;
      const actual = this._mainActualAction(t0);
      const shadow = this.main.decideAction(t0);
      const exActual = this._shadowExcluded(actual && actual.reason);
      const diff = !!(actual && shadow) && (actual.action !== shadow.action) && !exActual;
      const rec = {
        seq: ++this._shadowSeq,
        t0phase: t0.phase,
        phase: this.state.phase(),
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
  },

  /** 心跳拍聚合（dsh adapter supervise 调用）：有新 tick 记录才记账/发事件；无则不刷。
   *  连续 5 拍零 diff 记 info（收敛切换门槛观测）。 */
  _shadowHeartbeatBeat() {
    try {
      const rec = this._shadowLast;
      if (!rec) return;
      if (this._shadowLoggedSeq === rec.seq) return;
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
  },
};
