'use strict';

// STEP7 分片 F —— 沙箱实例监督适配（heartbeat 拍 -> 实例域 + 目录同步）
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续使用 this。
//
// 阶段六 B-5：宿主绑定切面去 this（改经按 host 缓存的**惰性 deps**）。方法名/{ methods }/逐字体保留。
const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      stopping: () => host._stopping,
      session: () => host.session,
      instances: () => host.instances,
      logger: () => host.logger,
      control: () => host.control,
      managedObjects: () => host.managedObjects,
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      syncSandboxRegistryEntry: (entry) => host._syncSandboxRegistryEntry(entry),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    /** 沙箱实例监督单拍（v3 R3 C3-4a observe -> C3-4b supervise 接管）：heartbeat 经 adapter
     *  对每个沙箱实例执行监督收敛（InstanceManager.supervise 单实例状态机，语义=旧 tick per-instance），
     *  并把目录项与实例域状态对齐（desired/phase/guardian——目录=真实视图，防 ghost/死登记）。
     *  域业务 CRUD/安装/装配/systemd/持久化保留 InstanceManager；本方法只做心跳驱动 + 目录同步。
     *  @returns {ok:boolean} 实例当前在线（heartbeat 统一写目录 lastObserved） */
    async _sandboxSuperviseOnce(entry) {
      const d = depsOf(this);
      if (d.stopping()) return { ok: false, error: 'guard stopping' };
      // INV-S1 全域（契约 §3.3）：会话退出中/已退出 -> 沙箱不再监督收敛（防 shutdownAll 停掉后又被拉起）。
      if (d.session().halting()) return { ok: false, error: 'session halting' };
      if (entry && d.instances() && typeof d.instances().supervise === 'function') {
        try {
          await d.instances().supervise(entry.id);
        } catch (e) {
          d.logger() && d.logger().warn && d.logger().warn('sandbox supervise(' + entry.id + '): ' + ((e && e.message) || e));
        }
      }
      let st = null;
      try {
        if (entry && d.instances() && typeof d.instances().probeInstance === 'function') {
          st = d.instances().probeInstance(entry.id);
        }
      } catch (e) {
        d.logger() && d.logger().warn && d.logger().warn('sandbox probe(' + (entry && entry.id) + '): ' + ((e && e.message) || e));
      }
      const running = !!(st && st.running);
      try { d.syncSandboxRegistryEntry(entry); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox entry sync: ' + ((e && e.message) || e)); }
      return { ok: running, error: running ? null : '沙箱实例未运行' };
    },
    /** 目录项 <- 实例域状态对齐（heartbeat 监督拍后调用）：实例已删 -> 注销（防死登记）；
     *  实例存在 -> desired/guardian/name/ownership 经 _managedSandboxSpec 申报，phase 落目录唯一词表。 */
    _syncSandboxRegistryEntry(entry) {
      const d = depsOf(this);
      if (!entry || !d.managedObjects() || !d.instances()) return;
      if (d.managedObjects().get(entry.id) !== entry) return; // 条目已被替换/注销
      const inst = d.instances().find(entry.id);
      if (!inst) {
        d.control().unregister(entry.id); // 实例已不存在：目录注销（heartbeat 不再空转）
        return;
      }
      try { d.control().upsert(d.control().sandboxSpec(inst)); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox upsert: ' + ((e && e.message) || e)); }
      const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'backoff', FAILED: 'failed' };
      const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
      try {
        if (entry.phase !== ph) d.managedObjects().setPhase(entry.id, ph);
      } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox setPhase: ' + ((e && e.message) || e)); }
    },
  },
};
