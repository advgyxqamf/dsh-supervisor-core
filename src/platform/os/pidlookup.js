'use strict';

// 平台化「监听端口反查 pid」：三端同一接口 findListeningPid(port) → number|null。
// - Linux：/proc/net/tcp* 收集 LISTEN inode → /proc/<pid>/fd 匹配（原 infra/pidlookup 逻辑）；
// - macOS：lsof -nP -iTCP:<port> -sTCP:LISTEN（同步，短超时）；
// - Windows：netstat -ano 解析 LISTENING 行（同步，短超时）。
// 任一步失败返回 null，调用方自行降级。

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/** 收集监听指定端口的所有 socket inode（Linux，IPv4 + IPv6，状态 = LISTEN 0A）。
 *  列序取数据行实测布局：sl(0) local(1) rem(2) st(3) tx:rx(4) tr:when(5) retrnsmt(6)
 *  uid(7) timeout(8) inode(9) …（数据行 17 列，表头为 12 名——表头与行不对齐，勿按表头取列；
 *  2026-09 曾误改表头解析导致 inode 取到第 11 列恒错，回退实测列位并保留 ss 兜底）。 */
function linuxListeningInodes(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const lineRaw of txt.split('\n')) {
      const cols = lineRaw.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1];
      const st = cols[3];
      const inode = cols[9];
      if (!local || !inode) continue;
      const p = local.split(':')[1];
      if (st === '0A' && p && parseInt(p, 16) === port) inodes.add('socket:[' + inode + ']');
    }
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
    // lsof 输出列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const out = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split('\n')) {
      const m = line.trim().split(/\s+/);
      if (m.length >= 2 && /^\d+$/.test(m[1])) return Number(m[1]);
    }
  } catch {}
  return null;
}

function winFind(port) {
  try {
    // netstat 输出例：TCP  127.0.0.1:41000  0.0.0.0:0  LISTENING  12345
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 3000 });
    const want = String(port);
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && (parts[0] === 'TCP' || parts[0] === 'TCPv6') && parts[3] === 'LISTENING') {
        const lp = parts[1];
        const p = lp.slice(lp.lastIndexOf(':') + 1);
        if (p === want) {
          const pid = Number(parts[4]);
          if (Number.isInteger(pid) && pid > 0) return pid;
        }
      }
    }
  } catch {}
  return null;
}

/** Linux 兜底：/proc fd 扫描在异 pidns 环境（容器/受限 /proc）看不到宿主进程时，
 *  用 ss（netlink，同 netns 可见宿主监听）解析 users:(…pid=NN…)——2026-09 实证：run_code 沙箱
 *  见得到 ss 的端口却 /proc 扫描不到宿主 daemon → findListeningPid 恒 null → 误判失联重复拉起。 */
function linuxFindSs(port) {
  // systemd user 环境 PATH 可能不含 /usr/sbin（ss 默认位置）——候选路径逐个试
  const candidates = ['ss', '/usr/sbin/ss', '/usr/bin/ss', '/bin/ss'];
  for (const ssBin of candidates) {
    try {
      const out = execFileSync(ssBin, ['-tlnHp', 'sport = :' + port], { encoding: 'utf8', timeout: 3000 });
      const m = /pid=(\d+)/.exec(out);
      if (m) return Number(m[1]);
    } catch {}
  }
  return null;
}

/** 找到监听 port 的进程 pid；找不到或环境不支持返回 null。 */
function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (isLinux) {
    const a = linuxFind(port);
    if (a !== null && a !== undefined) return a;
    return linuxFindSs(port);
  }
  if (isMac) return macFind(port);
  return winFind(port);
}

/** 进程存活检查（kill 0 信号探测；三平台通用）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** 读取进程命令行（三平台：Linux /proc / macOS ps / Windows wmic）。
 *  2026-09 审计修复：原实现非 Linux 返回 null → supervisor._isManagedProcess 在 win/mac 恒 false，
 *  接管既有实例/停止手动启动 DSH 的 cmdline 校验防线静默失效（既不能接管也不报错）。
 *  现补 mac/win 实现，使防线三端保留。 */
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
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim() || null;
    } catch { return null; }
  }
  if (isWindows) {
    try {
      // wmic process where ProcessId=<pid> get CommandLine /value
      const out = execFileSync('wmic', ['process', 'where', 'ProcessId=' + pid, 'get', 'CommandLine', '/value'], { encoding: 'utf8', timeout: 5000 });
      const m = /CommandLine=([\s\S]*)/.exec(out);
      return m ? m[1].trim() : null;
    } catch {
      // wmic 在新 Windows 弃用：回退 PowerShell CIM
      try {
        const ps = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine";
        return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 5000 }).trim() || null;
      } catch { return null; }
    }
  }
  return null;
}

/** 判断进程命令行是否匹配 DSH 特征（三平台可用）。 */
function isDshCmdline(pid) {
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  return /(^|\s)(node|.*dsh.*)(\s|$)/i.test(cmd) && /dsh/i.test(cmd);
}

module.exports = { findListeningPid, isAlive, readCmdline, isDshCmdline };
