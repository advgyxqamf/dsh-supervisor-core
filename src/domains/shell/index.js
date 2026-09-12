'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 壳更新安全网（域：shell）—— 2026-09-11
//
// 设计定位（必须理解清楚，避免越界）：
//   **内核不是壳的更新源**（冷启动时内核可能不在）。壳直连 npm CDN 自更新。
//   内核做的是**安全网**：预取 / 备份 / 观察 / 有界回退 / 审计。
//
// 为什么由内核做：
//   壳不受监督（无 systemd 单元，崩溃无人拉起），而内核是 `Restart=always` 的常驻服务。
//   壳被更新坏掉时内核**很可能仍在运行** —— 它是唯一有能力把壳救回来的角色。
//
// ⛔ 硬约束（用户明确要求，D6）：**绝不触碰内核既有更新机制**。
//   本域只读壳的产物/版本，绝不调用 runNpmInstall、绝不写任何内核版本状态。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// 版本比较复用内核**同一份**实现（dist 模块导出），避免两处 semver 语义分叉。
const { semverCompare } = require('../dist/index');

// ── 状态目录（与内核状态目录物理隔离）──
// 内核：~/.dsh/supervisor/    壳：~/.dsh/shell/
function shellDir() {
  return path.join(os.homedir(), '.dsh', 'shell');
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
// 关键字段 `attempt`：壳每次启动自增，使内核能在**壳完全起不来（连日志都没有）**时
// 也判断出「该版本反复失败」——这是回退决策的核心输入。
function identity() {
  return readJson(path.join(shellDir(), 'identity.json'));
}

// ── 更新账本（内核维护，权威）──
function journalPath() { return path.join(shellDir(), 'update-journal.json'); }
function readJournal() {
  return readJson(journalPath()) || {
    from: null, to: null, attempts: 0, maxAttempts: 2,
    confirmed: false, rolledBack: false, pinnedVersions: [],
    startedAt: null, lastAttemptAt: null,
  };
}
function writeJournal(j) { writeJson(journalPath(), j); }

/** 记录一次「壳更新已安装、待重启生效」。由壳侧上报（POST /shell/update-pending）或内核观察得到。*/
function markPending(from, to) {
  const j = readJournal();
  j.from = from || j.from;
  j.to = to;
  j.attempts = 0;
  j.confirmed = false;
  j.rolledBack = false;
  j.startedAt = new Date().toISOString();
  writeJournal(j);
  return j;
}

/** 核心决策：根据壳身份与账本，判断当前壳的更新状态。
 *  返回 { state, action, reason, ... }：
 *    'idle'          无进行中的更新
 *    'pending'       更新已安装，等待壳下次启动确认
 *    'confirmed'     壳已成功运行新版本（健康确认）
 *    'should-rollback' 判定为坏版本，应回退（内核据此动作）
 *
 *  ⚠ 2026-09-12 事实说明（审计 P0，**未修改逻辑，仅如实记录现状**）：
 *
 *    本判定链的**输入**在当前双仓实现下无法被填充，故 `evaluate()` 实际恒返回 `idle`：
 *      · `journal.to` 只能由 `markPending()` 设置；其唯一非测试调用方是
 *        `POST /shell/update-pending`（api/shell.js）；
 *      · 而壳仓（Tauri）**从不 POST 该端点**（grep 零命中）—— 壳用自己的一套：
 *        本地命令 `shell_set_phase`（update.rs::set_phase）+ 独立账本
 *        `~/.dsh/shell/update-guard.json`，与内核的 `update-journal.json` **不是同一份**；
 *      · 同理壳也从不 POST `/shell/health`，故 `id.phase === 'ready'` 的确认路径也不会被触发。
 *
 *    即：`should-rollback` / `confirmed` 两个状态在当前实现下**不可达**，
 *    回退能力实际由**壳自己的护栏**（update-guard + 冷却）承担。
 *
 *    ⚠ 刻意**不删除**本模块：它是「内核侧安全网」的设计落点，
 *      且 `watchdog.expectedAbsence()` 会读 `journal.to`（`markPending` 一旦被接线即生效）；
 *      删除会连带移除既有的状态机与测试。但**必须**让读者知道现状 ——
 *      否则会像 `api/surface.js` 那样把「壳(阶段上报/健康确认)」写成既成事实。
 */
function evaluate() {
  const id = identity();
  const j = readJournal();
  if (!j.to) return { state: 'idle', reason: '无进行中的更新', journal: j, identity: id };

  const cur = id && id.version ? String(id.version) : null;

  // 情形 1：壳已运行到目标版本 → 确认成功，清账本
  if (cur && cur === j.to && id && id.phase === 'ready') {
    if (!j.confirmed) {
      j.confirmed = true;
      j.attempts = 0;
      writeJournal(j);
    }
    return { state: 'confirmed', version: cur, reason: '壳已健康运行新版本', journal: j, identity: id };
  }

  // 情形 2：壳在跑，但不是目标版本 → 更新未生效（回退过 / 安装未替换）
  // 用壳的 attempt 计数（壳每次启动自增）作为「失败次数」的权威来源。
  const attempt = (id && typeof id.attempt === 'number') ? id.attempt : 0;
  if (cur && cur !== j.to && attempt >= (j.maxAttempts || 2)) {
    return {
      state: 'should-rollback',
      target: j.to, current: cur, attempts: attempt,
      reason: `壳 ${attempt} 次未能在 ${j.to} 上就绪（当前 ${cur}）`,
      journal: j, identity: id,
    };
  }

  return {
    state: 'pending',
    target: j.to, current: cur, attempts: attempt,
    reason: cur === j.to ? '等待壳上报就绪' : '等待壳重启到新版本',
    journal: j, identity: id,
  };
}

/** 回退：把坏版本拉黑，并记录回退意图。
 *  ⚠ 内核**不直接替换壳二进制**（那是壳/平台安装器的职责），而是：
 *    1) 把坏版本加入 pinnedVersions（壳门 0 读取后不会再用它）；
 *    2) 清空待确认账本，避免反复判定；
 *    3) 写事件供审计与面板展示。
 */
function rollback(reason) {
  const j = readJournal();
  const bad = j.to;
  if (bad && !j.pinnedVersions.includes(bad)) j.pinnedVersions.push(bad);
  j.rolledBack = true;
  j.confirmed = false;
  j.attempts = 0;
  j.to = null;
  j.lastAttemptAt = new Date().toISOString();
  writeJournal(j);
  return { ok: true, pinned: bad, reason: reason || null, journal: j };
}

/** 仅回环可用的健康上报（壳调用）。
 *  phase=ready 即「壳已健康启动」= 更新确认信号。
 */
function health(payload) {
  const p = payload || {};
  const dir = shellDir();
  fs.mkdirSync(dir, { recursive: true });
  // 更新 identity.json 的 phase（壳自己也会写；这里兜底，确保内核观察到一致状态）
  const idp = path.join(dir, 'identity.json');
  const id = readJson(idp) || {};
  if (p.phase) id.phase = String(p.phase);
  if (p.version) id.version = String(p.version);
  if (typeof p.attempt === 'number') id.attempt = p.attempt;
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
    pinned: j.pinnedVersions || [],
    dir: shellDir(),
  };
}


