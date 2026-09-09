'use strict';

// ★★★ 平台抽象层（跨平台产品架构的地基）★★★
// 原则：平台无关域（supervisor/domain/system-services）不得直接触碰平台 API
// （systemctl/notify-send/xdg-open//proc/netstat/lsof...），一律经本门面。
// 能力等价矩阵：每一平台均有 Provider 实现（允许能力面一致、隔离强度按平台文档化）。
//
// TODO(P2)：servicehost/sandbox 的完整集成（bin install 迁移、多实例 Provider 切换）。

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
    });
  }
  return Object.assign(base, {
    multiInstance: false, pidAdoption: false, processTreeKill: false,
    desktopNotify: false, autostart: false, frpExpose: false,
    hostService: 'none',
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
  // notify 为直接可调函数（supervisor.notify 按 platform.notify(title, body, onError) 调用），不能导出模块对象——否则通知路径报 platform.notify is not a function，升级终态被误判为失败
  notify: require('./notify').notify,
  browser: require('./browser'),
  autostart: require('./autostart'),};
