'use strict';

// §7.6 拆分自 supervisor.js → app/settings/settings-view.js → app/settings/lan-panel.js（步骤7 分片 C）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续用 this 协作。
const fs = require('node:fs');
const netInfo = require('../../platform/os/netinfo');

module.exports = {
  methods: {
    // ---- 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）----
    lanPanelStatus() {
      const enabled = this.config.apiHost === '0.0.0.0';
      const port = this.config.apiPort;
      // 真实可访问地址（2026-09 用户指正）：只给局域网内设备真正能访问的地址——
      // 取「走默认路由的真实出口网卡」的 IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
      const ips = [];
      if (enabled) {
        // ★ 平台化（2026-09-11 修 K8）：原实现**直接**调用 `ip` (iproute2) ——
        //   这是 Linux 专有命令；在 macOS/Windows 上抛异常后被 catch 吞掉，
        //   于是 ips 恒为空 → 面板显示「开关已开但没有任何可访问地址」，
        //   且**不报错**（静默降级）。同时它也是裸 execFileSync（无超时）。
        //   现下沉到 platform/os/netinfo（三平台实现 + 经 platform/util/exec 有界）。
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
        const host = enabled ? '0.0.0.0' : '127.0.0.1';
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
        if (this.events) this.events.append('lan_panel_changed', { enabled });
        if (this.logger && this.logger.info) this.logger.info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
        return { ok: true, ...this.lanPanelStatus() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
