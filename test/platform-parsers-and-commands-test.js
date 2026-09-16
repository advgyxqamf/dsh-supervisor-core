#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台「输出解析 + 命令构造 + 会话判定」可移植性穷举门禁（2026-09-13）
//
// 承接 platform-layer-portability-test：把**剩余平台层模块**的平台相关逻辑
// 也在任意宿主上穷举。
//
// 为使逻辑可穷举，本次**抽出了纯函数并让生产代码直接调用**（非平行实现）：
//   · pidlookup.js：parseProcNetTcpInodes / parseLsofPid / parseNetstatPid /
//                   parseSsPid / parseWmicCommandLine / parsePowerShellCommandLine
//   · notify.js   ：notifyCommand / appleScriptString / powerShellString
//   （原先把「解析/构造」与「I/O / spawn」揉在一起 → 只能在对应平台验证，
//     而平台解析与转义恰是跨平台 bug 的藏身处。）
//
// ## 本次同时修掉的真实缺陷（失效模式 b：同一事实两处实现且已分叉）
//
// **PowerShell 字符串转义被套用了 JSON 规则**：notify.js 的 Windows 分支用
//   JSON.stringify 构造标题/正文（产出 "a\"b"），而 PowerShell 的双引号字符串
//   用**双写**转义（"a""b"），反斜杠是字面字符 → PowerShell 在反斜杠处**终止字符串**
//   → 语法错误 → notify 静默失败（best-effort 的 catch 吞掉）。
//   AppleScript 确实用反斜杠，故两平台**必须分开实现**（不可复用同一 helper）。
//
// ## 锁定不变量
//   Y-1  pidlookup：三种平台格式的解析结果正确（含端口整段匹配、CRLF 容忍）
//   Y-2  **P1-2 回归锚点**：wmic 输出 "No Instance(s) Available." 必须返回 null
//        （⇒ 调用方继续走 PowerShell CIM 回退；旧实现直接 return null 跳过回退）
//   Y-3  notify：平台→命令映射正确；**转义规则按平台区分**（AppleScript 反斜杠 /
//        PowerShell 双写）；不支持平台返回 null
//   Y-4  desktop：sessionAvailable 是三个探针的**或**，且方式探针尊重 XDG_RUNTIME_DIR；
//        darwin/win32 恒真（会话由启动器限定）
//   Y-5  反向：判据能识别错误转义 / 空 wmic 误判（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const pid = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
const notify = require(path.join(ROOT, 'src', 'platform', 'os', 'notify.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

// ── Y-1：三平台监听者解析 ──
{
  // Windows netstat -ano（真实形态：CRLF；IPv6 行；非 LISTENING 行）
  const netstat = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:2800         0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:28101        0.0.0.0:0              ESTABLISHED     777',
    '  TCP    [::1]:28100            [::]:0                 LISTENING       12345',
    '  TCPv6  [::]:28102             [::]:0                 LISTENING       555',
  ].join(CRLF);
  check('Y-1 netstat：命中 LISTENING 行取 pid', pid.parseNetstatPid(netstat, 28100) === 12345, String(pid.parseNetstatPid(netstat, 28100)));
  check('Y-1 netstat：端口**整段**匹配（:28100 不被 :2800 误命中）',
    pid.parseNetstatPid(netstat, 2800) === 9999, String(pid.parseNetstatPid(netstat, 2800)));
  // ⚠ 严格判据：夹具里**只有** :28100，却询问 :2800 → 必须 null。
  //   贪婪子串匹配（indexOf）会错误返回 :28100 那行的 pid —— 这一条专门抓它。
  const onlyLonger = '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345'
    + CRLF + '  TCP    127.0.0.1:12800        0.0.0.0:0              LISTENING       22222';
  check('Y-1 netstat：**严格判据** 只有 :12800 / :28000 时询问 :2800 → null（抓贪婪匹配）',
    pid.parseNetstatPid(onlyLonger, 2800) === null, String(pid.parseNetstatPid(onlyLonger, 2800)));
  check('Y-1 netstat：同一夹具询问 :28100 → 12345',
    pid.parseNetstatPid(onlyLonger, 28100) === 12345, String(pid.parseNetstatPid(onlyLonger, 28100)));
  check('Y-1 netstat：同一夹具询问 :12800 → 22222（前缀/后缀干扰都不命中）',
    pid.parseNetstatPid(onlyLonger, 12800) === 22222, String(pid.parseNetstatPid(onlyLonger, 12800)));
  check('Y-1 netstat：非 LISTENING 行忽略（28101 是 ESTABLISHED）',
    pid.parseNetstatPid(netstat, 28101) === null, String(pid.parseNetstatPid(netstat, 28101)));
  check('Y-1 netstat：TCPv6 行也解析', pid.parseNetstatPid(netstat, 28102) === 555, String(pid.parseNetstatPid(netstat, 28102)));
  check('Y-1 netstat：无匹配返回 null', pid.parseNetstatPid(netstat, 28999) === null, 'null');
  check('Y-1 netstat：空/undefined 安全', pid.parseNetstatPid('', 80) === null && pid.parseNetstatPid(undefined, 80) === null, 'ok');

  // macOS lsof
  const lsof = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    12345 bowen   20u  IPv4 0x1a2b3c4d5e6f7a8b      0t0  TCP 127.0.0.1:28107 (LISTEN)',
  ].join(LF);
  check('Y-1 lsof：取第 2 列数字为 pid', pid.parseLsofPid(lsof) === 12345, String(pid.parseLsofPid(lsof)));
  check('Y-1 lsof：仅表头（无数字列）返回 null',
    pid.parseLsofPid('COMMAND   PID USER   FD') === null, 'null');

  // Linux ss -tlnHp
  const ssOut = 'LISTEN 0      511          0.0.0.0:28107      0.0.0.0:*    users:(("node",pid=12345,fd=20))';
  check('Y-1 ss：从 users:(...pid=N...) 取 pid', pid.parseSsPid(ssOut) === 12345, String(pid.parseSsPid(ssOut)));
  check('Y-1 ss：无 pid 段返回 null',
    pid.parseSsPid('LISTEN 0 511 0.0.0.0:28107 0.0.0.0:*') === null, 'null');

  // Linux /proc/net/tcp（0A = LISTEN；端口十六进制）
  const procTcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:6DCB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:6DCC 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 100 0 0 10 0',
  ].join(LF);
  const inodes = pid.parseProcNetTcpInodes(procTcp, 0x6DCB);
  check('Y-1 /proc/net/tcp：仅 0A(LISTEN) 且端口匹配的 inode 入集',
    inodes.size === 1 && inodes.has('socket:[424242]'), JSON.stringify([...inodes]));
  check('Y-1 /proc/net/tcp：非 LISTEN(01) 行被排除',
    pid.parseProcNetTcpInodes(procTcp, 0x6DCC).size === 0, '0');
}

