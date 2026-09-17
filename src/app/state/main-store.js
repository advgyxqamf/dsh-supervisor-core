'use strict';

// app/state/main-store.js —— main 元数据（dsh-main.json）存储工厂（真 ctor 注入）。
// createMainStore(deps) 自己持有 live 缓存与读写实现。
// deps：getConfig() -> { stateFile }；getLogger() -> logger。

const fs = require('node:fs');
const path = require('node:path');

function createMainStore(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let live = null; // dsh-main.json live 缓存（LanManager mainOf 持同一对象，须原地修改）

  /** <stateDir>/dsh-main.json。 */
  function dshMainFile() {
    try { return path.join(path.dirname(config().stateFile), 'dsh-main.json'); } catch { return null; }
  }

  /** 受管对象目录持久化文件名（按守卫 stateFile 派生，隔离同目录多守卫）。 */
  function registryFileName() {
    try {
      const b = path.basename(config().stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  function readDshMainFile() {
    try {
      const f = dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return {
          guardian: j.guardian === true,
          remoteEnabled: j.remoteEnabled === true,
          remoteToken: String(j.remoteToken || ''),
          frpEnabled: j.frpEnabled === true,
          frpRemotePort: j.frpRemotePort || null,
          wanPort: j.wanPort || null,
        };
      }
    } catch {}
    return { guardian: false, remoteEnabled: false, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort: null };
  }

  /** 读 main 元数据（无文件则默认：守护关、远程关）。结果缓存到 live。 */
  function readDshMain() {
    if (live) return live;
    live = readDshMainFile();
    return live;
  }

  /** 写 main 元数据(白名单字段，原子写 0600)。更新 live 缓存。 */
  function writeDshMain(meta) {
    if (!live) live = readDshMainFile();
    Object.assign(live, meta || {});
    const f = dshMainFile();
    if (!f) return;
    try {
      const cur = readDshMain();
      const merged = Object.assign({}, cur, meta || {});
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        guardian: merged.guardian === true,
        remoteEnabled: merged.remoteEnabled === true,
        remoteToken: String(merged.remoteToken || ''),
        frpEnabled: merged.frpEnabled === true,
        frpRemotePort: merged.frpRemotePort || null,
        wanPort: merged.wanPort || null,
      }, null, 2);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_writeDshMain: ' + ((e && e.message) || e));
    }
  }

  return { dshMainFile, registryFileName, readDshMain, readDshMainFile, writeDshMain };
}

module.exports = { createMainStore };
