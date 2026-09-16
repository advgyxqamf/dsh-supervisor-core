'use strict';

// ⚠ 步骤7 收尾：shutdownAll 用 platform.service() 停 systemd 单元；该依赖原在 supervisor.js 顶部，机械下沉时未随之携带。
const platform = require('../../platform/os/index');

const { registerAll } = require('../../app/control/adapters');

// ═══════════════════════════════════════════════════════════════════════════
// app/session/shutdown.js —— 关停编排
//
// 职责：停被管对象 → 会话置 stopped → 回执（绝不自行停止守卫）。
//
// 步骤 7（2026-09-16）：从 src/supervisor.js（组装根）下沉 —— 使 root 只剩组装与启动，
//   满足 DIRECTORY-STRUCTURE-DESIGN §5.2 DS-G7（supervisor.js ≤200 行）。
// ═══════════════════════════════════════════════════════════════════════════



function shutdown(host) {
    if (host._stopping) return host._shutdownPromise || Promise.resolve();
    host._stopping = true;
    host.lifecycle.beginShutdown();
    host.events.append('guard_exit', {});
    host.logger.info('guard shutting down');
    host.writeState(true);
    if (host._timer) clearInterval(host._timer);
    if (host._heartbeatTimer) clearInterval(host._heartbeatTimer);
    if (host._killTimer) clearTimeout(host._killTimer);
    if (host._adoptKillTimer) clearTimeout(host._adoptKillTimer);
    if (host._initialCheckTimer) clearTimeout(host._initialCheckTimer);
    if (host._upgradeTimer) clearInterval(host._upgradeTimer);
    if (host._shellWatchdogTimer) clearInterval(host._shellWatchdogTimer);
    if (host.api) {
      try {
        host.api.close();
      } catch {}
    }
    // ── 统一生命周期停止（2026-09 归一化架构）──
    // 过渡态：进程解耦（L3）完成前，router/lan 仍驻守卫进程——shutdown 必须停它们防孤儿
    // （反代实例进程、relay/frpc、动态端口残留）。解耦后此段改为「只停观测，不停进程」：
    // 守卫重启不应影响任何被管模块（它们独立生命周期，由 systemd/自身 supervisor 维持）。
    // 统一经 lifecycleManager 出口（而非直调模块对象），保证启停路径收敛到一处。
    // ⚠ 2026-09-12（P1）：`stopAll` 是 async —— 必须 **await**，否则调用方 exit 会截断它。
    //   返回的 Promise 存到 `_shutdownPromise`，使重复调用拿到同一个（幂等）。
    host._shutdownPromise = (async () => {
      try {
        if (host.lifecycleManager) {
          // L3 解耦：router 若为独立 daemon（detached）→ 守卫退出不停它（daemon 独立生命周期继续服务）；
          // 仅内嵌 router/lan（仍驻守卫进程的）需停防孤儿。实现：先把 daemon 型 router 项从 stopAll 豁免。
          try {
            const rlc = host.lifecycleManager.get('router');
            if (rlc && host._routerDaemonActive()) {
              rlc._monitoring = false; // 守卫退出不再监督该 daemon（daemon 自身继续运行）
            }
          } catch {}
          await host.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] }); // 守卫退出绝不动 DSH（RC2 契约）
        } else {
          // 兜底（lifecycleManager 未初始化时保持原行为防孤儿）
          try { if (host.lan) await host.lan.shutdown(); } catch (e) { host.logger.warn && host.logger.warn('lan shutdown: ' + (e && e.message)); }
          try { if (host.router) await host.router.stop(); } catch (e) { host.logger.warn && host.logger.warn('router stop: ' + (e && e.message)); }
        }
      } catch (e) { host.logger.warn && host.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
      // 守护语义：守卫退出不动 DSH，恢复后幂等调和
    })();
    return host._shutdownPromise;
}

