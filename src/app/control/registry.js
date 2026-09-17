'use strict';

// 
// 管家注册机（ManagedRegistry）—— 控制平面 v3 的声明目录（2026-09-06 定稿）。
//
// 定位：守卫核心层 = 大管家。本目录记录「管家直接负责」的受管对象的应然声明与所有权：
//   - 身份（kind/id/name）
//   - 应然（desired：用户意图 / guardian：自动拉起策略）——持久，由业务申报
//   - 所有权（端口 owner 引用 / root 路径 / unit 或 daemon 声明 / 进程模式）——持久
//   - 类型适配器引用（observe/apply 实现留在类型模块，经 registerAdapter 挂接，不持久化）
//
// 铁律（v3 设计公理落地）：
//   1) 实然（pid/占用/健康）只来自观测，绝不写回目录；
//   2) 注册即存在、注销即不存在（限管家直接负责的对象）；域自治对象不入簿（经 ctl 摘要）；
//   3) 目录不是第二状态源：phase 由调谐循环驱动（R3 挂接），业务不得直接改目录 phase；
//   4) 路径由 root 派生，不登记路径清单；端口只登记所有权引用（联动统一端口注册表）。
// 

const fs = require('node:fs');
const path = require('node:path');
// 纯模型（词表/entry/所有权）已拆到 managed-object.js（DF-2：registry ≤400；DF-3：纯/IO 分离）。
// 公开导出面不变（本文件 re-export createEntry/kindMeta/...）。
const { DESIRED, MANAGED_KINDS, kindMeta, registerKind: registerManagedKind, isDomainA, createEntry, normalizeOwnership } = require('./managed-object');

/** 进程生命周期唯一词表（控制平面 v3）。phase 含一个操作态 'installing'（对应安装任务）；
 *  升级/卸载态在 TaskRegistry，不在 phase。 */
const PHASES = ['stopped', 'installing', 'starting', 'running', 'draining', 'backoff', 'failed', 'restarting'];

//  纯模型（DESIRED/MANAGED_KINDS/kindMeta/registerKind/DOMAIN_A_KINDS/isDomainA/
//    createEntry/normalizeOwnership）已拆到 control/managed-object.js（DF-2/DF-3）。
//    本文件仍定义 PHASES（K3-d：唯一源）并 re-export 上述名字（公开导出面不变）。
//  心跳与调度（ADAPTER_TIMEOUT_TICKS / 单对象超时包装 / heartbeat 循环）已拆到
//    control/heartbeat.js（DF-2/DF-3：目录 CRUD+持久化 vs IO 调度分离）。
//    公开方法 heartbeat 签名与语义不变（薄委托）。
const { runHeartbeat } = require('./heartbeat');

/** 类型适配器：observe/apply 实现（类型模块注册；不进持久化）。 */
class ManagedRegistry {
  /**
   * @param {object} opts { file?: string(managed-objects.json), logger?, events?, ports? }
   */
  constructor(opts) {
    this.file = opts && opts.file;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.ports = (opts && opts.ports) || null; // 统一端口注册表（owner 释放联动；可选）
    this._objects = [];           // 内存目录（顺序 = 注册序）
    this._byId = new Map();
    this._adapters = {};          // kind -> { observe, apply }
    this._loaded = false;
    // 是否「从既有磁盘文件加载」（阶段 2 状态单源迁移判定）：
    //   true  = 历史库已有权威目录 -> 以目录 desired 为准，state.json 不回灌（纯投影）；
    //   false = 目录文件原不存在（首启/老库迁移）-> 允许 state.json 的 desired 作一次性种子。
    // 注意：必须记录「构造前是否存在」，而非 _save 之后——构造函数随后会创建文件（否则判定失真）。
    this._loadedFromDisk = false;
    if (this.file) {
      try { this._loadedFromDisk = fs.existsSync(this.file); } catch { this._loadedFromDisk = false; }
      this._load();
    }
  }

