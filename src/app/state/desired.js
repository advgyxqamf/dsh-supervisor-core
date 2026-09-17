'use strict';

// 用户意图写入工厂（真 ctor 注入）：可只 require 本模块 + 假 deps 直测。

const fs = require('node:fs');

function createDesired(deps) {
  const g = deps || {};
  const fields = g.fields;
  const store = g.store;
  const intents = () => (typeof g.getIntents === 'function' ? g.getIntents() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const configPath = () => (typeof g.getConfigPath === 'function' ? g.getConfigPath() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const setCrashHalted = typeof g.setCrashHalted === 'function' ? g.setCrashHalted : () => {};
  const setManualRestart = typeof g.setManualRestart === 'function' ? g.setManualRestart : () => {};
  const tick = () => { if (typeof g.tick === 'function') g.tick(); };
  const stopProcess = (why) => { if (typeof g.stopProcess === 'function') g.stopProcess(why); };

  /** 设置用户期望运行态（/start、/stop）。 */
  function setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    // 显式「启动」是用户意图，不受守护开关短路限制。
    if (v === 'running') { const it = intents(); if (it) it.register('start'); setCrashHalted(false); }
    if (v === 'running' && fields.phase() === 'OBSERVED') {
      fields.setObservedOnly(false);      // 从观测模式转正
      fields.setPhase('STOPPED');         // 交给 switch 立即重新调和
    }
    if (v === 'stopped' && fields.phase() === 'OBSERVED' && fields.observedOnly()) {
      stopProcess('desired_stopped');
    }
    if (fields.desired() !== v) {
      fields.setDesired(v);
      const ev = events();
      if (ev) ev.append('desired_changed', { desired: v });
      store.writeState();
    }
    tick();
    return { ok: true, desired: fields.desired() };
  }

  function requestRestart() {
    if (fields.desired() === 'stopped') {
      const ev = events();
      if (ev) ev.append('manual_restart_requested', { ignored: 'desired=stopped' });
      return { ok: false, error: 'desired=stopped，请先 /start' };
    }
    setManualRestart(true);
    setCrashHalted(false);
    const it = intents(); if (it) it.register('restart');
    const ev = events();
    if (ev) ev.append('manual_restart_requested', {});
    tick();
    return { ok: true };
  }

  /** config.json 补丁持久化；原子写 0600。
   *  返回**落盘成败**：成功 true；无 configPath（未配置落点）或写失败均 false。
   *  为什么返回布尔：调用方需要如实上报"配置是否真的落盘"，此前只能靠"回读 configPath 逐键比对"
   *  来核验 —— 那是第二套落盘判定，与这里必然分叉（P4-A #6）。既有调用方一律忽略返回值，故向后兼容。 */
  function persistConfigPatch(patch) {
    const p = configPath();
    if (!p) return false; // 无落点 = 未持久化（如实回 false，不再静默返回 undefined）
    try {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      Object.assign(cur, patch);
      delete cur.switcherAutoStart; // 旧键随持久化收敛删除
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
      return true;
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('config persist failed: ' + e.message);
      return false;
    }
  }

  return { setDesired, requestRestart, persistConfigPatch };
}

module.exports = { createDesired };
