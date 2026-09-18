'use strict';

// app/control/managed-object.js —— 受管对象目录的纯模型（词表 + entry + 所有权）。
//
// registry.js 仍定义并导出 PHASES（其字面量唯一源必须在 registry.js），
// 并 re-export 本模块的 createEntry/kindMeta 等，公开导出面保持不变。
// 本模块零 IO、零 this，可 require 后独立单测。

/** desired 唯一取值：用户意图（running=应保持运行 / stopped=应停止）。与 guardian（自动拉起策略）正交。 */
const DESIRED = ['running', 'stopped'];

/** 受管对象类型表（显式、稳定；不造通用 CRD）。future 扩展经 registerKind 声明能力。 */
const MANAGED_KINDS = {
  dsh:              { label: '原生 DSH',       startable: true, guardable: true },
  'sandbox-instance': { label: '沙箱实例',     startable: true, guardable: true },
  'router-daemon':  { label: '智能路由 daemon', startable: true, guardable: true },
  'lan-daemon':     { label: '远程控制 daemon', startable: true, guardable: true },
  plugin:           { label: '插件（聚合）',    startable: false, guardable: false },
};

let _customKinds = {};

function kindMeta(kind) {
  return MANAGED_KINDS[kind] || _customKinds[kind] || null;
}

/** 注册新类型能力（未来扩展；显式声明，非 CRD）。 */
function registerKind(kind, meta) {
  _customKinds[kind] = Object.assign({ label: kind, startable: false, guardable: false }, meta || {});
}

/** 域 A（用户意图域）的 kind 清单——只有它们才持有 `guardian` 字段。
 *
 *  契约 GUARD-DOMAIN-MODEL §2/§3 G-1：
 *   - 域 A = dsh / sandbox-instance：有用户意图轴（desired × guardian），
 *     guardian 表示崩溃时是否按用户意图自愈；
 *   - 域 B = router-daemon / lan-daemon（基础设施）：无用户意图轴，由保活路径无条件拉起，
 *     故根本不物化该字段（不是「置 false」，而是「不存在」——契约 §5 GD-1 的字面要求）。
 *
 *  判据必须落在入口（createEntry/load/save/update）而非申报处：申报处只是「不写」，
 *  但 createEntry 会对所有 kind 无条件物化该字段并随目录持久化，旧版本残留的
 *  `guardian: true` 便永远清不掉（update 见 `p.guardian === undefined` 即跳过）。 */
const DOMAIN_A_KINDS = new Set(['dsh', 'sandbox-instance']);

/** 该 kind 是否属域 A（只有域 A 才有 guardian 字段）。 */
function isDomainA(kind) { return DOMAIN_A_KINDS.has(kind); }

/**
 * 受管对象目录项（应然 + 所有权；phase 由调谐驱动，观测不入册）。
 * @param {object} o { kind, id, name, ownership? }
 */
function createEntry(o) {
  const meta = kindMeta(o.kind);
  if (!meta) throw new Error('未知受管对象类型: ' + o.kind + '（先 registerKind 声明）');
  if (!o.id || typeof o.id !== 'string') throw new Error('注册项缺少 id');
  return {
    kind: o.kind,
    id: o.id,
    name: String(o.name || o.id),
    // 应然（业务申报 / 用户操作；唯一持久意图）
    //   desired：两域共用同一字段名，但语义不同——
    //     域 A = 用户意图；域 B = 「当前业务是否需要它」的条件（契约 §2）。
    desired: (o.desired === 'stopped') ? 'stopped' : 'running',
    // guardian：域 A 专有字段（契约 §2/§3 G-1）。域 B 基础设施不物化它——
    //   不是「置 false」，是「不存在」，这样旧残留才清得掉。
    ...(isDomainA(o.kind) ? { guardian: o.guardian === true } : {}),
    // 所有权（注册时申报；持久）
    ownership: normalizeOwnership(o.ownership),
    // phase（调谐循环 R3 驱动；初始 stopped。业务不得直接改）
    phase: 'stopped',
    // 观测缓存（实然；不持久化，由 heartbeat/adapter 写入）
    lastObserved: null, // { ok, error, at }
    // 进程句柄/运行期引用（C3-3b G2：main 状态机句柄挂目录，不持久化——
    // 形如 { child?, adoptedPid?, adopted, observedOnly, startDeadline?, spawnBlockedUntil? }）
    process: null,
    // 域摘要引用（R4：daemon 类黑盒经 ctl 向目录呈报的紧凑摘要，只存引用/只读缓存，不持久化；
    // 形如 { runState, providers, accounts, proxyInstances, resourcePorts, fetchedAt }）
    domainSummary: null,
    // 退避（调谐用；崩溃窗口）随目录持久化（见 _load/_save）。
    backoffLevel: 0,
    backoffUntil: null,
    crashWindowStart: null,
    crashWindowRestarts: 0,
    restartCount: 0,
    startedAt: null,
    lastTransitionAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOwnership(own) {
  const o = own || {};
  const ports = Array.isArray(o.ports) ? o.ports
    .filter((p) => p && Number.isInteger(Number(p.port)) && p.port > 0)
    .map((p) => ({ role: String(p.role || 'default'), port: Number(p.port) })) : [];
  return {
    ports,
    rootPath: o.rootPath ? String(o.rootPath) : null,
    unit: o.unit ? String(o.unit) : null,
    daemonScript: o.daemonScript ? String(o.daemonScript) : null,
    processMode: ['spawn', 'systemd', 'daemon', 'adopted'].includes(o.processMode) ? o.processMode : null,
    meta: (o.meta && typeof o.meta === 'object') ? Object.assign({}, o.meta) : null, // 域备注（只读参考）
  };
}

module.exports = { DESIRED, MANAGED_KINDS, kindMeta, registerKind, isDomainA, createEntry, normalizeOwnership };
