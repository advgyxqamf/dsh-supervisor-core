#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：router / relay 域「纪律只在一处执行」类缺陷回归（2026-09-13）
//
// ## 缺陷（全部为失效模式 g，兼 b/e）
//
// ① P1 公网暴露安全闸（必须先设 remoteToken）只在 setFrp 一处执行
//    manager.js::setFrp 有令牌闸 + 端口合法性 + 端口占用校验；
//    而 registry-view.js::patchDshMain **同样能开启 frpEnabled** 却无闸 ——
//    /native/settings 把 body 原样透传（api/domains/native.js）→ 可绕过令牌闸开公网暴露。
//    frpc 以回环身份连 relay，来源闸放行；relay token 为空时 tokenGate 恒放行 → 公网零认证。
//
// ② P1 remoteToken 变更永远到不了已在运行的 relay
//    syncProxy 的「已存在则 return」快路径不重读 remoteToken；applyToken 只处理 dshToken。
//    → 令牌闸已放行，而 relay 进程内 token 仍是空串 → tokenGate 恒放行。
//
// ③ P1 删除供应商/账号/批量删 Key 时 stopInstance 不带 force
//    proxy.js::_canStopInstance 对「ready+可用+被 selected 指向」返回 false →
//    只置 _stopPendingUntilIdle 不 kill；而删除路径随即把账号/实例摘除 →
//    延迟标记不可达 → 进程与端口**永久泄漏**。
//
// ④ P2 实例重启被自身的在用保护吃掉
//    restartInstance 已自行处理在途（写 _restartPending），却又调不带 force 的
//    stopInstance → 被更宽的 _canStopInstance 拦下 → 未 kill、_restartPending 已被清 null、
//    _restartAt 已置 +2min → 自愈链静默失效 2 分钟。
//
// ## 门禁性质：以**源码形态 + 真实构造**为主（这些路径需真实子进程/systemd，无法在
//    无头 CI 完整驱动），但每条都锁定**可证伪的特征调用**与**计数**，且附反向断言防空转。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥离整行注释（本仓多次被自己的说明文字骗过）。 */
const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ── ① 公网暴露令牌闸必须两条路径同规 ──
console.log('== ① frp 令牌闸两条路径同规 ==');
{
  // ⚠ 2026-09-16 步骤7：patchDshMain/dshMainView 已从 registry-view.js 拆到 app/facade/main.js。
  // ⚠ 2026-09-17 R7：写动作 patchDshMain 再下沉 app/domain-actions/main.js（facade 只读）；
  //   安全闸收敛到 domains/relay/core.validateFrpExposure（app 侧与 relay 侧同一份纯函数）。
  const act = strip(read('src/app/domain-actions/main.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  const mgrCore = strip(read('src/domains/relay/core.js'));
  const gateMsg = '开启公网暴露前请先为该实例设置远程访问令牌';
  check('① setFrp 令牌闸经 core.validateFrpExposure（单一事实源，基线）',
    mgrCore.indexOf(gateMsg) >= 0 && /\.validateFrpExposure\(|validateFrpExposure\(/.test(mgr), '有');
  check('① 安全闸有唯一事实源 core.validateFrpExposure（含端口合法性/占用）',
    /function validateFrpExposure\s*\(/.test(mgrCore) && /无效的公网端口/.test(mgrCore) && /已被实例「/.test(mgrCore), '有');
  check('① patchDshMain 调用同一份安全闸（消除重复实现，旧实现无 → 可绕过）',
    /validateFrpExposure\s*\(/.test(act), '有');
  // 反向：闸必须在落盘 **之前**（否则已落盘半改状态）。
  // ⚠ P6-B-3：判据改为**形态无关** —— 实现已由 { methods }+this 改为真 ctor 工厂
  //   （createMainActions(deps)，不再读 this），故不再要求 `this.state.` 前缀，只锁「该写入发生」。
  //   同时把闸的定位由**导入行**改为**调用行**（`validateFrpExposure(`）：原写法 `indexOf('validateFrpExposure')`
  //   命中的是文件头的 require（恒在落盘之前），判据近乎恒真；改为调用行后才是真正的顺序判定。
  const WRITE_MAIN_META = 'writeMainMeta(meta)';
  const iGate = act.indexOf('validateFrpExposure(');
  const iWrite = act.indexOf(WRITE_MAIN_META);
  check('① 闸在落盘之前（不产生半改状态）', iGate > 0 && iWrite > 0 && iGate < iWrite,
    'gate@' + iGate + ' write@' + iWrite);
  // 反向自检（合成样本，不依赖真实数据）：带前缀/裸两形态都命中，缺失时不命中。
  check('① 反向：形态无关判据识别带前缀形态', 'this.state.writeMainMeta(meta);'.indexOf(WRITE_MAIN_META) >= 0, 'hit');
  check('① 反向：形态无关判据识别裸形态', 'state.writeMainMeta(meta);'.indexOf(WRITE_MAIN_META) >= 0, 'hit');
  check('① 反向：缺失该写入时不命中', 'const x = 1;'.indexOf(WRITE_MAIN_META) < 0, 'miss');

  // 行为：真实构造一个 patchDshMain 上下文，断言「无令牌开 frp」被拒
  //  P6-B-3：导出形态改为真 ctor 工厂 createMainActions(deps)（原地去 this）；本处按 deps
  //   注入构造，判据本意（安全闸行为）不变。R7 后模块位于 app/domain-actions/main.js。
  const { createMainActions } = require(path.join(ROOT, 'src', 'app', 'domain-actions', 'main.js'));
  const { installCollaborators } = require(path.join(ROOT, 'src', 'app', 'assembly', 'collaborators'));
  const inst = {};
  installCollaborators(inst);
  const written = [];
  // 级 2：state 已真 ctor 注入——注入点改为协作方方法（不再是 host._readDshMain 薄壳）。
  inst.state.readMainMeta = () => ({ guardian: false, remoteEnabled: false, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort: null });
  inst.state.writeMainMeta = (m) => written.push(m);
  inst.dshMainView = () => ({ ok: true });
  // R7：冲突清单改为注入的只读投影（不再直读 instances.instances）
  inst.exposurePeers = () => [];
  inst.config = { stateFile: '/tmp/x.json' };
  inst.logger = { warn() {} };
  inst.events = { append() {} };
  // daemon 用**字面 stub**（非 installCollaborators 的转发器）：与本用例无关，
  //   且不会随 daemons 切面的装配形态（P6-B-1 进行中）漂移。
  const daemons = { enabled: () => false, syncLanState: () => {} };
  const actions = createMainActions({
    getState: () => inst.state, getViews: () => inst.views, getDaemons: () => daemons,
    getEvents: () => inst.events, getLogger: () => inst.logger,
  });
  const bad = actions.patchDshMain({ frpEnabled: true, frpRemotePort: 7001 });
  check('① 行为：无令牌开 frp → 被拒（ok:false）', bad && bad.ok === false, JSON.stringify(bad));
  check('① 行为：被拒时**未落盘**（不产生半改状态）', written.length === 0, String(written.length));
  const badPort = actions.patchDshMain({ remoteToken: 'tok', frpEnabled: true, frpRemotePort: 99999 });
  check('① 行为：令牌已设但端口非法 → 被拒', badPort && badPort.ok === false, JSON.stringify(badPort));
  const good = actions.patchDshMain({ remoteToken: 'tok', frpEnabled: true, frpRemotePort: 7001 });
  check('① 行为：令牌+合法端口 → 通过', good && good.ok === true, JSON.stringify(good));
  check('① 行为：通过时**确实落盘一次**', written.length === 1, String(written.length));
  // 关闭 frp 不应被闸拦（关是安全方向）
  const off = actions.patchDshMain({ frpEnabled: false });
  check('① 行为：关闭 frp 不被闸拦', off && off.ok === true, JSON.stringify(off));
}

// ── ② relay 门卫令牌必须可热换 ──
console.log('== ② relay 门卫令牌热换 ==');
{
  // ⚠ 服务本体 index.js → proxy.js（SSOT §5.2）；编排 manager.js → ops.js。
  const rl = strip(read('src/domains/relay/proxy.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  check('② createRelay 的 token 是 let（旧为 const，永不变化）',
    /let token = o\.token/.test(rl), 'let');
  check('② 存在 setToken 热换入口', /server\.setToken = /.test(rl), '有');
  check('② 存在 hasToken 只读探针（不回传明文）', /server\.hasToken = /.test(rl), '有');
  // syncProxy 快路径必须下发令牌
  check('② syncProxy 快路径下发令牌（旧实现直接 return）',
    /existing\.token !== want/.test(mgr) && /setToken\(want\)/.test(mgr), '有');

  // 行为：真实 createRelay，断言 setToken 后门卫生效
  const { createRelay } = require(path.join(ROOT, 'src', 'domains', 'relay', 'index.js'));
  const srv = createRelay('127.0.0.1', 9, { token: '', logger: null });
  check('② 行为：初始空令牌 → hasToken() false（tokenGate 会恒放行）', srv.hasToken() === false, 'false');
  srv.setToken('newtok');
  check('② 行为：setToken 后 hasToken() true（门卫开始生效）', srv.hasToken() === true, 'true');
  srv.setToken('');
  check('② 行为：清空令牌后 hasToken() false', srv.hasToken() === false, 'false');
}

// ── ③ 删除路径必须 force 停实例 ──
console.log('== ③ 删除路径 force 停实例 ==');
{
  // ⚠ 域改造后删除路径编排从 index.js/router-ops.js 收敛到 ops.js（SSOT §5.1）。
  //   按「删除路径所在文件整组」读取（排除 proxy.js 内部的非删除 stopInstance），
  //   文件一搬判据仍覆盖；计数仍是**删除路径**的 force 调用，未放宽。
  const del = strip([
    'index.js', 'router-ops.js', 'ops.js', 'ops/admin.js', 'ops/apps-registry.js',
  ].map((f) => { try { return read(path.join('src', 'domains', 'router', f)); } catch { return ''; } }).join('\n'));
  check('③ removeProvider 对 proxy 实例传 force=true',
    /removed\.stopInstance\(i, true\)/.test(del), '有');
  // 反向：不得再有删除路径用不带 force 的 stopInstance
  check('③ 反向：删除路径不再存在裸 stopInstance(i)',
    !/removed\.instances \|\| \[\]\) removed\.stopInstance\(i\)/.test(del), '已改');
  check('③ setProviderKeys 删除账号传 force=true',
    /p\.stopInstance\(a\.instance, true\)/.test(del), '有');
  check('③ removeProxyKey 删除账号传 force=true',
    /p\.stopInstance\(p\.accounts\[idx\]\.instance, true\)/.test(del), '有');
  // 计数：删除路径的 force 调用应 >= 3（三处删除）
  const forceDeletes = (del.match(/stopInstance\([^)]*, true\)/g) || []).length;
  check('③ 删除路径 force 调用 >= 3 处', forceDeletes >= 3, String(forceDeletes));
}

// ── ④ 重启必须真正停掉进程 ──
console.log('== ④ 重启真正停进程 ==');
{
  const px = strip(read('src/domains/router/providers/proxy.js'));
  check('④ restartInstance 用 force 停实例（旧为不带 force）',
    /this\.stopInstance\(inst, true\)/.test(px), '有');
  // 失败可观测：未能停掉时重新武装待重启并清退避（不静默黑洞 2 分钟）
  check('④ 未能停掉时重新记待重启（不静默）',
    /restart-stop-failed/.test(px), '有');
  check('④ 未能停掉时清退避（避免 2 分钟黑洞）',
    /inst\._restartAt = 0;/.test(px), '有');
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
