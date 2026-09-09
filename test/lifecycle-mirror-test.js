#!/usr/bin/env node
'use strict';

// 生命周期健康视图同步契约（阶段一 2026-09 → C3-5b：观测镜像层移除后改由
//   _syncRouterLifecycleView 视图同步 + instances 聚合视图真实化）：
//   healthy/lastProbeAt/error 只由观测(视图同步)写入；desired 只表达应运行；
//   视图同步不读取/不写入任何资源内部业务状态（router 自治）。
// 自包含：构造 Supervisor（最小 cfg，不 start 定时器）+ 手动 registerAll（与 start 同源注册）。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mirror-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const { registerAll } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'adapters'));
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:1/',
    probeIntervalMs: 100000, // 不触发 tick 副作用
    apiHost: '127.0.0.1', apiPort: 31990,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
    distDir: path.join(TMP, 'dist'),
    switcherDir: path.join(TMP, 'sw'),
    providerFile: path.join(TMP, 'sw', 'providers.json'),
    lanDaemon: false, useSystemdForMain: false,
  };
  const sup = new Supervisor(cfg);
  registerAll(sup.lifecycleManager, {
    router: sup.router, lan: sup.lan, instances: sup.instances,
    supervisor: sup, pluginManager: sup.pluginManager, logger: sup.logger,
  });
  const ids = sup.lifecycleManager.all().map((l) => l.id).sort().join(',');
  check('M0 lifecycle 模块注册齐（dsh/instances/lan/router 等）', /router/.test(ids) && /dsh/.test(ids) && /instances/.test(ids), ids);

  const lc = sup.lifecycleManager.get('router');
  if (!lc) { check('M1-M6 生命周期健康视图同步（router 未注册，跳过）', true); } else {
    // M1 期望停止：视图同步不置 running/healthy（desired 正交）
    lc.wantStopped(); lc._monitoring = false;
    sup._syncRouterLifecycleView({ ok: true });
    check('M1 视图同步对期望停止项不置 running/healthy', lc.phase !== 'running' && lc.healthy === false, JSON.stringify({ phase: lc.phase, healthy: lc.healthy }));
    // M2 期望运行 + 观测健康 → running/healthy/error=null/lastProbeAt
    lc.wantRunning(); lc._monitoring = true;
    sup._syncRouterLifecycleView({ ok: true });
    check('M2 视图同步 ok → running/healthy/error=null/lastProbeAt', lc.phase === 'running' && lc.healthy === true && lc.error === null && !!lc.lastProbeAt, JSON.stringify({ phase: lc.phase, healthy: lc.healthy, error: lc.error, probe: !!lc.lastProbeAt }));
    // M3 观测异常 → healthy=false + error（守护介入依据）
    sup._syncRouterLifecycleView({ ok: false, error: 'ctl 失联' });
    check('M3 视图同步 !ok → healthy=false error 记录', lc.healthy === false && lc.error === 'ctl 失联', JSON.stringify({ healthy: lc.healthy, error: lc.error }));
    // M4 恢复 → healthy=true error 清空
    sup._syncRouterLifecycleView({ ok: true });
    check('M4 视图同步恢复 → healthy=true error=null', lc.healthy === true && lc.error === null, JSON.stringify({ healthy: lc.healthy, error: lc.error }));
    // M5 不污染 router 业务状态（只写统一状态机）
    const before = JSON.stringify(sup.routerStatus());
    sup._syncRouterLifecycleView({ ok: false, error: 'x' }); sup._syncRouterLifecycleView({ ok: true });
    const after = JSON.stringify(sup.routerStatus());
    check('M5 视图同步不污染 router 业务状态', before === after, 'len=' + before.length);
    // M6 缺省实然回退目录 router-daemon lastObserved：无目录项/未观测时 ok=false 且不抛
    sup.managedObjects.applyObservation('router-daemon', { ok: true });
    sup._syncRouterLifecycleView({}); // 无显式实然 → 读目录
    check('M6 无显式实然时回退目录观测', lc.healthy === true, JSON.stringify({ healthy: lc.healthy, error: lc.error }));
    // M6b 目录未观测（无 lastObserved）→ 安全降级不抛
    try { const e = sup.managedObjects.get('router-daemon'); e.lastObserved = null; sup._syncRouterLifecycleView({}); check('M6b 目录无观测安全降级', true, ''); } catch (err) { check('M6b 目录无观测安全降级', false, String(err)); }
  }

  // M7 守护开关（2026-09 收敛定稿）：router/lan 恒开；dsh/instances/plugins 默认关（跟开关走，dsh-main.json 持久化）
  const gRouter = sup.lifecycleManager.get('router');
  const gLan = sup.lifecycleManager.get('lan');
  const gDsh = sup.lifecycleManager.get('dsh');
  const gInst = sup.lifecycleManager.get('instances');
  check('M7 守护开关：router/lan 恒开，dsh/instances 默认关',
    gRouter.guardian === true && gLan.guardian === true && gDsh.guardian !== true && gInst.guardian !== true,
    JSON.stringify({ router: gRouter.guardian, lan: gLan.guardian, dsh: gDsh.guardian, instances: gInst.guardian }));

  // M8 守护动作事件（阶段四，事件脊）：guardian_action 带 resource/action/restartCount；未知资源安全
  const evs = [];
  const origAppend = sup.events.append.bind(sup.events);
  sup.events.append = (type, data) => { if (type === 'guardian_action') evs.push(data); return origAppend(type, data); };
  sup._guardianEvent('router', 'pull', { pid: 123 });
  sup._guardianEvent('lan', 'skip-guardian-off');
  sup._guardianEvent('nope', 'pull', { pid: 1 });
  sup.events.append = origAppend;
  check('M8 guardian_action 事件带 resource/action/restartCount',
    evs.length === 3 && evs[0].resource === 'router' && evs[0].action === 'pull' && evs[0].pid === 123 && typeof evs[0].restartCount === 'number' && evs[1].action === 'skip-guardian-off' && evs[2].resource === 'nope' && evs[2].restartCount === undefined,
    JSON.stringify(evs));

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
