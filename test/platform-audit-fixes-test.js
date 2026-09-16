#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// platform 层审计修复的回归（第七轮，2026-09-12）
//
// ## 缺陷
//
// P1-1 `loghub.js` 有 4 处 `this._log('warn', …)` 调用，**从未定义 `_log`**：
//   与 `markNetFail` 同型（声明了调用、方法不存在）。但它是**抛异常**而非 no-op：
//     `_ingest` 在「写盘失败」这一唯一应触发分支先调 `_log` → TypeError →
//     被同一条 try 的 catch 捕获 → catch 里再调 `_log` → 再抛 → 逃出整个 for 循环。
//     结果不是「水位不推进、下轮补齐」，而是**该批剩余事件丢弃 + 告警也丢失**。
//
// P1-2 `pidlookup.readCmdline` 的 Windows PowerShell 回退**不可达**：
//   wmic 存在但解析不中时直接 `return null`，而注释声称「wmic 失败…回退 PowerShell」。
//
// P2-1 `file-protect.writePrivate` 丢弃 `protectFile` 失败，无条件返回 ok:true。
//
// P2-2 `hasTool` 负结果**永久缓存** → 沙箱能力可能永久为假；
//   且 `instance/index.js` 构造期冻结 `sandboxSupported`。
//
// P2-4 Linux `.desktop` 的 `Exec=` 未按规范把字面 `%` 写成 `%%`。
//
// ## 锁定不变量
//   H-a  EventHub 定义 _log，且 4 处调用都在（不得再出现「调用无定义」）
//   H-b  readCmdline 的 PowerShell 回退在 wmic 解析不中时**可达**
//   H-c  writePrivate 传播保护失败（不再无条件 ok:true）
//   H-d  hasTool 负结果有 TTL；sandboxSupported 是实时 getter（非冻结字段）
//   H-e  .desktop Exec 转义覆盖 `%` → `%%`
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── H-a：loghub 的 _log ──
{
  const src = read('src/platform/service/log/hub.js');
  check('H-a EventHub 定义了 _log 方法', /\n  _log\(level, msg\) \{/.test(src), '有');
  // ⚠ 剥离注释行再统计 —— 说明文字里会引用 `this._log('warn', …)`（我第一版就数成 5）。
  const codeOnly = src.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  const calls = (codeOnly.match(/this\._log\(/g) || []).length;
  check('H-a 4 处调用仍在（仅补定义，未删调用）', calls === 4, calls + ' 处');
  // 行为级：pushGuard 写盘失败时不得抛异常，且告警到达 logger
  const { EventHub } = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'hub.js'));
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubh-'));
  const warned = [];
  const hub = new EventHub({
    stateDir: dir,
    guardEvents: { seq: 0, readSince: () => [] },
    logger: { warn: (m) => warned.push(m), info() {}, debug() {}, error() {} },
  });
  hub.writer.appendRaw = () => { hub.writer._lastAppendOk = false; };
  let threw = null;
  try { hub.pushGuard({ type: 'x', seq: 1, data: {} }); } catch (e) { threw = e; }
  check('H-a 行为：写盘失败分支不抛异常', threw === null, threw ? threw.message : '无');
  check('H-a 行为：告警确实到达 logger（此前被异常吞掉）', warned.length === 1, warned.length + ' 条');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── H-b：readCmdline 回退可达 ──
{
  // ⚠ 2026-09-17 域结构改造：pidlookup 拆为目录 —— 按目录聚合读取（H-b 覆盖面不变）。
  const PID_DIR = path.join(ROOT, 'src', 'platform', 'os', 'pidlookup');
  const src = fs.readdirSync(PID_DIR).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(PID_DIR, f), 'utf8')).join(String.fromCharCode(10));
  const i = src.indexOf('if (isWindows) {');
  const seg = src.slice(i, i + 1600);
  check('H-b wmic 解析不中时不再直接 return null',
    !/const m = \/CommandLine=\(\[\\s\\S\]\*\)\/\.exec\(out\);\s*\n\s*return m \? m\[1\]\.trim\(\) : null;/.test(seg),
    '已改');
  check('H-b 保留了 PowerShell CIM 回退', /Get-CimInstance Win32_Process/.test(seg), '有');
  check('H-b 回退在 wmic 分支之后（可达）',
    seg.indexOf('Get-CimInstance') > seg.indexOf('wmic process where'), '顺序正确');
}

