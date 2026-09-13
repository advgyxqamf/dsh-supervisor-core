#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 桌面壳看护 —— **端到端**验证（2026-09-11）
//
// 与 shell-watchdog-test.js 的分工：
//   · shell-watchdog-test.js         —— 纯决策逻辑（注入 mock，毫秒级、离线）
//   · 本测试                         —— **真实 Supervisor 进程 + 真实 spawn**，
//                                        证明「壳缺失 → 真的被拉起」这条链是通的
//
// 为什么必须有端到端：单元测试能证明「决策正确」，但不能证明「接进守卫后真的会拉起」——
//   本项目已多次出现「逻辑对、接线断」的失效（能力矩阵/registry 等）。
//
// 隔离手段：
//   · 沙箱 HOME（守卫的状态/identity/日志全在其中）；
//   · 假壳脚本写标记文件（拉起即证明）；
//   · **唯一进程名** —— 本机可能真有壳在跑，用不存在的名字确保进入「缺失」分支；
//   · 端口取自 test/_ports.js 安全段（避开 OS ephemeral 与生产池）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { safePort } = require(path.join(__dirname, '_ports'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-e2e-'));
const swDir = path.join(HOME, '.dsh', 'supervisor');
const shDir = path.join(HOME, '.dsh', 'shell');
fs.mkdirSync(swDir, { recursive: true });
fs.mkdirSync(shDir, { recursive: true });

// 假壳：被拉起即写标记，然后挂住（避免立刻退出被当成又缺失）。
//
// ⚠ 2026-09-13 修复（P1）：**必须跨平台构造**。
//   原实现写的是 '#!/bin/sh' + echo/sleep 的 **POSIX 脚本**，
//   而 restartShell 用 spawn(exe, [], {detached, stdio:'ignore'}) 直接执行它 ——
//   Windows **无法执行**该格式（且 .js 也不能直接 spawn）→ 拉起失败 →
//   本文件 E2E-1/3/4/5 在 Windows 上必红。
//   修法（与 uninstall-timeout-behavior-test 同一思路）：让假壳是**可被 spawn 的可执行**——
//      · POSIX：写一个可执行 shell 脚本（保持原样，最贴近真实情形）；
//      · Windows：写一个 **.cmd 批处理**（cmd.exe 可直接执行；Node 的 spawn 在
//        Windows 上对 .cmd 会经 cmd.exe 运行）。
//   两者都只做两件事：把 "launched <pid>" 追加到标记文件；随后挂住约 20s。
const marker = path.join(HOME, 'launched.txt');
const fakeShell = path.join(HOME, process.platform === 'win32' ? 'dsh-supervisor-gui.cmd' : 'dsh-supervisor-gui');
if (process.platform === 'win32') {
  const L = String.fromCharCode(13) + String.fromCharCode(10);
  fs.writeFileSync(fakeShell,
    '@echo off' + L +
    // 刻意**不写数字 pid**：清理逻辑用 /launched (\d+)/ 取 pid 再 SIGKILL，
    // 而 cmd 里拿不到子进程真实 pid；若写 %RANDOM%（数字）会被误当作 pid，
    // 可能**杀掉无关进程**。故此处写平台标识；该 .cmd 约 20s 自行退出，无需回收。
    'echo launched-win-shim >> "' + marker + '"' + L +
    // 挂住：ping 是本机回环，稳定且不需要额外工具；约 20s
    'ping -n 21 127.0.0.1 > nul' + L);
} else {
  fs.writeFileSync(fakeShell,
    '#!/bin/sh' + String.fromCharCode(10) +
    'echo "launched $$" >> "' + marker + '"' + String.fromCharCode(10) +
    'sleep 20' + String.fromCharCode(10));
  fs.chmodSync(fakeShell, 0o755);
}

// 壳的 identity.json：phase=ready（非预期缺席）+ 记录 exe（看护的路径来源）
fs.writeFileSync(path.join(shDir, 'identity.json'), JSON.stringify({
  version: '0.0.0-test', platform: process.platform, arch: process.arch,
  phase: 'ready', pid: 999999, exe: fakeShell,
  startedAt: Math.floor(Date.now() / 1000), attempt: 0, pinned: [],
}, null, 2));

const apiPort = safePort('shell-watchdog-e2e', 0);
const cfg = {
  apiHost: '127.0.0.1', apiPort,
  command: ['node', '-e', 'setInterval(()=>{},1000)'],
  healthUrl: 'http://127.0.0.1:' + safePort('shell-watchdog-e2e', 1) + '/',
  stateFile: path.join(swDir, 'state.json'),
  logFile: path.join(swDir, 'events.log'),
  supervisorLogFile: path.join(swDir, 'guard.log'),
  dshLogFile: path.join(swDir, 'dsh.log'),
  upgradeLogFile: path.join(swDir, 'upgrade.log'),
  probeIntervalMs: 1000,
  updateCheckEnabled: false, notifyEnabled: false,
  // 唯一进程名 → 恒定「壳缺失」；短宽限 → 验证快速
  shellProcPattern: 'dsh-supervisor-gui-watchdog-e2e-only',
  shellWatchdogIntervalMs: 1000,
  shellWatchdogGraceMs: 1500,
  shellWatchdogMaxRestarts: 2,
};

process.env.HOME = HOME;

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  let sup = null;
  try {
    sup = new Supervisor(cfg);
    sup.start();

    // 观察窗：宽限 1.5s + 若干拍
    for (let i = 0; i < 14 && !fs.existsSync(marker); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    const launched = fs.existsSync(marker);
    check('E2E-1 壳缺失 → 被真实拉起（写入标记）', launched,
      launched ? fs.readFileSync(marker, 'utf8').trim() : '未见标记文件');

    const log = fs.existsSync(cfg.supervisorLogFile) ? fs.readFileSync(cfg.supervisorLogFile, 'utf8') : '';
    check('E2E-2 看护随守卫启动', /\[shell-watchdog\] 已启用/.test(log), 'ok');
    check('E2E-3 先计时再拉起（有宽限，不抢跑）',
      /开始计时/.test(log) && /已拉起 pid=/.test(log), 'ok');
    check('E2E-4 拉起使用的是 identity.json 记录的 exe',
      log.includes(fakeShell), 'exe=' + fakeShell);

    const st = sup.shellWatchdog ? sup.shellWatchdog.status() : null;
    check('E2E-5 状态可观测（窗口内拉起次数）', !!(st && st.restartsInWindow >= 1),
      st ? 'restarts=' + st.restartsInWindow : 'null');
    check('E2E-6 图形会话判定可用', !!(st && st.session && typeof st.session.available === 'boolean'),
      st && st.session ? st.session.reason : 'null');
  } catch (e) {
    check('E2E 执行未抛异常', false, (e && e.stack) || String(e));
  } finally {
    try { if (sup) sup.shutdown(); } catch {}
    // ⚠ 清掉被拉起的假壳：restartShell 以 detached+unref 方式 spawn，
    //   不清会**遗留进程**（测试不应泄漏进程）。标记文件里记了它的 pid。
    try {
      if (fs.existsSync(marker)) {
        for (const line of fs.readFileSync(marker, 'utf8').split(/\r?\n/)) {
          const m = /launched (\d+)/.exec(line);
          if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch {} }
        }
      }
    } catch {}
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();