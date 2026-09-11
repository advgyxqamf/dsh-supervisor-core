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
const { execFileSync } = require('node:child_process');

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const ARCH = process.arch;

const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

// ---- 工具可执行性探测（模块级缓存：capabilities 可被 API/UI 多次调用）----
const _toolCache = {};
function hasTool(name, args) {
  if (_toolCache[name] !== undefined) return _toolCache[name];
  try {
    execFileSync(name, args || ['--version'], { stdio: 'ignore', timeout: 3000 });
    _toolCache[name] = true;
  } catch {
    _toolCache[name] = false;
  }
  return _toolCache[name];
}
// 重置探测缓存（测试/环境变化用）
function resetCapabilityProbes() {
  for (const k of Object.keys(_toolCache)) delete _toolCache[k];
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
      shellAutostart: true,  // XDG autostart .desktop（Exec 按实际安装解析）
      shellSelfHeal: false,  // ❌ 无监督：壳崩溃后无人拉起（见审计报告）
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
      // ⚠ macOS 壳链**未实现**（历史注释谎称「由 LaunchAgent 一并代管」，实测 plist 只含守卫）
      shellAutostart: false,
      shellSelfHeal: false,
    });
  }
  if (pl === 'win32') {
    return Object.assign(base, {
      multiInstance: false, // 沙箱 systemd-run 不可用（Phase 3 迁移计划任务/NSSM 后置 true）
      pidAdoption: true,    // netstat
      processTreeKill: true, // 期望 taskkill（实测覆写）
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
  dataDir, supervisorDir, capabilities, capabilityProfile, resetCapabilityProbes, hasTool,
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
  autostart: require('./autostart'),};
