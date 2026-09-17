'use strict';

// 反代供应商：账号=代理实例（进程），每账号一个实例（硬规则）。本文件是实例进程治理入口 +
// 账号生命周期钩子 + 池/探测/重启/命令委托：命令拼装归 command.js，实例池决策归 pool.js，
// spawn/探活/配额探测归 probe.js，重启重拉/对账归 restart.js，冻结/解冻状态机归 base.js 与 freeze.js。

const { ProviderBase } = require('./base');
const { keyFingerprint, maskKey } = require('./model');
const { ProxyInstance } = require('../model');
require('../port-segments'); // 本域端口段/独立池申报（require 即注入）
const ports = require('../../../platform/service/ports').shared;
const pidlook = require('../../../platform/os/pidlookup');
const { npxBin } = require('../../../platform/os/exec-path');
const { buildCommand } = require('./command');
const probe = require('./probe');
const restart = require('./restart');
const poolPolicy = require('./pool');
const life = require('./instance-lifecycle');

class ProxyProvider extends ProviderBase {
  constructor(opts) {
    super(opts);
    this.kind = 'proxy';
    this.proxyAppId = opts.proxyAppId;
    this.app = opts.app || null;
    this.stateDir = opts.stateDir || null; // 数据目录（config.stateFile 派生）：日志落这里
    this.proxyRunning = false;
    this.instances = [];
    this.selectedAccountKeyId = null;
    this._startLock = false; // 实例启动互斥：一次只 spawn 一个 npx
    this._stopping = false; // 关停标记：stop() 前置真，期间不预启动
    this._terminatingPids = new Set(); // 停服台账：已发 SIGTERM 的子进程 pid
    this._pool = poolPolicy.createPoolPolicy({ getConfig: () => this.config });
    this._restart = restart.createRestartOrchestrator({
      startInstance: (inst) => this.startInstance(inst),
      waitHealthy: (inst) => this._waitHealthy(inst),
      isAlive: (pid) => { try { return pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { return true; } },
      logger: this.logger,
      isStopping: () => this._stopping,
    });
    // ctor 注入钩子（打破 base 到 proxy 的 this.stopInstance 反向边）：删账号时释放实例与端口绑定
    this._hooks = this._hooks || {};
    this._hooks.onDiscardAccount = (acc) => {
      if (acc.instance) { try { this.stopInstance(acc.instance); } catch {} }
      try { ports.unregister('proxy:' + acc.keyId); } catch {}
      if (acc.instance) acc.instance.port = null;
    };
  }

  /** 能力声明：process-pool 具备实例生命周期。转发层据此决定是否走按需激活。 */
  supports(cap) {
    return ['instanceLifecycle', 'warmPool', 'switchBudget', 'reconcile', 'prewarm'].includes(cap);
  }

  accountOf(inst) { return this.accounts.find((a) => a.key === inst.key) || null; }

  /** 账号 -> 实例映射（一账号一实例）：usageOf 派生 warming 的依据。 */
  instanceOf(acc) {
    if (!acc) return null;
    return (this.instances || []).find((i) => i.keyId === acc.keyId) || acc.instance || null;
  }

  async ensureInstance(key) {
    let inst = this.instances.find((i) => i.key === key);
    if (inst) return inst;
    inst = new ProxyInstance({ key, keyId: keyFingerprint(key), maskedKey: maskKey(key), app: this.app, logger: this.logger, events: this.events });
    this.instances.push(inst);
    return inst;
  }

  /** 启动实例：并发去重（startingPromise）+ 全局串行（_startLock，防 npm 缓存锁风暴）。 */
  async startInstance(inst) {
    if (inst.pid) return { ok: true, already: true };
    if (inst.startingPromise) return inst.startingPromise;
    inst.startingPromise = (async () => {
      try {
        const lockWaitStart = Date.now();
        while (this._startLock && Date.now() - lockWaitStart < 30000) { await new Promise((r) => setTimeout(r, 250)); }
        if (this._startLock) return { ok: false, error: '实例启动互斥锁超时（前一次启动未完成）' };
        this._startLock = true;
        try {
          return await this._doStart(inst);
        } finally {
          this._startLock = false;
        }
      } finally {
        inst.startingPromise = null;
      }
    })();
    return inst.startingPromise;
  }

  /** 解析启动命令（缓存优先 + fallback npx）：纯拼装委托 command.js，凭证剔除留在本层（纪律）。 */
  async _resolveLaunchCommand(app, port, key) {
    const registry = this.dist ? await this.dist.selectRegistry(false).catch(() => null) : null;
    const cachedBin = this._cachedPkgBin(app.pkg);
    const launch = buildCommand({ app, port, cachedBin, registry, npxBin: npxBin(), execPath: process.execPath });
    if (!launch || !launch.ok) return launch || { ok: false, error: '命令拼装失败' };
    // 凭证纪律：key 只经 env（app.keyEnv），argv 必须剔除 --api-key 及其值与 {{key}} 占位
    const cmd = [];
    for (let i = 0; i < launch.cmd.length; i++) {
      const t = launch.cmd[i];
      if (t === '--api-key') { i++; continue; }
      if (String(t).includes('{{key}}')) continue;
      cmd.push(t);
    }
    return { ok: true, cmd, registry: launch.registry };
  }

  _cachedPkgBin(pkg) { return probe.cachedPkgBin(pkg); }
  _ensurePkgCached(app) { return probe.ensurePkgCached(this, app); }

  /** 启动实例（底层治理在 probe.js）。注意：方法保留在原型上，测试以 _doStart 打桩替换 spawn。 */
  async _doStart(inst) { return probe.spawnInstance(this, inst); }

  /** 标记实例被请求使用：只记录 lastUsedAt（清零归 markRequestOk，避免熔断计数到不了阈值）。 */
  markUsed(inst) {
    if (!inst) return;
    inst.lastUsedAt = Date.now();
  }

  /** 请求成功后清零失败计数（时机是熔断可达的全部要害）。不触碰健康监测的 _monitorFails。 */
  markRequestOk(inst) {
    if (!inst) return;
    inst._unhealthyCount = 0;
  }

  /** 实例停止仲裁（委托 instance-lifecycle.js）。 */
  _canStopInstance(acc) { return life.canStopInstance(this, acc); }
  /** 实例停止（幂等）：在途/在用 -> 标记待停；force 跳过仲裁（委托 instance-lifecycle.js）。 */
  stopInstance(inst, force) { return life.stopInstance(this, inst, force); }
  /** 请求结束补刀（委托 instance-lifecycle.js）。 */
  _retryPendingStop(acc) { return life.retryPendingStop(this, acc); }

  /** 等待全部 SIGTERM 在途子进程真正退出（实现与 zombie 判定在 probe.js）。 */
  async waitAllStopped(timeoutMs) { return probe.waitAllStopped(this, timeoutMs); }

  /** 实例探活（探活实现与计数分层在 probe.js，计数各归其主）。 */
  async healthInstance(inst) { return probe.healthInstance(this, inst); }

  /** 实例生命周期监控（进程/端口/HTTP 卡死检测）。 */
  async monitorLifecycle() { return probe.monitorLifecycle(this); }

  /** 实例重启：在途延后（_restartPending）+ 单实例退避（_restartAt）+ force 停止 + 重拉委托。
   *  退避只在真正执行重启时置位；stop 失败必须可观测（重新记待重启并清退避，不静默黑洞）。 */
  restartInstance(inst, reason) {
    if (!inst || this._stopping) return;
    if (!inst.pid && !inst.port) return;
    if (Date.now() < (inst._restartAt || 0)) return; // 退避中
    const acc = this.accountOf(inst);
    if (acc && (acc.inflight || 0) > 0) {
      inst._restartPending = reason || 'deferred';
      if (this.logger && this.logger.info) this.logger.info('[proxy-instance] 在途请求中，重启延后 key=' + inst.maskedKey + ' reason=' + inst._restartPending);
      return;
    }
    inst._restartAt = Date.now() + 120000; // 仅在真正执行时置退避
    inst._restartPending = null;
    if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 实例重启 key=' + inst.maskedKey + ' port=' + inst.port + ' reason=' + reason);
    const hadPid = !!inst.pid;
    try { this.stopInstance(inst, true); } catch (e) { this.logger.warn && this.logger.warn('[proxy-instance] 重启 stop 异常: ' + (e && e.message)); }
    if (inst.pid) {
      let stillAlive = true;
      try { stillAlive = (typeof pidlook !== 'undefined' && pidlook.isAlive) ? pidlook.isAlive(inst.pid) : true; } catch {}
      if (stillAlive) {
        inst._restartAt = 0;
        inst._restartPending = reason || 'restart-stop-failed';
        if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 重启未能停止进程 pid=' + inst.pid + ' key=' + inst.maskedKey + '，已重新记待重启（不静默）');
        return;
      }
    }
    this._restart.respawn(inst, { acc, hadPid });
  }

  /** 请求级熔断：连续 ≥2 次报错 -> 重启实例（与健康监测 _monitorFails 独立）。 */
  markInstanceProblem(instOrAcc, reason) {
    try {
      const inst = instOrAcc && instOrAcc.pid ? instOrAcc : null;
      if (!inst) return;
      inst._unhealthyCount = (inst._unhealthyCount || 0) + 1;
      inst.healthy = false;
      inst._lastProblem = reason || 'unknown';
      const failN = inst._unhealthyCount;
      if (failN >= 2) {
        inst._unhealthyCount = 0;
        this.restartInstance(inst, 'req-' + (reason || 'unknown') + ' x' + failN);
      }
    } catch {}
  }

  /** 兼容旧名（保持对外调用不破）。 */
  markInstanceNetFail(instOrAcc) { this.markInstanceProblem(instOrAcc, 'net-error'); }

  /** 实例空闲后补做「被延后的重启」（_restartPending 的消费点，不再只写不读）。 */
  flushRestartPending(inst) {
    if (!inst || !inst._restartPending) return;
    const acc = this.accountOf(inst);
    if (acc && (acc.inflight || 0) > 0) return;
    const why = inst._restartPending;
    inst._restartPending = null;
    if (this.logger && this.logger.info) {
      this.logger.info('[proxy-instance] 实例已空闲，补做延后的重启 key=' + inst.maskedKey + ' reason=' + why);
    }
    try { this.restartInstance(inst, why); } catch (e) {
      this.logger.warn && this.logger.warn('[proxy-instance] 补做重启异常: ' + (e && e.message));
    }
  }

  /** 模式级配额检测（策略注册与解析在 probe.js + quota-strategies.js）。 */
  async detectInstanceQuota(inst) { return probe.detectInstanceQuota(this, inst); }

  async addAccount(key, extra) { return life.addAccount(this, key, extra); }
  async _waitHealthy(inst, tries) { return life.waitHealthy(this, inst, tries); }
  isAccountUsable(acc, opts) { return life.isAccountUsable(this, acc, opts); }
  /** 停掉账号实例（委托 instance-lifecycle.js）。 */
  _stopInstanceIfAny(acc) { return life.stopInstanceIfAny(this, acc); }

  /** 429/403 配额触发冻结：先停实例，再状态机，再对账补备胎 + 异步补探测。 */
  markQuotaExhausted(acc, cooldownMs) {
    this._stopInstanceIfAny(acc);
    super.markQuotaExhausted(acc, cooldownMs);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  /** credits 余额不足：与窗口同一处置（停实例 + 冻结 + 对账补备胎）。 */
  markCreditsExhausted(acc) {
    this._stopInstanceIfAny(acc);
    super.markCreditsExhausted(acc);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  _probeAfterResponseFreeze(acc) { return probe.probeAfterResponseFreeze(this, acc); }

  // 实例池策略（纯决策在 pool.js，此处读 provider 状态并落 sticky）
  _quotaPercent(acc) { return poolPolicy.quotaPercent(acc); }

  residentAccount() {
    const r = this._pool.residentAccount({
      accounts: this.accounts,
      selectedAccountKeyId: this.selectedAccountKeyId,
      activeKeyId: this.activeAccount && this.activeAccount.keyId,
      residentKeyId: this._residentKeyId,
      isUsable: (a) => this.isAccountUsable(a),
    });
    if (r.resident) this._residentKeyId = r.residentKeyId; // 内存 sticky：空闲后回到同一账号
    return r.resident;
  }

  _limits() { return this._pool.limits(); }
  _switchBudgetMs() { return this._pool.switchBudgetMs(); }
  _stateCounts() { return this._pool.stateCounts(this.instances); }

  _needSpare() {
    return this._pool.needSpare({ resident: this.residentAccount(), limits: this._limits(), counts: this._stateCounts(), instances: this.instances });
  }

  desiredRunningAccounts() {
    const resident = this.residentAccount();
    return this._pool.desiredRunningAccounts({
      accounts: this.accounts, resident, limits: this._limits(), needSpare: this._needSpare(),
      isUsable: (a) => this.isAccountUsable(a),
    });
  }

  prewarmAsync(acc) { return restart.prewarmAsync(this, acc); }
  _runReconcile(allowStop) { return restart.runReconcile(this, allowStop); }
  reconcileInstances(opts) { return restart.reconcileInstances(this, opts); }
  reconcileNow() { return restart.reconcileNow(this); }
  isDesiredAccount(acc) { return poolPolicy.isDesired(this.desiredRunningAccounts(), acc); }

  /** 封号：停掉实例（不再消耗资源），再更新状态机。 */
  markBanned(acc, error) {
    this._stopInstanceIfAny(acc);
    super.markBanned(acc, error);
  }
}

module.exports = { ProxyProvider };
