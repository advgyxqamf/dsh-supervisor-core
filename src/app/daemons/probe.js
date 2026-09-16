'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// daemon 探活（probe）—— 步骤 7 拆分自 app/control/supervise-view.js + app/daemons/control-view.js。
//
// 职责：经 ctl 端口的监听者 cmdline 判定独立 daemon 是否在运行（守卫与 daemon 解耦后，
//   守卫探测到 daemon 在跑就不再内嵌启动，避免双占 ctl 口，只做监督）。
//   方法内一律经 this 协作（本步骤不做 ctor 注入）。
//
// 导出形态（STEP7-INTERFACE-CONTRACT §2）：module.exports = { methods: {...} }。
// ═══════════════════════════════════════════════════════════════════════════

const pidlook = require('../../platform/os/pidlookup');

module.exports = {
  methods: {
    /** 独立 router-daemon 是否在运行（探测 ctl 端口监听者 cmdline 是否 router-daemon，2026-09 L3）。
     *  守卫与 router-daemon 解耦后：守卫探测到 daemon 在跑 → 不再内嵌启动 router（避免双占 ctl 口），
     *  只做监督（lifecycleManager 周期探活 ctl 口，异常时拉起 daemon）。 */
    _routerDaemonActive() {
      try {
        const pid = pidlook.findListeningPid(this.ctl.routerPort());
        if (!pid) return false;
        // 2026-09-13 修复（P1）：路径字面量是 "/"，而 Windows 的 cmdline 是反斜杠
        //   → 直接 indexOf 永远 -1 → 认不出 daemon 已在跑（可能重复拉起）。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
      } catch { return false; }
    },

    /** **lan-daemon 模式是否启用**（结构性部署选择，非用户意图开关）。
     *
     *  ⚠ 步骤 7 归位（契约 §5 遗漏补齐）：原在 control-view.js，全仓 **20+ 处**调用
     *    （facade/lan、daemons/runtime、daemons/supervise、specs、main/process 等）。
     *    归此处（daemon 判定模块）以保持"daemon 相关判定内聚"。
     *    语义：config.lanDaemon === true 时 lan 由独立 daemon 承载（ctl 通道）；
     *    否则内嵌 LanManager。这是**部署形态选择**（壳写配置），不对用户暴露。 */
    lanDaemonEnabled() { return !!(this.config && this.config.lanDaemon === true); },

    _lanDaemonActive() {
      try {
        const pid = pidlook.findListeningPid(this.ctl.lanPort());
        if (!pid) return false;
        // 2026-09-13 修复（P1）：同 supervise-view —— 归一化后再与 "/" 字面量比较。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
      } catch { return false; }
    },
  },
};
