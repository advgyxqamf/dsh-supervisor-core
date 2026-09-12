'use strict';

// ★★★ 平台抽象层（跨平台产品架构的地基）★★★
// 原则：平台无关域（supervisor/domains/guard/api）**不得直接触碰平台 API**
// （systemctl/systemd-run/launchctl/schtasks/notify-send/xdg-open/wmic//proc/netstat/lsof…），
// 一律经本门面。2026-09 跨平台审计已把域层的 8 处 systemctl + wmic/powershell + xdg-open
// 全部收敛至此（回归防线见 test/cross-platform-test.js「分层不变量」）。
//
// 实现形态（务实，不追求形式统一）：
//   - 能力矩阵 capabilityProfile/capabilities：纯函数 + 工具探测（可测；非 Provider 对象）；
//   - 服务管理 service：**Provider 分派**（linux→systemd / darwin→launchd / win32→windows-service /
//     未知→none），未实现能力抛 CapabilityError（显式失败，不静默）；
//   - 其余（pidlookup/notify/browser/process/autostart/exec-path/file-protect）：函数内按平台分支，
//     接口三端一致。
//   注：原注释曾写「每一平台均有 Provider 实现」——与当时的 if/else 实现不符（跨平台审计发现），
//   现按真实形态描述；只有 service 是真 Provider 分派。
//
// TODO(P2)：servicehost/sandbox 的完整 Provider 化（bin install 迁移、多实例 Provider 切换）。

const os = require('node:os');
const path = require('node:path');
const ex = require('../exec');

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const ARCH = process.arch;

const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

// ---- 工具可执行性探测（模块级缓存：capabilities 可被 API/UI 多次调用）----
//
// ⚠ P2-2 修复（2026-09-12）：**负结果加 TTL**，不再永久缓存。
//
//   缺陷：原先 `_toolCache[name] !== undefined` 即返回（**含 false**，无 TTL、无失效入口）；
//    而 `domains/instance/index.js` 在**构造期**求值一次
//       `this.sandboxSupported = caps.multiInstance === true`
//     之后不再重算。于是若守卫启动时 PATH 缺 systemd 工具（登录早期/服务环境），
//     该能力会**永久**停在 false，直到守卫重启 —— 而 `capabilities()` 是 `/env/status`
//     的对外声明面（用户看到「不支持沙箱」却无从恢复）。
//     正是本仓高频模式「门禁/阈值因时序恒真或不可达」。
//
//   现：正结果永久缓存（工具装好了不会自己消失）；**负结果只在 NEG_TTL_MS 内有效**，
//     过期后重探 —— 用户事后安装 systemd 工具即可自愈，无需重启守卫。
const _toolCache = {};
const _NEG_TTL_MS = 60000; // 负结果 60s 内不重探（避免每次 /env/status 都 spawn 一遍）
function hasTool(name, args) {
  const hit = _toolCache[name];
  if (hit !== undefined) {
    if (hit === true) return true; // 正结果：永久
    if (Date.now() - (hit.at || 0) < _NEG_TTL_MS) return false; // 负结果：TTL 内沿用
    // 负结果过期 → 落到下面重探
  }
  // 经统一执行器。⚠ 2026-09-13（P0 修复）：改用 runOut ——
  //   旧实现 `ex.run(..., { stdio: 'ignore' }) !== null` 表面上与「命令存在」等价，实际
  //   **恒 false**：execFileSync 在 stdio:'ignore'（不捕获 stdout）时**成功也返回 null**，
  //   于是 hasTool('node') / hasTool('systemctl') / hasTool('systemd-run') 全部为假
  //   （实测），capabilities() 随之把 multiInstance/desktopNotify/autostart 一律降为 false
  //   → Linux 上「沙箱实例」功能对**所有**用户不可用（UI 报「当前平台不支持」），
  //     而平台其实完全支持。
  //   runOut 走 pipe 并返回字符串，null **只可能是失败** —— 判据与语义一致。
  const ok = ex.runOut(name, args || ['--version'], { timeoutMs: 3000 }) !== null;
  _toolCache[name] = ok ? true : { at: Date.now() };
  return ok;
}
/** 统一数据目录：~/.dsh（三平台一致，os.homedir 通用）。 */
function dataDir() {
  return path.join(os.homedir(), '.dsh');
}

/** 产品私有数据目录：~/.dsh/supervisor（状态/日志/端口登记/任务历史）。 */
function supervisorDir() {
  return path.join(dataDir(), 'supervisor');
}

/** 平台静态能力档位（纯函数，可测——2026-09 审计修复：capabilities 原硬编码全 true
 *  与实际不符，拆为「静态档位 + 实际工具探测」两层）。
 *  工具类字段（multiInstance/desktopNotify/autostart/win processTreeKill）在此返回
 *  平台期望值（工具存在时），capabilities() 用 hasTool 实测覆写（缺失才降 false）。
 *  @param platform 可选（默认 process.platform）
 *  @param arch 可选（默认 process.arch）
 *  @returns {{platform,arch,multiInstance,pidAdoption,processTreeKill,desktopNotify,autostart,frpExpose,hostService}} */