async function shutdownAll(host) {
    // 幂等：已进入退出流程 → 直接回执当前态（壳可安全重试/轮询）
    if (host._sessionHalting()) return { ok: true, already: true, sessionState: host._sessionState };
    host._setSessionState('stopping'); // 抑制一切自动拉起（INV-S1）
    host.logger.info('[session] 退出流程开始：停止全部被管对象…');
    host.events && host.events.append('shutdown_all', {});
    // 1) 停 DSH 主实例（本守卫是被管对象的所有者，契约 §2）
    host._stopMainDsh();
    // 2) 停全部沙箱（按实际单元名——glob 不经 shell 不展开，V5 修复）
    await host._stopAllSandboxes();
    // 3) 停路由/远程 daemon（独立进程；DaemonLifecycle.stop 串行换代语义）
    // ⚠ 2026-09-12（P2-2 配套）：`stop()` 现在**会如实返回 ok:false**（进程未在超时内退出时）。
    //   此前该返回值被直接丢弃 → 孤儿 daemon 会被静默放过（与「已全部停止」的回执矛盾）。
    //   现：失败即记事件 + warn，让面板/日志可见（仍继续后续步骤，不阻断关停流程）。
    const stopDaemon = async (kind) => {
      try {
        const lc = host._daemonLifecycle(kind);
        if (!lc) return;
        const r = await lc.stop();
        if (r && r.ok === false) {
          host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ' 未完成: ' + (r.error || '未知'));
          host.events && host.events.append('shutdown_daemon_stop_incomplete', { kind, pid: r.stopped || null, error: r.error || null });
        }
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ': ' + e.message); }
    };
    await stopDaemon('router');
    await stopDaemon('lan');
    // 4) 会话置 stopped 并回执——**守卫不停止自己**：守卫所属单元的所有者是外部（systemd + 壳，
    //    契约 §2/§4.1）。壳收到本回执后执行 systemctl --user stop，守卫进程随之收到 SIGTERM 自然退出。
    host._setSessionState('stopped');
    host.writeState(true);
    host.events && host.events.append('session_stopped', {});
    host.logger.info('[session] 被管对象已全部停止；等待外部所有者（壳/systemd）停止守卫进程');
    return { ok: true, sessionState: 'stopped' };
}

function _stopMainDsh(host) {
    try {
      // 退出会话 ≠ 改变用户运行意图（契约 §6：desired 仅在用户显式启停时改变）。
      // 「停后不再拉起」由 sessionState=stopping 抑制（INV-S1）；不再靠翻 desired——旧架构翻 desired
      // 是为防 systemd Restart=always 重拉 DSH，新架构由壳主动 stop 守卫，该理由已消失。
      // 保留 desired=running 使「下次打开壳」可恢复运行（契约 §5 启动时序）。
      if (host._mChild() || host._mAdoptPid()) { host.stopProcess('session_stop'); }
    } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop main: ' + e.message); }
}

async function _stopAllSandboxes(host) {
    // V5 修复：`systemctl stop dsh-web@*` 经 execFileSync 不走 shell，`*` 不会被展开（systemd 会把
    // 它当字面单元名）→ 沙箱根本停不掉。改为遍历本守卫登记的沙箱实例，按【实际单元名】逐个停。
    const insts = host.instances ? host.instances.all() : [];
    const sandboxes = insts.filter((i) => i.domain === 'sandbox' && i.id !== 'main');
    for (const inst of sandboxes) {
      try {
        // 服务管理器抽象（跨平台审计 §7.1）：编排层不直接调用 systemctl。
        platform.service.current().stopUnit('dsh-web@' + inst.id, { timeoutMs: 20000 });
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ': ' + e.message); }
      try { if (inst.state) inst.state.phase = 'STOPPED'; } catch {}
    }
    if (sandboxes.length) { try { host.instances.save(); } catch {} }
}

module.exports = { shutdown, shutdownAll, _stopMainDsh, _stopAllSandboxes };