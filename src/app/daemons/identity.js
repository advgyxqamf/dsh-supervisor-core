'use strict';

// lan-daemon / router-daemon 管理锁（身份文件）。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的
// **惰性 deps**（WeakMap；getter 每次读 host 实时值）。方法仍以 { methods } 导出、名字与体
// 逐字保留：装配路径 installMethods(host, mod.methods) 不变，AT 棘轮的直接方法调用计数归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。

const fs = require('node:fs');
const path = require('node:path');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      lanLockPath() { return host._lanLockPath(); },
      routerDaemonLockPath() { return host._routerDaemonLockPath(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    _lanLockPath() { const d = depsOf(this); try { return path.join(path.dirname(d.config().stateFile), 'lan-daemon.lock'); } catch { return null; } },
    _lanManaged() { const d = depsOf(this); try { const p = d.lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } },
    _writeLanLock() { const d = depsOf(this); try { const p = d.lanLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {} },
    _clearLanLock() { const d = depsOf(this); try { const p = d.lanLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {} },

    // router-daemon 管理权锁：只有「本守卫目录写过管理锁」的实例才可接管/停止/拉起独立 router-daemon，
    // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存）经全局 ctl 端口探测误接管/误杀生产 daemon。
    _routerDaemonLockPath() {
      const d = depsOf(this);
      try { return path.join(path.dirname(d.config().stateFile), 'router-daemon.lock'); } catch { return null; }
    },

    _daemonManaged() {
      const d = depsOf(this);
      try { const p = d.routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
    },

    _writeRouterDaemonLock() {
      const d = depsOf(this);
      try { const p = d.routerDaemonLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {}
    },

    _clearRouterDaemonLock() {
      const d = depsOf(this);
      try { const p = d.routerDaemonLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {}
    },
  },
};
