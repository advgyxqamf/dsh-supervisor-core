'use strict';

// platform/os/capability-profile —— 平台静态能力档位（纯数据 + 每平台一份；DF-1 拆分）。
//
// 为什么单列：index.js 是平台门面（DS-9 门面 ≤150 行）；能力档位是**纯数据**，与
//   运行时分派/工具探测无关。index.js#capabilityProfile 只保留「按平台选择档位」的分派
//   （cross-platform-architecture-gate CP-3 要求门面显式列出 linux/darwin/win32 分支），
//   档位本体在此。取值与拆分前逐字一致（capability-profile-test、
//   four-platform-behavior-matrix P-4/P-5、cross-platform-architecture-gate 依赖）。
//
// 工具类字段（multiInstance/desktopNotify/autostart/win processTreeKill）在此返回
// 平台期望值（工具存在时），index.js#capabilities() 用 hasTool 实测覆写（缺失才降 false）。
// 字段语义（2026-09-11 跨平台能力完整性审计补齐）：
//   guardAutostart / guardSelfHeal / shellAutostart / shellSelfHeal 为服务链自愈/自启声明；
//   此前这些没有能力字段，消费者无从得知，补字段 + 审计测试后声明与实现绑定。
//   （实现要点见 index.js 头注 + autostart.js 文件头的所有权矩阵。）

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
  // ✅ 2026-09-11 补齐：独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad）。
  //   守卫的 plist（com.dsh.supervisor）仍归**桌面壳**建立，内核只 enable/disable —— 见
  //   platform/os/autostart.js 文件头的所有权矩阵。
  shellAutostart: true,
  shellSelfHeal: true,   // 守卫看护（2026-09-11 新增，此前 macOS 完全没有壳自愈）
};

/** win32 档位：期望 schtasks/powershell/taskkill 实测覆写。 */
const win32 = {
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
