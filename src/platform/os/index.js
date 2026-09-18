'use strict';

const stateRoot = require('../service/state-root');

// 平台抽象层：平台无关域（supervisor/domains/guard/api）不得直接触碰平台 API（systemctl/
// systemd-run/launchctl/schtasks/notify-send/xdg-open/wmic/proc/netstat/lsof），一律经本门面。
// 能力矩阵为纯函数 + 工具探测；service 是 Provider 分派（linux->systemd / darwin->launchd /
// win32->windows-service / 未知->none，未实现能力抛 CapabilityError）；其余模块函数内按平台
// 分支、三端接口一致。
// 历史 TODO（已撤销，勿据以派单）：原记「servicehost/sandbox 的完整 Provider 化」。核验：**无 servicehost 模块**；
//   service 早已是 PROVIDERS[PLATFORM] 真 Provider 分派；sandbox 属 domains/instance（非 os 层）。其余 os 模块
//   按平台分支、三端接口一致，是**有意设计**而非待办。

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

// 工具可执行性探测（模块级缓存：capabilities 可被 API/UI 多次调用）。
// 正结果永久缓存；负结果只在 NEG_TTL_MS 内有效，过期重探 —— 否则启动早期 PATH 缺工具时
// 能力会永久停在 false，而 capabilities() 是 /env/status 的对外声明面，用户无从恢复。
const _toolCache = {};
const _NEG_TTL_MS = 60000; // 负结果 60s 内不重探（避免每次 /env/status 都 spawn 一遍）
function hasTool(name, args) {
  const hit = _toolCache[name];
  if (hit !== undefined) {
    if (hit === true) return true;
    if (Date.now() - (hit.at || 0) < _NEG_TTL_MS) return false;
  }
  // 必须用 runOut：execFileSync 在 stdio ignore 下成功也返回 null，用 !== null 判存在会恒 false，
  // 导致 capabilities() 把 multiInstance/desktopNotify/autostart 全部误降为 false。
  const ok = ex.runOut(name, args || ['--version'], { timeoutMs: 3000 }) !== null;
  _toolCache[name] = ok ? true : { at: Date.now() };
  return ok;
}
/** DSH 数据目录：~/.dsh（被管控对象的数据，不属于本产品状态）。 */
function dataDir() {
  return path.join(os.homedir(), '.dsh');
}

/** 本产品状态目录（独立于 DSH）；单一事实源 = platform/service/state-root.js。 */
function supervisorDir() {
  return stateRoot.supervisorDir();
}

/** 平台静态能力档位（纯函数）。档位数据在 ./capability-profile.js；本函数只做按平台分派
 *  （显式列出 linux/darwin/win32，未知->unknown）。工具类字段在此返回平台期望值，
 *  capabilities() 用 hasTool 实测覆写。
 *  @param platform 可选（默认 process.platform）
 *  @param arch 可选（默认 process.arch） */
function capabilityProfile(platform, arch) {
  const pl = platform || PLATFORM;
  const ar = arch || ARCH;
  const base = { platform: pl, arch: ar };
  if (pl === 'linux') return Object.assign(base, CAPABILITY_PROFILES.linux);
  if (pl === 'darwin') return Object.assign(base, CAPABILITY_PROFILES.darwin);
  if (pl === 'win32') return Object.assign(base, CAPABILITY_PROFILES.win32);
  return Object.assign(base, CAPABILITY_PROFILES.unknown);
}

/** 平台能力矩阵 = 静态档位 x 实际工具探测；供壳/面板做能力呈现与降级提示（/env/status）。 */
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
  execPath: require('./exec-path'),      // 跨平台可执行解析（扩展名/PATHEXT/标准目录）
  fileProtect: require('./file-protect'), // 跨平台文件保护（Unix chmod / Windows icacls）
  service: require('./service'),          // 服务管理器抽象（Provider 分派）
  // notify 必须是直接可调函数：supervisor 按 platform.notify(title, body, onError) 调用，
  // 导出模块对象会报 platform.notify is not a function，升级终态被误判为失败。
  notify: require('./notify').notify,
  browser: require('./browser'),
  desktop: require('./desktop'),          // 图形会话可用性（Linux 需真判定，见 desktop.js）
  autostart: require('./autostart'),
};
