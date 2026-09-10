#!/usr/bin/env node
'use strict';

// FRP 自愈回归（2026-09 修复）：
//   R1 配置生成必须含 loginFailExit = false（否则 frps 暂不可达 → frpc 退出且不重试 → 隧道永久失效）
//   R2 frpc 非预期退出 → 有界退避自动重拉（真实子进程 kill 验证）
//   R3 主动 stop / 停用 / 无代理 → 不重启

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-res-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { FrpManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frpmgr'));

  // ── R1：配置健壮性 ──
  console.log('== R1 配置健壮性（loginFailExit）==');
  {
    const m = new FrpManager({ dir: TMP, logger, events: null });
    const settings = { enabled: true, serverAddr: '1.2.3.4', serverPort: 7000, authToken: 'tok', user: 'dsh' };
    const insts = [{ id: 'inst-abc12345', frpEnabled: true, frpRemotePort: 7001, wanPort: 40000 }];
    const { text, count } = m.buildConfig(settings, insts);
    check('R1-a 生成配置含 loginFailExit = false', /^loginFailExit = false$/m.test(text), 'ok');
    check('R1-b 代理条目正确（localPort=wanPort, remotePort）', count === 1 && /localPort = 40000/.test(text) && /remotePort = 7001/.test(text), 'count=' + count);
    check('R1-c wanPort 缺失时不生成无效代理（防 frpc 解析失败）',
      m.buildConfig(settings, [{ id: 'x', frpEnabled: true, frpRemotePort: 7001, wanPort: null }]).count === 0, 'ok');
  }

  // ── R2/R3：真实子进程 crash → 自动重拉 ──
  console.log('== R2/R3 非预期退出自动重拉 ==');
  {
    const D = fs.mkdtempSync(path.join(TMP, 'live-'));
    const m = new FrpManager({ dir: D, logger, events: { append() {} } });
    // 用真实可执行脚本冒充 frpc：长驻 sleep，便于 kill 模拟崩溃
    fs.mkdirSync(path.dirname(m.binPath), { recursive: true });
    fs.writeFileSync(m.binPath, '#!/bin/sh\nsleep 300\n');
    fs.chmodSync(m.binPath, 0o755);
    m.saveSettings({ enabled: true, serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    const insts = [{ id: 'inst-abc12345', frpEnabled: true, frpRemotePort: 7001, wanPort: 40000 }];
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

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });