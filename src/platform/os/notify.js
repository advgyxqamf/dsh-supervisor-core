'use strict';

// 平台化桌面通知：三端同一 notify(title, body) 最佳努力接口（失败静默）。
// - Linux：notify-send（现有行为）；
// - macOS：osascript display notification；
// - Windows：PowerShell System.Windows.Forms.NotifyIcon 气泡（无需第三方模块）。

const { spawn } = require('node:child_process');
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/** 桌面通知（最佳努力）：关键事件即使面板没开也能触达用户。
 *  @returns {boolean} 是否成功派发（环境缺失等返回 false）。 */
function notify(title, body, onError) {
  try {
    if (isLinux) {
      const c = spawn('notify-send', ['-a', 'dsh-supervisor', String(title), String(body)], { stdio: 'ignore', detached: true });
      c.on('error', () => { if (onError) onError(); }); c.unref();
      return true;
    }
    if (isMac) {
      // osascript -e 'display notification "body" with title "title"'
      const script = 'display notification ' + JSON.stringify(String(body)) + ' with title ' + JSON.stringify(String(title));
      const c = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      c.on('error', () => { if (onError) onError(); }); c.unref();
      return true;
    }
    if (isWindows) {
      // PowerShell 气泡（调用方需已加载 WinForms；失败静默）
      const ps = [
        '[reflection.assembly]::loadwithpartialname("System.Windows.Forms") | Out-Null',
        '[reflection.assembly]::loadwithpartialname("System.Drawing") | Out-Null',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        '$n.ShowBalloonTip(4000, ' + JSON.stringify(String(title)) + ', ' + JSON.stringify(String(body)) + ', [System.Windows.Forms.ToolTipIcon]::None)',
        'Start-Sleep -Milliseconds 4200',
        '$n.Dispose(); $n.Visible = $false',
      ].join('; ');
      const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
      c.on('error', () => { if (onError) onError(); }); c.unref();
      return true;
    }
    return false;
  } catch { if (onError) onError(); return false; }
}

module.exports = { notify };
