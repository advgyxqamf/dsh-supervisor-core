'use strict';

// 平台进程探测（IO 层：/proc、lsof、netstat、ss、wmic）。
// Linux 用 /proc/net/tcp* 收集 LISTEN inode 再匹配 /proc/<pid>/fd，ss 兜底（异 pidns）；
// macOS 用 lsof；Windows 用 netstat -ano，cmdline 走 wmic 再到 PowerShell CIM 回退。
// 任一步失败返回 null，调用方自行降级；纯解析/归一化在 norm.js。

const fs = require('node:fs');
const ex = require('../../util/exec');
const {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
} = require('./norm');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function linuxListeningInodes(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const x of parseProcNetTcpInodes(txt, port)) inodes.add(x);
  }
  return inodes;
}

function linuxFind(port) {
  try {
    const inodes = linuxListeningInodes(port);
    if (!inodes.size) return null;
    const entries = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
    for (const pid of entries) {
      let fds;
      try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch { continue; }
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { continue; }
        if (inodes.has(link)) return Number(pid);
      }
    }
  } catch {}
  return null;
}

function macFind(port) {
  try {
    const out = ex.runOut('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeoutMs: 3000 });
    if (!out) return null;
    return parseLsofPid(out);
  } catch {}
  return null;
}

function winFind(port) {
  // netstat -ano 解析 LISTENING 行。曾改 PowerShell Get-NetTCPConnection 优先以解 netstat 可见
  // 滞后，但 PowerShell 输出的不确定性使守卫端口占用判定在 win runner 偶发失效，故回退 netstat；
  // relay 建连的可见滞后问题已由 targetReachable（TCP 直连）根治。
  try {
    const out = ex.runOut('netstat', ['-ano'], { timeoutMs: 3000 });
    if (!out) return null;
    return parseNetstatPid(out, port);
  } catch {}
  return null;
}

/** Linux 兜底：/proc fd 扫描在异 pidns（容器/受限 /proc）看不到宿主进程时，用 ss（netlink，
 *  同 netns 可见宿主监听）解析 users 里的 pid —— 否则 findListeningPid 恒 null，误判失联重复拉起。 */
function linuxFindSs(port) {
  // systemd user 环境 PATH 可能不含 /usr/sbin（ss 默认位置）——候选路径逐个试
  const candidates = ['ss', '/usr/sbin/ss', '/usr/bin/ss', '/bin/ss'];
  for (const ssBin of candidates) {
    try {
      const out = ex.runOut(ssBin, ['-tlnHp', 'sport = :' + port], { timeoutMs: 3000 });
      const pid = parseSsPid(out);
      if (pid !== null) return pid;
    } catch {}
  }
  return null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** 读取进程命令行（三平台：Linux /proc、macOS ps、Windows wmic）。原实现非 Linux 返回 null，
 *  使 supervisor._isManagedProcess 在 win/mac 恒 false、接管既有实例的 cmdline 校验静默失效。 */
function readCmdline(pid) {
  if (isLinux) {
    try {
      const buf = fs.readFileSync('/proc/' + pid + '/cmdline');
      return buf.toString('utf8').replace(/\0/g, ' ').trim();
    } catch { return null; }
  }
  if (isMac) {
    try {
      // ps -o command= -p <pid>：输出原始命令行（无标题行）
      const o = ex.runOut('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 3000 });
      return o ? (o.trim() || null) : null;
    } catch { return null; }
  }
  if (isWindows) {
    const out = ex.runOut('wmic', ['process', 'where', 'ProcessId=' + pid, 'get', 'CommandLine', '/value'], { timeoutMs: 5000 });
    // P1-2：wmic 取不到命令行时必须继续走下方回退。原实现在正则不命中时直接 return null，
    // 使回退永远不可达，isDshCmdline 恒 false，Windows 上既不能接管手动启动的 DSH 也不报错。
    // 修法：仅在确实解析出非空命令行时返回，否则继续 PowerShell CIM 回退（缺失/无输出/解析不中同此）。
    const viaWmic = parseWmicCommandLine(out);
    if (viaWmic) return viaWmic;
    {
      const ps = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine";
      const o = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 5000 });
      return parsePowerShellCommandLine(o);
    }
  }
  return null;
}

function pgrepList(pattern) {
  const out = [];
  const readCmd = (pid) => readCmdline(pid) || '';
  try {
    if (isMac) {
      // pgrep -f：BSD 版仅打印 pid（-a 不存在）；拿到的 pid 用 ps 补命令行
      const pids = (ex.runOut('pgrep', ['-f', String(pattern)], { timeoutMs: 3000 }) || '').split(/\r?\n/);
      for (const line of pids) {
        const pid = parseInt(line.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const cmd = readCmd(pid);
        if (!cmd) continue;
        out.push({ pid, cmdline: cmd });
      }
      return out;
    }
    if (isWindows) {
      // Windows 无 pgrep：走 Win32_Process 查询（含 CommandLine），按子串匹配
      const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const j = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 8000 }) || '';
      let arr = [];
      try { arr = JSON.parse(j); if (!Array.isArray(arr)) arr = [arr]; } catch {}
      for (const it of arr) {
        if (!it || !it.ProcessId) continue;
        const pid = Number(it.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const cmd = String(it.CommandLine || '');
        if (!cmd.includes(pattern)) continue;
        out.push({ pid, cmdline: cmd });
      }
      return out;
    }
    // Linux（含 -a 支持）
    const res = ex.runOut('pgrep', ['-af', String(pattern)], { timeoutMs: 3000 }) || '';
    for (const line of res.split(/\r?\n/)) {
      const m = /^(\d+)\s+([\s\S]*)$/.exec(line.trim());
      if (m) out.push({ pid: Number(m[1]), cmdline: m[2] });
    }
  } catch {}
  return out;
}

module.exports = {
  linuxListeningInodes, linuxFind, macFind, winFind, linuxFindSs,
  readCmdline, pgrepList, isAlive,
};
