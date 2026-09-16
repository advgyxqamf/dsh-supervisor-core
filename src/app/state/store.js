'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/state/store.js —— state.json 原子读写 + main 记录迁移工厂（真 ctor 注入）。
//
// 级 2：createStore(deps) 自己持有 _lastStateBody 与读写实现。
//   const store = createStore({ record, fields, mainStore, upgradeHold, getConfig, ... });
// 可只 require 本模块 + 假 deps 直测（DF-6）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

function createStore(deps) {
  const g = deps || {};
  const record = g.record;
  const fields = g.fields;
  const mainStore = g.mainStore;
  const upgradeHold = g.upgradeHold;
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const views = () => (typeof g.getViews === 'function' ? g.getViews() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  let lastStateBody = null;

  function writeState(force) {
    try {
      const snap = views().status();
      const updatedAt = snap.updatedAt;
      snap.updatedAt = null;
      const body = JSON.stringify(snap, null, 2);
      if (!force && body === lastStateBody) return; // 内容未变不写盘
      lastStateBody = body;
      snap.updatedAt = updatedAt;
      const dir = path.dirname(config().stateFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = config().stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, config().stateFile);
    } catch (e) {
      const l = logger();
      if (l && l.error) l.error('state write failed: ' + e.message);
    }
  }

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(config().stateFile, 'utf8'));
      // 阶段 2 状态单源：desired 权威是受管目录；仅目录文件不存在时用 state.json 作迁移种子。
      if (raw.desired === 'stopped' || raw.desired === 'running') {
        const m = reg();
        const registryHasSource = !!(m && m._loadedFromDisk);
        if (!registryHasSource) fields.setDesired(raw.desired);
      }
      if (typeof raw.restartCount === 'number') record.fieldOf('restartCount', raw.restartCount, true);
      if (typeof raw.backoffLevel === 'number') record.fieldOf('backoffLevel', raw.backoffLevel, true);
      if (typeof raw.crashWindowStart === 'number' || raw.crashWindowStart === null) record.fieldOf('crashWindowStart', raw.crashWindowStart, true);
      if (typeof raw.crashWindowRestarts === 'number') record.fieldOf('crashWindowRestarts', raw.crashWindowRestarts, true);
      if (typeof raw.lastFailure === 'string' || raw.lastFailure === null) record.procFieldOf('lastFailure', raw.lastFailure, true);
      if (typeof raw.lastRestartAt === 'string' || raw.lastRestartAt === null) record.procFieldOf('lastRestartAt', raw.lastRestartAt, true);
      // 升级 hold 跨守卫重启保持
      if (raw.upgradeHold === true) {
        upgradeHold.set(true);
        if (!upgradeHold.since()) upgradeHold.setSince(Date.now());
      }
    } catch {}
    // C3-3b G4：boot 相位不继承——复位 STOPPED，让首拍按真实探测收敛。
    try { fields.setPhase('STOPPED'); } catch {}
  }

  function migrateMainRecord() {
    try {
      const im = instances();
      if (!im || !Array.isArray(im.instances)) return;
      const idx = im.instances.findIndex((i) => i.id === 'main');
      if (idx < 0) return;
      const main = im.instances[idx];
      const f = mainStore.dshMainFile();
      if (f && !fs.existsSync(f)) {
        mainStore.writeDshMain({
          guardian: main.guardian === true,
          remoteEnabled: main.remoteEnabled === true,
          remoteToken: String(main.remoteToken || ''),
          frpEnabled: main.frpEnabled === true,
          frpRemotePort: main.frpRemotePort || null,
          wanPort: main.wanPort || null,
        });
      }
      im.instances.splice(idx, 1);
      if (im.save) { try { im.save(); } catch {} }
      const l = logger();
      if (l && l.info) l.info('[main] 概念清分：main 记录已迁出 instances.json → dsh-main.json');
      const ev = events();
      if (ev) ev.append('main_meta_migrated', {});
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_migrateMainRecord: ' + (e && e.message));
    }
  }

  return { writeState, loadState, migrateMainRecord };
}

module.exports = { createStore };
