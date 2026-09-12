#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 自启所有权与 macOS 原生壳自启（2026-09-11）
//
// 背景（本次修复的两类缺陷）：
//   1. **双写冲突**：内核与桌面壳**同时写** macOS 的 com.dsh.supervisor.plist；
//      且内核 disable 时 unlink 该文件，而壳下次启动会重建并 bootstrap →
//      **用户「关闭自启」不生效**。
//   2. **macOS 无壳自启**：旧注释谎称「同 plist 附带」，实测 plist 只含守卫。
//
// 不变量（本测试锁定）：
//   P1 标签分离：守卫 com.dsh.supervisor（壳所有） ≠ GUI com.dsh.supervisor.gui（内核所有）
//   P2 内核不写/不删守卫 plist（只 enable/disable + bootstrap/bootout）
//   P3 GUI plist 只表达「登录启动」：RunAtLoad + Aqua，**无 KeepAlive**（崩溃归看护）
//   P4 GUI 自启在无法定位壳可执行文件时**不盲写**（否则登录时静默失败）
//   P5 未知平台显式不支持（绝不静默成功）
//
// 全部离线：只做源码与纯函数断言，不调用 launchctl、不写真实 LaunchAgents。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const POS = path.join(ROOT, 'src', 'platform', 'os');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const asSrc = fs.readFileSync(path.join(POS, 'autostart.js'), 'utf8');
const autostart = require(path.join(POS, 'autostart.js'));

// ── P1 标签分离 ──
console.log('== P1 LaunchAgent 标签分离 ==');
{
  const g = (asSrc.match(/GUARD_LABEL\s*=\s*'([^']+)'/) || [])[1];
  const u = (asSrc.match(/GUI_LABEL\s*=\s*'([^']+)'/) || [])[1];
  check('P1-a 两个标签均显式声明', !!g && !!u, g + ' / ' + u);
  check('P1-b 标签不同（防争抢同一 plist）', g !== u, 'ok');
  check('P1-c GUI 为守卫的子标签（归属清晰）', u === g + '.gui', String(u));
}

// ── P2 所有权：内核不越权 ──
console.log('== P2 内核不写/不删守卫 plist ==');
{
  // ⚠ 切片必须在 **setAutostart 函数内**定位 macOS 分支：
  //   若从文件首个 `if (isMac) {`（在 status()）起切，会跨过整个 Windows 分支
  //   （其中确有 writeFileSync/unlinkSync 操作 watchdog.ps1）→ 误报。
  const fnStart = asSrc.indexOf('function setAutostart(');
  const macStart = asSrc.indexOf('if (isMac) {', fnStart);
  const macEnd = asSrc.indexOf('// Linux（systemd', macStart);
  const mac = asSrc.slice(macStart, macEnd > macStart ? macEnd : asSrc.length);
  check('P2-0 已正确切出 setAutostart 的 macOS 分支', macStart > fnStart && macEnd > macStart,
    'fnStart=' + fnStart + ' macStart=' + macStart + ' macEnd=' + macEnd);
  check('P2-a macOS 分支不写守卫 plist', !/writeFileSync\([^)]*GUARD_LABEL/.test(mac) && !/renameSync/.test(mac), 'ok');
  check('P2-b macOS 分支不删除守卫 plist', !/unlinkSync/.test(mac), 'ok');
  check('P2-c 守卫定义缺失时**显式报错**（不静默、不越权创建）',
    /守卫服务定义缺失/.test(mac), 'ok');
  check('P2-d 用 launchctl enable/disable 持久化开关', /on \? 'enable' : 'disable'/.test(asSrc), 'ok');
  check('P2-e 守卫定义模板已不再是内核资产（macPlist 已删）', !/function macPlist/.test(asSrc), 'ok');
  // 壳侧必须仍持有守卫 plist 模板（否则两边都没了 → 功能真空）
  const svc = path.join(ROOT, '..', 'dsh-supervisor-launcher', 'src-tauri', 'src', 'service.rs');
  if (fs.existsSync(svc)) {
    const s = fs.readFileSync(svc, 'utf8');
    check('P2-f 壳仍持有守卫 plist 模板（KeepAlive + RunAtLoad）',
      /KeepAlive/.test(s) && /RunAtLoad/.test(s), 'ok');
    check('P2-g 壳的 plist 路径与内核 GUARD_LABEL 一致',
      /com\.dsh\.supervisor\.plist/.test(s), 'ok');
  } else {
    console.log('SKIP P2-f/P2-g（壳仓不在同级目录）');
  }
}

