'use strict';

const stateRoot = require('../../platform/service/state-root');

// ═══════════════════════════════════════════════════════════════════════════
// 壳更新安全网 —— 更新账本 / 状态机 / 健康上报（域：shell / journal）
//
// 为什么拆出本文件（DIRECTORY-STRUCTURE-DESIGN §4.5 域内结构规范）：
//   shell 域原有单一 index.js 混合了两类职责——「账本读写 + 状态判定」与
//   「版本检测 + 壳重启（有 IO/进程副作用）」。本文件承载前者：它是**纯状态 +
//   本地 JSON 读写**，不 spawn 进程、不查网，故可独立审查与单测。
//   门面 index.js 只做组合与导出，导出面**逐字不变**（supervisor.js:28 依赖它）。
//
// 设计定位（必须理解清楚，避免越界）：
//   **内核不是壳的更新源**（冷启动时内核可能不在）。壳直连 npm CDN 自更新。
//   内核做的是**观察与审计**：读壳身份 + 更新账本，汇总状态供面板/CLI 查询。
//   ⚠ 2026-09-16 校正：注释原写「预取 / 备份 / 有界回退」，但该机制**已于 2026-09-15 整体移除**
//     （见 evaluate() 下方说明）——现**无预取、无缓存、无回退**，只剩 pending→confirmed 状态机。
//
// 为什么由内核做：
//   壳不受监督（无 systemd 单元，崩溃无人拉起），而内核是 `Restart=always` 的常驻服务。
//   壳被更新坏掉时内核**很可能仍在运行** —— 它是唯一有能力把壳救回来的角色。
//
// ⛔ 硬约束（用户明确要求，D6）：**绝不触碰内核既有更新机制**。
//   本域只读壳的产物/版本，绝不调用 runNpmInstall、绝不写任何内核版本状态。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
// 纯判定内核（deriveState）下沉 core.js —— evaluate 降为「读快照 → 委托纯内核 → 按需落盘」，
//   使状态机可用假快照直测（DF-6），且文件内不再混放纯决策。
const { deriveState } = require('./core');

// ── 状态目录（与内核状态目录物理隔离，且独立于 DSH 的 ~/.dsh）──
// 内核：<状态根>/supervisor/    壳：<状态根>/shell/（单一事实源 = platform/service/state-root.js）
// EXEC3/DF-8：state-root.root() 每次调用现读 DSH_SUPERVISOR_HOME，
//   故顶层 require 不固化路径；原「函数内 require」注释的前提不成立，已上提。
function shellDir() {
  return stateRoot.shellDir();
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ── 壳身份（壳在启动最早期写入；内核只读）──
// 读取 version / phase / exe / lastSeenAt 等运行时字段；护栏/回退字段已废除。
function identity() {
  return readJson(path.join(shellDir(), 'identity.json'));
}

// ── 更新账本（内核维护，权威）──
function journalPath() { return path.join(shellDir(), 'update-journal.json'); }
function readJournal() {
  return readJson(journalPath()) || {
    from: null, to: null, confirmed: false,
    startedAt: null, lastAttemptAt: null,
  };
}
function writeJournal(j) { writeJson(journalPath(), j); }

/** 记录一次「壳更新已安装、待重启生效」。由壳侧上报（POST /shell/update-pending）或内核观察得到。*/
function markPending(from, to) {
  const j = readJournal();
  j.from = from || j.from;
  j.to = to;
  j.confirmed = false;
  j.startedAt = new Date().toISOString();
  writeJournal(j);
  return j;
}

/** 核心判定：根据壳身份与账本，汇总当前壳的更新状态。
 *  返回 { state, reason, ... }：
 *    'idle'       无进行中的更新
 *    'pending'    更新已安装，等待壳下次启动确认
 *    'confirmed'  壳已成功运行新版本（健康确认）
 *
 *  约定：**没有**回退判定 —— 壳的更新强制且不可回退（不得回退、不得跳过）。
 *  本判定只描述事实，不产生任何回退动作；回退功能已整体移除。
 */
function evaluate() {
  const id = identity();
  const j = readJournal();
  // 纯判定委托 core.deriveState（入参即两个快照，不碰 IO）。
  const view = deriveState(id, j);
  // 显式副作用：仅当纯内核把账本从「未确认」翻转为「已确认」时落盘。
  //   语义与旧实现逐字一致：强制更新、无回退；本判定只描述事实。
  if (view.state === 'confirmed' && j.confirmed !== true) writeJournal(view.journal);
  return view;
}

// 回退功能已按硬规则整体移除：壳的更新强制且不可回退、不得跳过。

/** 仅回环可用的健康上报（壳调用）。
 *  phase=ready 即「壳已健康启动」= 更新确认信号。
 */
function health(payload) {
  const p = payload || {};
  const dir = shellDir();
  fs.mkdirSync(dir, { recursive: true });
  // 更新 identity.json 的 phase / version / lastSeenAt（壳自己也会写；这里兜底，
  // 确保内核能观察到一致状态——本域 evaluate() 正依赖它们）。
  //
  // 本函数只写**运行时**字段（phase/version/lastSeenAt），供内核侧观察与排障；
  //   identity.json 的护栏/回退字段已废除，写入方只有壳（单一写入点）。
  const idp = path.join(dir, 'identity.json');
  const id = readJson(idp) || {};
  if (p.phase) id.phase = String(p.phase);
  if (p.version) id.version = String(p.version);
  id.lastSeenAt = new Date().toISOString();
  writeJson(idp, id);

  const ev = evaluate();
  return { ok: true, phase: id.phase || null, state: ev.state, target: ev.target || null };
}

/** 汇总状态（供面板与 CLI）。*/
function status() {
  const id = identity();
  const ev = evaluate();
  const j = readJournal();
  return {
    identity: id,
    journal: j,
    state: ev.state,
    reason: ev.reason || null,
    dir: shellDir(),
  };
}

module.exports = { shellDir, identity, readJournal, writeJournal, markPending, evaluate, health, status };
