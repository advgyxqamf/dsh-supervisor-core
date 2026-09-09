'use strict';

// 主机服务对接 -> 平台抽象层（src/infra/platform/autostart，三端同能力：systemd / LaunchAgent / schtasks）。
// 保留类接口（supervisor/API 调用方零改动），实现全部委托平台层。

const platform = require('../platform/os/index');

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

module.exports = { HostService };
