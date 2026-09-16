#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-C：npm 必须经**统一解析入口**，不得硬编码裸 'npm'
//
// ## 缺陷
//
// Windows 上 npm 的实际可执行是 `npm.cmd`；Node 的 `spawn`/`execFileSync` **不做 PATHEXT 解析**
// （`.cmd`/`.bat` 必须由 cmd.exe 承载；自 CVE-2024-27980 起 Node 也不再隐式代跑 `.cmd`）
// → 传裸 `'npm'` 一律 `ENOENT`。
//
// 旧实现在**三处**各自硬编码：
//   · platform/distribution/index.js   let bin = 'npm'      （唯一安装执行器；步骤3 前为 domains/dist）
//   · guard/native/manager.js      ex.runOut('npm', ...)    （版本/root 探测）
//   · guard/native/manager.js      spawn('npm', ...)        （卸载）
// 后果：Windows 用户的「升级内核 / 安装 / 卸载 DSH」全部失败，错误只是含糊的 ENOENT。
// 两仓对同一事实答案不一致：壳仓早有 `npm_exe() → npm.cmd`。
//
// ## 锁定不变量
//   C-a  `npmBin()` 存在且：非 Windows 返回 'npm'，Windows 返回带扩展名的可执行
//   C-b  解析结果是**绝对路径或带扩展名**（Windows）—— 不能是裸 'npm'
//   C-c  源码里不得再出现裸 npm 调用（runOut('npm')/spawn('npm')/bin='npm'）
//   C-d  模板路径（commandTemplate 首项为 'npm'）同样被解析
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const { npmBin } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

// ── C-a：基础行为 ──
check('C-a npmBin 是函数', typeof npmBin === 'function', typeof npmBin);
check("C-a 非 Windows 返回 'npm'", npmBin({ platform: 'linux' }) === 'npm', npmBin({ platform: 'linux' }));
check("C-a darwin 返回 'npm'", npmBin({ platform: 'darwin' }) === 'npm', npmBin({ platform: 'darwin' }));

// ── C-b：Windows 解析**逻辑**必须真的去找带扩展名的可执行 ──
//
// ⚠ 断言设计说明：在 Linux 上跑 `npmBin({platform:'win32'})` 仍会走本机 PATH，
//   于是「返回绝对路径」这个条件会因**本机恰好有 npm** 而通过 —— 那是弱断言，
//   无法证明 Windows 分支真的会补扩展名。故此处直接断言**候选名生成**（纯函数），
//   它才是 Windows 解析的本质：必须先试 npm.cmd，而不是裸 npm。
const { candidateNames } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
{
  const wc = candidateNames('npm', 'win32').map((s) => s.toLowerCase());
  check('C-b Windows 候选名含 npm.cmd', wc.includes('npm.cmd'), JSON.stringify(candidateNames('npm', 'win32')));
  check('C-b Windows 候选名把 npm.cmd 排在裸 npm 之前',
    wc.indexOf('npm.cmd') < wc.indexOf('npm'), 'cmd@' + wc.indexOf('npm.cmd') + ' vs npm@' + wc.indexOf('npm'));
  check('C-b 非 Windows 候选名只有裸 npm（不误加扩展名）',
    JSON.stringify(candidateNames('npm', 'linux')) === JSON.stringify(['npm']),
    JSON.stringify(candidateNames('npm', 'linux')));
  const w = npmBin({ platform: 'win32' });
  check('C-b Windows 结果非裸 npm', w !== 'npm', w);
}

// ── C-c：源码不得再有裸 npm 调用 ──
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'src'), []);
const bare = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = f.replace(ROOT + path.sep, '');
  const lines = t.split(String.fromCharCode(10));
  lines.forEach((l, i) => {
    const s = l.trim();
    if (s.startsWith('//')) return; // 注释里的说明不算
    // ⚠ P1-4 修复（2026-09-12）：原正则只匹配 'npm' —— **对 'npx' 是盲区**，
    //   于是反代路径的裸 `execFile('npx', ...)` 长期绕过本门禁，
    //   而它的问题是**完全相同**的（Windows 上 npx 也是 .cmd）。
    //   现同时覆盖两者。
    if (/(runOut|runDetail|run|execFile|exec)\s*\(\s*'(npm|npx)'|spawn\s*\(\s*'(npm|npx)'|(let|const)\s+bin\s*=\s*'(npm|npx)'/.test(l)) {
      bare.push(rel + ':' + (i + 1) + '  ' + s.slice(0, 66));
    }
  });
}
check('C-c 源码无裸 npm/npx 调用', bare.length === 0, bare.length ? bare.join(' | ') : '已全部经 npmBin()/npxBin()');

// ── C-e：npx 与 npm 同构（P1-4）──
const { npxBin } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
check('C-e npxBin 是函数', typeof npxBin === 'function', typeof npxBin);
check("C-e 非 Windows 返回 'npx'", npxBin({ platform: 'linux' }) === 'npx', npxBin({ platform: 'linux' }));
{
  const wc2 = candidateNames('npx', 'win32').map((s) => s.toLowerCase());
  check('C-e Windows 候选名含 npx.cmd', wc2.includes('npx.cmd'), JSON.stringify(candidateNames('npx', 'win32')));
  check('C-e npx.cmd 排在裸 npx 之前',
    wc2.indexOf('npx.cmd') < wc2.indexOf('npx'), 'cmd@' + wc2.indexOf('npx.cmd'));
  const w2 = npxBin({ platform: 'win32' });
  check('C-e Windows 结果非裸 npx', w2 !== 'npx', w2);
}

// ── C-d：模板路径也解析 ──
{
  // ⚠ 2026-09-17（域结构第三轮）：distribution 已拆分，按目录聚合读取（安装执行器落在 install.js）。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  check('C-d commandTemplate 首项为 npm 时经统一 npm 解析（runtimeContract.npmBin(npmBin)）',
    /argv\[0\] === 'npm'\s*\)\s*\?\s*runtimeContract\.npmBin\(npmBin\)/.test(dist),
    '已接入');
}

// ── 反向：解析结果确实可执行（本机验证，非 Windows 分支）──
{
  const local = npmBin();
  check('反向：本机解析结果可用（非空字符串）', typeof local === 'string' && local.length > 0, local);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);