// ── P3 GUI plist 内容约束 ──
console.log('== P3 GUI plist 只表达「登录启动」==');
{
  const m = asSrc.match(/function macGuiPlist\(([\s\S]*?)\n}/);
  check('P3-a macGuiPlist 存在', !!m, 'ok');
  if (m) {
    const body = m[0];
    check('P3-b 含 RunAtLoad', /RunAtLoad/.test(body), 'ok');
    check('P3-c **不含** KeepAlive（崩溃归守卫看护，避免两套机制争抢）', !/KeepAlive/.test(body), 'ok');
    check('P3-d 限定 Aqua 会话', /LimitLoadToSessionType/.test(body) && /Aqua/.test(body), 'ok');
    // ⚠ 2026-09-12 更新（P3 转义修复）：下面两条原先是**错的**，把缺陷当成了要求 ——
    //   · P3-e 断言 `+ GUI_LABEL +`（裸拼接），但正确做法是经 xmlEscape（防 Label 含特殊字符）；
    //   · P3-f 断言 `replace(/"/g, ...)`，而那是 **JSON 转义**：XML 文本节点里 `"` 本就合法，
    //     真正会破坏 XML 的 `&`/`<`/`>` 完全没处理。测试锁定了错误实现，故修复后会红。
    //   现改为断言**真正的 XML 转义**。
    check('P3-e Label 经 xmlEscape（而非裸拼接）',
      /xmlEscape\(\s*GUI_LABEL\s*\)/.test(body), 'ok');
    check('P3-f 可执行路径经 xmlEscape（XML 真规则：& < >）',
      /xmlEscape\(\s*guiExe\s*\)/.test(body), 'ok');
    check('P3-f2 plist 内不再有把双引号当 XML 转义的旧写法',
      !/replace\(\/"\/g/.test(body), 'ok');
    check('P3-g 输出 stderr/stdout 落 ~/.dsh/shell（与壳同域，便于排障）',
      /\.dsh.*shell/.test(body) || /'shell'/.test(body), 'ok');
  }
}

// ── P4/P5 行为（纯参数调用，不触真实系统）──
console.log('== P4/P5 边界行为 ==');
{
  // 关闭：任何平台都必须是幂等且不抛
  for (const pl of ['linux', 'darwin', 'win32']) {
    let r;
    try { r = autostart.setGuiAutostart(false, pl); } catch (e) { r = { threw: e.message }; }
    check('P4 ' + pl + ' 关闭壳自启不抛且置 enabled=false', !r.threw && r.enabled === false, JSON.stringify(r));
  }
  // 未知平台：显式不支持（不静默成功）
  const u = autostart.setGuiAutostart(true, 'freebsd');
  check('P5 未知平台显式 unsupported', u.ok === false && u.unsupported === true, JSON.stringify(u));
  // darwin 不再返回 unsupported（已实现）
  const d = autostart.setGuiAutostart(false, 'darwin');
  check('P5 darwin 不再是 unsupported（已实现原生自启）', d.unsupported !== true && d.via === 'launchagent', JSON.stringify(d));
  // status() 的 guiSupported 在 darwin 必须为 true
  const st = autostart.status();
  // ⚠ 2026-09-12 修正：本条原为 `typeof st.guiSupported === 'boolean' || st.guiSupported === undefined`
  //   —— **恒真断言**（undefined 也通过，等于什么都没检查）。
  //   经复核该字段本身是死声明（仅 macOS 分支产出、全仓零消费），已从源码删除；
  //   故本断言改为检查**真实契约**：status() 至少要有 kind 与非 undefined 的 on。
  check('P5 status() 返回 kind 与布尔 on（真实契约）',
    typeof st.kind === 'string' && st.kind.length > 0 && typeof st.on === 'boolean',
    'kind=' + st.kind + ' on=' + st.on);
  check('P5b status() 不再产出已删除的死字段 guiSupported',
    st.guiSupported === undefined, String(st.guiSupported));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);