#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第四轮续：订阅/取证/端口归属 三处缺陷的回归
//
// ## 缺陷
//
// P1-1「frozen 且探测失败」使探测闸门**恒真** → 每 5 分钟起停实例：
//   `applyDetection` 的失败分支只写 lastProbeError，**不设 nextResetAt**；
//   而路由的闸门是 `missingReset = frozen && !nextResetAt` → 永真。
//
// P1-3 取证链路**零出口**却在转发主路径同步写盘：
//   evidenceTail/evidenceStats 全仓无调用方、surface.js 未登记、前端零引用，
//   而 append（statSync + appendFileSync）发生在每个上游 >=400 的路径上。
//
// P2-2 `PortRegistry.release(port, ownerId)` 的第二参被**静默忽略**：
//   调用方（objects.js）以 owner 意图调用，实际按端口号无条件删除 → 可误删他人登记。
//
// P2-4 `setProviderKeys(removeMasked)` 删反代账号时**不做收尾**：
//   缺 stopInstance / ports.unregister / instances 同步（removeProxyKey 三者齐备）
//   → orphan 实例与端口记录再无人释放。
//
// ## 锁定不变量
//   E-a  applyDetection 失败分支必须给出 nextResetAt 兜底（仅 frozen 且无恢复点时）
//   E-b  取证默认关闭（opt-in），且仍保留显式启用能力
//   E-c  release 接受 ownerId 且不匹配时不释放
//   E-d  setProviderKeys 删除路径必须复用与 removeProxyKey 同等的收尾
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const base = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'index.js'), 'utf8');
const ops = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'router-ops.js'), 'utf8');

// ── E-a：失败分支必须补 nextResetAt ──
{
  const m = base.match(/applyDetection\(acc, det\) \{[\s\S]*?\n  \}/);
  check('E-a 定位到 applyDetection', !!m, m ? 'ok' : '未找到');
  const body = m ? m[0] : '';
  const failBranch = body.slice(0, body.indexOf('acc.lastProbeError = null;') + 1);
  check('E-a 失败分支设置了 nextResetAt（防探测闸门恒真）',
    /acc\.nextResetAt\s*=/.test(failBranch), failBranch.length + ' 字符内');
  check('E-a 仅在无既有恢复点时补（不覆盖已精确的值）',
    /!acc\.nextResetAt/.test(failBranch), '有守卫');
}

// ── E-b：取证默认关（opt-in）──
check('E-b evidence 构造受 evidenceEnabled 控制',
  /this\.evidenceEnabled = opts\.evidenceEnabled === true/.test(idx), '已改');
check('E-b 默认不构造（findable：evidenceFile && evidenceEnabled）',
  /this\.evidenceFile && this\.evidenceEnabled/.test(idx), '已改');
check('E-b 仍保留显式启用能力（evidenceEnabled 可传 true）',
  /evidenceEnabled: true/.test(idx), '文档化');

// ── E-c：release 的 owner 校验 ──
check('E-c release 签名接受第二参', /release\(port, ownerId\)/.test(
  fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'), 'utf8')), '已改');
{
  const portsMod = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports.js'));
  const { PortRegistry } = portsMod;
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), 'p4-port-owner-' + process.pid + '.json');
  const reg = new PortRegistry({ file: tmp });
  // allocateMark(port, role, owner) 才能登记自定义 owner（register 的 owner 固定为 system:<role>）
  reg.allocateMark(25000, 'proxyInstance', 'proxy:AAA');
  // 异 owner 释放 → 必须 no-op
  const r1 = reg.release(25000, 'proxy:BBB');
  // 注：`get(role)` 按 role 查，按端口查须用 `isRegistered(port)`
  check('E-c 异 owner 释放被拒（不误删他人登记）', r1 === false && reg.isRegistered(25000),
    'released=' + r1 + ' stillRegistered=' + reg.isRegistered(25000));
  // 同 owner 释放 → 成功
  const r2 = reg.release(25000, 'proxy:AAA');
  check('E-c 同 owner 释放成功', r2 === true && !reg.isRegistered(25000), 'released=' + r2);
  // 不传 owner → 向后兼容（无条件释放）
  reg.allocateMark(25001, 'proxyInstance', 'proxy:CCC');
  const r3 = reg.release(25001);
  check('E-c 不传 ownerId 保持向后兼容', r3 === true, 'released=' + r3);
  try { fs.rmSync(tmp, { force: true }); } catch {}
}

// ── E-d：setProviderKeys 删除路径的收尾 ──
{
  const m = ops.match(/setProviderKeys\(id, opts\) \{[\s\S]*?\n  \}/);
  check('E-d 定位到 setProviderKeys', !!m, m ? 'ok' : '未找到');
  const body = m ? m[0] : '';
  check('E-d 删反代账号时停止实例', /p\.stopInstance\(/.test(body), '有');
  check('E-d 删反代账号时释放端口登记', /ports\.unregister\('proxy:'/.test(body), '有');
  check('E-d 同步 p.instances（防 orphan 实例记录）', /p\.instances\s*=\s*\(p\.instances/.test(body), '有');
  check('E-d 收尾限定于 proxy 类（direct 无实例/端口）', /p\.kind === 'proxy'/.test(body), '有');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);