'use strict';

// §7（步骤 7）拆分：app/control/scheduler.js —— 周期调度（tick：_dshConverge 别名）。
// 逐字搬迁自 src/app/main/converge-view.js（tick；H 负责的 _dshSuperviseOnce 追加于同一模块）（原型 mixin），仅做两件事：
//   1) 导出形态规范化：Object.getOwnPropertyDescriptors(X.prototype) → { methods: { ... } }（契约 §2）；
//   2) 方法体与注释逐字未改（含缩进）；方法内部继续以 this 协作（契约 §2：本步不做 ctor 注入）。
// 装配：app/assembly/compose.js 以 Object.assign(host, mod.methods) 注入（DS-G3）。

module.exports = {
  methods: {
  /** tick 保留为 _dshConverge 别名（C3-3b G3）：外部收敛触发点（start 首拍 / setDesired /
   *  requestRestart / _exitUpgradeHold）调用；shadow 模式下定时器也驱动此别名。
   *  on 模式下 main 每拍收敛由 heartbeat 的 dsh supervise 调用 _dshConverge（无独立 tick 定时器）。 */
  async tick() {
    return this.main.converge();
  },

  async _dshSuperviseOnce() {
    try {
      if (this._stopping) return { ok: false, error: 'guard stopping' };
      if (this.session.halting()) return { ok: false, error: 'session halting' }; // INV-S1 全域
      await this.main.converge(); // 唯一心跳驱动 main 收敛
      try { this.control.syncInstancesView(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('instances view sync: ' + ((e && e.message) || e)); } // C3-5b：聚合视图随心跳刷新
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[dsh] supervise 异常: ' + ((e && e.message) || e));
    }
    this.main.shadowHeartbeat(); // 影子聚合（每拍对新 tick 记录记账/事件）
    // R5 游离对象自检（低频 ~60s，只告警）：目录/期望之外的受管族进程与端口
    try {
      const now = Date.now();
      if (!this._lastOrphanAuditAt || now - this._lastOrphanAuditAt > 60000) {
        this._lastOrphanAuditAt = now;
        this.audit.orphan();
      }
    } catch (e) { this.logger && this.logger.debug && this.logger.debug('orphan audit: ' + ((e && e.message) || e)); }
    // 系统日志框架（P1b）：守卫 EventHub 每拍聚合 guard + daemon(ctl 拉尾, 节流 ~6 拍) 事件
    if (this.eventHub) { try { await this.eventHub.sync(); } catch (e) { this.logger && this.logger.debug && this.logger.debug('eventHub sync: ' + ((e && e.message) || e)); } }
    // C3-3a 观测语义保留：ok 与 tick 探测同源（lastProbeOk = L1 端口在线）
    return {
      ok: this._mLastProbeOk() === true,
      error: this._mLastProbeOk() ? null : (this.state.phase() === 'STOPPED' ? '未运行' : '端口未监听/不健康'),
    };
  },

  },
};
