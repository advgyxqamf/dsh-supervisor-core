'use strict';

// 管家面板局域网访问开关门面。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-5：直接调用与属性访问去 this（改经按 host 缓存的**惰性 deps**）。方法名/{ methods }/逐字体保留。
const fs = require('node:fs');
const netInfo = require('../../platform/os/netinfo');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config,
      logger: () => host.logger,
      events: () => host.events,
      configPath: () => host.configPath,
      api: () => host.api,
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      lanPanelStatus: () => host.lanPanelStatus(),
      apiRebind: () => host._apiRebind(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    lanPanelStatus() {
      const d = depsOf(this);
      const enabled = d.config().apiHost === '0.0.0.0';
      const port = d.config().apiPort;
      // 真实可访问地址：只给局域网内设备真正能访问的地址——取「走默认路由的真实出口网卡」的
      // IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
      const ips = [];
      if (enabled) {
        // 不能直接调 ip(iproute2)——Linux 专有，macOS/Windows 抛异常被吞，ips 恒空且不报错；
        // 经 platform/os/netinfo（三平台实现 + platform/util/exec 有界执行）。
        ips.push(...netInfo.lanAddresses());
        if (!ips.length) {
          d.logger() && d.logger().warn && d.logger().warn(
            "lan ips: 未枚举到可用局域网地址（platform=" + netInfo.PLATFORM +
            ", supported=" + netInfo.supported + "）"
          );
        }
      } else {
        ips.push("127.0.0.1");
      }
      // 去重保持稳定顺序
      const unique = [...new Set(ips)];
      return { enabled, host: d.config().apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
    },

    /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
    setLanPanel(enabled) {
      const d = depsOf(this);
      try {
        const on = enabled === true;
        // 开 LAN 必须已配置出回环访问密钥（apiAccessKey）：访问密钥层只对「已配置 key」的
        // 非回环请求生效，未配置时局域网内任意设备可零认证驱动写 API。故显式要求先设 key。
        if (on && !(d.config() && d.config().apiAccessKey)) {
          // code 供 API 层区分「客户端可修正的前置条件失败」（400）与「持久化异常」（500）。
          return { ok: false, code: 'ACCESS_KEY_REQUIRED', error: '开启局域网访问前请先设置访问密钥（apiAccessKey），否则局域网内任意设备可无认证访问' };
        }
        const host = on ? '0.0.0.0' : '127.0.0.1';
        const changed = d.config().apiHost !== host;
        d.config().apiHost = host;
        // 落盘失败必须如实上报（与 access.js 的处理口径一致）：内存是运行期权威，故仍完成重绑与事件，
        //   但把「未落盘」这一事实透传（api/domains/guard.js 据此回 500）。原实现只 logger.error 后
        //   照报 ok:true —— 面板显示已切换、重启后却回旧值（AUDIT D8 的同型另一半）。
        let persistError = null;
        if (d.configPath()) {
          try {
            const doc = JSON.parse(fs.readFileSync(d.configPath(), 'utf8'));
            doc.apiHost = host;
            const ctmp = d.configPath() + '.tmp';
            fs.writeFileSync(ctmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
            fs.renameSync(ctmp, d.configPath()); // 原子 + 0600
          } catch (e) {
            persistError = 'persist apiHost: ' + e.message;
            d.logger().error(persistError);
          }
        }
        if (changed && d.api() && typeof d.api().close === 'function') d.apiRebind();
        if (d.events()) d.events().append('lan_panel_changed', { enabled: on });
        if (d.logger() && d.logger().info) d.logger().info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
        // 取一次即可（原两处各调一次）：lanPanelStatus 会枚举局域网地址（平台子进程），
        //   且两者必须是同一份快照，否则成功/失败返回的 host/urls 可能不一致。
        const panel = d.lanPanelStatus();
        if (persistError) return { ok: false, error: persistError, ...panel };
        return { ok: true, ...panel };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
