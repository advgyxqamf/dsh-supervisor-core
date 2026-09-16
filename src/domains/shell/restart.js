'use strict';

const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');

// ═══════════════════════════════════════════════════════════════════════════
// 壳更新安全网 —— 版本检测 / 壳重启（域：shell / restart）
//
// 为什么拆出本文件（DIRECTORY-STRUCTURE-DESIGN §4.5 域内结构规范）：
//   本文件承载 shell 域中**有 IO/进程副作用**的一类职责——查 npm 版本、杀旧壳、
//   spawn 新壳。与 journal.js（纯状态 + 本地 JSON 读写）分离后，二者可分别审查：
//   读者不必在「账本状态机」里辨认进程信号处理，也不必在 spawn 代码里找账本语义。
//
// ⛔ 硬约束（用户明确要求，D6）：**绝不触碰内核既有更新机制**。
//   此处只做**版本检测**（不安装）；重启是把控制权交回壳的门 0（壳自更新）。
// ═══════════════════════════════════════════════════════════════════════════

const { identity } = require('./journal');
// 纯解析/谓词（exeFromCmdline / isShellProcess）下沉纯核心 core.js。
//   ⚠ 顶层依赖，**删除**原「函数内按需取 ./watchdog.isShellProcess」的反序边：
//   重启流程不得依赖上游看护模块（下游流程依赖上游谓词 = 方向反序，见设计 §A.2/E4）。
const { exeFromCmdline, isShellProcess } = require('./core');
// 版本比较复用内核**同一份**实现（shared/version），避免两处 semver 语义分叉。
const { semverCompare } = require('../../shared/version');

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
    // @dsh-sup/shell-release 属**我们的**发布 scope（契约 §1）→ 走 §3 通道控制
    //（rollback → canary → latest；latest 缺失才回落最高），且已不再「取全量最高」。
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
  // SSOT §3：异步 spawn 统一封装（固定 windowsHide:true）——壳是 detached 子进程，
  // 不加 windowsHide 会在 Windows 上新建控制台窗口。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 进程匹配名可配置：主要照顾「自定义安装名」的场景，同时让测试可注入一个不存在的名字，
  // 避免单元测试误杀开发者本机真实运行的壳进程。
  const pattern = o.procPattern || 'dsh-supervisor-gui';
  let procs = [];
  try { procs = pidlook.pgrepList(pattern) || []; } catch { procs = []; }
  // ⚠ P2-2 修复（2026-09-12）：改用**与 watchdog 同一个**判定函数。
  //
  //   缺陷：这里内联的排除表只有 3 个 flag（--shell-update-plan|--core-plan|--node-plan），
  //     而 `watchdog.js:isShellProcess` 有 6 个（多 --mirror-plan|--env-plan|--service-plan）。
  //     于是运行 `dsh-supervisor-gui --mirror-plan`（运维自检）时：
  //       watchdog 判「壳缺失」→ 触发 restartShell → 后者**弱过滤**把该自检进程算作壳
  //       → SIGTERM/SIGKILL **杀掉运维自检进程**。
  //   同一事实两处实现且已分叉 —— 现由一个共享谓词消除。
  // 共享判定现居纯核心 core.js（顶层依赖）—— 不再反序 require 上游 watchdog 模块。
  procs = procs.filter((p) => isShellProcess(p));

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
    // 原语义 detached:true + stdio 'ignore' → detachedIgnored（保留 env 传递）。
    const child = spawnOS.detachedIgnored(exe, [], { env: process.env });
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

module.exports = { SHELL_RELEASE_PKG, checkUpdate, restartShell };
