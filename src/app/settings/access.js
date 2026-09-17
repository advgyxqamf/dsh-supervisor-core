'use strict';

// 出回环访问密钥 / 关闭窗口行为门面。
// 导出形态 { methods }，方法经 this 协作。
module.exports = {
  methods: {
    // 出回环访问密钥：状态查询 + 设置/清除（api/guard.js 的 /settings 路由引用此门面）。
    /** 不回显明文。 */
    accessKeyStatus() {
      const cfg = this.config || {};
      return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
    },

    /** 设置/清除出回环访问密钥（空串=清除）。原子持久化到守卫 config。
     *  清空密钥必须**同时回关 LAN**（apiHost → 127.0.0.1 并持久化）：lan-panel 的开 LAN 前置条件是
     *  「已有 apiAccessKey」，若只清 key 不动 apiHost，就会留下「绑定 0.0.0.0 且零认证」的暴露窗口。
     *  监听 socket 的即时生效由 api 层的 fail-closed 兜底（本层只负责让配置事实自洽，不在此重绑）。 */
    setAccessKey(key) {
      try {
        const cfg = this.config || {};
        const k = typeof key === 'string' ? key.trim() : '';
        if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
        cfg.apiAccessKey = k || null;
        const patch = { apiAccessKey: k || null };
        // 非回环绑定 + 无密钥 = 零认证暴露 → 一并回关（与 setLanPanel 的开 LAN 前置条件对称）。
        const lanClosed = !k && !!cfg.apiHost && cfg.apiHost !== '127.0.0.1';
        if (lanClosed) {
          cfg.apiHost = '127.0.0.1';
          patch.apiHost = '127.0.0.1';
        }
        if (this.configPath) this.state.persistConfigPatch(patch);
        if (this.events) this.events.append('access_key_changed', { configured: !!k, lanClosed });
        return { ok: true, configured: !!k, lanClosed, host: cfg.apiHost || undefined };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // 关闭窗口行为：隐藏至托盘 / 退出管家（壳读取执行；系统级配置）。
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
