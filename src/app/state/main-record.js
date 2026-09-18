'use strict';

// 状态基座的存储原语工厂（真 ctor 注入）：自己持有 fallback 存储与读写实现。

function createMainRecord(deps) {
  const g = deps || {};
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let fallback = null;

  /** 目录 main 项（未初始化/异常返回 null）。 */
  function entryOf() {
    const m = reg();
    if (!m || typeof m.get !== 'function') return null;
    try { return m.get('main') || null; } catch { return null; }
  }

  /** 构造期 fallback 存储（目录初始化前/异常时的统一读写口）。 */
  function fallbackEntryOf() {
    if (!fallback) {
      fallback = {
        kind: 'dsh', id: 'main', name: '主实例',
        desired: 'running', guardian: true,
        ownership: { ports: [], rootPath: null, unit: null, daemonScript: null, processMode: 'spawn', meta: null },
        phase: 'stopped', lastObserved: null,
        backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0,
        restartCount: 0, startedAt: null, lastTransitionAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        process: null,
      };
    }
    return fallback;
  }

  function persistCrashField() {
    const m = reg();
    try {
      if (m && typeof m.persistCrashState === 'function') m.persistCrashState();
      else if (m && typeof m._save === 'function') m._save();
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('persistCrashField: ' + ((e && e.message) || e));
    }
  }

  /** 状态存储解析：目录 main entry 优先，构造期回退到 fallback。 */
  function storeOf() { return entryOf() || fallbackEntryOf(); }

  /** write=true 时值变化即落盘并返回 entry，否则读值。 */
  function fieldOf(name, v, write) {
    const e = storeOf();
    if (write) {
      if (e[name] !== v) { e[name] = v; persistCrashField(); }
      return e;
    }
    return e[name];
  }

  /** write=true 时返回 process 对象，否则读值。 */
  function procFieldOf(name, v, write) {
    const e = storeOf();
    let p = e.process;
    if (!p) {
      p = e.process = {
        child: null, adoptedPid: null, adopted: false, observedOnly: false,
        startDeadline: null, restartAt: null, spawnBlockedUntil: null, missingNotified: false,
        failStreak: 0, lastProbeAt: null, lastProbeOk: null, lastProbeHttpOk: null,
        lastFailure: null, lastRestartAt: null,
      };
    }
    if (write) { if (p[name] !== v) p[name] = v; return p; }
    return p[name];
  }

  return { entryOf, fallbackEntryOf, persistCrashField, storeOf, fieldOf, procFieldOf };
}

module.exports = { createMainRecord };
