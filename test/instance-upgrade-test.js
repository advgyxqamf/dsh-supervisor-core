#!/usr/bin/env node
'use strict';

// 实例升级链路回归（2026-09 修复两个「升级恒判失败」根因）：
//   R1 startInstance 被升级作业自身挡住 → systemd 从未拉起 → 端口不就绪 → 判失败。
//      修复：升级/回滚路径传 { fromUpgrade:true } 直通（本测试断言两条分支行为差异）。
//   R2 waitPortHealthy 在「剩余时间 < stabilityMs」时直接 break 判失败——
//      端口其实已就绪（只是探测晚）→ 慢启动实例被误判 → 触发不必要回滚。
//      修复：用剩余预算做缩短稳定期复检。
// 自包含：不启动真实 systemd / 不装真实 npm。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-upg-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance', 'index'));
  const { DistributionManager } = require(path.join(ROOT, 'src', 'domains', 'dist', 'index'));

  // ── R1：fromUpgrade 直通 ──
  console.log('== R1 升级作业不得挡住自己的重启（升级恒失败根因）==');
  {
    // 模拟「升级作业进行中」：tasks.isBusy('instance', id) 恒 true
    const id = 'u1';
    const tasksStub = { isBusy: () => true, current: () => ({ action: 'upgrade' }) };
    const mgr = new InstanceManager({ dir: TMP, logger, tasks: tasksStub, dist: null });
    mgr._setSandboxSupportedForTest(true);       // 绕过平台能力门（显式测试入口）
    mgr._prepareSystemd = () => {};
    let started = 0;
    mgr._systemdStart = () => { started++; return { ok: true }; };
    const inst = { id, name: '升级用例', domain: 'sandbox', port: 28090, state: { phase: 'STOPPED' } };
    mgr.instances = [inst];
    mgr._ensureSandboxDirs = () => {};
    // 预置 install 目录的 DSH 入口，使 startInstance 不走 _installSandbox
    const dshLib = path.join(mgr.sandboxInstallDir(inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
    fs.mkdirSync(dshLib, { recursive: true });
    fs.writeFileSync(path.join(dshLib, 'bin.js'), '// stub');

    // A) 非升级路径：被并发作业挡住（幂等短路）——这是**正确**语义（防双开安装）
    const a = await mgr.startInstance(id);
    check('R1-a 非升级调用：作业忙 → 幂等短路且不启动', a.installing === true && started === 0, JSON.stringify(a));

    // B) 升级路径：必须真正拉起（修复点）
    const b = await mgr.startInstance(id, { fromUpgrade: true });
    check('R1-b 升级调用：fromUpgrade=true → 真正启动 systemd', started === 1 && b.ok === true, 'started=' + started + ' ' + JSON.stringify(b));

    // C) 源码契约：升级与回滚两处调用均须带 fromUpgrade
    const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', 'index.js'), 'utf8');
    const withFlag = (src.match(/fromUpgrade: true/g) || []).length;
    const plainCall = (src.match(/await this\.startInstance\(id\)\.catch/g) || []).length;
    check('R1-c 升级/回滚两处均传 fromUpgrade', withFlag >= 2 && plainCall === 0, 'withFlag=' + withFlag + ' plain=' + plainCall);
  }

  // ── R2：waitPortHealthy 稳定期预算 ──
  console.log('== R2 晚就绪端口不得被误判失败 ==');
  {
    const dist = new DistributionManager({ logger });
    // 端口健壮性（2026-09-11 修复）：原先用固定端口 28091/28092，前一次运行的 socket
    // 处于 TIME_WAIT 时会导致 EADDRINUSE 使整个测试链中断（实测发生过）。
    // 改为向内核申请空闲端口，彻底消除该 flake。
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const port = await freePort();
    const srv = net.createServer((s) => { s.on('error', () => {}); try { s.end('ok'); } catch {} });
    srv.on('error', () => {}); // 兜底：即使监听失败也不炸掉测试进程
    // 3s 后才监听：模拟慢启动实例
    setTimeout(() => { try { srv.listen(port, '127.0.0.1'); } catch {} }, 3000);
    // 窗口 8s / 稳定期 15s：修复前 3000+15000 > 8000 → break 判失败；修复后按剩余预算复检 → 成功
    const r = await dist.waitPortHealthy({ host: '127.0.0.1', port, timeoutMs: 8000, stabilityMs: 15000 });
    check('R2-a 端口晚于 (timeout-stability) 就绪 → 仍判成功', r.ok === true, JSON.stringify(r));
    try { srv.close(); } catch {} ; await new Promise((r) => setTimeout(r, 50));

    // 对照组：端口始终不就绪 → 必须判失败（不掩盖真实失败）
    const dead = await freePort();
    const r2 = await dist.waitPortHealthy({ host: '127.0.0.1', port: dead, timeoutMs: 2500, stabilityMs: 15000 });
    check('R2-b 端口始终不就绪 → 判失败（不误报成功）', r2.ok === false, JSON.stringify(r2));

    // 源码契约：不应再有「剩余不足即 break」的硬失败分支
    const dsrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'), 'utf8');
        check('R2-c 已移除 break-判失败 写法', !dsrc.includes('stabilityMs > deadline) break'), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
