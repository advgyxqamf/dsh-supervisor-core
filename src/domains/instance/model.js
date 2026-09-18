'use strict';

// 领域模型：实例记录形状与迁移、视图行组装、任务状态词表。纯函数，零 IO、零隐式 this。
// 视图行的 IO 结果（已安装版本/最新版本/作业视图/探测结果）由调用方解析后传入。

const { semverCompare } = require('../../shared/version');

/** 任务状态映射到前端契约（前端轮询判定 done/failed；TaskRegistry 状态为 succeeded/skipped/canceled）。
 *  ⚠ 有意平行（P4-A-2 #30）：本函数与 domains/plugin/model.js 的 `taskStateToJobState`、
 *   domains/router/ops/apps-registry.js 的 `proxyUpdateStatus` 内联同映射是三份平行实现；
 *   三者映射分支完全一致（succeeded/skipped→done，failed/canceled→failed，余→running）。
 *   差异只在宿主投影：plugin 侧产出作业视图的 state 字段；apps-registry 侧内联，且紧邻另算
 *   errors = t.state === 'failed' ? 1 : 0（故 canceled 映射成 failed 而 errors 为 0）。
 *   有意平行而非抽公共函数：三处分属 instance/plugin/router 三域，抽取须三处同批改动；本批只加注释、不改行为。
 *   定位请按**符号名**（三处行号随注释增删漂移，写死行号会变成下一条失效引用）。 */
function taskStateToView(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
}

/** 磁盘文档实例记录映射到运行时记录（纯迁移，不落盘）。
 *  - 令牌收敛：历史遗留的 dshToken 列一律剔除（内存即刻断行，下次 save 落盘即清）；
 *  - guardian 缺省为关；
 *  - 重启后 FAILED 一律重置为「停止」（失败是一次性状态）。
 *  说明：令牌**源登记**（tokens.attach）是 IO，留在 store.load()，不进本函数。 */
function normalizeInstance(inst) {
  if (Object.prototype.hasOwnProperty.call(inst, 'dshToken')) delete inst.dshToken;
  if (inst.guardian === undefined) inst.guardian = false;
  if (inst.state && inst.state.phase === 'FAILED') {
    inst.state.phase = 'STOPPED';
    inst.state.lastError = null;
  }
  if (inst.state) inst.state.phase = inst.state.phase || 'STOPPED';
  return inst;
}

/** 新增实例记录（payload 规范化）。端口合法性/占用探测等编排在 ops.js。 */
function createRecord(payload, id) {
  const port = parseInt(payload.port, 10);
  return {
    id,
    name: String(payload.name || ('实例:' + port)).slice(0, 40),
    port,
    // 新增实例：默认沙箱域（绝对隔离、与原生/彼此互不干扰）
    domain: 'sandbox',
    kind: 'sandbox',
    autoRegistered: false,
    createdBy: 'user',
    command: Array.isArray(payload.command) ? payload.command : [],
    guardian: !!payload.guardian, // 进程守护(自动拉起)开关默认关（架构红线：未显式开启绝不自动拉起）
    remoteEnabled: !!payload.remoteEnabled,
    remoteToken: String(payload.remoteToken || ''),
    unitName: 'dsh-web@' + id,
    sandbox: {
      privateTmp: true,
      // node/dsh 位于 /home（nvm），ProtectHome=yes 会使其 exec 失败(203/EXEC)；默认关闭，可用 payload.protectHome 覆盖
      protectHome: payload.protectHome === undefined ? false : !!payload.protectHome,
      memoryMax: String(payload.memoryMax || '4G'),
      cpuQuota: String(payload.cpuQuota || '150%'),
    },
    state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null },
    createdAt: new Date().toISOString(),
  };
}

/** 单实例映射到前端契约行（纯）。resolved = { version, latest, updateJob, probe } 均为调用方解析好的 IO 结果。 */
function viewRow(inst, resolved) {
  const version = resolved.version;
  const latest = resolved.latest;
  return {
    id: inst.id,
    name: inst.name,
    port: inst.port,
    domain: inst.domain || 'native',
    kind: inst.kind || inst.domain || 'native',
    guardian: inst.guardian,
    remoteEnabled: inst.remoteEnabled,
    unitName: inst.unitName,
    sandbox: inst.sandbox,
    // 沙箱实例版本与更新（每实例独立 DSH 安装；native 无独立安装，返回 null 不显示）
    version,
    latest,
    updateAvailable: !!(latest && version && semverCompare(latest, version) > 0),
    updateJob: resolved.updateJob,
    state: Object.assign({}, resolved.probe, {
      // 沙箱生命周期（可观测）：lifecyclePhase 为内部状态机相位，lastError 暴露失败原因
      lifecyclePhase: inst.state ? inst.state.phase : 'STOPPED',
      lastError: inst.state ? inst.state.lastError : null,
      // 稳定性统计（与原生卡一致）：重启次数 / 最近故障原因（BACKOFF/FAILED 由状态机记录）
      restartCount: inst.state ? (inst.state.restartCount || 0) : 0,
      lastFailure: inst.state ? (inst.state.lastFailure || null) : null,
      installing: inst.state && inst.state.phase === 'INSTALLING',
      installOk: inst.state ? inst.state.installOk : undefined,
      installError: inst.state ? inst.state.installError : undefined,
      installLog: inst.state ? (inst.state.installLog || []) : [],
    }),
  };
}

module.exports = { taskStateToView, normalizeInstance, createRecord, viewRow };
