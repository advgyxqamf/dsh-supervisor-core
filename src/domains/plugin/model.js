'use strict';

const path = require('node:path');

// ═══════════════════════════════════════════════════════════════════════════
// 插件域 —— 领域模型（域：plugin / model，纯）
//
// F1：内置保护名单 + 作业记录形状 + 纯状态迁移。**零 IO、零 this 协作**。
//   · PROTECTED           —— 内置组件名单（禁止卸载/禁用）
//   · createJobRecord     —— 作业记录（install/uninstall/update 统一形状）
//   · finishJobRecord     —— 作业收尾（状态/错误/完成时刻）
//   · planJobCleanup      —— 作业保留上限（超出清理最旧）
//   · taskStateToJobState —— TaskRegistry 状态 → 作业视图状态（单一事实源映射）
// ═══════════════════════════════════════════════════════════════════════════

/** 内置组件：禁止卸载/禁用（bind 进 store/ops 的判定）。 */
const PROTECTED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

/** 作业保留上限（超出清理最旧）。 */
const MAX_JOBS = 50;

/** 新建作业记录：jobId + 每目标子记录（pending/log）。 */
function createJobRecord(kind, name, targetStr, targets) {
  const jobId = 'pj-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  return {
    id: jobId, kind, name, target: targetStr, state: 'running', startedAt: Date.now(), finishedAt: null, error: null,
    targets: targets.map((t) => ({ id: t.id, name: t.name, state: 'pending', log: [] })),
  };
}

/** 作业收尾：状态 + 错误 + 完成时刻（tasks 桥接由作业服务负责）。 */
function finishJobRecord(job, ok, error) {
  job.state = ok ? 'done' : 'failed';
  job.error = error || null;
  job.finishedAt = Date.now();
}

/** 计算超限需清理的 jobId（保留最新 MAX_JOBS 条）。 */
function planJobCleanup(ids, max = MAX_JOBS) {
  if (ids.length <= max) return [];
  return ids.slice(0, ids.length - max);
}

/** TaskRegistry 状态 → 作业视图状态（succeeded/skipped→done；failed/canceled→failed）。 */
function taskStateToJobState(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done'
    : (s === 'failed' || s === 'canceled') ? 'failed'
    : 'running';
}

/** 内置组件判定（读 PROTECTED）。 */
function isProtectedName(name) { return PROTECTED.has(name); }

/** 补丁行是否属于本插件（id 命中）。 */
function isOwnRow(e, ids) {
  return e && typeof e === 'object' && typeof e.id === 'string' && ids.includes(e.id);
}

/** 补丁行是否为本插件的 disabled 行。 */
function isOwnDisabled(e, ids) {
  return isOwnRow(e, ids) && e.disabled === true;
}

/** 从模块说明符推断所属包名；cordis: 前缀为内置无主。 */
function ownerPackage(moduleName, bundles) {
  if (!moduleName || String(moduleName).startsWith('cordis:')) return null;
  for (const b of bundles) if (String(moduleName).includes(b)) return b;
  return null;
}

/** 目标 home 补丁层路径（DSH_HOME/cordis.patch.yml，由 profileDir 上溯两级）。 */
function targetHomePatchPath(target) {
  return path.resolve(path.dirname(path.dirname(target.profileDir)), 'cordis.patch.yml');
}

module.exports = {
  PROTECTED, MAX_JOBS, createJobRecord, finishJobRecord, planJobCleanup, taskStateToJobState,
  isProtectedName, isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath,
};
