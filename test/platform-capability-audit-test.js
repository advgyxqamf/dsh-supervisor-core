#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 跨平台能力**完整性**审计（2026-09-11）
//
// 目的：把「跨平台能力」从**文字声明**变成**可执行断言**。
//
// 动机（真实事故）：审计发现 macOS 的壳自启/自愈**从项目奠基提交（8867942, 2026-09-01）
//   起就不存在**，而：
//     · 注释声称「mac 由 LaunchAgent 一并代管」（macPlist 从奠基至今逐字节未变、只含守卫）
//     · status() 硬编码 `gui: on`（把守卫自启当成壳自启）
//     · setGuiAutostart 对非 Linux **静默 `return { ok: true }`**
//     · AUDIT-CROSS-PLATFORM.md 给这项打了「三端齐全」
//   四层互相背书，**没有一层验证行为**。
//
// 本测试即是「验证行为」这一层。
//
// 不变量：
//   A1 完整性    每个能力字段对三平台 + 未知平台都有明确布尔值（无 undefined / 无遗漏）
//   A2 声明=true  该能力必须有**实现产物**（源码/机制证据）
//   A3 声明=false 该能力必须**显式报告不支持**（绝不静默成功）
//   A4 行为一致  模块的跨平台行为必须与 capabilityProfile 的声明一致
//   A5 自愈真伪  自愈类能力的声明必须匹配实际机制（不得声称存在而实现被条件屏蔽）
//   A6 无回归    历史错误声明不得重新出现
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const POS = path.join(ROOT, 'src', 'platform', 'os');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readOs = (f) => fs.readFileSync(path.join(POS, f), 'utf8');

