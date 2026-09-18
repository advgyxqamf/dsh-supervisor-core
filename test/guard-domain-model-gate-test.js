#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 守护域模型门禁（GD-1..GD-5）—— SSOT: GUARD-DOMAIN-MODEL.md §5
//
// ## 为什么需要它
//   契约 §1 记录了「模型错位」的真实后果：把基础设施（lan-daemon）硬塞进
//   「用户意图模型」，于是代码里出现了自相矛盾的三件套——
//     · 对恒 true 值的补丁判断（entry.guardian !== true，对基础设施无意义）；
//     · A/B 平面 id 混乱：计数写 get('lan-daemon') 而读 get('lan')；
//     · guardian_action 里 lan 的 restartCount 恒为 0（可观测性断裂）。
//   本门禁把 §2 的两域模型与 §3 的 G-1..G-6 铁律变成**可执行断言**，防止错位回潮。
//
// ## 断言（契约 §5）
//   GD-1 域 B 基础设施（**router-daemon 与 lan-daemon 两者**）的 entry 申报**不含** guardian 字段（G-1）
//   GD-2 _daemonSuperviseOnce 的 **router 与 lan 两个分支**均**不调用** _guardianEvent（G-2）
//   GD-3 两平面 id 必须**显式映射**，保活路径不得跨平面混用 id（G-5）
//        ⚠ 契约共识方案把 router-daemon 也归入域 B 后，「router 的 guardian_action 读写同 id」
//          这一断言前提已不存在（基础设施不发该事件）。G-5 的本义是「同一对象不得有两个 id，
//          或必须显式映射」，故按此断言。
//   GD-4 反向：判据能识别「基础设施带 guardian 字段 / 分支仍发事件」的旧形态（门禁非空转）
//   GD-5 基础设施保活路径不再有对恒 true 值的 guardian !== true 补丁判断（G-6）
//
// ⚠ 域划分（契约 §2，**共识方案**）：
//   域 A 用户意图 = main（原生 DSH）+ 沙箱实例；
//   域 B 基础设施 = **router-daemon + lan-daemon**（两者都无用户意图轴、都无条件保活）。
//
// ## 现状（2026-09-16 分片落地后）
//   实现已按契约归位：registry-view 两处申报删除 guardian；control-view 两分支删除
//   _guardianEvent / guardian!==true 补丁 / restartCount 写入。GD-1 / GD-2 / GD-5 全绿。
//   GD-4 仍以**构造的旧形态**证明判据有分辨力（门禁非空转）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BT = String.fromCharCode(96); // 反引号（模板串分隔符）

// ───────────────────────────────────────────────────────────────────────────
// 源码定位工具（纯静态；跳过字符串/注释，避免误判括号）
// ───────────────────────────────────────────────────────────────────────────

/** 从 openIdx 处的 '{' 出发，返回配对 '}' 的下标（跳过注释/字符串/模板串）。 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== String.fromCharCode(10)) i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === BT) {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 去除 // 行注释与块注释（跳过字符串/模板串，避免 'http://' 之类被误伤）。
 *  ⚠ 引用判据必须只看**代码**：任务硬约束「删除前 grep 证明零真实引用（注释不算）」——
 *  同理门禁也不得因一句「已删除 _guardianEvent」的说明性注释而误报。 */
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（删注释、保行结构）。
const { stripComments: stripCommentsLex } = require('./_strip');
function stripComments(src) { return stripCommentsLex(src); }

/** 取含 kind: '<kind>' 的申报对象字面量（从它所属的 '{' 到配对 '}'）。 */
function entrySpecOf(src, kind) {
  const m = new RegExp("kind\\s*:\\s*['\"]" + kind + "['\"]").exec(src);
  if (!m) return null;
  let open = -1;
  for (let i = m.index; i >= 0; i--) { if (src[i] === '{') { open = i; break; } }
  if (open < 0) return null;
  const close = matchBrace(src, open);
  return close < 0 ? null : src.slice(open, close + 1);
}

/** 取类方法体（name(...) { 到配对 '}' 之间的文本）。 */
function methodBody(src, name) {
  const m = new RegExp(name + "\\s*\\([^)]*\\)\\s*\\{").exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(src, open);
  return close < 0 ? null : src.slice(open + 1, close);
}

/** 取 lan 分支：从守护判入口（.enabled() / lanDaemonEnabled()，形态无关）到函数体末尾（lan 是最后一段）。 */
function lanBranchOf(fnBody) {
  // ⚠ 2026-09-17 阶段六 B-6：supervise.js 去 this 后 lan 闸变为 d.daemons().enabled()。
  //   判据改为**形态无关**（匹配任意接收者的 .enabled() 或 lanDaemonEnabled()）；判据本意不变。
  const i = fnBody.search(/(?:\.enabled\(\)|lanDaemonEnabled\(\))/);
  return i < 0 ? null : fnBody.slice(i);
}

