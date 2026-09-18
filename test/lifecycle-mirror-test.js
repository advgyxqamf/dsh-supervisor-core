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
  const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
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

  // M7 守护开关（契约 GUARD-DOMAIN-MODEL §2 域模型，2026-09-16 归位）：
  //   域 A（dsh/instances）guardian 跟用户开关走（默认关）；
  //   域 B 基础设施（router-daemon/lan-daemon）**不设 guardian**（无用户意图轴，由保活路径无条件拉起）。
  //   ⚠ 旧断言为「router/lan 恒开」——那是把基础设施硬套用户意图模型的错位形态，已按 G-1 删除。
  const gRouter = sup.lifecycleManager.get('router');
  const gLan = sup.lifecycleManager.get('lan');
  const gDsh = sup.lifecycleManager.get('dsh');
  const gInst = sup.lifecycleManager.get('instances');
  check('M7 域模型：基础设施(router/lan)不设 guardian，域 A(dsh/instances) 默认为关',
    gRouter.guardian !== true && gLan.guardian !== true && gDsh.guardian !== true && gInst.guardian !== true,
    JSON.stringify({ router: gRouter.guardian, lan: gLan.guardian, dsh: gDsh.guardian, instances: gInst.guardian }));

  // M8 域 A 的真实守护计数链路（2026-09-16 域模型收口，替换旧 M8）。
  //   ⚠ 旧 M8 直接调用 sup._guardianEvent(...) 断言「guardian_action 事件形状」。
  //     断言对象本身是死代码：router/lan 归域 B 后该函数全仓 src/ 零调用者，事件无生产者
  //     （详见 control-view.js 删除说明与 GUARD-DOMAIN-MODEL §2）——故旧块随函数一并删除。
  //   代之以契约 §2 域 A 的**真实链路**（无需任何死代码）：
  //     · dsh（原生）：崩溃/故障收敛走 _beginRestart(reason, {countCrash:true})
  //       → 发 restart_triggered 事件 且 restartCount +1；
  //     · 计划内重启（manual / countCrash:false）发事件但不计数。
  //   本用例直接驱动 _beginRestart（最小 cfg，无定时器副作用），验证事件与计数成对。
  const evs = [];
  const origAppend = sup.events.append.bind(sup.events);
  sup.events.append = (type, data) => { if (type === 'restart_triggered') evs.push(data); return origAppend(type, data); };
  const rcBefore = sup.restartCount;
  sup._beginRestart('exit:1', { countCrash: true });
  sup.events.append = origAppend;
  check('M8 dsh 崩溃收敛：restart_triggered 带 reason 且 restartCount +1（域 A 真实计数链路）',
    evs.length === 1 && evs[0].reason === 'exit:1' && sup.restartCount === rcBefore + 1,
    JSON.stringify({ evs, before: rcBefore, after: sup.restartCount }));
  // M8b 计划内重启不计入守护计数（计数只回答「用户开的守护触发了几次」）
  const evs2 = [];
  sup.events.append = (type, data) => { if (type === 'restart_triggered') evs2.push(data); return origAppend(type, data); };
  sup._beginRestart('manual', { countCrash: false });
  sup.events.append = origAppend;
  check('M8b 计划内重启（manual）发 restart_triggered 但不计入 restartCount',
    evs2.length === 1 && evs2[0].reason === 'manual' && sup.restartCount === rcBefore + 1,
    JSON.stringify({ evs2, count: sup.restartCount }));

  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
