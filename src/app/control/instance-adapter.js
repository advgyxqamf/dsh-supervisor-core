'use strict';

// STEP7 分片 F —— 沙箱实例监督适配（heartbeat 拍 → 实例域 + 目录同步）
// 逐字搬迁自 src/app/daemons/control-view.js（纯搬迁，逻辑零改动）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续使用 this。

module.exports = {
  methods: {
    /** 沙箱实例监督单拍（v3 R3 C3-4a observe → C3-4b supervise 接管）：heartbeat 经 adapter
     *  对每个沙箱实例执行监督收敛（InstanceManager.supervise 单实例状态机，语义=旧 tick per-instance），
     *  并把目录项与实例域状态对齐（desired/phase/guardian——目录=真实视图，防 ghost/死登记）。
     *  域业务 CRUD/安装/装配/systemd/持久化保留 InstanceManager；本方法只做心跳驱动 + 目录同步。
     *  @returns {ok:boolean} 实例当前在线（heartbeat 统一写目录 lastObserved） */
    async _sandboxSuperviseOnce(entry) {
      if (this._stopping) return { ok: false, error: 'guard stopping' };
      // INV-S1 全域（契约 §3.3）：会话退出中/已退出 → 沙箱不再监督收敛（防 shutdownAll 停掉后又被拉起）。
      if (this.session.halting()) return { ok: false, error: 'session halting' };
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
    },
    /** 目录项 ← 实例域状态对齐（heartbeat 监督拍后调用）：实例已删 → 注销（防死登记）；
     *  实例存在 → desired/guardian/name/ownership 经 _managedSandboxSpec 申报，phase 落目录唯一词表。 */
    _syncSandboxRegistryEntry(entry) {
      if (!entry || !this.managedObjects || !this.instances) return;
      if (this.managedObjects.get(entry.id) !== entry) return; // 条目已被替换/注销
      const inst = this.instances.find(entry.id);
      if (!inst) {
        this.control.unregister(entry.id); // 实例已不存在：目录注销（heartbeat 不再空转）
        return;
      }
      try { this.control.upsert(this.control.sandboxSpec(inst)); } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox upsert: ' + ((e && e.message) || e)); }
      const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'backoff', FAILED: 'failed' };
      const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
      try {
        if (entry.phase !== ph) this.managedObjects.setPhase(entry.id, ph);
      } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox setPhase: ' + ((e && e.message) || e)); }
    },
  },
};
