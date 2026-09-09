'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 统一生命周期抽象（ManagedLifecycle）—— 归一化架构核心（2026-09 用户定稿）。
//
// 定位：所有模块（DSH / 实例 / 智能路由 / 反代实例 / 远程控制 / 插件）的生命周期
// 统一收敛到同一个抽象。DSHSUP（守卫）是「监测者」：通过 LifecycleManager 看每个
// 模块的状态，按策略监测/拉起；模块各自独立生命周期——守卫重启 ≠ 模块重启。
//
// 关键语义：
//   - phase 状态机统一：stopped → starting → running → draining → stopped
//   - 启停只经 LifecycleManager 统一入口（start/stop/restart），模块不对外自出接口；
//   - 阶段由 start/stop 迁移驱动；周期拉起在守卫侧（supervisor daemon 监督 tick /
//     实例 watchdog+guardian）——本对象不内置探活（2026-09 债务清理：未接线的 probe 已删）；
//   - 进程独立性：本抽象描述「管理视图」，模块的实际进程可独立于守卫存在——
//     守卫重启只重置自己的观测，不重置模块运行态。
// ═══════════════════════════════════════════════════════════════════════════

const PHASES = ['stopped', 'starting', 'running', 'draining', 'degraded'];

/** 统一生命周期状态对象（每个模块实例一个，注册到 LifecycleManager）。 */
class ManagedLifecycle {
  /**
   * @param {object} opts
   *   - id: 模块唯一标识（如 'dsh' / 'router' / 'router.proxy.<keyId>' / 'inst.<id>' / 'lan'）
   *   - kind: 模块类别（'dsh' | 'router' | 'proxy-instance' | 'instance' | 'lan' | 'plugin'）
   *   - name: 显示名
   *   - logger / events：可选（日志与事件总线）
   *   - start(ctx)：async —— 启动该模块（由生命周期管理器调用）
   *   - stop(ctx)：async —— 停止该模块（守卫 shutdown 或用户启停时调用）
   *   - status()：返回模块自身细节状态（供面板展示，可选）
   */
  constructor(opts) {
    this.id = opts.id || ('lc-' + Math.random().toString(36).slice(2, 8));
    this.kind = opts.kind || 'module';
    this.name = opts.name || this.id;
    this.logger = opts.logger || null;
    this.events = opts.events || null;
    this._start = opts.start || null;
    this._stop = opts.stop || null;
    this._restart = opts.restart || null;
    this._status = opts.status || null;
    // 状态机
    this.phase = 'stopped';       // 观测到的阶段（守卫视角）
    this.desired = 'stopped';     // 期望状态（running = 应保持运行；stopped = 应停止）
    this.healthy = false;         // 最近一次观测（启停/守卫镜像）结果
    this.lastProbeAt = null;      // 保留字段（契约兼容；无内置探活时不更新）
    this.lastTransitionAt = null;
    this.error = null;            // 最近一次错误
    this.startedAt = null;
    this.restartCount = 0;        // 守卫代其拉起的累计次数（守护动作侧 +1）
    this.guardian = opts.guardian === true; // 守护开关：true=健康异常时守卫自动拉起（router/lan/dsh 由 adapters 置 true）；false=仅观测不自动拉起
    this._monitoring = false;     // 是否纳入统一启停管理
  }

  /* ── 状态查询（统一，供 LifecycleManager / API / 面板）── */
  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      phase: this.phase,
      desired: this.desired,
      healthy: this.healthy,
      startedAt: this.startedAt,
      lastProbeAt: this.lastProbeAt,
      lastTransitionAt: this.lastTransitionAt,
      error: this.error,
      restartCount: this.restartCount,
      guardian: this.guardian === true,
      monitoring: this._monitoring,
      detail: this._status ? (this._status() || null) : null,
    };
  }

  /* ── 内部状态迁移（由 LifecycleManager 驱动，模块不直接改 phase）── */
  _setPhase(p) {
    if (!PHASES.includes(p)) return;
    if (this.phase !== p) {
      this.phase = p;
      this.lastTransitionAt = new Date().toISOString();
    }
  }

  /* ── 供 LifecycleManager 调用的统一操作 ── */

  /** 期望保持运行。 */
  wantRunning() {
    this.desired = 'running';
    this.error = null;
  }

  /** 期望停止。 */
  wantStopped() {
    this.desired = 'stopped';
  }

  /** 启动模块（幂等：已在运行则 no-op）。 */
  async start() {
    if (this.phase === 'running' || this.phase === 'starting') return { ok: true, already: true };
    this.error = null;
    this._setPhase('starting');
    try {
      const r = this._start ? await this._start() : { ok: true };
      this.startedAt = this.startedAt || new Date().toISOString();
      this.desired = 'running';
      this._setPhase('running');
      this.healthy = true;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase('stopped');
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 停止模块（守卫 shutdown 或用户显式停）。 */
  async stop(reason) {
    if (this.phase === 'stopped') return { ok: true, already: true };
    this._setPhase('draining');
    try {
      const r = this._stop ? await this._stop(reason) : { ok: true };
      this.desired = 'stopped';
      this._setPhase('stopped');
      this.healthy = false;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase('running'); // 停失败回到运行态（可能是观测到的运行）
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 重启（stop → start 语义由调用方决定；这里提供便捷）。 */
  async restart() {
    if (this._restart) {
      const r = await this._restart();
      if (r && r.ok === false) return { ok: false, error: r.error, ...this.snapshot() };
      return { ok: r && r.ok !== false, ...this.snapshot() };
    }
    const wasDesired = this.desired;
    await this.stop('restart');
    if (wasDesired === 'running') await this.start();
    return { ok: true };
  }
}

module.exports = { ManagedLifecycle, PHASES };
