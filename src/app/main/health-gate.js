'use strict';

// §7（步骤 7）拆分：app/main/health-gate.js —— 崩溃窗口/退避记账（_bumpCrashWindow）。
// 逐字搬迁自 src/app/main/main-process.js（原型 mixin），仅做两件事：
//   1) 导出形态规范化：Object.getOwnPropertyDescriptors(X.prototype) → { methods: { ... } }（契约 §2）；
//   2) 方法体与注释逐字未改（含缩进）；方法内部继续以 this 协作（契约 §2：本步不做 ctor 注入）。
// 装配：app/assembly/compose.js 以 Object.assign(host, mod.methods) 注入（DS-G3）。
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

  /** 假死识别（健康维度判定）：进程/端口在但 HTTP 不健康 → 连续 failThreshold 次判故障重启。
   *  单次抖动不清零（failStreak 单调累积直到达到阈值或恢复健康），达到阈值即触发。
   *  httpProbeEnabled=false 时 healthOk 恒为 true（monitor.probe 已退化），此处天然不触发。
   *
   *  ⚠ 结构改造（消解 SCC②：main/process ↔ main/health-gate）：本方法**只记账 + 返回决策**，
   *    不再直接调 this.main.beginRestart()（那会造成 health-gate→process 反向边）。执行由收敛器
   *    （main/controller.js）承担 —— 依赖单向：controller/process → health-gate。
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
