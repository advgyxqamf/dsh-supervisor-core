'use strict';

// STEP7 分片 F —— daemon 保活单拍（router/lan 心跳监督）
// 逐字搬迁自 src/app/daemons/control-view.js（纯搬迁，逻辑零改动）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续使用 this。

const pidlook = require('../../platform/os/pidlookup');

/** 监督拍内拉取 router 域摘要的超时（ms）。
 *  必须远小于心跳拍宽对「阻塞」的容忍度：摘要只是只读缓存，失败即降级。
 *  对照 _ctlCall 的默认 120s —— 那会阻塞整条唯一心跳（见调用点说明）。 */
const ROUTER_SUMMARY_TIMEOUT_MS = 5000;

module.exports = {
  methods: {
    /** 唯一心跳驱动的 daemon 保活单拍（v3 R3 C3-2）：
     *  router/lan-daemon 的「业务需要它 + 失联即拉起」，由 ManagedRegistry.heartbeat 经 adapter 调用
     *  （节流≈30s，与原 L3 监督 tick 等价）。守卫重启不影响 daemon（进程独立）。
     *  ⚠ 契约 §2 域 B：这两个 daemon 是**基础设施**（能力自愈），本方法是**保活**，
     *    不是「用户意图被守护触发」——故两分支均不写 guardian_action / restartCount（G-1/G-2）。
     *  @returns {ok:boolean} daemon 当前在线（heartbeat 统一写入目录实然）。 */
    async _daemonSuperviseOnce(kind) {
      if (this._stopping) return { ok: false };
      // INV-S1 全域（契约 §3.3）：会话退出中/已退出 → 不再监督拉起 router/lan daemon。
      if (this.session.halting()) return { ok: false, error: 'session halting' };
      try {
        if (kind === 'router') {
          const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
          const wantRunning = this.config.routerAutostart === true || (rlc && rlc.desired === 'running');
          if (!wantRunning) return { ok: this.daemons.routerActive() };
          if (!this.daemons.managed()) return { ok: this.daemons.routerActive() }; // 异主隔离：监督不介入
          // 代际分类（DaemonLifecycle.classify）：识别「ctl 被外部/异代际进程占用」的 external 情形——
          // 原路径只按 cmdline 判 active，无法区分本守卫 daemon 与外部同名 daemon（classify 接线，2026-09）。
          const rlcx = this.daemons.lifecycle('router');
          if (rlcx && typeof rlcx.classify === 'function') {
            const c = rlcx.classify();
            if (c && c.mode === 'external') {
              // 异主隔离：只告警不接管。此处**不发 guardian_action**（契约 §2 域 B / G-2：基础设施保活不写用户意图事件）。
              this.logger && this.logger.warn && this.logger.warn('[router] 监督：ctl ' + this.ctl.routerPort() + ' 被外部进程占用（pid=' + c.owner + '），不接管不拉起');
              return { ok: false };
            }
          }
          if (this.daemons.routerActive()) {
            try { this.control.syncRouterView({ ok: true }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
            // R4 域摘要入目录（黑盒摘要引用，只读缓存；拉取失败仅降级——不影响监督）
            try {
              if (this.views.routerDaemonActive() && this.managedObjects) {
                // ⚠ P2 修复（2026-09-13）：**必须给这一处显式短超时**。
                //   domainSummary 经 ctl 转发，而 _ctlCall 的默认超时是 **120s**（见本文件 :67-69）。
                //   本 await 位于心跳的**串行** for 循环内 → 会把同拍后续的 lan/主实例/沙箱
                //   全部阻塞，并与「心跳是唯一周期驱动」复合：一拍最长 120s，
                //   期间 main 收敛、沙箱自愈、daemon 监督全部停摆（且只有 debug 级日志）。
                //   摘要只是**只读缓存**，失败可降级，不值得阻塞监督 → 5s 上限。
                //   ⚠ 必须直接走 _ctlCall 的 timeoutMs 形参：门面 proxy 的签名是
                //     fn=(...args)=>_ctlCall(port,prop,args)，把 {timeoutMs} 当**方法参数**传
                //     会被送到 daemon 的 domainSummary 而不是当超时用（我第一版就写错了）。
                const s = await this.ctl.call(this.ctl.routerPort(), 'domainSummary', [], ROUTER_SUMMARY_TIMEOUT_MS);
                const e = this.managedObjects.get('router-daemon');
                if (e && s && typeof s === 'object') {
                  e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
                }
              }
            } catch (e2) { this.logger && this.logger.debug && this.logger.debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
            return { ok: true };
          }
          // ⚠ 契约 §2 域 B / G-1+G-2：router-daemon 是**基础设施**，此处是**保活**（失联即拉起），
          //   不是「用户意图被守护触发」——故不判 guardian、不写 restartCount、不发 guardian_action。
          //   曾对恒 true 的 guardian 判 `!== true` 属删后的补丁；restartCount 属用户意图语义（该计数回答
          //   「用户开的守护触发了几次」），基础设施不适用。运维仍从下方 warn 日志看到「被重新拉起」。
          const rt = this.daemons.ensureRouterRuntime(true);
          if (rt.mode === 'daemon' && rt.spawned) {
            this.events.append('router_daemon_supervised', { pid: rt.spawned });
            if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联，已重新拉起 pid=' + rt.spawned);
            if (rlc) { rlc._setPhase('starting'); }
            setTimeout(() => {
              const up = pidlook.findListeningPid(this.ctl.routerPort());
              try { this.control.syncRouterView({ ok: !!up, error: up ? null : 'router-daemon 拉起后未就绪' }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
            }, 3000);
          } else if (rt.mode === 'error') {
            if (this.logger && this.logger.warn) this.logger.warn('[router] 监督拉起失败: ' + (rt.error || '未知'));
          }
          return { ok: false };
        }
        // kind === 'lan'
        // ⚠ 业务条件（契约 §2 域 B / G-1）：lan 该不该活着由**结构性部署选择**决定，不是用户开关——
        //   config.lanDaemon 在壳部署时选定「daemon 模式 vs 内嵌模式」，无面板入口、用户无需知情。
        if (!this.daemons.enabled()) return { ok: this.daemons.lanActive() };
        this.daemons.syncLanState();
        if (this.daemons.lanActive()) return { ok: true };
        // 保活（失联即拉起）：**不判 guardian、不写 restartCount、不发 guardian_action**（契约 G-1/G-2）。
        //   基础设施不存在「用户意图轴」，拉起是它的职责，不是「守护功能被触发」——
        //   故原先那处「对恒 true 的 guardian 判否」的补丁、以及为它服务的 restartCount 双写，均属错位产物，删。
        //   运维仍能由下方 warn 日志看到「lan 被重新拉起」（这是保活日志，不是守护事件）。
        //   ⚠ id 平面（G-5）：本分支工作于 **B 平面**（adapters 注册 id='lan'，即 lifecycleManager.get('lan')）；
        //   目录 entry 属 **A 平面**（申报 id='lan-daemon'）。两平面经本函数的 kind 参数显式映射
        //   （supervisor.js: registerAdapter('lan-daemon', …) → _daemonSuperviseOnce('lan')）。
        //   基础设施路径全程无需再取目录 entry——原先取它只为读那个恒 true 的 guardian 字段。
        const rt = this.daemons.ensureLanRuntime(true);
        if (rt.mode === 'daemon' && rt.spawned) {
          if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督：lan-daemon 失联，已重新拉起 pid=' + rt.spawned);
        } else if (rt.mode === 'error') {
          if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督拉起失败: ' + (rt.error || '未知'));
        }
        return { ok: false };
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('[' + kind + '] 监督异常: ' + (e && e.message));
        return { ok: false };
      }
    },
  },
};
