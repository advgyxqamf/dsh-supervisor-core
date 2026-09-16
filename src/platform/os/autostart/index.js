'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台化开机自启（三端同一 setAutostart(on) / status()）—— 门面（组合 + 分派）
//
// ## 所有权矩阵（2026-09-11 定案 —— 此前**没有**矩阵，导致两个写入方争同一文件）
//
// | 产物                          | 唯一所有者        | 依据 |
// |-------------------------------|-------------------|------|
// | 守卫服务**定义**              | **桌面壳**        | 引导顺序：壳是安装器，装内核后立即建立（service.rs）|
// |   · Linux  ~/.config/systemd/user/dsh-supervisor.service
// |   · macOS  ~/Library/LaunchAgents/com.dsh.supervisor.plist
// |   · Windows 计划任务 DSH-Supervisor
// | 守卫自启**开关**（enable/disable）| **内核**（面板）| 用户可见设置项在面板 |
// | 壳（GUI）自启产物              | **内核**          | 同上；与守卫自启同属「整链自启」语义 |
// | 壳崩溃自愈                    | **守卫看护**      | 壳不能自监督（domains/shell/watchdog）|
//
// ### 修复的历史缺陷（本次定案的原因）
//
// 1. **双写冲突**：内核曾与壳**同时写** macOS 的 com.dsh.supervisor.plist ——
//    两个模板各自演进必然漂移；且内核 disable 时 unlink 该文件，
//    而壳下次启动会**重建并 bootstrap** → **用户「关闭自启」不生效**。
//    现内核**只做 enable/disable + bootstrap/bootout，绝不写/删该文件**。
// 2. **macOS 无壳自启**：旧注释谎称「同 plist 附带」，实测 plist 只含守卫；
//    现新增独立 LaunchAgent com.dsh.supervisor.gui（内核所有）。
//
// ## 平台机制（实现见同目录 win32/darwin/linux.js）
// - Linux  ：systemd --user enable/disable + linger + XDG autostart .desktop（GUI）
// - macOS  ：launchctl enable/disable + bootstrap/bootout（守卫 plist 由壳建立；GUI 独立 plist）
// - Windows：schtasks ONLOGON（GUI）+ /Change /ENABLE|/DISABLE（守卫）
//
// 全部外部命令经 platform/util/exec 统一执行器（有界 + SIGKILL + windowsHide），
// 平台能力缺失时返回明确错误，绝不静默成功。
// ═══════════════════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveExecutable } = require('../exec-path');

const win32 = require('./win32');
const darwin = require('./darwin');
const linux = require('./linux');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/** 守护进程执行路径（自启/服务定义使用）。
 *  P0 修复：旧实现硬拼 ~/.local/bin/dsh-supervisor —— Windows 上**无 .exe 且目录非标准**。
 *  现经跨平台解析：PATH（Windows 含 PATHEXT）→ %APPDATA%\npm → ~/.local/bin → ~/.npm-global/bin。
 *  仍无命中时回退「平台规范的安装位置」（Windows 带 .exe），保证路径形态正确。 */
function daemonCommand() {
  const hit = resolveExecutable('dsh-supervisor', { envVar: 'DSH_SUPERVISOR_DAEMON' });
  if (hit) return hit;
  const exe = isWindows ? 'dsh-supervisor.exe' : 'dsh-supervisor';
  return path.join(os.homedir(), '.local', 'bin', exe);
}

/** GUI 壳可执行路径（Windows watchdog 拉起面板用）。
 *  壳由 launcher 安装器部署，位置随安装方式而异——按 env 覆盖 → 常见安装位置解析。 */
function guiCommand() {
  const hit = resolveExecutable('dsh-supervisor-gui', { envVar: 'DSH_SHELL_EXE' });
  if (hit) return hit;
  const home = os.homedir();
  const exe = isWindows ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui';
  const cands = isWindows
    ? [path.join(home, '.local', 'bin', exe), path.join(home, 'AppData', 'Local', 'Programs', 'dsh-supervisor', exe)]
    : [path.join(home, '.local', 'bin', exe), '/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return cands[0];
}

/** 平台实现所需依赖经显式注入（不靠同一 this，DF-4）。 */
const DEPS = { guiCommand };

/** 当前自启状态（三端同一 kind/on/gui 形态）。 */
function status() {
  if (isWindows) return win32.status();
  if (isMac) { return darwin.status(); }
  // 未知平台：显式 kind:'none' 且不触碰 systemctl（不产生误导性的 ENOENT 噪声）。
  if (!isLinux) return { kind: 'none', unit: 'unsupported', on: false, gui: false };
  return linux.status();
}

/** 服务链自启（守卫 + 面板）。 */
function setAutostart(on) {
  if (isWindows) return win32.setAutostart(on, DEPS);
  if (isMac) return darwin.setAutostart(on, DEPS);
  return linux.setAutostart(on, DEPS);
}

/** GUI（桌面壳）登录自启 —— 三平台均已实现（win32 由 setAutostart 的 schtasks 承担）。 */
function setGuiAutostart(on, platform) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return darwin.setGuiAutostart(on, DEPS);
  if (pl === 'win32') return win32.setGuiAutostart(on);
  if (pl !== 'linux') return { ok: false, unsupported: true, platform: pl, enabled: false, error: '未知平台' };
  return linux.setGuiAutostart(on, DEPS);
}

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand, guiCommand };
