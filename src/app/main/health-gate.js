'use strict';

// app/main/health-gate.js —— 崩溃窗口/退避记账（_bumpCrashWindow）与假死判定（_applyHealthCheck）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
const guardian = require('../../shared/guardian');

module.exports = {
  methods: {
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
      this.state.setPhase('BACKOFF');
      this.events.append('crash_loop_entered', {
        level: d.backoffLevel,
        waitMs: this.config.backoff[d.backoffLevel],
      });
      this.logger.error('crash loop entered: level=' + d.backoffLevel + ' waitMs=' + this.config.backoff[d.backoffLevel]);
      this.ui.notify('DSH 反复崩溃', '已进入第 ' + d.backoffLevel + ' 级退避（' + Math.round(this.config.backoff[d.backoffLevel] / 1000) + 's），请查看 dsh-supervisor 面板');
    }
  },

  /** 假死识别（健康维度判定）：进程/端口在但 HTTP 不健康时连续 failThreshold 次判故障重启。
   *  单次抖动不清零（failStreak 单调累积直到达到阈值或恢复健康），达到阈值即触发。
   *  httpProbeEnabled=false 时 healthOk 恒为 true（monitor.probe 已退化），此处天然不触发。
   *
   *  本方法只记账 + 返回决策，不直接调 this.main.beginRestart()（否则造成
   *  health-gate -> process 反向边）；执行由收敛器（main/controller.js）承担。
   *  依赖单向：controller/process -> health-gate。
   *  @returns {{restart:boolean, reason?:string, countCrash?:boolean}} */
  _applyHealthCheck(healthOk) {
    if (healthOk) {
      this._mSetFailStreak(0);
      return { restart: false };
    }
    this._mSetFailStreak(this._mFailStreak() + 1);
    const threshold = this.config.failThreshold || 2;
    if (this._mFailStreak() >= threshold) {
      this.events.append('unhealthy', { reason: 'http_unhealthy', streak: this._mFailStreak() });
      return { restart: true, reason: 'http_unhealthy', countCrash: true };
    }
    return { restart: false };
  }
  },
};
