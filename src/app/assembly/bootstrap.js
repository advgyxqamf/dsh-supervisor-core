'use strict';

const execPath = require('../../platform/os/exec-path');

// ═══════════════════════════════════════════════════════════════════════════
// app/assembly/bootstrap.js —— 启动序列
//
// 职责：markStarted、注册受管对象、首拍收敛、心跳与壳看护定时器。
//
// 步骤 7（2026-09-16）：从 src/supervisor.js（组装根）下沉 —— 使 root 只剩组装与启动，
//   满足 DIRECTORY-STRUCTURE-DESIGN §5.2 DS-G7（supervisor.js ≤200 行）。
//
// ⚠ 步骤7 回归收敛（本次修复）：机械下沉时 `_bootstrap` 只搬了前半段——
//   ① require 未随方法携带（createShellWatchdog/pidlook/platform），
//      `_startShellWatchdog` 一运行即 ReferenceError（被自身 try 吞成 warn）；
//   ② `markStarted()` / guard_started 事件被整段丢弃（守卫 readyz 恒 false）；
//   ③ **唯一心跳定时器整段丢失** —— 而 managedObjects 存在时不建 tick 定时器，
//      故 main 收敛/沙箱监督/daemon 监护**完全无驱动** → DSH 永远停在 STARTING；
//   ④ router 自启动、lan 反向对账、更新检查定时器、壳看护启动亦未搬运。
//   现按 HEAD 版 start() 的原始顺序逐段补回（方法体逻辑未改，仅 host 化）。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const { registerAll } = require('../../app/control/adapters');
// ⚠ 步骤7 收尾：以下三个 require 原在 supervisor.js 顶部，机械下沉时**未随方法携带**。
//   `_startShellWatchdog` 直接引用 createShellWatchdog/pidlook/platform，缺任一即 ReferenceError。
const { createShellWatchdog } = require('../../domains/shell/watchdog');
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');

