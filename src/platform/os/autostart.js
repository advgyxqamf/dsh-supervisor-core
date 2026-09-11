'use strict';

// 平台化开机自启：三端同一 setAutostart(on)/status()。
// - Linux：systemd --user enable/disable + linger + GUI desktop（原 host-service 逻辑迁移）；
// - macOS：LaunchAgent plist（RunAtLoad + KeepAlive）+ 登录面板（同 plist 附带）；
// - Windows：schtasks ONLOGON 登录任务（/RL HIGHEST）。
// 全部 execFileSync 外置 try/catch（平台能力缺失 → 明确错误返回）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveExecutable } = require('./exec-path');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function laFile(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', name + '.plist');
}
function guiFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'dsh-supervisor-gui-autostart.desktop');
}

/** 当前自启状态。 */
function status() {
  if (isWindows) {
    // 三个任务的**职责分离**（2026-09-11 架构修正）：
    //   DSH-Supervisor          -> 守卫守护进程（**由桌面壳建立**；壳的 schtasks /Run 指向它）
    //   DSH-Supervisor-GUI      -> 登录时打开桌面壳（本文件的 autostart 开关管理）
    //   DSH-Supervisor-Watchdog -> 每 5 分钟保活（崩溃自拉）
    //
    // ⚠ 旧实现把 DSH-Supervisor 指向 **GUI 壳**，而壳的 start_guard_service() 执行
    //   `schtasks /Run /TN DSH-Supervisor` —— 于是「启动守卫」实际只是再开一次壳
    //   （被单实例插件折回焦点），**守卫永远不会被启动**。现已改名分离，彻底消除该错位。
    let guard = false, gui = false, watchdog = false;
    const has = (tn) => {
      try {
        const out = execFileSync('schtasks', ['/Query', '/TN', tn], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return out.includes(tn);
      } catch { return false; }
    };
    guard = has('DSH-Supervisor');
    gui = has('DSH-Supervisor-GUI');
    watchdog = has('DSH-Supervisor-Watchdog');
    return { kind: 'schtasks', on: guard || gui || watchdog, gui, watchdog, guard };
  }
  if (isMac) {
    const on = fs.existsSync(laFile('com.dsh.supervisor'));
    // ⚠ gui 必须**如实**（2026-09-11 审计修复）：
    //   LaunchAgent plist 只含守卫（ProgramArguments = <daemon> daemon），**不含桌面壳**。
    //   旧实现返回 `gui: on`（把「守卫自启」当成「壳自启」），使面板显示「开机自启已开启」
    //   而壳实际不会自启。这是「静默成功」的同一类缺陷，直接违反本仓已声明的不变量：
    //     service.js: 「未实现的能力**显式抛 CapabilityError**（绝不静默失败）」。
    return { kind: 'launchagent', on, gui: false, guiSupported: false };
  }
  // Linux
  let unit = 'unknown';
  try { unit = execFileSync('systemctl', ['--user', 'is-enabled', 'dsh-supervisor.service'], { encoding: 'utf8' }).trim(); }
  catch (e) { unit = ((e && e.stdout) || 'disabled').trim() || 'disabled'; }
  return { kind: 'systemd', unit, on: unit === 'enabled', gui: fs.existsSync(guiFile()) };
}

/** 服务链自启（守卫 + 面板）。 */
function setAutostart(on) {
  const errors = [];
  if (isWindows) {
    // Windows 崩溃自拉宿主（2026-09 补齐）：schtasks ONLOGON 只登录启动一次，进程崩溃后不会重启。
    // 方案：双任务——(a) ONLOGON 启动 GUI 壳（用户常驻入口）；(b) Watchdog 每 5 分钟检查守卫
    // API（localhost:apiPort 探测），进程不在则重新拉起 daemon（写 watchdog.ps1 到数据目录，纯 PS 免转义）。
    try {
      const watchdogPs1 = path.join(os.homedir(), '.dsh', 'supervisor', 'watchdog.ps1');
      if (on) {
        const apiPort = process.env.DSH_SUPERVISOR_API_PORT || '36361';
        const daemon = daemonCommand();
        const guiPath = guiCommand();
        const ps = [
          '$ErrorActionPreference = "SilentlyContinue"',
          '$port = ' + JSON.stringify(String(apiPort)),
          '$daemon = ' + JSON.stringify(String(daemon)),
          '$gui = ' + JSON.stringify(String(guiPath)),
          '$up = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue',
          '# ── 守卫保活（仅在守卫不可达时）──',
          'if (-not $up) {',
          '  $p = @(Get-Process -Name dsh-supervisor -ErrorAction SilentlyContinue)',
          "  if (-not $p) { Start-Process -FilePath $daemon -ArgumentList 'daemon' -WindowStyle Hidden }",
          '}',
          '# ── 壳保活（⚠ 必须**独立于守卫状态**）──',
          '#   2026-09-11 审计修复：旧实现把壳检查嵌在上面的 if (-not $up) 内，',
          '#   于是「壳崩、守卫活」时 $up 为真 → 整块跳过 → **壳永远不会被拉起**。',
          '#   而那恰是壳自愈唯一需要生效的场景（守卫由服务管理器保活，壳无人管）。',
          '$g = @(Get-Process -Name dsh-supervisor-gui -ErrorAction SilentlyContinue)',
          'if (-not $g -and (Test-Path $gui)) { Start-Process -FilePath $gui -WindowStyle Hidden }',
          'exit 0',
        ].join(String.fromCharCode(13, 10));
        fs.mkdirSync(path.dirname(watchdogPs1), { recursive: true });
        const atmp = watchdogPs1 + '.tmp'; fs.writeFileSync(atmp, ps); fs.renameSync(atmp, watchdogPs1); // 原子写
        // (a) 登录启动 GUI（任务名与「守卫服务」分离，避免覆盖壳建立的守卫任务）
        try { execFileSync('schtasks', ['/Create', '/TN', 'DSH-Supervisor-GUI', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + guiCommand() + '"']); } catch (e) { errors.push('schtasks gui: ' + e.message); }
        // (c) 守卫任务（DSH-Supervisor）由**桌面壳**建立；这里只负责「开机自启」语义的启用
        try { execFileSync('schtasks', ['/Change', '/TN', 'DSH-Supervisor', '/ENABLE']); } catch {}
        // (b) 每 5 分钟 watchdog 保活（崩溃自动拉起）
        try { execFileSync('schtasks', ['/Create', '/TN', 'DSH-Supervisor-Watchdog', '/SC', 'MINUTE', '/MO', '5', '/RL', 'HIGHEST', '/F', '/TR', 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + watchdogPs1 + '"']); } catch (e) { errors.push('schtasks watchdog: ' + e.message); }
      } else {
        try { execFileSync('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-Watchdog', '/F']); } catch {}
        try { execFileSync('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']); } catch {}
        // 守卫任务不删除（它是**服务定义**，删了壳的 /Run 会再次失败）；只停用开机自启。
        try { execFileSync('schtasks', ['/Change', '/TN', 'DSH-Supervisor', '/DISABLE']); } catch {}
        try { fs.unlinkSync(watchdogPs1); } catch {}
      }
    } catch (e) { errors.push('watchdog setup: ' + e.message); }
    return { ok: errors.length === 0, errors, ...status() };
  }
  if (isMac) {
    try {
      const file = laFile('com.dsh.supervisor');
      if (on) {
        const plist = macPlist(daemonCommand());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const atmp = file + '.tmp'; fs.writeFileSync(atmp, plist); fs.renameSync(atmp, file); // 原子写
        try { execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), file]); } catch {}
      } else {
        try { execFileSync('launchctl', ['bootout', 'gui/' + process.getuid(), 'com.dsh.supervisor']); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
    } catch (e) { errors.push('launchagent: ' + e.message); }
    return { ok: errors.length === 0, errors, ...status() };
  }
  // Linux（systemd --user + linger + GUI desktop）
  try { execFileSync('systemctl', ['--user', 'daemon-reload']); } catch (e) { errors.push('daemon-reload: ' + e.message); }
  try { execFileSync('systemctl', ['--user', on ? 'enable' : 'disable', 'dsh-supervisor.service']); } catch (e) { errors.push((on ? 'enable' : 'disable') + ': ' + e.message); }
  try { execFileSync('loginctl', [on ? 'enable-linger' : 'disable-linger', os.userInfo().username]); } catch (e) { if (on) errors.push('enable-linger: ' + e.message); }
  const g = setGuiAutostart(on);
  if (!g.ok) errors.push(g.error);
  return { ok: errors.length === 0, errors, ...status() };
}