function capabilityProfile(platform, arch) {
  const pl = platform || PLATFORM;
  const ar = arch || ARCH;
  const base = { platform: pl, arch: ar };
  if (pl === 'linux') {
    return Object.assign(base, {
      multiInstance: true,   // 平台期望：有 systemd-run（capabilities 实测覆写）
      pidAdoption: true,
      processTreeKill: true,
      desktopNotify: true,   // 期望 notify-send（实测覆写）
      autostart: true,       // 期望 systemctl（实测覆写）
      frpExpose: true,
      hostService: 'systemd',
      // ── 服务链自愈/自启（2026-09-11 跨平台能力完整性审计补齐）──
      // 此前这些**没有能力字段**，消费者（面板/壳）无从得知；而实现层已存在缺陷
      // （autostart.js 对未实现平台静默返回 ok:true）。补字段 + 审计测试后，声明与实现绑定。
      guardAutostart: true,  // systemd --user enable + linger
      guardSelfHeal: true,   // unit Restart=always
      shellAutostart: true,  // 原生：XDG autostart .desktop（Exec 按实际安装解析）
      shellSelfHeal: true,   // 守卫看护（domains/shell/watchdog，三平台一套机制）
    });
  }
  if (pl === 'darwin') {
    return Object.assign(base, {
      multiInstance: false, // 沙箱 systemd-run 不可用（Phase 3 迁移 launchd 后置 true）
      pidAdoption: true,    // lsof
      processTreeKill: true,
      desktopNotify: true,  // 期望 osascript（实测覆写）
      autostart: true,      // launchctl/LaunchAgent 恒在
      frpExpose: true,
      hostService: 'launchd',
      guardAutostart: true,  // LaunchAgent RunAtLoad + KeepAlive
      guardSelfHeal: true,   // KeepAlive
      // ✅ 2026-09-11 补齐：独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad）。
      //   守卫的 plist（com.dsh.supervisor）仍归**桌面壳**建立，内核只 enable/disable —— 见
      //   platform/os/autostart.js 文件头的所有权矩阵。
      shellAutostart: true,
      shellSelfHeal: true,   // 守卫看护（2026-09-11 新增，此前 macOS 完全没有壳自愈）
    });
  }
  if (pl === 'win32') {
    return Object.assign(base, {
      multiInstance: false, // 沙箱 systemd-run 不可用（Phase 3 迁移计划任务/NSSM 后置 true）
      pidAdoption: true,    // netstat
      // P1-G 修复（2026-09-12）：该声明此前**没有实现产物** —— `killTree` 虽已导出，
      //   但停止路径只用 `signalProcess`（Windows 上仅单进程）。
      //   现已接入 `_killTree`（supervisor 的 SIGKILL 升级路径 + 接管实例路径），
      //   声明与实现一致。回归：test/process-tree-kill-test.js。
      processTreeKill: true, // taskkill /PID /T（由 hasTool 覆写；使用点见 main-process._killTree）
      desktopNotify: true,   // 期望 powershell（实测覆写）
      autostart: true,       // 期望 schtasks（实测覆写）
      frpExpose: true,
      hostService: 'windows-service',
      guardAutostart: true,  // schtasks DSH-Supervisor（ONLOGON）
      guardSelfHeal: true,   // schtasks DSH-Supervisor-Watchdog 每 5 分钟
      shellAutostart: true,  // schtasks DSH-Supervisor-GUI（ONLOGON，由 setAutostart 建立）
      // ✅ 2026-09-11 修复：watchdog 的壳检查已移出 `if (-not $up)` ——
      //   旧实现只在「守卫也挂了」时才检查壳，而「壳崩、守卫活」正是唯一需要它的场景。
      //   前置条件：登录自启已启用（watchdog 任务由 setAutostart 建立），
      //   与 guardSelfHeal 的同一前提一致。
      shellSelfHeal: true,
    });
  }
  return Object.assign(base, {
    multiInstance: false, pidAdoption: false, processTreeKill: false,
    desktopNotify: false, autostart: false, frpExpose: false,
    hostService: 'none',
    guardAutostart: false, guardSelfHeal: false,
    shellAutostart: false, shellSelfHeal: false,
  });
}

/** 平台能力矩阵 = 静态档位（capabilityProfile）× 实际工具探测（hasTool 覆写）。
 *  供壳/面板做能力感知呈现与降级提示（/env/status capabilities）。 */
function capabilities() {
  const p = capabilityProfile();
  const pl = p.platform;
  if (pl === 'linux') {
    p.multiInstance = hasTool('systemd-run');
    p.desktopNotify = hasTool('notify-send');
    p.autostart = hasTool('systemctl');
  } else if (pl === 'darwin') {
    p.desktopNotify = hasTool('osascript');
  } else if (pl === 'win32') {
    p.processTreeKill = hasTool('taskkill');
    p.desktopNotify = hasTool('powershell');
    p.autostart = hasTool('schtasks');
  }
  return p;
}

module.exports = {
  PLATFORM, ARCH, isLinux, isMac, isWindows,
  dataDir, supervisorDir, capabilities, capabilityProfile, hasTool,
  processControl: require('./process'),
  pidlookup: require('./pidlookup'),
  // P0/P1 修复（2026-09 跨平台审计）：
  //   execPath     —— 跨平台可执行解析（Windows 扩展名/PATHEXT/标准目录）
  //   fileProtect  —— 跨平台文件保护（Unix chmod / Windows icacls）
  execPath: require('./exec-path'),
  fileProtect: require('./file-protect'),
  //   service      —— 服务管理器抽象（systemd/launchd/windows/none Provider 分派）
  service: require('./service'),
  // notify 为直接可调函数（supervisor.notify 按 platform.notify(title, body, onError) 调用），不能导出模块对象——否则通知路径报 platform.notify is not a function，升级终态被误判为失败
  notify: require('./notify').notify,
  browser: require('./browser'),
  //   desktop      —— 图形会话可用性（守卫看护桌面壳的前置条件；Linux 需真判定，见 desktop.js）
  desktop: require('./desktop'),
  autostart: require('./autostart'),};
