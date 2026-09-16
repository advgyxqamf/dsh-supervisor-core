'use strict';

// §7.6 拆分自 supervisor.js → app/settings/settings-view.js → app/settings/access.js（步骤7 分片 C）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续用 this 协作。
module.exports = {
  methods: {
    // ---- 出回环访问密钥（F2 定案）：状态查询 + 设置/清除（api/guard.js 的 /settings 路由引用此门面；
    // 2026-09 修复：此前该路由调 sup.accessKeyStatus() 但 Supervisor 从未实现该门面 →
    // 设置页每次 GET 抛 uncaughtException → 守卫 60s 3 次异常自杀重启 → 设置页长时间无响应。）----
    /** 状态（不回显明文）：configured + host。 */
    accessKeyStatus() {
      const cfg = this.config || {};
      return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
    },

    /** 设置/清除出回环访问密钥（空串=清除）。原子持久化到守卫 config。 */
    setAccessKey(key) {
      try {
        const cfg = this.config || {};
        const k = typeof key === 'string' ? key.trim() : '';
        if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
        cfg.apiAccessKey = k || null;
        if (this.configPath) this.state.persistConfigPatch({ apiAccessKey: k || null });
        if (this.events) this.events.append('access_key_changed', { configured: !!k });
        return { ok: true, configured: !!k };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // ---- 关闭窗口行为（2026-09 用户定稿）：隐藏至托盘 / 退出管家（壳读取执行；系统级配置）----
    /** 当前关闭行为：'hide' | 'exit'。 */
    closeActionStatus() {
      const cfg = this.config || {};
      const v = cfg.closeAction;
      return { closeAction: (v === 'exit') ? 'exit' : 'hide' };
    },

    /** 设置关闭行为（'hide'=关闭隐藏至托盘，服务继续；'exit'=关闭=退出管家，停止全部服务链）。 */
    setCloseAction(v) {
      try {
        const val = (v === 'exit') ? 'exit' : 'hide';
        const cfg = this.config || {};
        cfg.closeAction = val;
        if (this.configPath) this.state.persistConfigPatch({ closeAction: val });
        if (this.events) this.events.append('close_action_changed', { closeAction: val });
        return { ok: true, closeAction: val };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
