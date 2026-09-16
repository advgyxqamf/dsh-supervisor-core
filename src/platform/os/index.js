'use strict';

const stateRoot = require('../service/state-root');

// ★★★ 平台抽象层（跨平台产品架构的地基）★★★
// 原则：平台无关域（supervisor/domains/guard/api）**不得直接触碰平台 API**
// （systemctl/systemd-run/launchctl/schtasks/notify-send/xdg-open/wmic//proc/netstat/lsof…），
// 一律经本门面。2026-09 跨平台审计已把域层的 8 处 systemctl + wmic/powershell + xdg-open
// 全部收敛至此（回归防线见 test/cross-platform-test.js「分层不变量」）。
//
// 实现形态（务实，不追求形式统一）：
//   - 能力矩阵 capabilityProfile/capabilities：纯函数 + 工具探测（可测；非 Provider 对象）；
//     档位纯数据归 ./capability-profile.js（DF-1 拆分），本门面只留按平台选择的分派；
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
const ex = require('../util/exec');
// 平台静态能力档位（纯数据；本门面只做分派。CP-3 要求门面显式列出三平台分支）。
const CAPABILITY_PROFILES = require('./capability-profile');

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
//    而 `domains/instance/core.js` 在**构造期**求值一次
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
/** DSH 数据目录：~/.dsh（**被管控对象**的数据；不属于本产品状态）。 */
function dataDir() {
  return path.join(os.homedir(), '.dsh');
}

/** 本产品状态目录（**独立于 DSH**）：XDG 状态根/dsh-supervisor/supervisor。
 *  单一事实源 = platform/service/state-root.js（覆盖 DSH_SUPERVISOR_HOME）。 */
function supervisorDir() {
  return stateRoot.supervisorDir();
}

/** 平台静态能力档位（纯函数，可测）。档位纯数据在 ./capability-profile.js（DF-1 拆分），
 *  本函数只做「按平台选择档位」的分派（CP-3：门面显式列出三平台分支；未知→unknown）。
 *  工具类字段（multiInstance/desktopNotify/autostart/win processTreeKill）在此返回
 *  平台期望值（工具存在时），capabilities() 用 hasTool 实测覆写（缺失才降 false）。
 *  @param platform 可选（默认 process.platform）
 *  @param arch 可选（默认 process.arch）
 *  @returns {{platform,arch,multiInstance,pidAdoption,processTreeKill,desktopNotify,autostart,frpExpose,hostService}} */
function capabilityProfile(platform, arch) {
  const pl = platform || PLATFORM;
  const ar = arch || ARCH;
  const base = { platform: pl, arch: ar };
  if (pl === 'linux') return Object.assign(base, CAPABILITY_PROFILES.linux);
  if (pl === 'darwin') return Object.assign(base, CAPABILITY_PROFILES.darwin);
  if (pl === 'win32') return Object.assign(base, CAPABILITY_PROFILES.win32);
  return Object.assign(base, CAPABILITY_PROFILES.unknown);
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

