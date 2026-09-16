#!/usr/bin/env node
'use strict';

// FRP 自愈回归（2026-09 修复）：
//   R1 配置生成必须含 loginFailExit = false（否则 frps 暂不可达 → frpc 退出且不重试 → 隧道永久失效）
//   R2 frpc 非预期退出 → 有界退避自动重拉（真实子进程 kill 验证）
//   R3 主动 stop / 停用 / 无代理 → 不重启

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-res-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  //  结构改造：进程托管在 frp.js（原 frpmgr.js）。
  const { FrpManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frp'));

  // ── R1：配置健壮性 ──
  console.log('== R1 配置健壮性（loginFailExit）==');
  {
    const m = new FrpManager({ dir: TMP, logger, events: null });
    const settings = { enabled: true, serverAddr: '1.2.3.4', serverPort: 7000, authToken: 'tok', user: 'dsh' };
    const insts = [{ id: 'inst-abc12345', frpEnabled: true, frpRemotePort: 7001, wanPort: 28070 }];
    const { text, count } = m.buildConfig(settings, insts);
    check('R1-a 生成配置含 loginFailExit = false', /^loginFailExit = false$/m.test(text), 'ok');
    check('R1-b 代理条目正确（localPort=wanPort, remotePort）', count === 1 && /localPort = 28070/.test(text) && /remotePort = 7001/.test(text), 'count=' + count);
    check('R1-c wanPort 缺失时不生成无效代理（防 frpc 解析失败）',
      m.buildConfig(settings, [{ id: 'x', frpEnabled: true, frpRemotePort: 7001, wanPort: null }]).count === 0, 'ok');
  }

  // ── R2/R3：真实子进程 crash → 自动重拉 ──
  // ⚠ 仅 POSIX：本组用「POSIX shell 脚本」（#!/bin/sh + sleep）冒充 frpc 可执行文件；
  //   Windows 无法执行该格式（spawn 同步抛 errno -4094 / code UNKNOWN）——
  //   属**测试夹具的平台限制**，非产品缺陷。产品侧「spawn 失败不得崩溃」由 frpmgr 的
  //   try/catch 降级保证（本次一并修复）。Windows 上跳过并显式说明，不静默变绿。
  console.log('== R2/R3 非预期退出自动重拉 ==');
  if (process.platform === 'win32') {
    console.log('SKIP R2/R3（Windows 无法执行 POSIX shell 夹具）');
  } else {
    const D = fs.mkdtempSync(path.join(TMP, 'live-'));
    const m = new FrpManager({ dir: D, logger, events: { append() {} } });
    // 用真实可执行脚本冒充 frpc：长驻 sleep，便于 kill 模拟崩溃
    fs.mkdirSync(path.dirname(m.binPath), { recursive: true });
    fs.writeFileSync(m.binPath, '#!/bin/sh\nsleep 300\n');
    fs.chmodSync(m.binPath, 0o755);
    m.saveSettings({ enabled: true, serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    const insts = [{ id: 'inst-abc12345', frpEnabled: true, frpRemotePort: 7001, wanPort: 28070 }];
    m.syncFromInstances(insts);
    await sleep(400);
    const first = m.child;
    check('R2-a 配置就绪且真实启动', !!first && Number.isInteger(first.pid), 'pid=' + (first && first.pid));

    // 非预期退出（外部 kill -9）→ exit 事件 → 排期重启
    if (first) { try { process.kill(first.pid, 'SIGKILL'); } catch {} }
    await sleep(600);
    check('R2-b 非预期退出后已排期重启', !!m._restartTimer, 'timer=' + !!m._restartTimer);
    check('R2-c child 已清空（等待重拉）', m.child === null, 'ok');

    // 等退避到期（2s）→ 新进程出现
    await sleep(2600);
    const second = m.child;
    check('R2-d 退避到期后自动重拉', !!second && Number.isInteger(second.pid), 'pid=' + (second && second.pid));

    // 主动 stop → 清定时器、不重启
    m.stop();
    await sleep(300);
    check('R3-a 主动 stop 清重启定时器', !m._restartTimer, 'ok');
    check('R3-b 主动 stop 后 child 为空且不再 spawn', m.child === null, 'ok');

    // 停用（enabled=false）→ 即使退出也不重启
    m.saveSettings({ enabled: false, serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    m._intentionalStop = false;
    m._lastCount = 0;
    m._scheduleRestart();
    check('R3-c 停用/无代理时不重启', !m._restartTimer, 'timer=' + !!m._restartTimer);
    try { if (m.child && m.child.pid) process.kill(m.child.pid, 'SIGKILL'); } catch {}
  }

  // ── R4：frpc 不可执行时必须优雅降级（不得抛出 / 不得崩溃进程）──
  //   两条失败路径都要覆盖：
  //     ① spawn 同步抛出（Windows 上拿非可执行格式当程序）
  //     ② spawn 异步 emit 'error'（存在但不可执行：权限/架构/目标是目录）
  //   ②若无监听器会成为未捕获异常 → 整个守卫崩溃。
  console.log('== R4 frpc 不可执行时的降级 ==');
  {
    const D4 = fs.mkdtempSync(path.join(TMP, 'bad-'));
    const m4 = new FrpManager({ dir: D4, logger, events: { append() {} } });
    fs.mkdirSync(m4.binPath, { recursive: true });   // binPath 变成**目录**：existsSync 通过但不可执行
    m4.saveSettings({ enabled: true, serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    m4.syncFromInstances([{ id: 'inst-abc12345', frpEnabled: true, frpRemotePort: 7001, wanPort: 28070 }]);
    check('R4-a start 不抛出（同步异常已降级为返回值）', true, 'ok');
    await sleep(500);
    check('R4-b 异步 spawn 失败已被处理（child 清空、进程未崩溃）', m4.child === null, 'child=' + (m4.child && m4.child.pid));
    m4.stop();
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });