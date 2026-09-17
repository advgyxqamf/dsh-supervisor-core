'use strict';

// app/domain-actions/main.js —— 原生 DSH(main) 域写动作（facade 只读，写动作下沉至此）。
// 导出形态 { createMainActions(deps) }：**原地去 this**（P6-B-3），实现只经注入的惰性 deps 取事实，
// 故可只 require 本模块 + 假 deps 直接断言。装配侧（app/assembly/facets.js）仍把返回的方法
// **平铺**装到 host，故 api 的 sup.patchDshMain 消费面与方法语义不变。
// 公网暴露安全闸单一事实源：调用 domains/relay/core.validateFrpExposure，使 app 侧
// patchDshMain 与 relay 侧 setFrp 同规。实例冲突清单经注入的只读投影 views.exposurePeers()，
// 不直读实例域的内部数组（消除跨域穿透）。
// 无 Node 内建依赖：仅用 relay/core 的纯判定 + 注入的 deps。

const { validateFrpExposure } = require('../../domains/relay/core');

/** patchDshMain 工厂。
 *  @param deps { getState, getViews, getDaemons, getEvents, getLogger } 全为惰性取值。 */
function createMainActions(deps) {
  const g = deps || {};
  return {

    /** main 元数据补丁(白名单: guardian/remoteEnabled/remoteToken/frpEnabled/frpRemotePort/wanPort)。 */
    patchDshMain(patch) {
      const p = patch || {};
      const state = g.getState();
      const views = g.getViews();
      const meta = state.readMainMeta();
      const prev = { ...meta };
      if (p.guardian !== undefined) meta.guardian = !!p.guardian;
      if (p.remoteEnabled !== undefined) meta.remoteEnabled = !!p.remoteEnabled;
      if (p.remoteToken !== undefined) meta.remoteToken = String(p.remoteToken || '');
      if (p.frpEnabled !== undefined) meta.frpEnabled = !!p.frpEnabled;
      if (p.frpRemotePort !== undefined) meta.frpRemotePort = p.frpRemotePort ? Number(p.frpRemotePort) : null;
      if (p.wanPort !== undefined) meta.wanPort = p.wanPort ? Number(p.wanPort) : null;
      // 公网暴露安全闸必须与 relay/ops.js 的 setFrp() 同规：setFrp 要求「开启前必须已设
      // remoteToken」并校验端口合法性与占用，而本函数同样能开启 frpEnabled；若缺此闸，
      // /native/settings 把 body 原样透传到 patchDshMain（api/domains/native.js），
      // POST /native/settings { frpEnabled:true, frpRemotePort:7001 } 即可绕过令牌闸。
      // 后果：frpc 以 127.0.0.1 回环身份连 relay，来源闸对回环放行；relay 的 token 为空时
      // tokenGate 恒放行，公网流量零认证触达 DSH 特权方法面（settings/credentials/host.*）。
      // 修法：调用 relay/core 同一份校验（令牌 + 端口合法性 + 端口占用），单一事实源；
      // 校验必须发生在 state.writeMainMeta 之前，否则已落盘半改状态。
      // remoteToken 若在同一次 patch 里提供，视为已设置（一次提交两字段合法）。
      // 按「写入生效后的状态」判闸，不按原始入参类型：frpEnabled=1/"true" 等真值经上面的
      // !! 归一会落盘 true，而旧实现用 p.frpEnabled === true 判闸会跳过校验；已开启后单改
      // remoteToken='' / frpRemotePort（此时 p.frpEnabled 为 undefined）同样绕过。两者都会
      // 让空 token 落盘：relay 的 tokenGate 对空 token 恒放行 -> 公网零认证触达特权 API。
      // 只要生效后 frp 仍开启（含本次开启、或已开启而本次改令牌/端口），就必须过 validateFrpExposure。
      if (!!meta.frpEnabled) {
        const v = validateFrpExposure({
          enabled: true,
          remoteToken: String(meta.remoteToken || ''),
          frpRemotePort: meta.frpRemotePort,
          peers: views.exposurePeers(), // 注入的只读投影（不直读实例域内部数组）
          selfId: 'main',
        });
        if (!v.ok) return { ok: false, error: v.error };
        meta.frpRemotePort = v.port;
      }
      state.writeMainMeta(meta);
      const daemons = g.getDaemons();
      if (daemons.enabled()) { try { daemons.syncLanState(); } catch {} }
      // 开关变更事件：所有 main 开关记录进事件日志，可审计回放
      try {
        const events = g.getEvents();
        if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
          events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
        }
        if (p.remoteEnabled !== undefined && prev.remoteEnabled !== meta.remoteEnabled) {
          events.append('dsh_remote_changed', { enabled: meta.remoteEnabled === true });
        }
        if (p.frpEnabled !== undefined && prev.frpEnabled !== meta.frpEnabled) {
          events.append('dsh_frp_changed', { enabled: meta.frpEnabled === true });
        }
      } catch (e) { const logger = g.getLogger(); logger && logger.warn && logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
      return { ok: true, main: views.dshMain() };
    },
  };
}

module.exports = { createMainActions };