/** GUI（桌面壳）登录自启 —— 平台差异**如实声明**（2026-09-11 审计修复）。
 *
 *  linux  —— ✅ XDG autostart .desktop（本函数实现）
 *  win32  —— ✅ schtasks 任务 DSH-Supervisor-GUI（由 setAutostart 建立；本函数不重复实现）
 *  darwin —— ❌ **未实现**
 *
 * ⚠ 历史错误（本项目奠基提交 8867942 起即存在，直到 2026-09-11 审计才被发现）：
 *   旧注释声称「mac 由 LaunchAgent 一并代管」，而 macPlist 从奠基提交至今**逐字节未变**、
 *   只含守卫。旧实现据此对非 Linux 平台直接 `return { ok: true }` —— **静默成功**，
 *   调用方与用户都以为壳已配置自启。
 *   现改为对未实现平台**显式报告**（ok:false + unsupported），与 service.js 的 CapabilityError 同规。
 */
function setGuiAutostart(on, platform) {
  const pl = platform || process.platform;
  if (pl === 'darwin') {
    return {
      ok: false, unsupported: true, platform: pl, enabled: false,
      error: 'macOS 桌面壳登录自启未实现（LaunchAgent plist 仅含守卫，不含壳）',
    };
  }
  if (pl === 'win32') {
    // Windows 的壳自启由 setAutostart 的 schtasks DSH-Supervisor-GUI 承担（职责分离，见本文件顶部注释）。
    return { ok: true, platform: pl, enabled: !!on, via: 'schtasks', task: 'DSH-Supervisor-GUI' };
  }
  if (pl !== 'linux') return { ok: false, unsupported: true, platform: pl, enabled: false, error: '未知平台' };
  try {
    const file = guiFile();
    if (on) {
      const tpl = path.join(__dirname, '..', '..', '..', 'desktop', 'dsh-supervisor-gui-autostart.desktop');
      let entry = fs.readFileSync(tpl, 'utf8');
      // ⚠ Exec 必须指向**解析出的真实路径**（2026-09-11 审计修复）：
      //   模板写死 `@HOME@/.local/bin/dsh-supervisor-gui`，而 deb/rpm 把可执行装在
      //   **/usr/bin/dsh-supervisor-gui**（实测 dpkg -c 确认）。
      //   于是「用安装包」的用户启用开机自启后，登录时 Exec 指向**不存在的文件** ——
      //   桌面环境静默忽略，用户以为已开启。
      //   guiCommand() 已具备跨安装形态的解析能力（PATH/标准目录），此处复用。
      entry = entry.split('@HOME@').join(os.homedir());
      const guiBin = guiCommand();
      const oldExec = os.homedir() + '/.local/bin/dsh-supervisor-gui';
      if (entry.includes(oldExec)) entry = entry.split(oldExec).join(guiBin);
      // Icon 同样按实际安装解析（deb 装到 /usr/share，本地装到 ~/.local/share）
      const iconCandidates = [
        path.join(os.homedir(), '.local', 'share', 'icons', 'dsh-supervisor.png'),
        '/usr/share/icons/hicolor/256x256/apps/dsh-supervisor.png',
        '/usr/share/pixmaps/dsh-supervisor.png',
      ];
      const icon = iconCandidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
      if (icon) entry = entry.split(/^Icon=.*$/m).join('Icon=' + icon);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const atmp2 = file + '.tmp'; fs.writeFileSync(atmp2, entry); fs.renameSync(atmp2, file); // 原子写
    } else { try { fs.unlinkSync(file); } catch {} }
    return { ok: true, enabled: !!on, exec: guiCommand() };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 守护进程执行路径（自启/服务定义使用）。
 *  P0 修复：旧实现硬拼 ~/.local/bin/dsh-supervisor —— Windows 上**无 .exe 且目录非标准**，
 *  watchdog 的 Start-Process 静默失败（Windows 崩溃自愈实际不可用）。
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
  const hit = resolveExecutable(isWindows ? 'dsh-supervisor-gui' : 'dsh-supervisor-gui',
    { envVar: 'DSH_SHELL_EXE' });
  if (hit) return hit;
  const home = os.homedir();
  const exe = isWindows ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui';
  const cands = isWindows
    ? [path.join(home, '.local', 'bin', exe), path.join(home, 'AppData', 'Local', 'Programs', 'dsh-supervisor', exe)]
    : [path.join(home, '.local', 'bin', exe), '/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return cands[0];
}

function macPlist(daemon) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + '  <key>Label</key><string>com.dsh.supervisor</string>\n'
    + '  <key>ProgramArguments</key>\n'
    + '  <array><string>' + daemon.replace(/"/g, '\\"') + '</string><string>daemon</string></array>\n'
    + '  <key>RunAtLoad</key><true/>\n'
    + '  <key>KeepAlive</key><true/>\n'
    + '  <key>ProcessType</key><string>Interactive</string>\n'
    // 系统日志框架（目录收敛 §8）：守卫 stdout/stderr 落入独立 log/guard-stdio.log（launchd 重定向），
    // 不与 createLogger(log/guard.log) 同一文件——避免双写交错/轮转竞态（旧布局曾落 supervisor.log 根目录）。
    + '  <key>StandardOutPath</key><string>' + path.join(os.homedir(), '.dsh', 'supervisor', 'log', 'guard-stdio.log') + '</string>\n'
    + '  <key>StandardErrorPath</key><string>' + path.join(os.homedir(), '.dsh', 'supervisor', 'log', 'guard-stdio.log') + '</string>\n'
    + '</dict></plist>\n';
}

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand, guiCommand };
