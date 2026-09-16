'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// shell 域 —— 纯核心（域内依赖图的**汇点**，零出度）
//
// 依 DOMAIN-STRUCTURE-DESIGN §5.5 / design-notes/shell.md §C.2：
//   把 shell 域**全部无 IO 的判定/谓词/解析**收敛到本文件，与所有有副作用的
//   实现文件（journal/restart/watchdog）分离。本文件**不引入任何模块**，
//   是域内依赖图唯一的汇点（其它文件 → core，而 core 无出边）→ DF-7 单向、DF-5 无环。
//
// 逐条来源（纯搬迁，零行为改动）：
//   · DEFAULTS        ← 原 watchdog.js 的模块级常量（纯配置）
//   · isShellProcess  ← 原 watchdog.js（纯谓词：谁是桌面壳主程序）
//   · decide          ← 原 watchdog.js（纯决策，穷举可单测）
//   · exeFromCmdline  ← 原 restart.js（纯解析：cmdline 首段 → exe）
// 新增（同族纯函数，消除既有重复/补足可测性）：
//   · isUpdatePhase   ← 提取原 watchdog.js 两处逐字重复的相位谓词，单一事实源
//   · deriveState     ← 提取原 journal.evaluate 的纯内核（入参即 id/journal 两个快照），
//                        使该状态机可在无文件系统、无进程的前提下用假快照直测（DF-6）
//
// 纪律：本文件不得出现 模块引入 / fs. / spawn( / process.kill / setInterval /
//   Date.now / Math.random —— 否则 DF-3（纯/IO 分离）与 DF-7（汇点）即破。
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  enabled: true,
  intervalMs: 20000,        // 检查周期
  graceMs: 90000,           // 壳缺失多久才动作（避让自更新/自重启空窗）
  updateGraceMs: 300000,    // 壳正处于更新/重启预期态时的宽限（5 分钟）
  maxRestarts: 5,           // 窗口内拉起次数上限
  windowMs: 1800000,        // 30 分钟窗口
  // P2 修复：identity.phase 的**时效上限**——超过这个时长未更新，视为陈旧（壳已崩），
  //  不再当作「预期缺席」，让看护按正常宽限期介入。取值需 > 正常更新耗时（含下载+校验+重启）。
  phaseMaxAgeMs: 600000,    // 10 分钟
  procPattern: 'dsh-supervisor-gui',
};

/** 判定一个进程是否**桌面壳主程序**（而非本仓的无头自检进程）。 */
function isShellProcess(proc) {
  const c = String((proc && proc.cmdline) || '');
  // 无头自检入口会同时匹配进程名，必须排除 —— 否则看护会把自检当成壳。
  if (/--shell-update-plan|--core-plan|--node-plan|--mirror-plan|--env-plan|--service-plan/.test(c)) return false;
  return /dsh-supervisor-gui(\.exe)?/.test(c);
}

/**
 * 纯决策函数（不碰进程/时钟/文件系统 —— 便于穷举单测）。
 *
 * @param {object} i
 *   - alive            壳进程数（>0 视为存活）
 *   - absentForMs      已连续缺失多久（alive=false 时有效；null = 首次发现缺失）
 *   - expectedAbsence  壳是否处于「预期缺席」（自更新/重启中/更新待确认）
 *   - sessionAvailable 当前是否有图形会话
 *   - restartsInWindow 窗口内已拉起次数
 *   - hasExe           能否定位壳可执行文件
 *   - config           { graceMs, updateGraceMs, maxRestarts }
 * @returns {{action:'alive'|'record'|'wait'|'skip'|'restart', reason:string, needMs?:number}}
 */
function decide(i) {
  const c = i.config || {};
  if (i.alive > 0) return { action: 'alive', reason: '壳在运行' };
  if (i.absentForMs === null || i.absentForMs === undefined) {
    return { action: 'record', reason: '首次观察到壳缺失，开始计时' };
  }
  const needMs = i.expectedAbsence
    ? (c.updateGraceMs || DEFAULTS.updateGraceMs)
    : (c.graceMs || DEFAULTS.graceMs);
  if (i.absentForMs < needMs) {
    return { action: 'wait', reason: i.expectedAbsence ? '壳处于预期缺席（更新/重启）' : '未达宽限期', needMs };
  }
  if (!i.sessionAvailable) {
    return { action: 'skip', reason: '无图形会话（注销/纯终端），拉起 GUI 必失败' };
  }
  if ((i.restartsInWindow || 0) >= (c.maxRestarts || DEFAULTS.maxRestarts)) {
    return { action: 'skip', reason: '窗口内拉起次数已达上限，停止重试（防风暴）' };
  }
  if (!i.hasExe) {
    return { action: 'skip', reason: '无法定位壳可执行文件（identity.json 未记录 exe）' };
  }
  return { action: 'restart', reason: '壳缺失且已过宽限期', needMs };
}

/** 壳是否处于「更新中」相位（自更新/重启）—— 单一事实源，消除看护内两处重复判定。 */
function isUpdatePhase(phase) {
  const p = String(phase || '');
  return p === 'restarting' || p.indexOf('shell-update') === 0;
}

/** 解析进程命令行首段为可执行路径（处理 Windows 含空格的引号路径）。 */
function exeFromCmdline(cmdline) {
  const s = String(cmdline || '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  return s.split(/\s+/)[0] || null;
}

/** 更新账本状态机（纯内核）：由 (壳身份, 更新账本) 两个快照推导当前状态。
 *
 *  返回 { state, reason, ... }：
 *    'idle'       无进行中的更新
 *    'pending'    更新已安装，等待壳下次启动确认
 *    'confirmed'  壳已成功运行新版本（健康确认）
 *
 *  约定：**没有**回退判定 —— 壳的更新强制且不可回退（不得回退、不得跳过）。
 *  本判定只描述事实，不产生任何副作用；**落盘由调用方（evaluate）按 state 显式执行**。
 *  不修改入参：确认分支返回**新**账本对象（confirmed=true），旧对象保持只读语义。
 *
 *  @param {object|null} id      壳身份快照（version / phase / exe / lastSeenAt …）
 *  @param {object|null} journal 更新账本快照（to / confirmed / from / startedAt …）
 */
function deriveState(id, journal) {
  const j = journal || {};
  if (!j.to) return { state: 'idle', reason: '无进行中的更新', journal: j, identity: id };

  const cur = id && id.version ? String(id.version) : null;

  // 情形 1：壳已运行到目标版本 → 确认成功（账本翻转由 evaluate 落盘）
  if (cur && cur === j.to && id && id.phase === 'ready') {
    const next = j.confirmed === true ? j : Object.assign({}, j, { confirmed: true });
    return { state: 'confirmed', version: cur, reason: '壳已健康运行新版本', journal: next, identity: id };
  }

  // 其余情况：等待壳重启到目标版本并就绪。
  //  壳的更新**强制且不可回退**，此处只描述事实，不产生任何回退动作。
  return {
    state: 'pending',
    target: j.to, current: cur,
    reason: cur === j.to ? '等待壳上报就绪' : '等待壳重启到新版本',
    journal: j, identity: id,
  };
}

module.exports = { DEFAULTS, isShellProcess, decide, isUpdatePhase, exeFromCmdline, deriveState };
