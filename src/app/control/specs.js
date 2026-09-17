'use strict';

// 
// app/control/specs.js —— 受管对象申报工厂（真 ctor 注入）。
//
// 级 2：createSpecs(deps) 自己持有申报/注册实现。
//   const specs = createSpecs({ getState, getManagedObjects, getInstances, getConfig, getCtl, getDaemons, getLogger });
// 可只 require 本模块 + 假 deps 直测（DF-6）。
// 

const os = require('node:os');
const path = require('node:path');
const { daemonScript } = require('../daemons/scripts');

function createSpecs(deps) {
  const g = deps || {};
  const state = () => (typeof g.getState === 'function' ? g.getState() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const ctl = () => (typeof g.getCtl === 'function' ? g.getCtl() : null);
  const daemons = () => (typeof g.getDaemons === 'function' ? g.getDaemons() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  /** main(dsh) 申报为管家注册项。 */
  function mainSpec() {
    const m = state().readMainMeta();
    return {
      kind: 'dsh', id: 'main', name: '主实例',
      desired: state().desired() === 'stopped' ? 'stopped' : 'running',
      guardian: m.guardian === true,
      ownership: {
        ports: [{ role: 'dsh-main', port: Number(config().targetPort || 3080) }],
        rootPath: path.join(os.homedir(), '.dsh'),
        processMode: 'spawn',
      },
    };
  }

  /** 单个沙箱实例申报。 */
  function sandboxSpec(inst) {
    if (!inst || !inst.id) return null;
    const phase = inst.state && inst.state.phase;
    const running = phase === 'RUNNING' || phase === 'STARTING' || phase === 'INSTALLING';
    let rootPath = null;
    const im = instances();
    try { if (im && typeof im.sandboxRoot === 'function') rootPath = im.sandboxRoot(inst); } catch {}
    return {
      kind: 'sandbox-instance', id: inst.id, name: String(inst.name || inst.id),
      desired: running ? 'running' : 'stopped',
      guardian: inst.guardian === true,
      ownership: {
        ports: [{ role: 'inst', port: Number(inst.port) }],
        rootPath,
        unit: 'dsh-web@' + inst.id,
        processMode: 'systemd',
      },
    };
  }

  /** 申报或更新（存在->update 应然；否则 register）。 */
  function upsert(spec) {
    const m = reg();
    if (!m || !spec) return;
    try {
      const existing = m.get(spec.id);
      if (existing) m.update(spec.id, { desired: spec.desired, guardian: spec.guardian, name: spec.name, ownership: spec.ownership });
      else m.register(spec);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_upsertManaged(' + (spec && spec.id) + '): ' + (e && e.message));
    }
  }

  function unregister(id) {
    const m = reg();
    if (!m || !id) return;
    try { m.unregister(id); } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_unregisterManaged(' + id + '): ' + (e && e.message));
    }
  }

  /** 启动对齐：main + 全部沙箱 + router/lan daemon 申报入册（幂等）。 */
  function syncManagedRegistry() {
    const m = reg();
    if (!m) return;
    try {
      upsert(mainSpec());
      const _m = instances();
      const sandboxes = (_m && typeof _m.all === 'function' && _m.all()) || [];
      for (const inst of sandboxes) {
        if (inst.id === 'main' || inst.domain === 'native') continue;
        upsert(sandboxSpec(inst));
      }
      // 域 B 基础设施（router/lan daemon）不写 guardian（GUARD-DOMAIN-MODEL §2）。
      const c = ctl();
      upsert({
        kind: 'router-daemon', id: 'router-daemon', name: '智能路由 daemon',
        desired: config().routerAutostart === true ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('router'),
          ports: [{ role: 'ctl', port: c.routerPort() }],
          processMode: 'daemon',
        },
      });
      const d = daemons();
      upsert({
        kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon',
        desired: d.enabled() ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('lan'),
          ports: [{ role: 'ctl', port: c.lanPort() }],
          processMode: 'daemon',
        },
      });
      const l = logger();
      if (l && l.info) l.info('[registry] 受管对象已申报: ' + m.list().map((o) => o.kind + ':' + o.id).join(','));
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_syncManagedRegistry: ' + (e && e.message));
    }
  }

  return { mainSpec, sandboxSpec, upsert, unregister, syncManagedRegistry };
}

module.exports = { createSpecs };