function _bootstrap(host) {
    // ⚠ 步骤 7 收尾：HTTP 服务启动已上移到 src/supervisor.js 的 startApi()（root 的特权职责，
    //   因 api 层在依赖序上位于 app 之上，app 不得 require api —— 契约 DS-3）。
    //   本函数只做**启动序列**：守卫生命周期标记 → 首拍收敛 → 心跳/看护定时器 → 各域装配。
    //
    // ⚠ 回归收敛：守卫生命周期标记原在 start() 开头，机械下沉时整段丢失。
    //   不放回则 lifecycle.isReady() 恒 false（/readyz 失败），状态摘要无 startedAt。
    try {
      host.events.append('guard_started', {
        pid: process.pid,
        version: host.guardVersion,
        healthUrl: host.config.healthUrl,
        api: host.config.apiHost + ':' + host.config.apiPort,
      });
    } catch {}
    try { host.lifecycle.markStarted(); } catch {}
    host.logger.info('guard started v' + host.guardVersion + ' pid=' + process.pid);
    // （生命周期注册已上移到 app/assembly/compose.js 的构造期 —— 见那里的说明）
    host.tick(); // 首拍立即收敛
    // main(dsh) 收敛驱动源（C3-3b G3 接管 → C3-5 终态）：唯一心跳（registry heartbeat →
    // dsh supervise → _dshConverge）是唯一周期驱动——tick 定时器不再创建；
    // 仅 registry 不可用（极罕见）时保留 tick 定时器兜底（保证 main 不被放养）。
    host._timer = host.managedObjects ? null : setInterval(() => host.tick(), host.config.probeIntervalMs);
    // ── 唯一心跳（v3 R3 C3-2/C3-3b G3）：daemon 监督 + main 收敛 + 沙箱监督的唯一周期驱动 ──
    // ⚠ 步骤7 回归收敛：本段（含 _heartbeatBusy 兜底释放、可观测字段）在下沉时**整段丢失**；
    //   而 managedObjects 存在时上面不建 tick 定时器 → 无任何周期驱动 → 生产 DSH 永不收敛。
    //   _heartbeatBusy 防慢拍重叠（probe 超时/长 I/O 时心跳不并发，防 daemon 双监督/main 双收敛）。
    //   ⚠ P1 修复（2026-09-13）：_heartbeatBusy 必须有**兜底释放**，否则一次卡死 = 心跳永停。
    //   缺陷：`if (host._heartbeatBusy) return;` 是**丢拍**语义；更严重的是 _heartbeatBusy 只在
    //     .finally 里释放 —— 若 heartbeat 返回的 promise **永不 settle**，.finally 永不执行
    //     → _heartbeatBusy 永久 true → 心跳永停。而心跳是唯一周期驱动，停摆后 main 永不 spawn/adopt、
    //     沙箱挂了永不退避重试、daemon 失联永不被拉起，/status 却仍显示最后一次写入的 phase。
    //   修法：① 独立兜底定时器在「远大于任何正常拍」的阈值后强制释放 busy（并记 warn）；
    //     ② 暴露 _lastHeartbeatAt / _heartbeatStalls，使「心跳停摆」可观测而非隐形。
    host._lastHeartbeatAt = Date.now();
    host._heartbeatStalls = 0;
    // ⚠ 拍宽必须在 setInterval **之前**求值：它同时用作间隔与超时阈值。
    //   （若写在回调内部却在 `}, iv)` 处引用 → ReferenceError，心跳定时器根本没建起来。）
    const heartbeatIv = host.config.probeIntervalMs || 5000;
    host._heartbeatTimer = setInterval(() => {
      if (host._heartbeatBusy) return;
      host._heartbeatBusy = true;
      const iv = heartbeatIv;
      host._lastHeartbeatAt = Date.now();
      // 兜底释放（阈值 = 拍宽 × 12：远大于任何正常拍，又保证必定恢复）。unref：不拖住进程退出。
      const stallMs = Math.max(30000, iv * 12);
      const guard = setTimeout(() => {
        if (host._heartbeatBusy) {
          host._heartbeatBusy = false;
          host._heartbeatStalls++;
          if (host.logger && host.logger.warn) {
            host.logger.warn('[heartbeat] 单拍超过 ' + stallMs + 'ms 未结算，强制释放防停摆（第 ' + host._heartbeatStalls + ' 次）');
          }
        }
      }, stallMs);
      if (guard && typeof guard.unref === 'function') guard.unref();
      Promise.resolve(host.managedObjects ? host.managedObjects.heartbeat(iv) : null)
        .catch(() => {})
        .finally(() => { clearTimeout(guard); host._heartbeatBusy = false; });
    }, heartbeatIv);
    // 远程控制：为已开启远程控制的实例补建代理（幂等）
    // L3b：relay/frpc 由独立 lan-daemon 承载——守卫只写状态并拉起/监督 daemon，不在本地建 relay
    if (host.lanDaemonEnabled()) {
      host._syncLanState();
      const lrt = host._ensureLanRuntime(true);
      if (host.logger && host.logger.info) host.logger.info('[lan] L3b 模式：lan-daemon ' + (lrt.mode === 'daemon' ? ('已就绪 pid=' + (lrt.spawned || '(既有)')) : ('未就绪 mode=' + lrt.mode)));
    } else {
      host.lan.reconcile().catch(() => {});
      host.lan.syncFrpc();
    }
    // 沙箱实例监督（R3 C3-4b）：并入唯一心跳 sandbox-instance adapter（heartbeat 逐实例
    // supervise → InstanceManager.supervise）；registry 不可用（极罕见）时兜底自持定时器。
    if (!host.managedObjects) host.instances.startTimer(host.config.probeIntervalMs || 5000);
    // 注意：守卫启动只是守卫自身的生命周期，绝不在启动时去注册/拉起/切换任何实例（含 main）。
    // main 是否纳管/拉起，由各实例自己的［进程守护 guardian］开关 + 实例自身生命周期决定，不因守卫启动而改变。
    // 为已开启远程控制的实例补建代理（幂等；L3b 下由 lan-daemon reconcile 收敛）
    if (!host.lanDaemonEnabled()) {
      for (const inst of host.instances.all()) { if (inst.remoteEnabled) host.lan.syncProxy(inst).catch(() => {}); }
    }
    if (host.config.routerAutostart === true) {
      // 统一生命周期视图同步：router 期望运行 → 注册项纳入监测
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc._setPhase && rlc._setPhase('starting'); }
      // L3 进程解耦：独立 router-daemon 优先——daemon 在跑则监督它（不再内嵌启动双占 43011）；
      // daemon 未跑则拉起独立 daemon（detached）；daemon 不可用（脚本缺失）退回内嵌。
      // 接管既有 daemon（守卫重启/手动拉起）→ 先落管理锁（本守卫目录），监督/启停权归属本守卫。
      if (host._routerDaemonActive()) host._writeRouterDaemonLock();
      const rt = host._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        // 状态文件写权归 daemon（防双写覆盖：守卫只读，providers.json 由 daemon 独占持久化）
        // ⚠ 该纪律已在 `_ensureRouterRuntime` 内部对**全部三条** daemon 路径统一处置，本行是幂等兜底。
        host._disableRouterPersist();
        if (rt.spawned) {
          // 刚拉起：等待 daemon 就绪（短轮询 ctl 端口）
          setTimeout(() => {
            const up = pidlook.findListeningPid(host._routerCtlPort());
            if (rlc) { if (up) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('starting'); } /* healthy 由 _supervise mirror 观测置位 */ }
          }, 3000);
        } else if (rt.active) {
          // daemon 已在跑：监督模式
          if (rlc) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } /* healthy 由 _supervise mirror 观测置位 */
        }
        return; // 已由独立 daemon 承担，不执行下方内嵌启动
      }
      // daemon 不可用 → 内嵌 router（回退路径，保持原行为）
      host.router.start().then((r) => {
        if (rlc) { if (r && r.ok !== false) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('stopped'); rlc.error = (r && r.error) || 'start 失败'; } /* healthy 由 _supervise mirror 观测置位 */ }
        if (r && r.ok === false) host.logger.warn('中转服务启动失败：' + (r.error || '未知错误'));
      });
    } else {
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; }
    }
    if (host.config.updateCheckEnabled !== false) {
      host._initialCheckTimer = setTimeout(() => {
        host.nativeManager.checkUpdate();
      }, host.config.initialCheckDelayMs || 20000);
      host._upgradeTimer = setInterval(() => {
        host.nativeManager.checkUpdate();
      }, host.config.updateCheckIntervalMs || 3600000);
    }
    // ⚠ P3 修复（2026-09-13，失效模式 g）：「失败隔离」纪律必须在本调用点也执行。
    //   本行是启动序列的**最后一个调用且为裸调用**（无 try），但看护自身注释明确声明
    //   「任何异常都不得影响守卫主循环 —— 看护是**增强**，不是依赖」。
    //   前置条件不同：此刻首拍 tick 与心跳 interval **刚刚建好**，若异常从此冒泡则调用方
    //   拿不到「已启动」，且异常路径下守卫状态不明确。
    //   修法：与同文件其它装配同规，包 try/catch 并只记 warn（增强失败不阻断主循环）。
    try {
      host._startShellWatchdog();
    } catch (e) {
      if (host.logger && host.logger.warn) {
        host.logger.warn('[shell-watchdog] 启动异常（不影响守卫主循环）: ' + ((e && e.message) || e));
      }
    }
}