/** 剥离注释：A6「历史错误声明不得重现」必须只看**代码**。
 *  ⚠ 修复过程会在注释里**引用旧声明的原文**（用于解释病因），
 *    不剥离就会把解释文字误判为实际代码（首版即因此 3 项误报）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .split('\n')
    .map((l) => {
      // 行注释：需避开字符串内的 //（本仓该场景罕见，此处保守处理：仅剥离行首注释）
      const i = l.indexOf('//');
      if (i < 0) return l;
      // 引号内的 // 不视为注释
      const before = l.slice(0, i);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 1 ? l : before;
    })
    .join('\n');
}

const { capabilityProfile } = require(POS);
const autostart = require(path.join(POS, 'autostart.js'));
const service = require(path.join(POS, 'service.js'));

const PLATFORMS = ['linux', 'darwin', 'win32'];
const UNKNOWN = 'freebsd';
const CAP_FIELDS = [
  'multiInstance', 'pidAdoption', 'processTreeKill', 'desktopNotify', 'autostart', 'frpExpose',
  'guardAutostart', 'guardSelfHeal', 'shellAutostart', 'shellSelfHeal',
];

// ── A1 完整性 ──
console.log('== A1 能力字段完整性（无遗漏 / 无 undefined）==');
{
  for (const pl of PLATFORMS.concat([UNKNOWN])) {
    const r = capabilityProfile(pl, 'x64');
    const missing = CAP_FIELDS.filter((f) => typeof r[f] !== 'boolean');
    check('A1 ' + pl + ' 全部能力字段为布尔值', missing.length === 0, missing.length ? 'missing/非布尔: ' + missing.join(', ') : 'ok');
    check('A1 ' + pl + ' platform/arch 透传', r.platform === pl && r.arch === 'x64', '');
  }
}

// ── A4 autostart 跨平台行为（真实调用，非文本扫描）──
console.log('== A4 autostart 跨平台行为一致性 ==');
{
  // 壳自启：声明必须与行为一致
  const expectShellAutostart = { linux: true, darwin: false, win32: true };
  for (const pl of PLATFORMS) {
    const claimed = capabilityProfile(pl, 'x64').shellAutostart;
    check('A4 ' + pl + ' shellAutostart 声明与 capabilityProfile 一致', claimed === expectShellAutostart[pl], 'claimed=' + claimed);
    let r;
    try { r = autostart.setGuiAutostart(false, pl); } catch (e) { r = { ok: false, threw: e.message }; }
    if (claimed) {
      check('A4 ' + pl + ' 声明可自启 → setGuiAutostart 不报不支持', r && r.unsupported !== true, JSON.stringify(r));
    } else {
      check('A4 ' + pl + ' 声明不可自启 → **显式**报不支持（不得静默 ok:true）',
        r && r.ok === false && r.unsupported === true, JSON.stringify(r));
    }
  }
  // 未知平台一律显式不支持
  const ru = autostart.setGuiAutostart(false, UNKNOWN);
  check('A4 未知平台显式不支持', ru && ru.ok === false && ru.unsupported === true, JSON.stringify(ru));
}

// ── A3 声明=false 必须显式不支持 ──
console.log('== A3 不支持的能力必须显式报告 ==');
{
  // 沙箱多实例：darwin/win32 声明 false → service Provider 必须抛 CapabilityError
  const svcSrc = readOs('service.js');
  check('A3 service.js darwin Provider 为显式不支持', /darwin:\s*makeUnsupported/.test(svcSrc), 'ok');
  check('A3 service.js win32 Provider 为显式不支持', /win32:\s*makeUnsupported/.test(svcSrc), 'ok');
  check('A3 不支持路径抛 CapabilityError（非静默）',
    /throw new CapabilityError/.test(svcSrc), 'ok');
  for (const pl of ['darwin', 'win32']) {
    check('A3 ' + pl + ' multiInstance 声明为 false', capabilityProfile(pl, 'x64').multiInstance === false, '');
  }
  // 未知平台的壳自启必须显式不支持（已在 A4 覆盖行为侧）
}

// ── A2 声明=true 必须有实现产物 ──
console.log('== A2 声明能力必须有实现产物 ==');
{
  const pidSrc = readOs('pidlookup.js');
  check('A2 pidlookup 三平台分支齐全',
    /isLinux/.test(pidSrc) && /isMac/.test(pidSrc) && /isWindows/.test(pidSrc), 'ok');
  const procSrc = readOs('process.js');
  check('A2 process 有 Windows 分支（taskkill 整树）', /taskkill/.test(procSrc), 'ok');
  check('A2 process 有 POSIX 分支（进程组信号）', /kill\(-pid/.test(procSrc), 'ok');
  const notifySrc = readOs('notify.js');
  check('A2 notify 三平台实现',
    /notify-send/.test(notifySrc) && /osascript/.test(notifySrc) && /powershell|NotifyIcon/i.test(notifySrc), 'ok');
  const fpSrc = readOs('file-protect.js');
  check('A2 fileProtect Unix 分支（chmod）', /chmodSync/.test(fpSrc), 'ok');
  check('A2 fileProtect Windows 分支（icacls）', /icacls/.test(fpSrc), 'ok');
  // 守卫自启三平台
  const asSrc = readOs('autostart.js');
  check('A2 守卫自启 Linux（systemctl enable）', /systemctl/.test(asSrc) && /enable/.test(asSrc), 'ok');
  check('A2 守卫自启 macOS（launchctl bootstrap）', /launchctl/.test(asSrc) && /bootstrap/.test(asSrc), 'ok');
  check('A2 守卫自启 Windows（schtasks /Create）', /schtasks/.test(asSrc) && /\/Create/.test(asSrc), 'ok');
  // 壳自启
  check('A2 壳自启 Linux（XDG .desktop）', /autostart/.test(asSrc) && /\.desktop/.test(asSrc), 'ok');
  check('A2 壳自启 Windows（DSH-Supervisor-GUI 任务）', /DSH-Supervisor-GUI/.test(asSrc), 'ok');
}

// ── A5 自愈机制真伪 ──
console.log('== A5 自愈机制真实性 ==');
{
  const asSrc = readOs('autostart.js');
  // 守卫自愈：macOS KeepAlive
  const plist = asSrc.match(/function macPlist[\s\S]*?\n}/);
  check('A5 macOS 守卫自愈 plist 含 KeepAlive', !!plist && /KeepAlive/.test(plist[0]), 'ok');
  check('A5 macOS 守卫自愈 plist 含 RunAtLoad', !!plist && /RunAtLoad/.test(plist[0]), 'ok');
  // 壳自愈 Windows：shell 检查必须**独立于** `if (-not $up)` 块
  const ps = asSrc.match(/const ps = \[[\s\S]*?\]\.join/);
  check('A5 Windows watchdog 脚本存在', !!ps, 'ok');
  if (ps) {
    const script = ps[0];
    const idxUpBlock = script.indexOf('if (-not $up)');
    const idxGuiCheck = script.indexOf('if (-not $g');
    check('A5 Windows 壳检查**未**嵌套在守卫块内（壳崩/守卫活时可自愈）',
      idxUpBlock >= 0 && idxGuiCheck > 0 && idxGuiCheck > idxUpBlock,
      'up@' + idxUpBlock + ' gui@' + idxGuiCheck);
    check('A5 Windows watchdog 定时存在（schtasks MINUTE）', /\/SC',\s*'MINUTE'/.test(asSrc) || /MINUTE/.test(asSrc), 'ok');
  }
  // 声明为 true 的平台必须有对应机制
  check('A5 win32 shellSelfHeal 声明为 true 且机制存在',
    capabilityProfile('win32', 'x64').shellSelfHeal === true && !!ps, 'ok');
}

// ── A6 无回归：历史错误声明不得重现 ──
console.log('== A6 历史错误声明不得重现 ==');
{
  const asCode = stripComments(readOs('autostart.js'));  // ⚠ 只看代码，不看注释
  check('A6 无「mac 由 LaunchAgent 一并代管」的假声明', !/mac 由 LaunchAgent 一并代管/.test(asCode), 'ok');
  check('A6 无「同 plist 附带」的假声明（GUI 从未在 plist 中）', !/同 plist 附带/.test(asCode), 'ok');
  check('A6 无 setGuiAutostart 的静默成功分支',
    !/if \(!isLinux\) return \{ ok: true/.test(asCode), 'ok');
  // macOS status().gui 不得再谎报
  const macStatus = asCode.match(/if \(isMac\) \{[\s\S]*?return \{[^}]*\};/);
  check('A6 macOS status() 不再把守卫自启当作壳自启（gui: on）',
    !!macStatus && !/gui:\s*on/.test(macStatus[0]), macStatus ? macStatus[0].replace(/\s+/g, ' ').slice(0, 80) : '未找到');
  // Linux .desktop 的 Exec 不得硬编码 ~/.local/bin
  check('A6 Linux .desktop Exec 按实际安装解析（不硬编码 .local/bin）',
    /guiCommand\(\)/.test(asCode) && /oldExec/.test(asCode), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);