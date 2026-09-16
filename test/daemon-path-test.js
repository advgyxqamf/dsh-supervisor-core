#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 受管 daemon 路径回归（K1，2026-09-11）
//
// 生产级缺陷：§7.6 拆分后路径推导未更新 → `_daemonLifecycle()` 恒返回 null
// → **守卫永远无法自起 router/lan daemon**。
//
// 本测试直接调用 **真实的原型方法**（而非重新实现一遍路径逻辑）：
// 既有测试的问题正是「直接 new DaemonLifecycle / 自行 spawn」，
// 完全绕过 `control-view.js` 的路径推导，于是缺陷对测试不可见。
//
// 覆盖：
//   K1-a `_daemonLifecycle('router')` 必须构造成功（非 null）
//   K1-b `_daemonLifecycle('lan')` 必须构造成功
//   K1-c 构造出的实例 script 指向**真实存在**的文件
//   K1-d 无 configPath 时（测试/非守卫实例）仍必须返回 null（不越权管理）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 取真实 mixin 的 `_daemonLifecycle` 描述符。
// ⚠ 2026-09-16 步骤7：_daemonLifecycle 已从 control-view.js 拆到 app/daemons/runtime.js；
//   导出形态从属性描述符改为 { methods }。
const mod = require(path.join(ROOT, 'src', 'app', 'daemons', 'runtime.js'));
const { installCollaborators } = require(path.join(ROOT, 'src', 'app', 'assembly', 'collaborators'));
const fn = mod.methods._daemonLifecycle;
check('K1 取到真实 _daemonLifecycle 方法', typeof fn === 'function', typeof fn);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k1daemon-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ stateFile: path.join(tmp, 'state.json') }));

/** 最小上下文：只提供 `_daemonLifecycle` 真正读取的字段。 */
function ctx(configPath) {
  return installCollaborators({
    configPath,
    config: { stateFile: path.join(tmp, 'state.json') },
    logger: { warn() {}, info() {}, error() {} },
    _routerCtlPort: () => 43107,
    _lanCtlPort: () => 43108,
    _lc: null,
  });
}

for (const kind of ['router', 'lan']) {
  let inst = null;
  let err = null;
  try { inst = fn.call(ctx(cfgPath), kind); } catch (e) { err = e; }
  check('K1-a ' + kind + ' daemon 生命周期可构造（非 null）', !err && !!inst,
    err ? ('抛错: ' + err.message) : (inst ? 'ok' : 'null（路径解析失败 → 该 daemon 永不启动）'));
  if (inst) {
    const script = inst.script || (inst.opts && inst.opts.script);
    check('K1-c ' + kind + ' script 指向真实文件', !!script && fs.existsSync(script), script || '(未暴露 script 字段)');
  }
}

// 无 configPath → 必须返回 null（不越权管理独立 daemon）
{
  let r = null;
  let e2 = null;
  try { r = fn.call(ctx(null), 'router'); } catch (e) { e2 = e; }
  check('K1-d 无 configPath 时返回 null（测试实例不越权）', !e2 && r === null,
    e2 ? ('抛错: ' + e2.message) : String(r));
}

// 幂等：第二次调用返回缓存的同一实例
{
  const c = ctx(cfgPath);
  const a = fn.call(c, 'router');
  const b = fn.call(c, 'router');
  check('K1-e 同 kind 返回缓存实例（不重复构造）', !!a && a === b, a === b ? 'ok' : '不同实例');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);