/** 取 router 分支：从 kind === 'router' 判分到 lan 分支起点。 */
function routerBranchOf(fnBody) {
  const i = fnBody.search(/kind\s*===\s*['"]router['"]/);
  const j = fnBody.search(/(?:\.enabled\(\)|lanDaemonEnabled\(\))/);
  if (i < 0) return null;
  return fnBody.slice(i, j > i ? j : fnBody.length);
}

// ── 判据（正/反共用；GD-4 对它们做反向断言，证明门禁非空转）──

/** GD-1 判据：entry 申报块是否带 guardian 字段（域 B 不应有用户意图字段）。 */
const hasGuardianField = (spec) => /\bguardian\s*:/.test(spec);

/** GD-2 判据：某分支是否调用 _guardianEvent('<id>'。 */
const callsGuardianEvent = (branch, id) => new RegExp("_guardianEvent\\(\\s*['\"]" + id + "['\"]").test(branch);

/** GD-3 判据（旧形态专用）：事件读取 id（_guardianEvent('<id>')）与计数写入 id（get('<id>')）是否配对。
 *  ⚠ 共识方案把基础设施（router/lan）全部归入域 B 后，保活路径不再发该事件，
 *    本判据只用于 GD-4 反向（证明「写读 id 错位」这种旧形态确实能被识别），不再作正面断言。 */
const idPaired = (branch, id) => callsGuardianEvent(branch, id)
  && new RegExp("get\\(\\s*['\"]" + id + "['\"]\\s*\\)").test(branch);

/** GD-5 判据（泛指）：是否存在对 guardian 的 !== true 补丁判断。 */
const hasGuardianNotTruePatch = (src) => /\.guardian\s*!==\s*true/.test(src);

/** GD-5 判据（旧形态，特指）：entry.guardian !== true（lan 分支当年那处补丁）。 */
const hasEntryGuardianPatch = (src) => /entry\s*\.\s*guardian\s*!==\s*true/.test(src);

/** 递归收集 src/ 下全部 .js 源码（供 GD-5 全域旧形态扫描）。 */
function walkSrc(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkSrc(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// GD-1 域 B 基础设施 entry 申报不含 guardian 字段（G-1）
// ═══════════════════════════════════════════════════════════════════════════
{
  const registrySrc = read('src/app/control/specs.js');
  // 域 B 基础设施 = router-daemon + lan-daemon（契约 §2 共识方案）——两个都要断言。
  const lanSpec = entrySpecOf(registrySrc, 'lan-daemon');
  const routerSpec = entrySpecOf(registrySrc, 'router-daemon');
  check('GD-1 lan-daemon 申报块被准确定位', !!lanSpec,
    lanSpec ? 'registry-view.js 中已定位 kind: lan-daemon 对象字面量' : '未找到 kind: lan-daemon 申报块');
  check('GD-1 router-daemon 申报块被准确定位', !!routerSpec,
    routerSpec ? 'registry-view.js 中已定位 kind: router-daemon 对象字面量' : '未找到 kind: router-daemon 申报块');
  // 域 B 基础设施（router-daemon + lan-daemon）**两者都不得有** guardian 字段（契约 §2 共识方案）。
  check('GD-1 域 B 基础设施申报不含 guardian 字段（G-1：无用户意图轴）',
    !!lanSpec && !!routerSpec && !hasGuardianField(lanSpec) && !hasGuardianField(routerSpec),
    [lanSpec && hasGuardianField(lanSpec) ? 'lan-daemon 仍含 guardian:' : null,
     routerSpec && hasGuardianField(routerSpec) ? 'router-daemon 仍含 guardian:' : null]
      .filter(Boolean).join('; ') || 'ok（两者均无 guardian）');

  // ⚠ GD-1 运行期断言（2026-09-16 补强，复检发现）：
  //   上面只查**申报源码**——但 createEntry 曾对所有 kind 无条件物化该字段并随目录落盘，
  //   于是"申报不写"掩盖不了"数据层仍有该字段"：实测升级路径曾让两个 daemon 长期带
  //   guardian: true，而 update() 因 guardian===undefined 永不修正 → 契约 GD-1 形同虚设。
  //   故必须断言**运行期形态**（"不存在"而非"置 false"）。
  const { createEntry } = require(path.join(ROOT, 'src', 'app', 'control', 'registry.js'));
  const daemonEntry = createEntry({ kind: 'lan-daemon', id: 'lan-daemon', desired: 'stopped', guardian: true });
  check('GD-1 运行期：域 B entry **不物化** guardian 键（不是"置 false"，是"不存在"）',
    !('guardian' in daemonEntry),
    'lan-daemon entry 的键: ' + Object.keys(daemonEntry).join(','));
  const dshEntry = createEntry({ kind: 'dsh', id: 'main', desired: 'running', guardian: true });
  check('GD-1 运行期：域 A entry **保留** guardian（反向对照，防判据误伤）',
    dshEntry.guardian === true, 'dsh entry guardian=' + JSON.stringify(dshEntry.guardian));
}

// ═══════════════════════════════════════════════════════════════════════════
// GD-2 基础设施保活路径不调用 _guardianEvent（G-2）
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ 2026-09-16 步骤7：原 control-view.js 已拆为多个模块（facade/router、daemons/supervise、…）。
//   本门禁的断言对象是「保活路径」，横跨 facade（router 分支）与 daemons/supervise（_daemonSuperviseOnce），
//   故读**整组**（否则文件拆分即静默失去覆盖面）。
const controlSrc = [
  'src/app/facade/router.js',
  'src/app/daemons/supervise.js',
  'src/app/daemons/runtime.js',
  'src/app/facade/lan.js',
].map((f) => read(f)).join(String.fromCharCode(10));
const fnBody = methodBody(controlSrc, '_daemonSuperviseOnce');
const lanBranch = fnBody ? lanBranchOf(fnBody) : null;
{
  check('GD-2 _daemonSuperviseOnce 函数体与 lan 分支被准确定位',
    !!fnBody && !!lanBranch,
    fnBody ? (lanBranch ? '函数体 ' + fnBody.length + ' 字符，lan 分支已切出' : '函数体内未找到 lan 分支判入口') : '未找到 _daemonSuperviseOnce');
  const routerBr = fnBody ? routerBranchOf(fnBody) : null;
  check("GD-2 基础设施保活路径不调用 _guardianEvent('lan')（G-2）",
    !!lanBranch && !callsGuardianEvent(lanBranch, 'lan'),
    lanBranch && callsGuardianEvent(lanBranch, 'lan') ? 'lan 分支仍发 guardian_action 事件（基础设施不该有守护计数）' : 'ok');
  check("GD-2 基础设施保活路径不调用 _guardianEvent('router')（G-2）",
    !!routerBr && !callsGuardianEvent(routerBr, 'router'),
    routerBr && callsGuardianEvent(routerBr, 'router') ? 'router 分支仍发 guardian_action 事件（域 B 不该有守护计数）' : 'ok');
  // ⚠ 2026-09-16 域模型收口（比「分支不调用」更强，防止函数换处复活）：
  //   整份 control-view.js 已**不再定义** _guardianEvent，且全仓 src/ 无任何 guardian_action 生产者。
  //   判据改为全域扫描（注释不算引用），对错位回潮是硬失败而非静默。
  const controlCode = stripComments(controlSrc);
  check('GD-2b 全域不存在 _guardianEvent 定义/调用（函数已删，非仅分支未调用）',
    !/_guardianEvent\s*\(/.test(controlCode),
    /_guardianEvent\s*\(/.test(controlCode) ? 'control-view.js 仍有 _guardianEvent 定义' : 'ok（函数已删除，注释不计）');
  const producerOffenders = walkSrc(path.join(ROOT, 'src'), [])
    .filter((p) => /append\(\s*['"]guardian_action['"]/.test(stripComments(fs.readFileSync(p, 'utf8'))));
  check('GD-2c guardian_action 事件无任何生产者（G-2：域 B 不发；函数已删故域 A 亦不需要）',
    producerOffenders.length === 0,
    producerOffenders.length ? producerOffenders.map((p) => path.relative(ROOT, p)).join(', ') : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// GD-3 两平面 id 显式映射 + 保活路径不跨平面混用 id（G-5）
// ═══════════════════════════════════════════════════════════════════════════
{
  const routerBranch = fnBody ? routerBranchOf(fnBody) : null;
  check('GD-3 router 分支被准确定位（用于 GD-2 的域 B 断言）', !!routerBranch,
    routerBranch ? 'router 分支已切出' : '未找到 kind === router 分支');
  // 域 B 的 A/B 平面：A 平面目录 id='lan-daemon'（registry 申报），B 平面 lifecycle id='lan'（adapters）。
  // G-5 要求二者**要么一致、要么显式映射**——此处断言映射点确实存在且可读。
  // ⚠ 步骤 7（2026-09-16）：registerAdapter 的注册点随构造期装配一起从 src/supervisor.js
  //   下沉到 app/assembly/compose.js（薄壳只剩组装与启动）——故改读新模块；
  //   仍断言「注册点本身即映射点」（kind='lan-daemon' → _daemonSuperviseOnce('lan')），
  //   否则文件一搬门禁就静默失去覆盖面。
  // R3 严值 DF-2：受管注册机 adapter 挂接随各域构造拆到 compose/domains.js。
  const composeSrc = read('src/app/assembly/compose/domains.js');
  const mapped = /registerAdapter\(\s*'lan-daemon'\s*,[\s\S]{0,160}?_daemonSuperviseOnce\(\s*'lan'\s*\)/.test(composeSrc);
  check("GD-3 域 B 两平面 id 显式映射（A 平面 'lan-daemon' → B 平面 'lan'，G-5）",
    mapped, mapped ? 'ok（compose.js 注册点即映射点）' : '未找到显式映射');
  // 保活路径不得跨平面取 id：基础设施分支全程不应再 get('lan-daemon')（那是 A 平面 id）。
  check('GD-3 保活路径不跨平面混用 id（A 平面 lan-daemon 已从保活路径移除）',
    !!lanBranch && !/get\(\s*'lan-daemon'\s*\)/.test(lanBranch),
    lanBranch && /get\(\s*'lan-daemon'\s*\)/.test(lanBranch) ? 'lan 分支仍取 A 平面 id' : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// GD-4 反向：判据能识别旧形态（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════
{
  // 旧形态1：基础设施 entry 带 guardian（当年 registry-view.js:223 的形态）
  const OLD_ENTRY = "this._upsertManaged({ kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon', desired: 'running', guardian: true, ownership: { processMode: 'daemon' } });";
  const oldSpec = entrySpecOf(OLD_ENTRY, 'lan-daemon');
  check('GD-4 反向：判据能识别「基础设施带 guardian 字段」的旧形态',
    !!oldSpec && hasGuardianField(oldSpec),
    oldSpec ? '命中 guardian:（判据有效）' : '构造片段未被判违规（判据空转！）');

  // 正确形态：无 guardian → 判据不得误报
  const CLEAN_ENTRY = "this._upsertManaged({ kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon', ownership: { processMode: 'daemon' } });";
  const cleanSpec = entrySpecOf(CLEAN_ENTRY, 'lan-daemon');
  check('GD-4 反向：判据不误报无 guardian 的正确形态',
    !!cleanSpec && !hasGuardianField(cleanSpec), 'ok');

  // 旧形态2：lan 分支仍调用 _guardianEvent（当年 control-view.js:451/469 的形态）
  const OLD_LAN_BRANCH = "if (!this.lanDaemonEnabled()) return { ok: this._lanDaemonActive() };\n"
    + "const entry = this.managedObjects.get('lan-daemon');\n"
    + "if (entry && entry.guardian !== true) { this._guardianEvent('lan', 'skip-guardian-off'); return { ok: false }; }\n"
    + "this._guardianEvent('lan', 'pull', { pid: rt.spawned });";
  check('GD-4 反向：判据能识别旧 lan 分支仍发 _guardianEvent',
    callsGuardianEvent(OLD_LAN_BRANCH, 'lan'), 'hit');

  // 旧形态3：lan 的写读 id 错位（写 get('lan-daemon') / 读事件 resource='lan'）
  check('GD-4 反向：id 配对判据能识别 lan 写读错位（写 lan-daemon / 读 lan）',
    !idPaired(OLD_LAN_BRANCH, 'lan'), '命中错位（判据有效）');

  // 旧形态4：恒 true 值上的 guardian !== true 补丁
  check('GD-4 反向：判据能识别恒 true 值上的 guardian !== true 补丁',
    hasGuardianNotTruePatch(OLD_LAN_BRANCH) && hasEntryGuardianPatch(OLD_LAN_BRANCH), 'hit');
}

// ═══════════════════════════════════════════════════════════════════════════
// GD-5 删除对恒 true 值的 guardian !== true 补丁判断（G-6）
// ═══════════════════════════════════════════════════════════════════════════
{
  // 域 A 对象的 guardian 判断合法（rlc.guardian !== true 是正常用户意图逻辑），
  // 故按上下文区分：主断言只看 infrastructural 的 lan 分支。
  check('GD-5 lan 保活分支不存在 guardian !== true 补丁判断（G-6）',
    !!lanBranch && !hasGuardianNotTruePatch(lanBranch),
    lanBranch && hasGuardianNotTruePatch(lanBranch) ? 'lan 分支仍有对恒 true 值的 !== true 判断' : 'ok');

  // 全域旧形态扫描：entry.guardian !== true 是当年 lan 分支的特征写法（域 A 用 rlc/lc，不叫 entry），
  // 它一旦回归即判违规，防止补丁换个地方复活。
  const allSrc = walkSrc(path.join(ROOT, 'src'), []);
  const offenders = allSrc.filter((p) => hasEntryGuardianPatch(fs.readFileSync(p, 'utf8')));
  check('GD-5 全域不存在 entry.guardian !== true 旧补丁形态',
    offenders.length === 0,
    offenders.length ? offenders.map((p) => path.relative(ROOT, p)).join(', ') : allSrc.length + ' 个源码文件已扫描');
}

// ═══════════════════════════════════════════════════════════════════════════
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
