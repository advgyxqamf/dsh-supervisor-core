'use strict';

// 平台化「监听端口反查 pid」：三端同一接口 findListeningPid(port) → number|null。
// - Linux：/proc/net/tcp* 收集 LISTEN inode → /proc/<pid>/fd 匹配（原 infra/pidlookup 逻辑）；
// - macOS：lsof -nP -iTCP:<port> -sTCP:LISTEN（同步，短超时）；
// - Windows：netstat -ano 解析 LISTENING 行（同步，短超时）。
// 任一步失败返回 null，调用方自行降级。

const fs = require('node:fs');
const ex = require('../exec');

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
    const out = ex.runOut('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeoutMs: 3000 });
    if (!out) return null;
    for (const line of out.split('\n')) {
      const m = line.trim().split(/\s+/);
      if (m.length >= 2 && /^\d+$/.test(m[1])) return Number(m[1]);
    }
  } catch {}
  return null;
}

function winFind(port) {
  // netstat -ano 解析 LISTENING 行。
  // 2026-09-10 复盘：曾改 PowerShell Get-NetTCPConnection 优先以解 netstat 可见滞后，但 PowerShell
  // 输出/执行不确定性使守卫「端口占用判定」（smoke.js S9）在 win runner 偶发失效——回退 netstat。
  // relay 建连的可见滞后问题已由 relay/manager targetReachable(TCP 直连) 根治，此处不再承担该职责。
  try {
    // netstat 输出例：TCP  127.0.0.1:41000  0.0.0.0:0  LISTENING  12345
    const out = ex.runOut('netstat', ['-ano'], { timeoutMs: 3000 });
    if (!out) return null;
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
      const out = ex.runOut(ssBin, ['-tlnHp', 'sport = :' + port], { timeoutMs: 3000 });
      const m = out && /pid=(\d+)/.exec(out);
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
      const o = ex.runOut('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 3000 });
      return o ? (o.trim() || null) : null;
    } catch { return null; }
  }
  if (isWindows) {
    // wmic process where ProcessId=<pid> get CommandLine /value
    const out = ex.runOut('wmic', ['process', 'where', 'ProcessId=' + pid, 'get', 'CommandLine', '/value'], { timeoutMs: 5000 });
    // ⚠ P1-2 修复（2026-09-12）：**wmic 取不到命令行时也必须走下方回退**。
    //
    //   缺陷：原实现 `return m ? m[1].trim() : null;` —— 只要 wmic **存在**
    //     （Win10/11 出厂仍在，仅标记弃用）且退出码 0，即便输出是
    //     `No Instance(s) Available.`（进程已退出/权限不足/名称不中），
    //     正则不命中就**直接 return null** → 下方回退**永远不可达**；
    //     而回退上方的注释恰好声称「wmic 失败或在新 Windows 已弃用：回退 PowerShell CIM」。
    //
    //   后果：`isDshCmdline` 恒 false → `_isManagedProcess` 恒 false →
    //     Windows 上**既不能接管手动启动的 DSH、也不给出任何错误**（与「三端保留防线」的声明相反）。
    //
    //   修法：wmic 仅在**确实解析出非空命令行**时返回；否则继续走回退。
    if (out) {
      const m = /CommandLine=([\s\S]*)/.exec(out);
      const viaWmic = m ? m[1].trim() : '';
      if (viaWmic) return viaWmic;
      // 落空 → 继续尝试回退（不再直接 return null）
    }
    // wmic 缺失/不可用/无输出/解析不中：回退 PowerShell CIM
    {
      const ps = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine";
      const o = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 5000 });
      return o ? (o.trim() || null) : null;
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

/**
 * 平台兼容的「按命令行模式匹配进程」：返回 [{pid, cmdline}]。
 * 修复（2026-09）：原多处用 Linux 专属 `pgrep -af <pat>`，在 macOS 的 pgrep（BSD 系）上
 *  -a 选项不存在 → 命令报错被 try/catch 吞掉 → 匹配恒空 → 端口再推导/旧代回收在 mac 静默失效；
 *  Windows 上更无 pgrep 命令。现统一走本函数：
 *  - Linux   用 pgrep -af（兼容）；
 *  - macOS   用 pgrep -f（仅回 pid）+ ps 补 cmdline；
 *  - Windows 用 Win32_Process 查询（ProcessId + CommandLine，同 frpmgr 平台分支）。
 *  pattern 按子串匹配命令行（与旧 pgrep -af 的 "匹配完整命令行" 语义一致，非正则）。
 */
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

module.exports = { findListeningPid, isAlive, readCmdline, isDshCmdline, pgrepList };
