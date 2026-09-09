#!/usr/bin/env node
'use strict';

// 管家注册机（ManagedRegistry）单测 —— 控制平面 v3 R0 地基。
// 覆盖：注册/注销(级联释放端口)/更新/查询/持久化恢复/应然-实然分离/非法输入/类型表。

const path = require('node:path');
const os = require('node:os');
const fs2 = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs2.mkdtempSync(path.join(os.tmpdir(), 'mreg-'));
const { ManagedRegistry, PHASES, DESIRED, MANAGED_KINDS } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'objects'));

let failures = 0;
const check = (name, cond, extra) => { if (!cond) failures++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); };

// 假端口注册表（owner 语义 + release 记录）
const released = [];
const fakePorts = {
  _reg: new Map(),
  isRegistered: function (p) { return this._reg.has(p); },
  allocateMark: function (p, role, owner) { this._reg.set(p, { role, owner }); },
  release: function (p) { released.push(p); this._reg.delete(p); },
};

(async () => {
  const file = path.join(TMP, 'managed-objects.json');
  const events = [];
  const reg = new ManagedRegistry({ file, logger: null, events: { append: (t, d) => events.push(t) }, ports: fakePorts });

  // 1. 注册
  const dsh = reg.register({ kind: 'dsh', id: 'main', name: '主实例', desired: 'running', guardian: true, ownership: { ports: [{ role: 'dsh-main', port: 3080 }], rootPath: '/home/u/.dsh', processMode: 'spawn' } });
  check('注册 dsh 返回目录项', !!dsh && dsh.id === 'main' && dsh.phase === 'stopped');
  const inst = reg.register({ kind: 'sandbox-instance', id: 'inst-1', name: '沙箱1', desired: 'running', guardian: false, ownership: { ports: [{ role: 'inst', port: 3200 }], rootPath: '/data/instances/inst-1', unit: 'dsh-web@inst-1' } });
  check('注册沙箱', !!inst);
  check('查询 list 顺序', reg.list().map(o => o.id).join(',') === 'main,inst-1');
  check('byKind', reg.byKind('sandbox-instance').length === 1);
  check('get', reg.get('main').kind === 'dsh');
  check('kind 能力', MANAGED_KINDS.dsh.guardable === true && MANAGED_KINDS.plugin.startable === false);
  check('PHASES 唯一词表', JSON.stringify(PHASES) === JSON.stringify(['stopped','installing','starting','running','draining','backoff','failed','restarting']));
  check('DESIRED', DESIRED.length === 2);

  // 2. 非法输入
  let threw = 0;
  try { reg.register({ kind: 'nope', id: 'x' }); } catch { threw++; }
  try { reg.register({ kind: 'dsh', id: 'main' }); } catch { threw++; } // 重复
  try { reg.register({ kind: 'dsh' }); } catch { threw++; } // 无 id
  check('非法 kind/重复/缺 id 均拒绝', threw === 3);

  // 3. update（应然申报）
  const up = reg.update('main', { guardian: false });
  check('update guardian', up.ok && reg.get('main').guardian === false);
  reg.update('main', { desired: 'stopped' });
  check('update desired', reg.get('main').desired === 'stopped');
  const bad = reg.update('main', { desired: 'maybe' });
  check('非法 desired 拒绝', !bad.ok);
  check('update 未注册', !reg.update('nope', {}).ok);

  // 4. 应然/实然分离：观测写入不落盘；phase 只能经 setPhase
  reg.applyObservation('main', { ok: true });
  check('观测写入内存', reg.get('main').lastObserved && reg.get('main').lastObserved.ok === true);
  reg.setPhase('main', 'running');
  check('setPhase 生效', reg.get('main').phase === 'running');
  reg.setPhase('main', 'huh');
  check('非法 phase 忽略', reg.get('main').phase === 'running');

  // 5. 持久化恢复（文件只含应然+所有权+受管 phase，不含观测）
  const reg2 = new ManagedRegistry({ file, logger: null, events: null, ports: fakePorts });
  check('恢复 2 对象', reg2.count() === 2);
  check('恢复 desired', reg2.get('main').desired === 'stopped');
  check('恢复 guardian', reg2.get('main').guardian === false);
  check('恢复 phase', reg2.get('main').phase === 'running');
  check('恢复所有权 ports', reg2.get('main').ownership.ports[0].port === 3080);
  check('观测不持久化', reg2.get('main').lastObserved === null);
  const body = fs2.readFileSync(file, 'utf8');
  check('文件 schema 标记', body.indexOf('managed-objects@1') >= 0);
  check('文件无适配器/观测字段', body.indexOf('observe') < 0 && body.indexOf('lastObserved') < 0);

  // 6. 注销级联（释放所有权端口）
  const before = released.length;
  reg2.unregister('main');
  check('注销后不存在', !reg2.get('main') && reg2.count() === 1);
  check('注销释放端口(owner)', released.length > before && released.indexOf(3080) >= 0);
  // 事件在独立文件实例上验证（避免多实例共享主 file 相互覆盖）
  const evtFile = path.join(TMP, 'evt-objects.json');
  const regEvt = new ManagedRegistry({ file: evtFile, logger: null, events: { append: (t) => events.push(t) } });
  regEvt.register({ kind: 'dsh', id: 'tmp-evt' });
  regEvt.unregister('tmp-evt');
  check('注销事件', events.filter(e => e === 'managed_object_removed').length >= 1);
  const reg3 = new ManagedRegistry({ file, logger: null });
  check('注销后持久化生效(重启不再现)', reg3.count() === 1 && !reg3.get('main'));

  // 7. adapter 挂接
  reg.registerAdapter('dsh', { observe: () => ({ ok: true }) });
  check('adapter 可挂接/读取', !!reg.adapter('dsh'));
  let athrew = 0;
  try { reg.registerAdapter('nope', {}); } catch { athrew++; }
  check('未知类型 adapter 拒绝', athrew === 1);

  // 8. heartbeat（R3 C3-1）：观测收集/节流/异常隔离/未挂 adapter 跳过
  const hbFile = path.join(TMP, 'hb-objects.json');
  const hb = new ManagedRegistry({ file: hbFile, logger: null, events: null });
  let observeCount = 0;
  hb.register({ kind: 'sandbox-instance', id: 's1' });
  hb.register({ kind: 'sandbox-instance', id: 's2', ownership: { meta: { tickEvery: 6 } } }); // 节流对象
  hb.registerAdapter('sandbox-instance', { observe: (e) => { observeCount++; if (e.id === 's1') return { ok: true }; throw new Error('boom'); } });
  hb.register({ kind: 'dsh', id: 'm' }); // 无 adapter
  const r1 = await hb.heartbeat(1000);
  check('heartbeat 观测到 ok 对象', r1.observed.indexOf('s1') >= 0);
  check('heartbeat 抛错对象不进 observed', r1.observed.indexOf('s2') < 0);
  check('heartbeat 跳过无 adapter 对象', r1.observed.indexOf('m') < 0);
  check('heartbeat 异常隔离并上报(s2)', r1.errors.length === 1 && r1.errors[0].indexOf('s2') >= 0);
  check('观测已写入实然', hb.get('s1').lastObserved && hb.get('s1').lastObserved.ok === true);
  const c1 = observeCount;
  const r2 = await hb.heartbeat(1000);
  // 节流对象 s2 上一拍刚跑(tickEvery=6)应跳过; s1 每拍都跑(报错)
  check('heartbeat 节流生效(s2 跳过)', r2.observed.indexOf('s2') < 0);
  check('heartbeat 每拍对象继续观测(s1)', r2.observed.indexOf('s1') >= 0);
  check('实然不持久化', JSON.stringify(fs2.readFileSync(hbFile, 'utf8')).indexOf('lastObserved') < 0);


  // 9. heartbeat derivePhase（daemon 类）：desired×观测收敛 phase
  const dpFile = path.join(TMP, 'dp-objects.json');
  const dp = new ManagedRegistry({ file: dpFile, logger: null });
  dp.register({ kind: 'router-daemon', id: 'rd', desired: 'running', guardian: true });
  dp.registerAdapter('router-daemon', { supervise: () => ({ ok: true }), derivePhase: true });
  await dp.heartbeat(1000);
  check('derivePhase: desired running + ok → phase running', dp.get('rd').phase === 'running');
  dp.registerAdapter('router-daemon', { supervise: () => ({ ok: false }), derivePhase: true });
  await dp.heartbeat(1000);
  check('derivePhase: 失联 → phase stopped', dp.get('rd').phase === 'stopped');
  console.log('');
  const passCount = 26;
  console.log('结果: ' + (passCount - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
