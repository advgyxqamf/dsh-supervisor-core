'use strict';

// daemon 探活（probe）：经 ctl 端口的监听者 cmdline 判定独立 daemon 是否在运行。
// 守卫探测到 daemon 在跑就不再内嵌启动，避免双占 ctl 口，只做监督。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-1 补齐：属性级去 this（改经按 host 缓存的**惰性 deps**）。方法名/{ methods }/逐字体保留。
const pidlook = require('../../platform/os/pidlookup');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) { d = { config: () => host.config, ctl: () => host.ctl }; DEPS.set(host, d); }
  return d;
}

module.exports = {
  methods: {
    /** 独立 router-daemon 是否在运行（探测 ctl 端口监听者 cmdline 是否 router-daemon）。
     *  守卫探测到 daemon 在跑就不再内嵌启动 router（避免双占 ctl 口），只做监督
     *  （lifecycleManager 周期探活 ctl 口，异常时拉起 daemon）。 */
    _routerDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().routerPort());
        if (!pid) return false;
        // 匹配前必须归一化分隔符：路径字面量是 "/"，而 Windows 的 cmdline 是反斜杠，
        //   直接 indexOf 永远 -1，会认不出 daemon 已在跑而重复拉起。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
      } catch { return false; }
    },

    /** lan-daemon 模式是否启用（结构性部署选择，非用户意图开关）。
     *  config.lanDaemon === true 时 lan 由独立 daemon 承载（ctl 通道），
     *  否则内嵌 LanManager。这是部署形态选择（壳写配置），不对用户暴露。 */
    lanDaemonEnabled() { const d = depsOf(this); const cfg = d.config(); return !!(cfg && cfg.lanDaemon === true); },

    _lanDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().lanPort());
        if (!pid) return false;
        // 同 router：归一化分隔符后再与 "/" 字面量比较。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
      } catch { return false; }
    },
  },
};
