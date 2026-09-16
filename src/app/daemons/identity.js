'use strict';

// STEP7 分片 F —— lan-daemon 管理锁（身份文件）
// 逐字搬迁自 src/app/daemons/control-view.js（纯搬迁，逻辑零改动）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续使用 this。

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  methods: {
    _lanLockPath() { try { return path.join(path.dirname(this.config.stateFile), 'lan-daemon.lock'); } catch { return null; } },
    _lanManaged() { try { const p = this._lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } },
    _writeLanLock() { try { const p = this._lanLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {} },
    _clearLanLock() { try { const p = this._lanLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {} },

    // ── router-daemon 管理权锁（2026-09 L3 监督）——H 追加 ──
    // 关键语义：只有「本守卫目录写过管理锁」的 Supervisor 实例才可接管/停止/拉起独立 router-daemon。
    // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存于同一主机）经全局 ctl 端口探测
    // 误接管/误杀生产 daemon（2026-09 实测 p2p-api-test 曾把测试调用经 ctl 打到线上路由）。
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
