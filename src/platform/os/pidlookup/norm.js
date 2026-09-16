'use strict';

// pidlookup/norm.js —— 平台输出**纯解析器** + cmdline 归一化（零 IO）。
// DF-3：本文件不 require 任何 IO 模块；DF-6：可独立 require 测试。
// 生产代码直接调用这些解析器（非平行实现）。

// ═══════════════════════════════════════════════════════════════════════════
// 平台输出**纯解析器**（2026-09-13，跨平台架构规范化）
//
// 为什么要单独抽出来：原先各平台的解析**内联在** `macFind`/`winFind`/`linuxFindSs`
// 里，而它们都带 I/O（`ex.runOut` / `fs.readFileSync`）→ 只能在本平台验证。
// 而平台解析恰恰是**跨平台 bug 的藏身处**（本仓真实发生过 Windows wmic 解析落空
// 却**不回退** PowerShell，导致「三端保留 cmdline 防线」的声明在 Windows 上失效）。
//
// 抽成纯函数后：**在任意宿主上都能穷举三种平台格式的解析结果**，
// 且生产代码直接调用它们（不是平行实现 —— 那是"同一事实两处实现"）。
// ═══════════════════════════════════════════════════════════════════════════

/** 解析 `/proc/net/tcp{,6}` 文本 → 该 port 处于 LISTEN(0A) 的 socket inode 集合。
 *  @returns {Set<string>} 形如 `socket:[12345]`（与 /proc/<pid>/fd 的 link 同名） */
function parseProcNetTcpInodes(txt, port) {
  const inodes = new Set();
  for (const lineRaw of String(txt || '').split('\n')) {
    const cols = lineRaw.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1];
    const st = cols[3];
    const inode = cols[9];
    if (!local || !inode) continue;
    const p = local.split(':')[1];
    if (st === '0A' && p && parseInt(p, 16) === port) inodes.add('socket:[' + inode + ']');
  }
  return inodes;
}

/** 解析 macOS `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出 → pid 或 null。
 *  列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME（取首个第 2 列为数字的行）。 */
function parseLsofPid(out) {
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length >= 2 && /^\d+$/.test(m[1])) return Number(m[1]);
  }
  return null;
}

/** 解析 Windows `netstat -ano` 输出 → 监听该 port 的 pid 或 null。
 *  ⚠ 端口必须**整段相等**（`:41000` 不得被 `:4100` 命中）；容忍 CRLF。 */
function parseNetstatPid(out, port) {
  const want = String(port);
  for (const line of String(out || '').split('\n')) {
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
  return null;
}

/** 解析 Linux `ss -tlnHp` 输出 → `users:(("node",pid=123,fd=20))` 里的 pid 或 null。 */
function parseSsPid(out) {
  const m = out && /pid=(\d+)/.exec(String(out));
  return m ? Number(m[1]) : null;
}

/** 解析 Windows `wmic ... get CommandLine /value` 输出 → 命令行或 null。
 *
 *  ⚠ 这是 P1-2 的**回归锚点**：`No Instance(s) Available.`（进程已退出/权限不足）
 *    必须返回 **null**，从而让调用方**继续走 PowerShell CIM 回退**；
 *    旧实现在此直接 `return null` 而**跳过回退** → Windows 上 cmdline 防线静默失效。 */
function parseWmicCommandLine(out) {
  if (!out) return null;
  const m = /CommandLine=([\s\S]*)/.exec(String(out));
  const v = m ? m[1].trim() : '';
  return v || null;
}

/** 解析 PowerShell CIM 的 CommandLine 输出 → 命令行或 null（trim；空串视为未取到）。 */
function parsePowerShellCommandLine(out) {
  const v = out ? String(out).trim() : '';
  return v || null;
}

// 归一化 cmdline 的路径分隔符为 "/"。
// 为什么必须：readCmdline 返回各平台**原生**分隔符（Linux /proc、macOS ps、Windows wmic/ps），
//   而本仓的进程**标记**（daemon-lifecycle 的 _cmdMarks、supervise-view/control-view 的
//   "/domains/..." 字面量）按约定统一为 "/"。直接 indexOf 在 Windows 上**永远不匹配** →
//   认不出自己的 daemon（可能误判端口异主 / 重复拉起）。故比较前两侧都要归一化。
function normCmdline(s) { return String(s || '').replace(/\\/g, '/'); }

module.exports = {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
  normCmdline,
};
