#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// test/app-ctor-injection-test.js —— app 级 2「真 ctor 注入」直测（DF-6 判据）。
//
// 判据：协作方模块可**只 require + 假 deps**直接断言行为，无需构造 Supervisor。
// 覆盖三个已完成工厂化的切面：state / session / control。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const { createStateStore } = require(path.join(ROOT, 'src', 'app', 'state', 'collaborator'));
const { createSession } = require(path.join(ROOT, 'src', 'app', 'session', 'machine'));
const { createControlPlane } = require(path.join(ROOT, 'src', 'app', 'control', 'collaborator'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctor-inj-'));
const warnLog = [];

/** 假受管目录（含真实 setPhase/update/register/unregister 语义）。 */
function fakeRegistry() {
  const entries = new Map();
  return {
    entries,
    _loadedFromDisk: false,
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    setPhase(id, ph) { const e = entries.get(id); if (e) { e.phase = ph; e.lastTransitionAt = 't'; } },
    update(id, patch) { const e = entries.get(id); if (e) Object.assign(e, patch); },
    register(spec) { entries.set(spec.id, Object.assign({ phase: 'stopped' }, spec)); },
    unregister(id) { entries.delete(id); },
    persistCrashState() {},
  };
}

// ───────────────────────────────────────────────────────────────────────────
// F8 state：createStateStore(deps) —— 自己持有 phase/desired/字段/IO 实现
// ───────────────────────────────────────────────────────────────────────────
{
  const reg = fakeRegistry();
  const stateFile = path.join(tmp, 'state.json');
  const state = createStateStore({
    getConfig: () => ({ stateFile }),
    getConfigPath: () => path.join(tmp, 'config.json'),
    getLogger: () => ({ warn: (m) => warnLog.push(m) }),
    getEvents: () => null,
    getManagedObjects: () => reg,
    getInstances: () => null,
    getViews: () => ({ status: () => ({ updatedAt: null }) }),
    getIntents: () => null,
    getHold: () => false, setHold() {}, getSince: () => null, setSince() {},
    getCrashHalted: () => false, setCrashHalted() {},
    getManualRestart: () => false, setManualRestart() {},
    stopProcess() {}, tick() {},
  });

  check('S1 state 工厂可独立构造（无 Supervisor）', typeof state.phase === 'function', 'ok');
  check('S2 无目录项 → fallback：phase 默认 STOPPED', state.phase() === 'STOPPED', state.phase());

  state.setPhase('RUNNING');
  check('S3 setPhase 大写 → 目录 canonical running', state.store().phase === 'running', state.store().phase);
  check('S4 phase 读回大写 RUNNING', state.phase() === 'RUNNING', state.phase());

  state.setDesired('stopped');
  check('S5 setDesired 写目录 desired', state.store().desired === 'stopped' && state.desired() === 'stopped', state.desired());

  state.field('restartCount', 3);
  check('S6 field 写读一致', state.field('restartCount') === 3, String(state.field('restartCount')));
  state.procField('adopted', true);
  check('S7 procField 写读一致', state.procField('adopted') === true, String(state.procField('adopted')));
  check('S8 访问器 phase/desired 与协作方同源', state.accessors.phase.get() === 'RUNNING' && state.accessors.desired.get() === 'stopped', 'ok');

  state.writeMainMeta({ guardian: true, remoteToken: 'tok' });
  check('S9 main 元数据写后读同源', state.readMainMeta().guardian === true && state.readMainMeta().remoteToken === 'tok', 'ok');
  check('S10 mainMetaFile 派生自 stateFile', state.mainMetaFile() === path.join(tmp, 'dsh-main.json'), state.mainMetaFile());
  const rf = state.registryFileName();
  check('S11 registryFileName 派生（生产 state.json → managed-objects.json）', rf === 'managed-objects.json', rf);

  state.persistConfigPatch({ apiAccessKey: 'k' });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check('S12 persistConfigPatch 原子落盘', cfg.apiAccessKey === 'k', JSON.stringify(cfg));
}

// ───────────────────────────────────────────────────────────────────────────
// F2 session：createSession(deps) —— 自己持有会话态
// ───────────────────────────────────────────────────────────────────────────
{
  const evs = [];
  const session = createSession({
    events: () => ({ append: (e, p) => evs.push([e, p]) }),
    desired: () => 'running',
    crashHalted: () => false,
  });
  check('C1 初始 starting 且 shouldRun=true', session.state() === 'starting' && session.shouldRun() === true, session.state());
  session.setState('running');
  session.setState('stopping');
  check('C2 stopping → halting=true / shouldRun=false', session.halting() === true && session.shouldRun() === false, String(session.halting()));
  check('C3 迁移发 session_state 事件', evs.length === 2 && evs[0][0] === 'session_state', JSON.stringify(evs));

  const halted = createSession({ events: () => null, desired: () => 'running', crashHalted: () => true });
  check('C4 crashHalted → shouldRun=false', halted.shouldRun() === false, String(halted.shouldRun()));
  const stopped = createSession({ events: () => null, desired: () => 'stopped', crashHalted: () => false });
  check('C5 desired=stopped → shouldRun=false', stopped.shouldRun() === false, String(stopped.shouldRun()));
}

// ───────────────────────────────────────────────────────────────────────────
// F6/F7 control：createControlPlane(deps) —— 视图投影 + 受管申报
// ───────────────────────────────────────────────────────────────────────────
{
  const reg = fakeRegistry();
  reg.register({ kind: 'dsh', id: 'main', desired: 'running', phase: 'running' });
  const lcMap = new Map();
  const mkLc = (id) => ({ id, desired: 'stopped', phase: 'stopped', _monitoring: false, _setPhase(p) { this.phase = p; }, wantRunning() { this.desired = 'running'; } });
  const routerLc = mkLc('router'); routerLc.desired = 'running'; lcMap.set('router', routerLc);
  lcMap.set('instances', mkLc('instances'));
  lcMap.set('dsh', mkLc('dsh'));
  const mgr = { get: (id) => lcMap.get(id) };

  const state = {
    dshEntry: () => reg.get('main'),
    phase: () => 'RUNNING',
    desired: () => 'running',
    guardian: () => true,
    readMainMeta: () => ({ guardian: true }),
  };
  const control = createControlPlane({
    getLifecycleManager: () => mgr,
    getState: () => state,
    getManagedObjects: () => reg,
    getInstances: () => ({ instances: [], sandboxRoot: (i) => '/root/' + i.id }),
    getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
    getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
    getDaemons: () => ({ enabled: () => false }),
    getLogger: () => ({ info() {}, warn() {} }),
  });

  control.syncInstancesView();
  check('P1 syncInstancesView → instances 视图 running/healthy', lcMap.get('instances').phase === 'running' && lcMap.get('instances').healthy === true, lcMap.get('instances').phase);
  control.syncRouterView({ ok: true });
  check('P2 syncRouterView(ok) → router running/healthy', lcMap.get('router').phase === 'running' && lcMap.get('router').healthy === true, lcMap.get('router').phase);
  control.syncDshView();
  check('P3 syncDshView → dsh running + guardian 同源', lcMap.get('dsh').phase === 'running' && lcMap.get('dsh').guardian === true, lcMap.get('dsh').phase);

  const spec = control.sandboxSpec({ id: 's1', name: '沙箱', port: 3900, state: { phase: 'RUNNING' }, guardian: true });
  check('P4 sandboxSpec 申报 desired=running + unit', spec && spec.desired === 'running' && spec.ownership.unit === 'dsh-web@s1', JSON.stringify(spec && spec.ownership));
  check('P5 sandboxSpec 的 rootPath 来自实例域', spec.ownership.rootPath === '/root/s1', spec.ownership.rootPath);

  control.upsert(spec);
  check('P6 upsert 注册沙箱实例', !!reg.get('s1'), 'ok');
  control.unregister('s1');
  check('P7 unregister 注销', !reg.get('s1'), 'ok');

  reg.unregister('main');
  control.syncManagedRegistry();
  const keys = [...reg.entries.keys()].sort();
  check('P8 syncManagedRegistry 申报 main + router/lan daemon', keys.join(',') === 'lan-daemon,main,router-daemon', keys.join(','));
  check('P9 域 B daemon 申报不含 guardian 字段（G-1）',
    !('guardian' in reg.get('router-daemon')) && !('guardian' in reg.get('lan-daemon')), 'ok');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
