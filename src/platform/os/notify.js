'use strict';

// 平台化桌面通知：三端同一 notify(title, body) 最佳努力接口（失败静默）。
// - Linux：notify-send（现有行为）；
// - macOS：osascript display notification；
// - Windows：PowerShell System.Windows.Forms.NotifyIcon 气泡（无需第三方模块）。

// SSOT §3：异步 spawn 统一封装（固定 windowsHide:true）。
const spawnOS = require('./spawn');

/** AppleScript 字符串字面量转义。
 *  AppleScript 与 JSON 都用反斜杠转义，故 JSON.stringify 恰好等价。 */
function appleScriptString(s) {
  return JSON.stringify(String(s));
}

/** PowerShell **双引号字符串**字面量转义。
 *
 *  2026-09-13 修复（失效模式 b：同一事实两处实现且已分叉）：
 *    PowerShell 的转义**不是**反斜杠 —— 双引号要**双写**（" → ""），
 *    反斜杠在 PowerShell 里是字面字符。而原实现直接复用 JSON.stringify
 *    （产出 "a\"b"）→ PowerShell 在反斜杠处**终止字符串** → 语法错误 →
 *    notify 静默失败（best-effort 的 catch 吞掉）。
 *    即「把 JSON 的转义规则套到 PowerShell 上」——两者**不是同一规则**。
 *    注：反向也成立（AppleScript 确实用反斜杠），故两者必须**分开实现**。 */
function powerShellString(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

/** 平台 → 通知命令（**纯函数，可穷举**；不 spawn、无副作用）。
 *
 *  抽出来的理由与 pidlookup 的解析器同：原实现把「命令构造」与「spawn」揉在一起，
 *  只能在对应平台验证；而**命令构造/转义**恰是跨平台 bug 的藏身处（见上）。
 *  @returns {{cmd:string,args:string[]}|null} null = 该平台无通知机制
 */
function notifyCommand(platform, title, body) {
  const pl = platform || process.platform;
  const t = String(title == null ? '' : title);
  const b = String(body == null ? '' : body);
  if (pl === 'linux') {
    // argv 直传，无 shell → 无转义问题
    return { cmd: 'notify-send', args: ['-a', 'dsh-supervisor', t, b] };
  }
  if (pl === 'darwin') {
    const script = 'display notification ' + appleScriptString(b) + ' with title ' + appleScriptString(t);
    return { cmd: 'osascript', args: ['-e', script] };
  }
  if (pl === 'win32') {
    const ps = [
      '[reflection.assembly]::loadwithpartialname("System.Windows.Forms") | Out-Null',
      '[reflection.assembly]::loadwithpartialname("System.Drawing") | Out-Null',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      '$n.ShowBalloonTip(4000, ' + powerShellString(t) + ', ' + powerShellString(b) + ', [System.Windows.Forms.ToolTipIcon]::None)',
      'Start-Sleep -Milliseconds 4200',
      '$n.Dispose(); $n.Visible = $false',
    ].join('; ');
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  }
  return null;
}

/** 桌面通知（最佳努力）：关键事件即使面板没开也能触达用户。
 *  @returns {boolean} 是否成功派发（环境缺失/平台不支持返回 false）。 */
function notify(title, body, onError) {
  try {
    const plan = notifyCommand(process.platform, title, body);
    if (!plan) return false;
    const c = spawnOS.detachedIgnored(plan.cmd, plan.args);
    c.on('error', () => { if (onError) onError(); });
    c.unref();
    return true;
  } catch { if (onError) onError(); return false; }
}

module.exports = { notify, notifyCommand, appleScriptString, powerShellString };