// ── Y-2：P1-2 回归锚点 —— wmic 空输出必须回退 ──
{
  check('Y-2 wmic 正常输出：取出 CommandLine 并 trim',
    pid.parseWmicCommandLine('CommandLine=node.exe --flag  ' + CRLF + CRLF) === 'node.exe --flag',
    JSON.stringify(pid.parseWmicCommandLine('CommandLine=node.exe --flag  ' + CRLF + CRLF)));
  // 内部换行**保留**（只 trim 两端）——命令行本身可能含换行
  check('Y-2 wmic 多行命令行保留内部换行',
    pid.parseWmicCommandLine('CommandLine=a' + CRLF + 'b') === 'a' + CRLF + 'b',
    JSON.stringify(pid.parseWmicCommandLine('CommandLine=a' + CRLF + 'b')));
  // ⚠ 核心：进程已退出/权限不足时 wmic 输出这个 → 必须 null（⇒ 调用方走 CIM 回退）
  const noInstance = 'No Instance(s) Available.';
  check('Y-2 **P1-2 锚点**：wmic 输出 No Instance(s) Available. → null（触发 CIM 回退）',
    pid.parseWmicCommandLine(noInstance) === null, JSON.stringify(pid.parseWmicCommandLine(noInstance)));
  check('Y-2 wmic 输出 CommandLine=（空值）→ null（同样触发回退）',
    pid.parseWmicCommandLine('CommandLine=') === null, 'null');
  check('Y-2 wmic 无输出 → null', pid.parseWmicCommandLine('') === null && pid.parseWmicCommandLine(null) === null, 'ok');
  check('Y-2 PowerShell CIM 输出 trim；空串 → null',
    pid.parsePowerShellCommandLine('  node.exe x  ') === 'node.exe x'
    && pid.parsePowerShellCommandLine('   ') === null, 'ok');
}

