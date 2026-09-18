'use strict';

const platform = require('../../platform/os/index');

// app/session/shutdown.js —— 关停编排：停被管对象、会话置 stopped、回执（绝不自行停止守卫）。



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
    // router/lan 仍驻守卫进程（进程解耦完成前）时 shutdown 必须停它们防孤儿
    // （反代实例进程、relay/frpc、动态端口残留）。统一经 lifecycleManager 出口，保证启停路径收敛到一处。
    // stopAll 是 async，必须 await，否则调用方 exit 会截断它；
    // 返回的 Promise 存到 _shutdownPromise，使重复调用拿到同一个（幂等）。
    host._shutdownPromise = (async () => {
      try {
        if (host.lifecycleManager) {
          // router 若为独立 daemon（detached），守卫退出不停它（其生命周期继续服务）；
          // 仅内嵌 router/lan 需停防孤儿：先把 daemon 型 router 项从 stopAll 豁免。
          try {
            const rlc = host.lifecycleManager.get('router');
            if (rlc && host._routerDaemonActive()) {
              rlc._monitoring = false; // 守卫退出不再监督该 daemon（daemon 自身继续运行）
            }
          } catch {}
          await host.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] }); // 守卫退出绝不动 DSH（RC2 契约）
        } else {
          // 兜底：lifecycleManager 未初始化时防孤儿
          try { if (host.lan) await host.lan.shutdown(); } catch (e) { host.logger.warn && host.logger.warn('lan shutdown: ' + (e && e.message)); }
          try { if (host.router) await host.router.stop(); } catch (e) { host.logger.warn && host.logger.warn('router stop: ' + (e && e.message)); }
        }
      } catch (e) { host.logger.warn && host.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
      // 守护语义：守卫退出不动 DSH，恢复后幂等调和
    })();
    return host._shutdownPromise;
}

async function shutdownAll(host) {
    // 幂等：已进入退出流程则直接回执当前态（壳可安全重试/轮询）
    if (host._sessionHalting()) return { ok: true, already: true, sessionState: host._sessionState };
    host._setSessionState('stopping'); // 抑制一切自动拉起（INV-S1）
    // 持久化「用户已退出」（2026-09-18 修，K1）：会话态只活内存，守卫一旦被外部/登录
    //   重新拉起就遗忘退出意图 —— 看护 90s 后把刚退出的桌面壳拉回。落盘后新守卫 boot
    //   经 loadState 继承；看护观测到壳在线（用户重开）时自动清除。立即写盘，防中途被杀。
    host._shellHalted = true;
    try { host.writeState(true); } catch (e) { host.logger.warn && host.logger.warn('shutdownAll persist shellHalted: ' + e.message); }
    // 同步停桌面壳看护（2026-09-18 修）：会话退出中不得再自愈拉起壳。
    //   bootstrap 的 tick 门是运行期防线；此处清定时器是与完整 shutdown() 对齐的第二道。
    if (host._shellWatchdogTimer) { clearInterval(host._shellWatchdogTimer); host._shellWatchdogTimer = null; }
    // 与完整 shutdown() 对齐（K5）：退出后不得再有任何周期收敛（心跳会重新监督/拉起被管对象）。
    //   sessionState=stopping 已抑制；清定时器是第二道，防某适配器门遗漏时残留周期动作。
    if (host._heartbeatTimer) { clearInterval(host._heartbeatTimer); host._heartbeatTimer = null; }
    if (host._timer) { clearInterval(host._timer); host._timer = null; }
    if (host._initialCheckTimer) { clearTimeout(host._initialCheckTimer); host._initialCheckTimer = null; }
    if (host._upgradeTimer) { clearInterval(host._upgradeTimer); host._upgradeTimer = null; }
    if (host._killTimer) { clearTimeout(host._killTimer); host._killTimer = null; }
    if (host._adoptKillTimer) { clearTimeout(host._adoptKillTimer); host._adoptKillTimer = null; }
    host.logger.info('[session] 退出流程开始：停止全部被管对象…');
    host.events && host.events.append('shutdown_all', {});
    // 1) 停 DSH 主实例（本守卫是被管对象的所有者，契约 §2）
    host._stopMainDsh();
    // 2) 停全部沙箱（按实际单元名——glob 不经 shell 不展开）
    await host._stopAllSandboxes();
    // 3) 停路由/远程 daemon（独立进程；DaemonLifecycle.stop 串行换代语义）
    // stop() 会如实返回 ok:false（进程未在超时内退出时）：失败即记事件 + warn，
    //   让面板/日志可见（仍继续后续步骤，不阻断关停流程）。
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
      // 退出会话不等于改变用户运行意图（契约 §6：desired 仅在用户显式启停时改变）。
      // 「停后不再拉起」由 sessionState=stopping 抑制（INV-S1）；保留 desired=running
      // 使下次打开壳可恢复运行（契约 §5 启动时序）。
      if (host._mChild() || host._mAdoptPid()) { host.stopProcess('session_stop'); }
    } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop main: ' + e.message); }
}

async function _stopAllSandboxes(host) {
    // systemctl stop dsh-web@* 经 execFileSync 不走 shell，`*` 不会被展开（被当字面单元名），
    // 沙箱停不掉。故遍历本守卫登记的沙箱实例，按实际单元名逐个停。
    const insts = host.instances ? host.instances.all() : [];
    const sandboxes = insts.filter((i) => i.domain === 'sandbox' && i.id !== 'main');
    for (const inst of sandboxes) {
      let stopped = false;
      try {
        // 服务管理器抽象（跨平台审计 §7.1）：编排层不直接调用 systemctl。
        // 仅当 stopUnit 明确返回成功才认为单元已停：Linux 停止失败返回 false，
        // 非 Linux（无用户单元）抛 CapabilityError；两条路径都不得把实例谎报为 STOPPED。
        stopped = platform.service.current().stopUnit('dsh-web@' + inst.id, { timeoutMs: 20000 }) === true;
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ': ' + (e && e.message)); }
      if (!stopped) {
        // 未确认停止：保留原 phase，不落 STOPPED（否则下次按错误相位决策形成 ghost）。
        host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ' 未确认停止，保留原 phase');
        host.events && host.events.append('shutdown_sandbox_stop_incomplete', { id: inst.id });
        continue;
      }
      try { if (inst.state) inst.state.phase = 'STOPPED'; } catch {}
    }
    if (sandboxes.length) { try { host.instances.save(); } catch {} }
}

module.exports = { shutdown, shutdownAll, _stopMainDsh, _stopAllSandboxes };
