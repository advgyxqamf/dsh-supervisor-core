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
// ⚠ 2026-09-17 域结构改造：autostart 已拆为 autostart/{index,win32,darwin,linux}.js ——
//   按目录聚合读取，P1/P3/P6 判据的覆盖面不因切分而静默失效。
const AUTO = path.join(POS, 'autostart');
const asSrc = fs.readdirSync(AUTO).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(AUTO, f), 'utf8')).join(String.fromCharCode(10));
const autostart = require(AUTO);

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
  // ⚠ 2026-09-17 域结构改造：macOS setAutostart 落 autostart/darwin.js —— 切出该实现函数体，
  //   避免跨过 Windows 分支（其中确有 writeFileSync 操作）造成误报。
  const mac = (fs.readFileSync(path.join(AUTO, 'darwin.js'), 'utf8').match(/function setAutostart\([\s\S]*?\n\}/) || [''])[0];
  check('P2-0 已正确切出 setAutostart 的 macOS 实现', !!mac && mac.includes('守卫服务定义缺失'),
    mac ? 'ok' : '未找到 darwin setAutostart');
  check('P2-a macOS 实现不写守卫 plist', !/writeFileSync\([^)]*GUARD_LABEL/.test(mac) && !/renameSync/.test(mac), 'ok');
  check('P2-b macOS 实现不删除守卫 plist', !/unlinkSync/.test(mac), 'ok');
  check('P2-c 守卫定义缺失时**显式报错**（不静默、不越权创建）',
    /守卫服务定义缺失/.test(mac), 'ok');
  check('P2-d 用 launchctl enable/disable 持久化开关', /on \? 'enable' : 'disable'/.test(asSrc), 'ok');
  check('P2-e 守卫定义模板已不再是内核资产（macPlist 已删）', !/function macPlist/.test(asSrc), 'ok');
  // 壳侧「仍持有守卫 plist 模板 / label 与内核一致」属壳仓自身契约，
  //   由壳仓测试负责；内核**不读壳仓源码**（两仓按账号/仓库隔离）。
  //   ⚠ 已知设计债：内核 macOS 的 enable/disable 仍需与该 label 一致 ——
  //     正确形态是壳把 label 经**运行期契约产物**（如 registry.json）投给内核，
  //     或在壳仓发布物中固定，而非内核硬编码 + 跨仓比对源码。见 RELEASE-STANDARD.md §0。
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
    check('P3-g 输出 stderr/stdout 落产品状态根 shell 目录（独立于 DSH）',
      /shellDir\(\)/.test(body), 'ok');
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

// ── P6 XDG 自启模板必须内嵌（2026-09-16 清理）──
//   缺陷：模板原从 `<pkg>/desktop/*.desktop` 读盘，而 launcher 发行态**不携带**该目录
//     → Linux 壳自启 `fs.readFileSync` ENOENT → 静默失败，且无任何门禁覆盖。
//   修法：模板内嵌为常量；本门禁锁定「内嵌」且「不再读外置 desktop/ 目录」。
console.log('== P6 XDG 自启模板内嵌 ==');
{
  check('P6-a 存在内嵌的 GUI_AUTOSTART_TEMPLATE 常量',
    /const GUI_AUTOSTART_TEMPLATE\s*=/.test(asSrc), 'ok');
  check('P6-b 不再从外置 desktop/ 目录读模板',
    !/readFileSync\([^)]*desktop[^)]*\)/.test(asSrc), 'ok');
  check('P6-c 模板含 Desktop Entry 必需键',
    /\[Desktop Entry\]/.test(asSrc) && /Type=Application/.test(asSrc), 'ok');
  const tpl = asSrc.match(/const GUI_AUTOSTART_TEMPLATE = \[([\s\S]*?)\]\.join/);
  check('P6-d 模板含 Exec/Icon/Name（写入前会被重写）',
    !!tpl && /Exec=@HOME@/.test(tpl[1]) && /Icon=@HOME@/.test(tpl[1]) && /Name=/.test(tpl[1]),
    tpl ? 'ok' : '未匹配到模板数组');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);