// ── Y-3：notify 平台→命令映射 + 转义规则区分 ──
{
  const L = notify.notifyCommand('linux', 'T', 'B');
  check('Y-3 linux → notify-send，标题/正文作为 argv（无 shell 转义面）',
    L && L.cmd === 'notify-send' && L.args[2] === 'T' && L.args[3] === 'B', JSON.stringify(L));
  const D = notify.notifyCommand('darwin', 'T', 'B');
  check('Y-3 darwin → osascript -e display notification',
    D && D.cmd === 'osascript' && /^display notification /.test(D.args[1]) && /with title /.test(D.args[1]), D && D.args[1]);
  const W = notify.notifyCommand('win32', 'T', 'B');
  check('Y-3 win32 → powershell -NoProfile -NonInteractive -Command',
    W && W.cmd === 'powershell' && W.args[0] === '-NoProfile' && /ShowBalloonTip/.test(W.args[3]), W && W.cmd);
  check('Y-3 不支持平台 → null（notify 返回 false，不静默谎报已派发）',
    notify.notifyCommand('freebsd', 'T', 'B') === null, 'null');

  // ⚠ 转义：两平台规则**不同**，必须分开实现（本次修复的正是"套用 JSON 规则"）
  const Q = String.fromCharCode(34);
  const raw = 'a' + Q + 'b';
  check('Y-3 AppleScript 转义用反斜杠（JSON 规则恰好等价）',
    notify.appleScriptString(raw) === Q + 'a' + String.fromCharCode(92) + Q + 'b' + Q,
    notify.appleScriptString(raw));
  check('Y-3 **PowerShell 转义用双写**（不是反斜杠）',
    notify.powerShellString(raw) === Q + 'a' + Q + Q + 'b' + Q,
    notify.powerShellString(raw));
  check('Y-3 两者产出**不同**（证明不可复用同一 helper）',
    notify.appleScriptString(raw) !== notify.powerShellString(raw), '已区分');
  // 端到端：win32 命令里不得出现反斜杠转义形态
  const wQ = notify.notifyCommand('win32', raw, raw);
  check('Y-3 win32 命令里标题用双写而**不含** \\" 形态',
    wQ.args[3].indexOf('ShowBalloonTip(4000, ' + Q + 'a' + Q + Q + 'b' + Q) >= 0, 'ok');
}

/** 子进程伪造 platform + env 后执行（模块级：Y-4 与 Y-5 都要用）。 */
function underFakeEnv(platform, env, body) {
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    Object.entries(env).map(([k, v]) => (v === null
      ? ("delete process.env." + k + ";")
      : ("process.env." + k + " = " + JSON.stringify(v) + ";"))).join(LF),
    body,
  ].join(LF);
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, cwd: ROOT }).trim();
  } catch (e) { return 'EXECFAIL:' + ((e && e.message) || e); }
}

// ── Y-4：desktop 会话判定 ──
{
  const BODY = [
    "const d = require('./src/platform/os/desktop.js');",
    "const s = d.describe();",
    "process.stdout.write(JSON.stringify(s));",
  ].join(LF);

  for (const p of ['darwin', 'win32']) {
    const out = underFakeEnv(p, { DISPLAY: null, WAYLAND_DISPLAY: null }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    check('Y-4 ' + p + ' 恒为可用（会话由启动器限定）且 reason=session-scoped-by-launcher',
      !!j && j.available === true && j.reason === 'session-scoped-by-launcher', out.slice(0, 70));
  }
  {
    const out = underFakeEnv('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    check('Y-4 linux + DISPLAY → 可用且 reason=env(...)',
      !!j && j.available === true && j.reason === 'env(DISPLAY/WAYLAND_DISPLAY)', out.slice(0, 90));
  }
  {
    // 空 XDG_RUNTIME_DIR → wayland 探针必须为假（尊重该变量）；x11 探针取决于宿主
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
    const out = underFakeEnv('linux', { DISPLAY: null, WAYLAND_DISPLAY: null, XDG_RUNTIME_DIR: empty }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    const hasX = (() => { try { return fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f)); } catch { return false; } })();
    check('Y-4 linux：available === (env || x11套接字 || wayland套接字) —— 逻辑等价（任意宿主成立）',
      !!j && j.available === hasX, out.slice(0, 110));
    check('Y-4 linux + 空 XDG_RUNTIME_DIR：reason 不含 wayland-socket（尊重该变量）',
      !!j && (hasX ? j.reason === 'x11-socket' : j.reason === 'none'), j ? j.reason : out.slice(0, 60));
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

// ── Y-5：反向（判据必须能识别违规）──
{
  const Q = String.fromCharCode(34);
  check('Y-5 反向：判据能识别"把 JSON 规则套到 PowerShell"的旧形态',
    (Q + 'a' + String.fromCharCode(92) + Q + 'b' + Q) !== notify.powerShellString('a' + Q + 'b'), 'hit');
  check('Y-5 反向：判据能识别"空 wmic 被当成有值"',
    pid.parseWmicCommandLine('No Instance(s) Available.') !== 'No Instance(s) Available.', 'hit');
  check('Y-5 反向：端口整段匹配判据有效（:2800 与 :28100 不同）',
    pid.parseNetstatPid('  TCP  127.0.0.1:2800  0.0.0.0:0  LISTENING  1', 28100) === null, 'hit');
  check('Y-5 反向：underFakeEnv 确实伪造了 platform',
    underFakeEnv('win32', {}, "process.stdout.write(process.platform)") === 'win32', 'ok');
}

const failed = results.filter((r) => !r);
console.log(LF + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
