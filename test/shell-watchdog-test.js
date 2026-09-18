#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 桌面壳看护（domains/shell/watchdog.js）回归测试
//
// 背景：修复前 Linux/macOS **完全没有**壳自愈；Windows 的 watchdog 把壳检查嵌在
//   `if (-not $up)` 内，「壳崩、守卫活」时整块跳过 —— 而那恰是唯一需要它的场景。
// 本测试锁定新机制的四条边界：只在真缺失时动作 / 宽限 / 需图形会话 / 有界重试。
//
// 全部离线：不碰真实进程、不碰真实文件系统、不绑端口（注入 mock 与时钟）。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
// 纯决策/谓词已下沉 core.js（域结构改造）；看护状态机仍在 watchdog.js。
//   ⚠ 读取面必须随文件搬移同步更新，否则判据静默失去覆盖面（本仓已多次踩坑）。
const { createShellWatchdog } = require(path.join(ROOT, 'src', 'domains', 'shell', 'watchdog'));
const { decide, isShellProcess, DEFAULTS } =
  require(path.join(ROOT, 'src', 'domains', 'shell', 'core'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ── W1 decide() 纯函数穷举 ──
console.log('== W1 decide() 决策穷举 ==');
{
  const cfg = { graceMs: 1000, updateGraceMs: 5000, maxRestarts: 3 };
  const base = { alive: 0, absentForMs: null, expectedAbsence: false, sessionAvailable: true, restartsInWindow: 0, hasExe: true, config: cfg };
  const d = (o) => decide(Object.assign({}, base, o));

  check('W1-a 壳在运行 → alive（不动作）', d({ alive: 2 }).action === 'alive');
  check('W1-b 首次发现缺失 → record（开始计时）', d({ absentForMs: null }).action === 'record');
  check('W1-c 未达宽限 → wait', d({ absentForMs: 500 }).action === 'wait');
  check('W1-d 达宽限 + 就绪 → restart', d({ absentForMs: 1000 }).action === 'restart');
  check('W1-e 预期缺席用 updateGraceMs（1s 不应触发）', d({ absentForMs: 1000, expectedAbsence: true }).action === 'wait');
  check('W1-f 预期缺席超 updateGraceMs → restart', d({ absentForMs: 5000, expectedAbsence: true }).action === 'restart');
  check('W1-g 无图形会话 → skip（拉起必失败）', d({ absentForMs: 9999, sessionAvailable: false }).action === 'skip');
  check('W1-h 达上限 → skip（防风暴）', d({ absentForMs: 9999, restartsInWindow: 3 }).action === 'skip');
  check('W1-i 无法定位 exe → skip（不盲拉）', d({ absentForMs: 9999, hasExe: false }).action === 'skip');
  check('W1-j 决策优先级：无会话优先于上限', d({ absentForMs: 9999, sessionAvailable: false, restartsInWindow: 9 }).reason.includes('图形会话'));
  check('W1-k wait 给出 needMs（便于诊断）', typeof d({ absentForMs: 10 }).needMs === 'number');
}

// ── W2 进程过滤 ──
console.log('== W2 isShellProcess 过滤 ==');
{
  check('W2-a 匹配壳主程序', isShellProcess({ cmdline: '/usr/bin/dsh-supervisor-gui' }) === true);
  check('W2-b 匹配 Windows .exe', isShellProcess({ cmdline: 'C:\\x\\dsh-supervisor-gui.exe' }) === true);
  check('W2-c 排除 --shell-update-plan 自检', isShellProcess({ cmdline: 'dsh-supervisor-gui --shell-update-plan' }) === false);
  check('W2-d 排除 --service-plan 自检', isShellProcess({ cmdline: 'dsh-supervisor-gui --service-plan' }) === false);
  check('W2-e 空 cmdline 不误判', isShellProcess({ cmdline: '' }) === false);
}

// ── W3 tick() 集成（注入 mock）──
console.log('== W3 tick() 集成 ==');
const mk = (opts) => {
  const o = opts || {};
  let t = 1000000;
  const calls = { restarts: [] };
  const deps = {
    shell: {
      identity: () => (o.identity === undefined ? { exe: '/usr/bin/dsh-supervisor-gui', phase: o.phase || 'ready' } : o.identity),
      readJournal: () => (o.journal || { to: null, confirmed: false }),
      restartShell: async (a) => { calls.restarts.push(a); return o.restartResult || { ok: true, pid: 4321, exe: a.exePath }; },
    },
    pidlookup: { pgrepList: () => (o.alive ? [{ pid: 999, cmdline: '/usr/bin/dsh-supervisor-gui' }] : []) },
    desktop: { sessionAvailable: () => o.session !== false, describe: () => ({ available: o.session !== false, reason: 'test' }) },
    logger: { info() {}, warn() {} },
    events: { append() {} },
    config: Object.assign({ shellWatchdogGraceMs: 1000, shellWatchdogUpdateGraceMs: 5000 }, o.config || {}),
    now: () => t,
  };
  if (o.halted) deps.halted = o.halted;
  if (o.onShellAlive) deps.onShellAlive = o.onShellAlive;
  const w = createShellWatchdog(deps);
  return { w, calls, adv: (ms) => { t += ms; } };
};

(async () => {
  {
    const m = mk({ alive: true });
    const r = await m.w.tick();
    check('W3-a 壳存活 → 不拉起', m.calls.restarts.length === 0 && (r.alive === 1 || r.skipped === undefined), JSON.stringify(r));
  }
  {
    const m = mk({ alive: false });
    await m.w.tick();                                   // 首拍：record
    m.adv(1200);
    const r = await m.w.tick();                          // 超宽限：restart
    check('W3-b 缺失超宽限 → 拉起且传 exe', m.calls.restarts.length === 1 && r.restarted === true, JSON.stringify(r));
    check('W3-c 拉起使用 identity.json 的 exe（非猜测）', m.calls.restarts[0] && m.calls.restarts[0].exePath === '/usr/bin/dsh-supervisor-gui', JSON.stringify(m.calls.restarts[0]));
  }
  {
    const m = mk({ alive: false, session: false });
    await m.w.tick();
    m.adv(5000);
    await m.w.tick();
    check('W3-d 无图形会话 → 不拉起', m.calls.restarts.length === 0, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, identity: { phase: 'shell-update-download', exe: '/x/gui' } });
    await m.w.tick();
    m.adv(1200);
    await m.w.tick();
    check('W3-e 壳处于更新中 → 不抢跑（宽限延长）', m.calls.restarts.length === 0, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, identity: { phase: 'ready', exe: null } });
    await m.w.tick();
    m.adv(5000);
    const r = await m.w.tick();
    check('W3-f 无 exe 可定位 → 明确跳过而非盲拉', m.calls.restarts.length === 0 && /无法定位/.test(r.skipped || ''), JSON.stringify(r));
  }
  {
    const m = mk({ alive: false, config: { shellWatchdogMaxRestarts: 2 } });
    for (let i = 0; i < 6; i++) { await m.w.tick(); m.adv(2000); }
    check('W3-g 有界重试：不超过 maxRestarts', m.calls.restarts.length <= 2, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, restartResult: { ok: false, error: 'spawn 失败' } });
    await m.w.tick();
    m.adv(1200);
    const r = await m.w.tick();
    check('W3-h 拉起失败 → 如实返回错误（不假成功）', r.restarted === false && /spawn 失败/.test(r.error || ''), JSON.stringify(r));
  }
  {
    const m = mk({ alive: false });
    const st = m.w.status();
    check('W3-i status() 暴露可观测字段', st.enabled === true && typeof st.intervalMs === 'number' && st.session && typeof st.session.available === 'boolean', JSON.stringify(st).slice(0, 90));
  }
  {
    // 2026-09-18：退出门下沉看护域 —— 退出中/已退出恒不拉起（退出管家后不再自愈）。
    const m = mk({ alive: false, halted: () => true });
    await m.w.tick();
    m.adv(5000);
    const r = await m.w.tick();
    check('W3-j 退出中/已退出 → 恒不拉起（skipped=halted）',
      m.calls.restarts.length === 0 && r.skipped === 'halted', JSON.stringify(r));
  }
  {
    // 壳在线 -> 回调清除持久退出标记（用户重开壳后自愈恢复，不会被永久抑制）。
    let seen = 0;
    const m = mk({ alive: true, onShellAlive: () => { seen++; } });
    await m.w.tick();
    check('W3-k 观测到壳在线 → 回调 onShellAlive（清除退出标记）', seen === 1, 'seen=' + seen);
  }

  // ── W4 接线 ──
  console.log('== W4 接线与声明 ==');
  {
    // ⚠ 2026-09-16 步骤7（薄壳化）：看护的装配/接线已从 src/supervisor.js 下沉到
    //   app/assembly/bootstrap.js（启动装配 :27,159-189）与 app/session/shutdown.js（关闭清理）。
    //   判据改读真实接线点，否则文件一搬就静默失去覆盖面。
    const boot = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'bootstrap.js'), 'utf8');
    const shutdown = fs.readFileSync(path.join(ROOT, 'src', 'app', 'session', 'shutdown.js'), 'utf8');
    check('W4-a 装配引入看护模块', /domains\/shell\/watchdog/.test(boot));
    check('W4-b 看护中注入 pidlookup + desktop', /pidlookup:\s*pidlook/.test(boot) && /desktop:\s*platform\.desktop/.test(boot));
    check('W4-c 看护随守卫启停（启动装配 + 关闭清理）',
      /_startShellWatchdog\(\)/.test(boot) && /clearInterval\(host\._shellWatchdogTimer\)/.test(shutdown));
    check('W4-d 看护异常不影响守卫主循环（catch 包裹）', /初始化失败（不影响守卫）/.test(boot));
    check('W4-e 可按配置禁用（shellWatchdog=false）', /shellWatchdog === false/.test(boot));
    check('W4-h 退出门下沉看护域：装配注入 halted + onShellAlive',
      /halted:\s*\(\)\s*=>/.test(boot) && /onShellAlive:/.test(boot));
    check('W4-i shutdownAll 落盘持久退出标记（host._shellHalted = true）', /host\._shellHalted = true/.test(shutdown));

    const { capabilityProfile } = require(path.join(ROOT, 'src', 'platform', 'os'));
    for (const pl of ['linux', 'darwin', 'win32']) {
      check('W4-f ' + pl + ' shellSelfHeal 声称为 true（本次实现）',
        capabilityProfile(pl, 'x64').shellSelfHeal === true, String(capabilityProfile(pl, 'x64').shellSelfHeal));
    }
    // darwin 原生自启已于 2026-09-11 补齐（独立 LaunchAgent）——
    // 「原生自启」与「崩溃自愈」是两个独立字段，此处断言二者**同时**成立。
    check('W4-g darwin 原生自启与崩溃自愈**同时**成立（互补而非替代）',
      capabilityProfile('darwin', 'arm64').shellAutostart === true &&
      capabilityProfile('darwin', 'arm64').shellSelfHeal === true);
  }

  // ── W5（已移除跨仓读）──
  //   「壳写 identity.json 的 exe/lastSeenAt」是壳仓自身的产出契约，由壳仓测试负责
  //   （src-tauri/src/update.rs::t1 已断言 exe 必须存在）。
  //   内核侧只验证**消费行为**：W1-i（无 exe → 不盲拉）、W3-c（用 identity.exe 拉起）、
  //   W3-f（exe 为空 → 明确跳过）。内核不读壳仓源码。

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();