  /*  持久化（应然+所有权；实然与适配器不入册）  */
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const arr = (raw && Array.isArray(raw.objects)) ? raw.objects : [];
      for (const o of arr) {
        // 逐条容错：单条坏 entry（缺 id/字段异常）不得中断整份加载，否则其后合法条目全部静默丢失。
        try {
          if (!o || !kindMeta(o.kind)) continue; // 未知类型/损坏条目：跳过（不阻断启动）
          // guardian 只在域 A 传：域 B 的**旧残留**（早期版本曾写 true）由此被自然丢弃——
          //   配合 _save 不写该字段，升级后首次落盘即完成归一（无需一次性迁移脚本）。
          const e = createEntry({ kind: o.kind, id: o.id, name: o.name, desired: o.desired, guardian: isDomainA(o.kind) ? o.guardian : undefined, ownership: o.ownership });
          // 恢复持久化的受管阶段(仅合法值;观测不恢复)
          if (PHASES.includes(o.phase)) e.phase = o.phase;
          if (Number.isInteger(o.backoffLevel)) e.backoffLevel = o.backoffLevel;
          if (typeof o.backoffUntil === 'number' && o.backoffUntil > Date.now()) e.backoffUntil = o.backoffUntil;
          // 崩溃窗/重启计数随目录持久化（B2 归一：与 state.json 不再双副本——main 崩溃保护跨重启保持）。
          if (Number.isInteger(o.restartCount) && o.restartCount >= 0) e.restartCount = o.restartCount;
          if (o.crashWindowStart === null || typeof o.crashWindowStart === 'number') e.crashWindowStart = o.crashWindowStart;
          if (Number.isInteger(o.crashWindowRestarts) && o.crashWindowRestarts >= 0) e.crashWindowRestarts = o.crashWindowRestarts;
          if (typeof o.startedAt === 'string') e.startedAt = o.startedAt;
          e.lastTransitionAt = null;
          this._index(e);
        } catch (err) {
          this._log('warn', 'managed-objects 条目损坏已跳过(' + ((o && o.kind) || '?') + ':' + ((o && o.id) || '?') + '): ' + ((err && err.message) || err));
        }
      }
      this._loaded = true;
    } catch { /* 首次启动/文件缺失：空目录 */ }
  }

  _save() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        schema: 'managed-objects@1',
        objects: this._objects.map((o) => Object.assign({
          kind: o.kind, id: o.id, name: o.name,
          // desired 两域共用（语义不同，见 createEntry）；guardian **仅域 A** 落盘（G-1）。
          desired: o.desired,
          ownership: o.ownership,
          phase: o.phase, backoffLevel: o.backoffLevel,
          backoffUntil: (o.backoffUntil && o.backoffUntil > Date.now()) ? o.backoffUntil : null,
          // B2 归一：崩溃保护字段随目录持久化（主 DSH 崩溃计数/窗跨守卫重启保持），不再只落 state.json
          restartCount: Number.isInteger(o.restartCount) ? o.restartCount : 0,
          crashWindowStart: o.crashWindowStart || null,
          crashWindowRestarts: Number.isInteger(o.crashWindowRestarts) ? o.crashWindowRestarts : 0,
          startedAt: o.startedAt, createdAt: o.createdAt, updatedAt: o.updatedAt,
        }, isDomainA(o.kind) ? { guardian: o.guardian === true } : {})),
      }, null, 2);
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { this._log('warn', 'managed-objects 持久化失败: ' + (e && e.message)); }
  }

  /** B2 归一：崩溃/退避字段变化时的持久化入口（防抖 50ms 合并同拍多次变更，避免写放大）。
   *  仅落盘目录文件；由 supervisor._persistCrashField 在 _mField 变更后调用。 */
  persistCrashState() {
    if (this._crashSaveTimer) return; // 已排期，合并
    this._crashSaveTimer = setTimeout(() => {
      this._crashSaveTimer = null;
      this._save();
    }, 50);
    if (this._crashSaveTimer.unref) this._crashSaveTimer.unref(); // 不阻塞进程退出
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) this.logger[lv](msg);
  }
  _event(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data || {}); } catch {} }
  }

  /*  目录操作  */
  _index(e) { this._byId.set(e.id, e); this._objects.push(e); }
  _drop(e) {
    this._byId.delete(e.id);
    const i = this._objects.indexOf(e);
    if (i >= 0) this._objects.splice(i, 1);
  }

  /** 注册新类型能力（未来扩展；显式声明，非 CRD）。委托纯模型 managed-object。 */
  registerKind(kind, meta) {
    registerManagedKind(kind, meta);
    return this;
  }

  /** 类型模块挂接适配器（observe/apply 实现留在类型层）。 */
  registerAdapter(kind, adapter) {
    if (!kindMeta(kind)) throw new Error('未知类型，先 registerKind: ' + kind);
    this._adapters[kind] = adapter || {};
    return this;
  }
  adapter(kind) { return this._adapters[kind] || null; }

  /** 业务创建对象时申报入册。 */
  register(spec) {
    const e = createEntry(spec);
    if (this._byId.has(e.id)) throw new Error('重复注册（id 已存在）: ' + e.id);
    this._index(e);
    this._syncPortsOwner(e, true);
    this._save();
    this._event('managed_object_registered', { kind: e.kind, id: e.id, name: e.name });
    return e;
  }

  /** 对象变更申报（desired/guardian/ownership/name）。
   *  `guardian` 是**域 A 专有**（契约 G-1）：域 B 基础设施忽略它并清除历史残留。 */
  update(id, patch) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const p = patch || {};
    if (p.desired !== undefined) {
      if (!DESIRED.includes(p.desired)) return { ok: false, error: '非法 desired: ' + p.desired };
      e.desired = p.desired;
    }
    // guardian 仅域 A 可改（G-1）：域 B 基础设施无此字段——既**不写入**，也**主动清除**历史残留
    //   （旧版本曾写 true；此处删除该键，使升级后的既有 entry 在下一次 update 时即被归一）。
    if (isDomainA(e.kind)) {
      if (p.guardian !== undefined) e.guardian = p.guardian === true;
    } else if ('guardian' in e) {
      delete e.guardian;
    }
    if (p.name !== undefined) e.name = String(p.name || e.id);
    if (p.ownership !== undefined) {
      const old = e.ownership.ports;
      e.ownership = normalizeOwnership(p.ownership);
      this._syncPortsOwner(e, true);
      for (const op of old) { if (!e.ownership.ports.some((np) => np.port === op.port)) this._releasePort(op.port, e.id); }
    }
    e.updatedAt = new Date().toISOString();
    this._save();
    this._event('managed_object_updated', { kind: e.kind, id: e.id });
    return { ok: true, object: e };
  }

  /** 注销（销毁时调用）。级联：按所有权释放端口（owner 语义）-> 移出目录 -> 持久化。 */
  unregister(id, opts) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const o = opts || {};
    // 注意 P3 修复（2026-09-13）：**清掉节流游标**。
    //   _nextTickAt 原先只写不读其它、且**没有任何清除路径**（全仓仅 heartbeat 内一处读写）。
    //   对象注销后若同 id 重新注册，旧游标不会跟着新对象走（新对象是新 entry，天然无游标），
    //   故注销本身影响有限；真正的缺口是「守卫重启才自然丢失」——
    //   在 unregister 处显式清除，使生命周期边界上的语义完整、可测。
    e._nextTickAt = null;
    // 级联停/清理由调用方决定（域业务保留最终权力）；这里只做目录应做的：
    // 1) 释放所有权端口（若注入统一端口注册表，按 owner=本对象释放）
    for (const op of e.ownership.ports) this._releasePort(op.port, e.id);
    if (o.onBeforeRemove) { try { o.onBeforeRemove(e); } catch (err) { this._log('warn', 'onBeforeRemove(' + e.id + '): ' + (err && err.message)); } }
    this._drop(e);
    this._save();
    this._event('managed_object_removed', { kind: e.kind, id: e.id });
    return { ok: true };
  }

  /** 释放本对象持有的端口（按 owner）。
   *
   *  注意 2026-09-12（P2-2 配套）：`PortRegistry.release()` 现已**真正支持** `ownerId` 校验
   *    （此前第二参被静默忽略，故这里曾有 `catch { release(port) }` 的回退）。
   *    回退现已删除 —— 保留它会绕过 owner 判定，正是 P2-2 要堵的「误删他人端口登记」。
   *    记录返回值仅用于日志（不匹配即 no-op 是期望行为，不是错误）。
   */
  _releasePort(port, ownerId) {
    if (!this.ports || typeof this.ports.release !== 'function') return;
    try { this.ports.release(port, ownerId); } catch (err) {
      this._log('warn', 'releasePort(' + port + '/' + ownerId + '): ' + (err && err.message));
    }
  }
  _syncPortsOwner(e, ensure) {
    if (!this.ports || typeof this.ports.allocateMark !== 'function') return;
    for (const op of e.ownership.ports) {
      try {
        if (ensure && !this.ports.isRegistered(op.port)) this.ports.allocateMark(op.port, 'managed:' + e.id, e.id);
      } catch {}
    }
  }

  /*  查询（唯一全系统视图入口）  */
  list() { return this._objects.slice(); }
  get(id) { return this._byId.get(id) || null; }
  byKind(kind) { return this._objects.filter((o) => o.kind === kind); }
  count() { return this._objects.length; }

  /** 唯一心跳（调度/IO 已拆到 control/heartbeat.js；公开签名与语义不变）。
   *  本方法只做薄委托：runHeartbeat(registry, intervalMs) 负责监督单拍、节流、
   *  单对象超时隔离；观测写入口仍是本实例的 applyObservation/setPhase。
   *  @param {number} [intervalMs] 心跳拍宽（默认 5000）
   *  @returns {Promise<{ observed: string[], errors: string[] }>}
   */
  heartbeat(intervalMs) { return runHeartbeat(this, intervalMs); }

  /** 观测写入（仅由 heartbeat/类型 observe 调用；实然不进持久化）。 */
  applyObservation(id, obs) {
    const e = this.get(id);
    if (!e) return null;
    e.lastObserved = {
      ok: !!(obs && obs.ok),
      error: (obs && obs.error) || null,
      at: new Date().toISOString(),
    };
    return e;
  }

  /** 调谐循环对目录项的 phase 写入（R3 由 heartbeat 调用；业务不得直接改）。 */
  setPhase(id, p) {
    const e = this.get(id);
    if (!e) return null;
    if (!PHASES.includes(p)) return e;
    if (e.phase !== p) {
      e.phase = p;
      e.lastTransitionAt = new Date().toISOString();
      this._event('managed_object_phase', { kind: e.kind, id: e.id, phase: p });
      this._save(); // 受管阶段随目录持久化（重启恢复；观测不入册）
    }
    return e;
  }
}

module.exports = { ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership };
