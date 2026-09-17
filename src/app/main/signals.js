'use strict';

// app/main/signals.js —— 进程终止信号（_isManagedProcess/_signalChild/_killTree/_killSequence/_killAdopted）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');

module.exports = {
  methods: {
  /** 校验 pid 进程是否属于本守卫管理：cmdline 含配置的启动 bin，或符合 DSH 特征（兼容外部手动起的标准 DSH）。
   *  精确匹配避免"路径碰巧含 dsh 就误接管"与"安装路径不含 dsh 就漏接管"。 */
  _isManagedProcess(pid) {
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = this.config.command && this.config.command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    return pidlook.isDshCmdline(pid);
  },

  /** 向进程组发信号（detached spawn 的子进程是组长）；组信号失败退回单进程（平台层封装：
   *  POSIX 组信号；Windows 无组语义则单进程信号，树语义由 `killTree` 提供）。 */
  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  },

  /** 整树终止。
   *
   *  为什么必须单独有这个方法：
   *   平台层提供 `killTree`（Windows = `taskkill /PID <pid> /T`，POSIX = 进程组信号），
   *   实际停止路径若只用 `signalProcess`，它在 Windows 上只 `process.kill(pid, sig)`（单进程语义由平台层注释自己写明）。
   *   于是 Windows 上停止 DSH 只杀父进程：其派生的子进程（node / 浏览器 / 子命令）成为**孤儿**，
   *   继续占端口、持文件锁；守卫重启后 adopt 复用即被楔死。
   *
   *   POSIX 上 `killTree` 退化为组信号，与 `_signalChild` 等价（幂等，无害）。
   */
  _killTree(child, sig) {
    const pc = platform.processControl;
    if (pc && typeof pc.killTree === 'function') {
      pc.killTree(child.pid, sig || 'SIGKILL', () => {});
      return;
    }
    // 兜底：平台层未提供时退回单进程信号（不因能力缺失而完全不杀）
    this._signalChild(child, sig || 'SIGKILL');
  },

  _killSequence(child) {
    this.events.append('sigterm_sent', { pid: child.pid });
    // 优雅期先发 SIGTERM：Windows 上仍走单进程信号（给目标自行收尾的机会），
    // 超时后的 SIGKILL 才升级为整树（孤儿才是真问题，见上方 _killTree 说明）。
    this._signalChild(child, 'SIGTERM');
    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      if (child.exitCode === null && child.signalCode === null) {
        this._killTree(child, 'SIGKILL');
        this.events.append('sigkill_sent', { pid: child.pid, tree: platform.PLATFORM === 'win32' });
      }
    }, this.config.stopGraceMs);
  },

  /** 杀无句柄的接管实例（仅知 pid）。 */
  _killAdopted(pid) {
    this.events.append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    this._adoptKillTimer = setTimeout(() => {
      this._adoptKillTimer = null;
      if (pidlook.isAlive(pid)) {
        // 接管实例同样可能有子进程：Windows 上升级为整树（taskkill /T），
        // 否则会留下孤儿子进程占端口。
        const pc = platform.processControl;
        if (pc && typeof pc.killTree === 'function') {
          pc.killTree(pid, 'SIGKILL', () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        this.events.append('sigkill_sent', { pid, adopted: true, tree: platform.PLATFORM === 'win32' });
      }
    }, this.config.stopGraceMs);
  }
  },
};
