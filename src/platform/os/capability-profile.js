'use strict';

// 平台静态能力档位（纯数据；DF-1 拆分）。index.js#capabilityProfile 只做按平台选择的分派
// （cross-platform-architecture-gate CP-3 要求门面显式列出三平台分支），档位本体在此。
// 工具类字段在此返回平台期望值，index.js#capabilities 用 hasTool 实测覆写（缺失才降 false）。
// guardAutostart/guardSelfHeal/shellAutostart/shellSelfHeal 为服务链自愈/自启声明。

/** Linux 档位：期望 systemd（systemd-run/systemctl/notify-send 实测覆写）。 */
const linux = {
  multiInstance: true,   // 平台期望：有 systemd-run（capabilities 实测覆写）
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,   // 期望 notify-send（实测覆写）
  autostart: true,       // 期望 systemctl（实测覆写）
  frpExpose: true,
  hostService: 'systemd',
  guardAutostart: true,  // systemd --user enable + linger
  guardSelfHeal: true,   // unit Restart=always
  shellAutostart: true,  // 原生：XDG autostart .desktop（Exec 按实际安装解析）
  shellSelfHeal: true,   // 守卫看护（domains/shell/watchdog，三平台一套机制）
};

/** darwin 档位：期望 launchd / osascript 实测覆写。 */
const darwin = {
  multiInstance: false, // 沙箱 systemd-run 不可用（Phase 3 迁移 launchd 后置 true）
  pidAdoption: true,    // lsof
  processTreeKill: true,
  desktopNotify: true,  // 期望 osascript（实测覆写）
  autostart: true,      // launchctl/LaunchAgent 恒在
  frpExpose: true,
  hostService: 'launchd',
  guardAutostart: true,  // LaunchAgent RunAtLoad + KeepAlive
  guardSelfHeal: true,   // KeepAlive
  // 独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad）；守卫 plist 归桌面壳建立，
  // 内核只 enable/disable（见 autostart.js 头注的所有权矩阵）。
  shellAutostart: true,
  shellSelfHeal: true,   // 守卫看护（三平台一套机制）
};

/** win32 档位：期望 schtasks/powershell/taskkill 实测覆写。 */
const win32 = {
  multiInstance: false, // 沙箱 systemd-run 不可用（Phase 3 迁移计划任务/NSSM 后置 true）
  pidAdoption: true,    // netstat
  // processTreeKill 已接入 _killTree（supervisor 的 SIGKILL 升级路径 + 接管实例路径），
  processTreeKill: true, // taskkill /PID /T（由 hasTool 覆写；使用点见 main-process._killTree）
  desktopNotify: true,   // 期望 powershell（实测覆写）
  autostart: true,       // 期望 schtasks（实测覆写）
  frpExpose: true,
  hostService: 'windows-service',
  guardAutostart: true,  // schtasks DSH-Supervisor（ONLOGON）
  guardSelfHeal: true,   // schtasks DSH-Supervisor-Watchdog 每 5 分钟
  shellAutostart: true,  // schtasks DSH-Supervisor-GUI（ONLOGON，由 setAutostart 建立）
  // watchdog 的壳检查不再限定在守卫也挂的块内 —— 壳崩而守卫活正是唯一需要它的场景。
  // 前置条件：登录自启已启用（watchdog 任务由 setAutostart 建立），与 guardSelfHeal 同前提。
  shellSelfHeal: true,
};

/** 未知平台档位：全能力 false，hostService=none（显式失败，不谎报）。 */
const unknown = {
  multiInstance: false, pidAdoption: false, processTreeKill: false,
  desktopNotify: false, autostart: false, frpExpose: false,
  hostService: 'none',
  guardAutostart: false, guardSelfHeal: false,
  shellAutostart: false, shellSelfHeal: false,
};

module.exports = { linux, darwin, win32, unknown };
