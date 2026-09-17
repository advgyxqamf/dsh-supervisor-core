'use strict';

const fs = require('node:fs');

// 出回环访问密钥 / 关闭窗口行为门面。
// 导出形态 { methods }，方法经 this 协作。
//
// 行为变更声明（P4-A-2 #6）：setAccessKey/setCloseAction 原先无论是否落盘成功都回 { ok:true }；
//   现当「有 configPath 且本次补丁未落盘」时如实回 { ok:false, error }（写入失败原因透传）。
//   无 configPath（本层不做持久化）与核验通过仍回 { ok:true }；内存态 config 不回滚。
/** 读回配置文件核验本次补丁的每个键是否落盘（核验可观测结果，不重实现持久化）。
 *  写入契约仍在 state.persistConfigPatch（app/state/desired.js）；本函数只读盘、不写盘。
 *  返回 null 表示通过或不适用（无 configPath）；返回字符串为失败原因（供透传）。 */
function verifyPersisted(configPath, patch) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return '配置读取核验失败: ' + e.message;
  }
  for (const name of Object.keys(patch)) {
    if (doc[name] !== patch[name]) return '配置未落盘: ' + name;
  }
  return null;
}

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
        if (this.configPath) {
          this.state.persistConfigPatch(patch);
          // 核验落盘结果：写入失败时如实回失败并透传原因（无 configPath 时本层不持久化，保持 ok:true）。
          const persistError = verifyPersisted(this.configPath, patch);
          if (persistError) return { ok: false, error: persistError };
        }
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
        if (this.configPath) {
          this.state.persistConfigPatch({ closeAction: val });
          // 核验落盘结果：写入失败时如实回失败并透传原因（无 configPath 时本层不持久化，保持 ok:true）。
          const persistError = verifyPersisted(this.configPath, { closeAction: val });
          if (persistError) return { ok: false, error: persistError };
        }
        if (this.events) this.events.append('close_action_changed', { closeAction: val });
        return { ok: true, closeAction: val };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
