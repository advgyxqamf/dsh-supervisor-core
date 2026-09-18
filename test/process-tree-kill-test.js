#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-G：`processTreeKill` 的**声明必须有实现产物**
//
// ## 缺陷
//
// 平台层早已提供 `killTree`（Windows = `taskkill /PID <pid> /T`；POSIX = 进程组信号），
// **且已导出**，`capabilityProfile().processTreeKill = true` 也早已声明 ——
// 但全仓**零调用点**：真实停止路径只用 `signalProcess`，
// 而它自己模块头的注释就写着「Windows：仅单进程（树语义由 killTree 提供）」。
//
// 后果：Windows 上停止 DSH 只杀父进程，其派生的子进程（node / 浏览器 / 子命令）成为**孤儿**，
//   继续占端口、持文件锁；守卫重启后 adopt 复用即被楔死。
//
// 这违反了本仓确立的不变量：**声明必须由可执行断言支撑**。
// （`processTreeKill` 只由 `hasTool('taskkill')` 覆写 —— 只证明「命令存在」，不证明「被使用」。）
//
// ## 锁定不变量
//   G-a  平台层导出 killTree 且 Windows 分支用 taskkill /T
//   G-b  supervisor 的 SIGKILL 升级路径**实际调用** killTree（不再只有 signalProcess）
//   G-c  接管实例（无 child 句柄）路径同样走整树
//   G-d  `processTreeKill` 的声明与使用点对应（注释指向接入处）
//   G-e  优雅期仍先发 SIGTERM（整树只是**升级**手段，不是一上来就杀树）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const processSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'process.js'), 'utf8');
// ⚠ 2026-09-16 步骤7：main-process.js 拆为 app/main/{process,signals}.js；
//   判据须读**两者**（进程机制 + 信号序列），否则拆分即静默失去覆盖面。
const mainProc = ['process.js', 'signals.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'app', 'main', f), 'utf8'))
  .join(String.fromCharCode(10));
// 2026-09-16（§4.5 测试指针同步）：os/index.js 已缩为平台分派门面，
//   能力档位纯数据下沉到 os/capability-profile.js —— 聚合整个 os/ 目录，覆盖面不缩小。
const _osDir = path.join(ROOT, 'src', 'platform', 'os');
const osIndex = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? fs.readFileSync(p, 'utf8') : '';
  }).join(String.fromCharCode(10));
})(_osDir);

const pc = require(path.join(ROOT, 'src', 'platform', 'os', 'process.js'));

// ── G-a：平台层实现 ──
check('G-a 平台层导出 killTree', typeof pc.killTree === 'function', typeof pc.killTree);
check('G-a killTree 的 Windows 分支用 taskkill /T（整树）',
  /execFile\('taskkill', \['\/PID', String\(pid\), '\/T'\]/.test(processSrc), '有');

// ── G-b：supervisor 实际调用（这是缺陷的核心）──
check('G-b main-process 定义 _killTree 并调用 platform killTree',
  /_killTree\(child/.test(mainProc) && /pc\.killTree\(/.test(mainProc),
  '已接入');
check('G-b SIGKILL 升级路径改用 _killTree（不再是 signalProcess）',
  /killTree\(child, 'SIGKILL'\)/.test(mainProc), '已改');

// ── G-c：接管实例（无 child 句柄）──
//   ⚠ 不能用 indexOf('_killAdopted') 切片：'stopProcess' 里**先**出现调用/提及，
//     定义在后面 —— 从首次出现处切片会拿到错误的区间（我第一版就踩了这个）。
//     改为直接断言「存在 `killTree(pid` 调用」且「_killAdopted 函数体内有它」。
{
  const m = mainProc.match(/\n  _killAdopted\(pid\) \{[\s\S]*?\n  \}/);
  check('G-c 定位到 _killAdopted 函数体', !!m, m ? m[0].length + ' 字符' : '（未找到）');
  check('G-c 接管实例路径也走 killTree（整树）',
    !!m && /killTree\(pid/.test(m[0]), '已接入');
}

// ── G-d：声明与使用点对应 ──
check('G-d processTreeKill 的注释指向实现（防再次「声明无产物」）',
  /processTreeKill: true[^\n]*(main-process\._killTree|_killTree)/.test(osIndex), '已指向');

// ── G-e：整树只是升级，优雅期仍先 SIGTERM ──
{
  // 同上：用**函数体正则**定位，而非 indexOf（避免命中调用处/注释）。
  const m = mainProc.match(/\n  _killSequence\(child\) \{[\s\S]*?\n  \}/);
  check('G-e 定位到 _killSequence 函数体', !!m, m ? m[0].length + ' 字符' : '（未找到）');
  const seq = m ? m[0] : '';
  const iTerm = seq.indexOf("signalChild(child, 'SIGTERM')");
  const iTree = seq.indexOf('killTree(child');
  check('G-e 先 SIGTERM 再（超时后）_killTree',
    iTerm >= 0 && iTree >= 0 && iTerm < iTree, 'term@' + iTerm + ' tree@' + iTree);
}

// ── 反向：不得把所有停止都改成整树（那会丢掉优雅期语义）──
check('反向：优雅期仍用 signalProcess（非整树）',
  /signalChild\(child, 'SIGTERM'\)/.test(mainProc), '保留');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);