function _startShellWatchdog(host) {
    if (host.config.shellWatchdog === false) {
      host.logger.info && host.logger.info('[shell-watchdog] 已按配置禁用');
      return;
    }
    try {
      host.shellWatchdog = createShellWatchdog({
        shell: host.shellDomain,
        pidlookup: pidlook, desktop: platform.desktop,
        logger: host.logger,
        events: host.events,
        config: host.config,
      });
      host._shellWatchdogTimer = setInterval(() => {
        Promise.resolve(host.shellWatchdog.tick()).catch(() => {});
      }, host.shellWatchdog.intervalMs);
      if (host._shellWatchdogTimer.unref) host._shellWatchdogTimer.unref();
      host.logger.info && host.logger.info('[shell-watchdog] 已启用（周期 ' +
        Math.round(host.shellWatchdog.intervalMs / 1000) + 's）');
    } catch (e) {
      host.logger.warn && host.logger.warn('[shell-watchdog] 初始化失败（不影响守卫）: ' + ((e && e.message) || e));
    }
}


function _registerFixedPorts(host) {
    // 端口来源以配置为准（healthUrl / command --port，normalize 已统一）。
    // 注意：不做 pgrep 启发式猜端口——同一 bin 的其它实例/残留进程会劫持监管目标
    // （实测：残留 mock 的 "--port 3901" 让守卫从 3911 被导到 3901，接管错误对象）。
    ports.register('dsh-main', host.config.targetPort);
    ports.register('supervisor-api', host.config.apiPort);
}

function _bindNativeDshCommand(host) {
    try {
      const cmd = Array.isArray(host.config.command) ? host.config.command.slice() : [];
      const cur = cmd[1];
      // 显式路径（含分隔符或 ~）→ **以用户为准**，即使当前不存在也不覆盖（未装就如实报未装）。
      // 只有出厂默认/裸逻辑名才由检测填充 —— 这正是「检测 → 绑定」的边界。
      const isBare = !cur || cur === 'dsh' || cur === 'dsh.cmd' || (!/[\\/]/.test(cur) && !String(cur).startsWith('~'));
      if (!isBare) return;
      const d = execPath.resolveDsh();
      if (!d || !d.bin) return;
      host.config.command = d.isJs
        ? [d.runtime || process.execPath, d.bin, ...cmd.slice(2)]
        : [d.bin, ...cmd.slice(2)];
      try { host.events && host.events.append('dsh_command_bound', { from: cur || null, to: host.config.command[1] }); } catch {}
      try { host.logger.info && host.logger.info('原生 DSH 已绑定: ' + host.config.command.join(' ')); } catch {}
    } catch (e) { try { host.logger.warn && host.logger.warn('原生 DSH 绑定失败: ' + (e && e.message)); } catch {} }
}

module.exports = { _bootstrap, _startShellWatchdog, _registerFixedPorts, _bindNativeDshCommand };
