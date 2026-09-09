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
    // 自启 = ONLOGON(GUI) + Watchdog(崩溃自拉) 双任务任一存在即视为已配置
    let on = false, watchdog = false;
    try {
      const out = execFileSync('schtasks', ['/Query', '/TN', 'DSH-Supervisor'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      on = out.includes('DSH-Supervisor');
    } catch {}
    try {
      const w = execFileSync('schtasks', ['/Query', '/TN', 'DSH-Supervisor-Watchdog'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      watchdog = w.includes('Watchdog');
    } catch {}
    return { kind: 'schtasks', on: on || watchdog, gui: on, watchdog };
  }
  if (isMac) {
    const on = fs.existsSync(laFile('com.dsh.supervisor'));
    return { kind: 'launchagent', on, gui: on };
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
        const ps = [
          '$ErrorActionPreference = "SilentlyContinue"',
          '$port = ' + JSON.stringify(String(apiPort)),
          '$daemon = ' + JSON.stringify(String(daemon)),
          '$gui = Join-Path $env:USERPROFILE ".local\\bin\\dsh-supervisor-gui.exe"',
          '$up = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue',
          'if (-not $up) {',
          '  $p = @(Get-Process -Name dsh-supervisor -ErrorAction SilentlyContinue)',
          "  if (-not $p) { Start-Process -FilePath $daemon -ArgumentList 'daemon' -WindowStyle Hidden }",
          '  $g = @(Get-Process -Name dsh-supervisor-gui -ErrorAction SilentlyContinue)',
          '  if (-not $g -and (Test-Path $gui)) { Start-Process -FilePath $gui -WindowStyle Hidden }',
          '}',
          'exit 0',
        ].join(String.fromCharCode(13, 10));
        fs.mkdirSync(path.dirname(watchdogPs1), { recursive: true });
        const atmp = watchdogPs1 + '.tmp'; fs.writeFileSync(atmp, ps); fs.renameSync(atmp, watchdogPs1); // 原子写
        // (a) 登录启动 GUI（守卫由 GUI 引导拉起）
        try { execFileSync('schtasks', ['/Create', '/TN', 'DSH-Supervisor', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + path.join(os.homedir(), '.local', 'bin', 'dsh-supervisor-gui.exe') + '"']); } catch (e) { errors.push('schtasks logon: ' + e.message); }
        // (b) 每 5 分钟 watchdog 保活（崩溃自动拉起）
        try { execFileSync('schtasks', ['/Create', '/TN', 'DSH-Supervisor-Watchdog', '/SC', 'MINUTE', '/MO', '5', '/RL', 'HIGHEST', '/F', '/TR', 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + watchdogPs1 + '"']); } catch (e) { errors.push('schtasks watchdog: ' + e.message); }
      } else {
        try { execFileSync('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-Watchdog', '/F']); } catch {}
        try { execFileSync('schtasks', ['/Delete', '/TN', 'DSH-Supervisor', '/F']); } catch {}
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

/** GUI 登录自启（Linux 面板 autostart；mac 由 LaunchAgent 一并代管；Windows 由 schtasks 一并代管）。 */
function setGuiAutostart(on) {
  if (!isLinux) return { ok: true, enabled: on, note: process.platform };
  try {
    const file = guiFile();
    if (on) {
      const tpl = path.join(__dirname, '..', '..', '..', 'desktop', 'dsh-supervisor-gui-autostart.desktop');
      let entry = fs.readFileSync(tpl, 'utf8');
      entry = entry.split('@HOME@').join(os.homedir());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const atmp2 = file + '.tmp'; fs.writeFileSync(atmp2, entry); fs.renameSync(atmp2, file); // 原子写
    } else { try { fs.unlinkSync(file); } catch {} }
    return { ok: true, enabled: !!on };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 守护进程执行路径（自启/服务定义使用；安装后 ~/.local/bin/dsh-supervisor 或 dataDir 内）。 */
function daemonCommand() {
  return process.env.DSH_SUPERVISOR_DAEMON || path.join(os.homedir(), '.local', 'bin', 'dsh-supervisor');
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

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand };
