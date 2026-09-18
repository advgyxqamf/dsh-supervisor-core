'use strict';

// 系统级统一端口注册表（PortRegistry）。
// 全系统所有端口登记为唯一来源的端口记录 { port, role, owner, createdAt }，持久化到 ports.json（0600）：
// 守卫重启后绑定全量恢复，不丢、不重复分配；owner 归属，删除对象即释放端口。
// 职责分层：纯算法 core.js / 持久化 store.js / 迁移 migrate.js / 探测 probe.js / 分配 alloc.js。

const path = require('node:path');
const stateRoot = require('../../service/state-root');
const core = require('./core');
const store = require('./store');
const migrate = require('./migrate');
const probe = require('./probe');
const { PortAllocator } = require('./alloc');

class PortRegistry {
  /** @param {object} [opts] { file, pools } — file 默认 <状态根>/supervisor/ports.json。 */
  constructor(opts) {
    this._file = (opts && opts.file) || path.join(stateRoot.supervisorDir(), 'ports.json');
    this._records = new Map();   // port -> { port, role, owner, createdAt }
    this._allocLock = false;     // 分配互斥：探测(await)窗口内并发调用必须串行
    this._pools = Object.assign({}, core.DEFAULT_POOLS, (opts && opts.pools) || {});
    this._alloc = new PortAllocator(this);
    this._load();
  }

  /** 设置/覆盖物理池定义（config 注入）。 */
  configurePools(pools) {
    if (pools && typeof pools === 'object') this._pools = Object.assign({}, core.DEFAULT_POOLS, pools);
    return this._pools;
  }

  /** 实例侧注册接口（委托模块级函数；段名/池名同样是域知识）。 */
  registerSegment(role, pool) { core.registerSegment(role, pool); return this; }

  /** 逻辑段到池定义（未注册段名回退 managed 池）。 */
  rangeOf(segment) { return core.rangeOf(this._pools, segment); }

  _anchorOffset(segment) { return core.anchorOffset(this._pools, segment); }

  /** 重设持久化文件并重新加载；旧内存记录废弃（不写回旧文件）。 */
  configureFile(file) {
    if (typeof file !== 'string' || !file) return;
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  /* 持久化（委托 store） */
  _load() {
    this._records = new Map();
    for (const r of store.loadRecords(this._file)) this._records.set(r.port, r);
  }

  /** 重新从文件加载（读路径先 reload，以权威文件为准）。 */
  reload() {
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  _save() { store.saveRecords(this._file, [...this._records.values()]); }

  /** 通用记录迁移：owner 命中任一前缀的记录 oldFile 到 newFile，并从旧文件清除。 */
  migrateByOwnerPrefix(oldFile, newFile, prefixes) {
    return migrate.migrateByOwnerPrefix(oldFile, newFile, prefixes);
  }

  /* 登记（固定 / 用户 / 动态） */
  /** 登记固定端口；同端口已被其它固定角色占用则报错；user/动态记录由固定权威覆盖。 */
  register(role, port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.register: 非法端口 ' + port);
    const existing = this._records.get(p);
    if (existing) {
      const existingFixed = String(existing.owner || '').startsWith('system:');
      if (existingFixed && existing.role !== role) throw new Error('端口 ' + p + ' 已被 [' + existing.role + '] 占用，无法登记为 [' + role + ']');
      if (existing.owner && !existingFixed) this._records.delete(p);
    }
    this._records.set(p, { port: p, role, owner: 'system:' + role, createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 登记用户配置端口（实例内部端口等）；冲突（固定/保留池/已占）抛错。 */
  registerUser(port, owner) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.registerUser: 非法端口 ' + port);
    if (this._records.has(p)) throw new Error('端口 ' + p + ' 已被 [' + this._records.get(p).role + '] 占用');
    const reserved = core.reservedPoolOf(this._pools, p);
    if (reserved) throw new Error('端口 ' + p + ' 位于动态保留池 [' + reserved + ']，实例端口不可占用');
    this._records.set(p, { port: p, role: 'user', owner: owner || 'user', createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 按 owner 释放端口（对象删除/关闭时调用）。 */
  unregister(owner) {
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  /** 释放端口：不传 ownerId 按端口号；传了则仅当登记 owner 匹配才释放。
   *  注意空值检查必须在 owner 比较之前（旧实现顺序反了会抛 TypeError）。
   *  @returns {boolean} 是否真的释放了一条记录 */
  release(port, ownerId) {
    const p = Number(port);
    const rec = this._records.get(p);
    if (!rec) return false;
    if (ownerId !== undefined && ownerId !== null && rec.owner !== ownerId) return false;
    this._records.delete(p);
    this._save();
    return true;
  }

  /* 查询 */
  /** 按 role 取端口（固定端口）。 */
  get(role) {
    for (const r of this._records.values()) if (r.role === role) return r.port;
    return null;
  }

  isRegistered(port) { return this._records.has(Number(port)); }

  recordOf(port) { return this._records.get(Number(port)) || null; }

  byOwner(owner) {
    for (const r of this._records.values()) if (r.owner === owner) return r.port;
    return null;
  }

  /** 端口是否被占用：已登记 ∩ 本机实际监听；excludeOwner 仅豁免 registry 登记。 */
  async isTaken(port, excludeOwner) {
    const rec = this._records.get(Number(port));
    if (rec && (!excludeOwner || rec.owner !== excludeOwner)) return true;
    return probe.portListening(port);
  }

  /** 全部端口清单（按端口升序）。 */
  list() {
    return [...this._records.values()].sort((a, b) => a.port - b.port);
  }

  /** 只读聚合：本注册表 + 同目录下其它注册表文件（去重，本表优先）。
   *  @param {string[]} extraFiles 相对本注册表目录的文件名 */
  readAll(extraFiles) {
    const byPort = new Map();
    const adopt = (r) => { if (r && !byPort.has(r.port)) byPort.set(r.port, r); };
    for (const r of this.list()) adopt(r);
    for (const r of store.extraRecords(this._file, extraFiles)) adopt(r);
    return [...byPort.values()];
  }

  /* 确定性槽位仲裁 / 动态分配（委托 PortAllocator） */
  /** 统一绑定持久 + 确定性分配 + 孤儿回收，池满返回显式 conflict。 */
  claimSlot(rangeKey, owner, opts) { return this._alloc.claimSlot(rangeKey, owner, opts); }

  /** 指定逻辑段分配空闲端口并登记（owner 绑定）；池满返回 null。 */
  allocate(rangeKey, owner, opts) { return this._alloc.allocate(rangeKey, owner, opts); }

  /** 显式登记已分配端口（复用持久化端口时调用）。 */
  allocateMark(port, role, owner) {
    const p = Number(port);
    if (!this._records.has(p)) {
      this._records.set(p, { port: p, role: role || 'dynamic', owner: owner || 'dynamic', createdAt: Date.now() });
      this._save();
    }
  }

  /* 容量 */
  /** 池容量视图：每池 { base, size, used, free, utilization }。 */
  capacity() { return core.capacityOf(this._pools, this._records); }

  /** 逻辑段当前可用量。 */
  available(segment) { return core.availableOf(this._pools, this._records, segment); }

  /** 逻辑段是否已满。 */
  isFull(segment) { return this.available(segment) <= 0; }

  /** 全部端口快照（固定/用户/分配）。 */
  snapshotAll() { return core.snapshotOf(this._records); }
}

module.exports = { PortRegistry };
