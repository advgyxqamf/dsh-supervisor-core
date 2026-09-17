'use strict';

// lan-daemon / router-daemon 管理锁（身份文件）。
// 导出形态 { methods }，方法经 this 协作。

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  methods: {
    _lanLockPath() { try { return path.join(path.dirname(this.config.stateFile), 'lan-daemon.lock'); } catch { return null; } },
    _lanManaged() { try { const p = this._lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } },
    _writeLanLock() { try { const p = this._lanLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {} },
    _clearLanLock() { try { const p = this._lanLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {} },

    // router-daemon 管理权锁：只有「本守卫目录写过管理锁」的实例才可接管/停止/拉起独立 router-daemon，
    // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存）经全局 ctl 端口探测误接管/误杀生产 daemon。
    _routerDaemonLockPath() {
      try { return path.join(path.dirname(this.config.stateFile), 'router-daemon.lock'); } catch { return null; }
    },

    _daemonManaged() {
      try { const p = this._routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
    },

    _writeRouterDaemonLock() {
      try { const p = this._routerDaemonLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {}
    },

    _clearRouterDaemonLock() {
      try { const p = this._routerDaemonLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {}
    },
  },
};
