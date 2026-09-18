'use strict';

// app/facade/lan.js —— lan(relay) 域只读门面（写动作 setLanFrp/lanFrpc/syncFrpc 在
// app/domain-actions/lan.js）。只读白名单（DG-14 强制）：listLan（读触发对账，见
// FACADE_EXCEPTIONS）/ frpStatus；daemon 模式经 43108 ctl 委托，内嵌模式走 LanManager
// 只读方法。导出契约：module.exports = { methods }，方法内部走 this。
//
// 阶段六 B-1 补齐：属性级去 this（改经按 host 缓存的**惰性 deps**）。方法名/{ methods }/
// 逐字体保留；DG-14 的 facadeWriteViolations 与 token-boundary 的 host._lanCtlCall 覆写面不变。
const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = { daemons: () => host.daemons, ctl: () => host.ctl, lan: () => host.lan };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  // 远程控制委托：全部转发给 LanManager。
  // daemon 监督模式经 43108 ctl 委托（异步）；本地模式走 LanManager（同步）。
  // 令牌收敛：listLan 输出剔除 token/dshToken——/lan-access 允许 LAN/私网 Host 访问，
  // 直出 dshToken 会把 DSH 会话令牌泄漏给局域网；权威仍在 DshTokenService（relay 经
  // tokenOf 内部读取，无需经此透传）。返回形如 {items,addresses}。
  listLan() {
    const d = depsOf(this);
    // 白名单外显：只放行结构字段与注入状态 inject；任何令牌字段都不外传。
    const sanitize = (r) => {
      if (!r || !r.items) return r;
      return { items: r.items.map((it) => {
        const out = {
          id: it.id, name: it.name, dshPort: it.dshPort, wanPort: it.wanPort,
          enabled: !!it.enabled, localPort: it.localPort || null, running: !!it.running,
          // 公网暴露状态（非机密）必须过白名单，否则 UI 无法呈现开关与远端端口。
          frpEnabled: it.frpEnabled === true,
          frpRemotePort: it.frpRemotePort || null,
          // 令牌状态（布尔，不泄明文）：公网暴露的安全闸要求已设令牌，UI 据此引导。
          tokenSet: !!String(it.token || '').trim(),
        };
        if (it.inject) {
          out.inject = {
            tokenSet: !!it.inject.tokenSet,
            cookieReady: !!it.inject.cookieReady,
            lastOkAt: it.inject.lastOkAt || null,
            lastError: it.inject.lastError || null,
            lastErrorAt: it.inject.lastErrorAt || null,
          };
        }
        return out;
      }), addresses: r.addresses || [] };
    };
    if (d.daemons().enabled() /* daemon 启用即 ctl */) return d.ctl().lanCall('list').then(sanitize).catch(() => ({ items: [], addresses: [] }));
    try { return sanitize(d.lan().list()); } catch { return { items: [], addresses: [] }; }
  },

  frpStatus() {
    const d = depsOf(this);
    if (d.daemons().enabled() /* daemon 启用即 ctl */) return d.ctl().lanCall('frpStatus');
    return d.lan().frpStatus();
  },
} };
