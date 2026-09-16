'use strict';

// app/domain-actions/main.js —— 原生 DSH(main) 域**写动作**（R7/R8：facade 只读，写动作下沉）。
//
// 来源：src/app/facade/main.js#patchDshMain（搬迁）。
//
// 本批两处归一化（对应 R7 的"消除重复闸 / 消除跨域直读"）：
//   ① **公网暴露安全闸单一事实源**：不再内联一份与 relay 重复的校验，改调用
//      domains/relay/core.validateFrpExposure —— app 侧 patchDshMain 与 relay 侧 setFrp 同规。
//   ② **实例冲突清单改为注入**：不再直读 this.instances.instances（跨域内部数组穿透），
//      改经宿主注入的只读投影 host.exposurePeers()（装配点 app/assembly/compose.js 接线）。
//
// 无 Node 内建依赖：仅用 relay/core 的纯判定 + 宿主注入。

const { validateFrpExposure } = require('../../domains/relay/core');

const methods = {
  /** main 元数据补丁(白名单: guardian/remoteEnabled/remoteToken/frpEnabled/frpRemotePort/wanPort)。 */
  patchDshMain(patch) {
    const p = patch || {};
    const meta = this.state.readMainMeta();
    const prev = { ...meta };
    if (p.guardian !== undefined) meta.guardian = !!p.guardian;
    if (p.remoteEnabled !== undefined) meta.remoteEnabled = !!p.remoteEnabled;
    if (p.remoteToken !== undefined) meta.remoteToken = String(p.remoteToken || '');
    if (p.frpEnabled !== undefined) meta.frpEnabled = !!p.frpEnabled;
    if (p.frpRemotePort !== undefined) meta.frpRemotePort = p.frpRemotePort ? Number(p.frpRemotePort) : null;
    if (p.wanPort !== undefined) meta.wanPort = p.wanPort ? Number(p.wanPort) : null;
    // ⚠ P1 修复（2026-09-13，失效模式 g + b）：**公网暴露安全闸必须与 setFrp 同规**。
    //   缺陷：relay/ops.js 的 setFrp() 设了「开启公网暴露前必须已设 remoteToken」的安全闸
    //     （外加端口合法性 + 端口占用校验），而本函数**同样能开启 frpEnabled**却没有该闸 ——
    //     /native/settings 把 body **原样透传**到 patchDshMain（api/domains/native.js），于是
    //     POST /native/settings { frpEnabled:true, frpRemotePort:7001 }
    //     即可**绕过令牌闸**打开公网暴露。
    //   为什么后果严重：frpc 以 127.0.0.1 回环身份连 relay，来源闸对回环放行；
    //     而 relay 的 token 为空时 tokenGate 恒放行 —— 公网流量即**零认证**触达
    //     DSH 特权方法面（settings/credentials/host.*）。这正是 setFrp 那道闸要防的事。
    //   修法：调用 relay/core 的**同一份**校验（令牌 + 端口合法性 + 端口占用），单一事实源。
    //     校验必须发生在 _writeDshMain **之前**（否则已落盘半改状态）。
    //     注意：remoteToken 若在同一次 patch 里提供，视为已设置（用户一次提交两字段是合法的）。
    if (p.frpEnabled === true) {
      const effToken = (p.remoteToken !== undefined) ? String(p.remoteToken || '') : String(meta.remoteToken || '');
      const v = validateFrpExposure({
        enabled: true,
        remoteToken: effToken,
        frpRemotePort: (p.frpRemotePort !== undefined) ? p.frpRemotePort : meta.frpRemotePort,
        peers: this.views.exposurePeers(), // 注入的只读投影（不直读 this.instances.instances）
        selfId: 'main',
      });
      if (!v.ok) return { ok: false, error: v.error };
      meta.frpRemotePort = v.port;
    }
    this.state.writeMainMeta(meta);
    if (this.daemons.enabled()) { try { this.daemons.syncLanState(); } catch {} }
    // 开关变更事件（2026-09 收敛：所有 main 开关记录进事件日志，可审计回放）
    try {
      if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
        this.events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
      }
      if (p.remoteEnabled !== undefined && prev.remoteEnabled !== meta.remoteEnabled) {
        this.events.append('dsh_remote_changed', { enabled: meta.remoteEnabled === true });
      }
      if (p.frpEnabled !== undefined && prev.frpEnabled !== meta.frpEnabled) {
        this.events.append('dsh_frp_changed', { enabled: meta.frpEnabled === true });
      }
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
    return { ok: true, main: this.views.dshMain() };
  },
};

module.exports = { methods };
