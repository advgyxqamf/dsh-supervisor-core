'use strict';

// 管家面板局域网访问开关门面。
// 导出形态 { methods }，方法经 this 协作。
const fs = require('node:fs');
const netInfo = require('../../platform/os/netinfo');

module.exports = {
  methods: {
    lanPanelStatus() {
      const enabled = this.config.apiHost === '0.0.0.0';
      const port = this.config.apiPort;
      // 真实可访问地址：只给局域网内设备真正能访问的地址——取「走默认路由的真实出口网卡」的
      // IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
      const ips = [];
      if (enabled) {
        // 不能直接调 ip(iproute2)——Linux 专有，macOS/Windows 抛异常被吞，ips 恒空且不报错；
        // 经 platform/os/netinfo（三平台实现 + platform/util/exec 有界执行）。
        ips.push(...netInfo.lanAddresses());
        if (!ips.length) {
          this.logger && this.logger.warn && this.logger.warn(
            "lan ips: 未枚举到可用局域网地址（platform=" + netInfo.PLATFORM +
            ", supported=" + netInfo.supported + "）"
          );
        }
      } else {
        ips.push("127.0.0.1");
      }
      // 去重保持稳定顺序
      const unique = [...new Set(ips)];
      return { enabled, host: this.config.apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
    },

    /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
    setLanPanel(enabled) {
      try {
        const on = enabled === true;
        // 开 LAN 必须已配置出回环访问密钥（apiAccessKey）：访问密钥层只对「已配置 key」的
        // 非回环请求生效，未配置时局域网内任意设备可零认证驱动写 API。故显式要求先设 key。
        if (on && !(this.config && this.config.apiAccessKey)) {
          // code 供 API 层区分「客户端可修正的前置条件失败」（400）与「持久化异常」（500）。
          return { ok: false, code: 'ACCESS_KEY_REQUIRED', error: '开启局域网访问前请先设置访问密钥（apiAccessKey），否则局域网内任意设备可无认证访问' };
        }
        const host = on ? '0.0.0.0' : '127.0.0.1';
        const changed = this.config.apiHost !== host;
        this.config.apiHost = host;
        if (this.configPath) {
          try {
            const doc = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            doc.apiHost = host;
            const ctmp = this.configPath + '.tmp';
            fs.writeFileSync(ctmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
            fs.renameSync(ctmp, this.configPath); // 原子 + 0600
          } catch (e) { this.logger.error('persist apiHost: ' + e.message); }
        }
        if (changed && this.api && typeof this.api.close === 'function') this._apiRebind();
        if (this.events) this.events.append('lan_panel_changed', { enabled: on });
        if (this.logger && this.logger.info) this.logger.info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
        return { ok: true, ...this.lanPanelStatus() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