/** 壳发布包名（清单包；其版本与各平台产物包一致）。
 *  **为什么用清单包**：壳的产物按平台分包（shell-linux-x64 / darwin-arm64 / win-x64 …），
 *  但版本始终一致；查清单包即可得到「最新壳版本」，无需在本机判断平台。 */
const SHELL_RELEASE_PKG = '@dsh-sup/shell-release';

/** 检测壳是否有新版本（与内核自更新同源：npm registry + 镜像回退）。
 *  @param {object} dist DistributionManager（含 fetchLatestVersion）
 *  @param {object} opts { authoritative }
 *  @returns {Promise<{ok:boolean, installed:string|null, latest:string|null, updateAvailable:boolean, error?:string}>}
 *
 *  说明：内核**不是**壳的更新源（壳直连 npm CDN 自更新）；此处只做**版本检测**，
 *  供面板与「内核 + 桌面壳一起检测」的产品语义使用。
 */
async function checkUpdate(dist, opts) {
  const id = identity();
  const installed = (id && id.version) ? String(id.version) : null;
  if (!dist || typeof dist.fetchLatestVersion !== 'function') {
    return { ok: false, installed, latest: null, updateAvailable: false, error: '分发服务未初始化' };
  }
  try {
    const latest = await dist.fetchLatestVersion(SHELL_RELEASE_PKG, 'npm', { authoritative: (opts && opts.authoritative) === true });
    if (!latest) {
      return { ok: false, installed, latest: null, updateAvailable: false, error: '未查询到壳发布版本（可能尚未发布）' };
    }
    // 版本比较：复用内核同一份 semverCompare（避免两处语义分叉）
    const updateAvailable = Boolean(installed && semverCompare(latest, installed) > 0);
    return { ok: true, installed, latest, updateAvailable };
  } catch (e) {
    return { ok: false, installed, latest: null, updateAvailable: false, error: (e && e.message) || String(e) };
  }
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

/** 重启桌面壳（用于应用壳更新）。
 *
 *  **为什么需要它**：壳的自更新发生在**壳启动时**（门 0：查清单 → 下载 → 验签 → 安装 → 重启）。
 *  因此「让壳用上新版本」= 让壳重新启动一次。本函数完成这件事，并把门 0 交给新壳。
 *
 *  安全设计：
 *   · **必须先等旧壳真正退出**再拉起新壳——壳装了 single-instance 插件，
 *     旧实例仍在时新实例会「唤起旧窗口后自行退出」，等于没重启。
 *   · SIGTERM → 有界等待 → 必要时 SIGKILL → 再等待（都不成功则明确失败，不静默）。
 *   · 新壳 detached + stdio ignore + unref：不成为内核的子进程负担，内核退出也不带走它。
 *
 *  @returns {Promise<{ok:boolean, restarted?:boolean, killed?:number[], pid?:number, error?:string}>}
 */
async function restartShell(opts) {
  const o = opts || {};
  const { spawn } = require('node:child_process');
  const pidlook = require('../../platform/os/pidlookup');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 进程匹配名可配置：主要照顾「自定义安装名」的场景，同时让测试可注入一个不存在的名字，
  // 避免单元测试误杀开发者本机真实运行的壳进程。
  const pattern = o.procPattern || 'dsh-supervisor-gui';
  let procs = [];
  try { procs = pidlook.pgrepList(pattern) || []; } catch { procs = []; }
  // 过滤掉明显不是壳主程序的匹配（例如本模块的 --shell-update-plan 自检进程）
  procs = procs.filter((p) => {
    const c = String(p.cmdline || '');
    if (/--shell-update-plan|--core-plan|--node-plan/.test(c)) return false;
    return /dsh-supervisor-gui(\.exe)?/.test(c);
  });

  const exe = procs.length ? exeFromCmdline(procs[0].cmdline) : (o.exePath || null);
  if (!exe) return { ok: false, error: '无法定位桌面壳可执行文件（壳未运行且未提供 exePath）' };

  const killed = [];
  for (const p of procs) {
    try { process.kill(p.pid, 'SIGTERM'); killed.push(p.pid); } catch { /* 已退出 */ }
  }

  // 有界等待旧壳退出（最多 ~6s），随后 SIGKILL 兜底再等（~2s）
  const waitGone = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const alive = procs.some((p) => { try { return pidlook.isAlive(p.pid); } catch { return false; } });
      if (!alive) return true;
      await sleep(200);
    }
    return !procs.some((p) => { try { return pidlook.isAlive(p.pid); } catch { return false; } });
  };
  let gone = await waitGone(o.graceMs || 6000);
  if (!gone) {
    for (const p of procs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* 忽略 */ } }
    gone = await waitGone(2000);
  }
  if (!gone) {
    return { ok: false, error: '旧壳进程未能在超时内退出，已放弃重启（避免双实例）', killed };
  }

  // 拉起新壳（门 0 将在其启动时执行：检测 → 下载 → 验签 → 安装 → 重启进新版）
  //
  // ⚠ P0-1 修复（2026-09-12）：**必须监听 `'error'`，且不能在 spawn 返回时就报成功**。
  //
  //   缺陷：原实现 `try { spawn(...); child.unref(); return {ok:true,restarted:true} }` ——
  //    而 Node 的 `spawn` 对**不存在的可执行文件不抛同步错**，只发异步 `'error'`
  //    （实测：`syncThrew=无 / child.pid=undefined / uncaughtException=ENOENT`）。
  //    该 child 无 `'error'` 监听 → 异常逃逸为**进程级 uncaughtException** →
  //    而 `bin/dsh-supervisor` 对「60s 内 3 次未捕获异常」会**自杀**（交给 systemd 拉起）。
  //    同时 `watchdog.js` 收到 `ok:true` 就写「已拉起」事件并把 `missingSince` 清零 →
  //    **假成功 + 每 90s 一拍的慢速风暴**，直到 5 次/30min 上限才罢休。
  //
  //   修法：a) 监听 `'error'`，把失败**如实回报**并让调用方（watchdog）保留下次重试；
  //         b) `spawn` 返回后先看 `child.pid`（未定义即失败）—— 这是同步可判的；
  //         c) `'error'` 可能晚于返回（ENOENT 是下一 tick），故同时提供**异步确认**：
  //            返回的 pid 已同步校验；后续 error 只记事件，不再逃逸。
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env: process.env });
    // 异步 error 必须被接住（否则逃逸为 uncaughtException → 守卫自杀）。
    //   注：此刻已无法回滚「壳没起来」这一事实（spawn 已返回），
    //   但如实记事件让 watchdog/面板可见，且不再让异常逃逸。
    child.on('error', (e) => {
      // 注：本模块无 logger 依赖（见下方记账注释），事件经 opts.events 注入（可选）。
      try { if (o.events && o.events.append) o.events.append('shell_restart_spawn_error', { exe, error: (e && e.message) || String(e) }); } catch {}
    });
    child.unref();
    // 同步可判的失败：spawn 对 ENOENT 返回 pid=undefined（错误在下一 tick 才 emit）。
    if (!child.pid) {
      return { ok: false, error: '拉起新壳失败：子进程未启动（' + exe + ' 不存在或不可执行）', killed };
    }
    // 记账交给 API 层（events.append('shell_restart_requested')）——本模块保持纯函数式、无 logger 依赖。
    return { ok: true, restarted: true, killed, pid: child.pid, exe };
  } catch (e) {
    return { ok: false, error: '拉起新壳失败: ' + ((e && e.message) || e), killed };
  }
}
module.exports = { status, evaluate, health, markPending, rollback, identity, readJournal, shellDir, checkUpdate, restartShell, SHELL_RELEASE_PKG };
