'use strict';

// 主机服务对接 -> 平台抽象层（src/platform/os/autostart）。
//
// ⚠ 2026-09-11 更正两处历史错误（跨平台能力审计发现）：
//   1) 路径 `src/infra/platform/autostart` **不存在** —— 平台层早已迁至 `src/platform/os/`；
//   2) 「三端同能力」是**假的** —— macOS 的壳自启/自愈从未实现。
//      真实能力以 capabilityProfile() 的 shellAutostart / shellSelfHeal 声明为准，
//      并由 test/platform-capability-audit-test.js 强制与实现绑定。
// 保留类接口（supervisor/API 调用方零改动），实现全部委托平台层。

const platform = require('../../platform/os/index');

class HostService {
  constructor(opts) {
    this.opts = opts || {};
    this.logger = opts.logger || console;
    this.events = opts.events || null;
  }

  /* ── 服务链自启（systemd / macOS LaunchAgent / Windows schtasks）── */
  autostartStatus() {
    const st = platform.autostart.status();
    return { unit: st.unit || st.kind || 'n/a', gui: !!st.gui, on: !!st.on };
  }

  setAutostart(on) {
    const r = platform.autostart.setAutostart(!!on);
    if (this.events) this.events.append('autostart_changed', { enabled: !!on, ok: !!r.ok });
    if (this.logger && this.logger.info) this.logger.info('autostart -> ' + (on ? 'on' : 'off') + (r.errors && r.errors.length ? ' errors=' + r.errors.length : ''));
    return { ok: !!r.ok, errors: r.errors || [], ...this.autostartStatus() };
  }

}

// §7.6 拆分自 supervisor.js → app/settings/settings-view.js 的 autostart 门面（步骤7 分片 C）。
// 原 HostService（主机服务对接）保留在上；新增 { methods } 导出，形态按
// STEP7-INTERFACE-CONTRACT §2 统一；方法内部继续用 this 协作（委托 this.hostService）。
module.exports = {
  HostService,
  methods: {
    autostartStatus() {
      return this.hostService.autostartStatus();
    },

    setAutostart(on) {
      return this.hostService.setAutostart(on);
    },
  },
};