// ── H-c：writePrivate 传播失败 ──
{
  const src = read('src/platform/os/file-protect.js');
  const m = src.match(/function writePrivate\(file, data\) \{[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  check('H-c writePrivate 检查 protectFile 返回值',
    /const p1 = protectFile\(tmp\)/.test(body) && /const p2 = protectFile\(file\)/.test(body), '有');
  check('H-c 保护失败时返回 ok:false（不再无条件成功）',
    /p1 && p1\.ok === false/.test(body) && /p2 && p2\.ok === false/.test(body), '有');
  // ⚠ 顺序断言（我第一版修复时踩过）：`const p2 = ...` 必须在 `if (p2 ...)` **之前**，
  //   否则 TDZ 抛 'Cannot access p2 before initialization' —— 且只在成功路径暴露。
  const iP2Decl = body.indexOf('const p2 = protectFile(file)');
  const iP2Use = body.indexOf('if (p2 && p2.ok === false)');
  check('H-c p2 声明先于使用（避免 TDZ）',
    iP2Decl >= 0 && iP2Use > iP2Decl, 'decl@' + iP2Decl + ' use@' + iP2Use);
  // 行为级：成功路径必须真的返回 ok:true（上面的 TDZ 只在此路径暴露）
  {
    const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'));
    const os = require('node:os');
    const probe = path.join(os.tmpdir(), 'wp-probe-' + process.pid + '.json');
    const r = fp.writePrivate(probe, '{"a":1}');
    check('H-c 行为：成功写入返回 ok:true', r && r.ok === true, JSON.stringify(r));
    check('H-c 行为：文件确实存在', fs.existsSync(probe), '存在');
    try { fs.rmSync(probe, { force: true }); } catch {}
  }
}

// ── H-d：能力缓存 TTL + 实时 getter ──
{
  const osIdx = read('src/platform/os/index.js');
  check('H-d hasTool 负结果有 TTL（_NEG_TTL_MS）', /_NEG_TTL_MS/.test(osIdx), '有');
  check('H-d 正结果仍永久缓存（工具装好不会自己消失）', /if \(hit === true\) return true/.test(osIdx), '有');
  // ⚠ 2026-09-16 步骤8a（DIRECTORY-STRUCTURE-DESIGN §4.5）：instance 域已拆为
  //   core/ops/upgrade + index 门面（getter 留在 core.js 的 class 内）。本组断言的对象
  //   是「域」的 sandboxSupported 纪律，故按域聚合读取，判据不搬走。
  const inst = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
    .join(String.fromCharCode(10));
  check('H-d sandboxSupported 是实时 getter', /get sandboxSupported\(\)/.test(inst), '有');
  check('H-d 不再是构造期冻结字段',
    !/this\.sandboxSupported = /.test(inst.replace(/\/\/.*/g, '')), '已改');
  check('H-d 测试覆写经显式方法（非 setter，防生产误写）',
    /_setSandboxSupportedForTest\(v\)/.test(inst), '有');
}

// ── H-e：.desktop 的 % 转义 ──
{
  // ⚠ 2026-09-17 域结构改造：execQuote 落 autostart/linux.js（Linux XDG 自启）。
  const src = read('src/platform/os/autostart/linux.js');
  const i = src.indexOf('const execQuote');
  const j = src.indexOf(";", src.indexOf("+ '\"'", i));
  check('H-e execQuote 应用了 %% 转义', src.slice(i, j).includes("replace(/%/g, '%%')"), '有');
  // 行为级：求值该表达式并验证边界
  try {
    const execQuote = eval('(' + src.slice(i + 'const execQuote = '.length, j) + ')');
    const esc = execQuote('/home/100%user/b/dsh');
    const plain = execQuote('/home/a b/b/dsh');
    check('H-e 行为：字面 % 被写成 %%', esc.includes('%%') && !/%/.test(esc.split('%%').join('')), esc);
    check('H-e 行为：含空格路径仍被引号界定', /^".*"$/.test(plain), plain);
  } catch (e) { check('H-e 行为：execQuote 可求值', false, e.message); }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);