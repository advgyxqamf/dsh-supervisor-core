#!/usr/bin/env node
'use strict';

// ═════════════════════════════════════════════════════════════════════════
// 开发运行时安全门禁（2026-09-16）
//
// ## 事故（本门禁的由来）
//
// 我在清理临时文件时执行了 rm -rf /tmp/dsh-*。而 **DSH 自身正在用
// /tmp/dsh-subprocess-<随机>/ 存放子进程 stdout 日志** —— 目录被删后 DSH 写日志
// 触发 ENOENT，**进程崩溃退出（code=1）**，约 6 分钟后才由系统守卫重新拉起。
//
// 源码开发**绝不应影响**系统正在运行的 DSH 与已安装的 supervisor。我误以为
// /tmp 下的 dsh-* 都是我自己的测试残留 —— 实际 **DSH 与 AI 运行时都用这个前缀**。
//
// ## 判据（DEVELOPMENT-TRACK 5.3 铁律 R-2/R-3）
//
//   R-G1  仓内脚本/测试不得对 /tmp 使用**通配/前缀**删除
//   R-G2  仓内脚本/测试不得对**系统运行时路径**做破坏性操作
//   R-G3  反向：判据能识别真实违规样本（门禁非空转）
//
// 为什么必须有这条：规则写在文档里会被忽略；**写成会失败的断言**才会被执行。
// 这条规则的代价是**用户正在运行的服务中断** —— 必须是硬门禁。
// ═════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

// ── 扫描面：仓内**可执行**的脚本与测试 ──
const SCAN_DIRS = ['src', 'test', 'release', 'bin', 'ci', '.github'];
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.sh', '.bash', '.yml', '.yaml']);
const SKIP_DIR = new Set(['node_modules', 'target', 'dist', '.git', 'ui-react']);
const SKIP_FILE = new Set([SELF]);

/** 剥离注释：注释里**举例说明**禁令（如本文件的样本）不构成违规。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .map((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) return '';
      return l;
    })
    .join(String.fromCharCode(10));
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(d, files);

// ── R-G1：/tmp 通配/前缀删除 ──
// 逐条列出形态，避免"宽正则误伤"（本仓反复踩过宽正则的坑）。
// 注意：这些正则是**判据**，不是命令；本文件被 SKIP_FILE 豁免自身扫描。
const TMP_VIOLATIONS = [
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*\/tmp\/[^\s"']*[*?\[]/, desc: 'shell 通配删除 /tmp/*' },
  { re: /\brm(?:dir)?Sync\s*\(\s*['"`]\/tmp\/[^'"`]*[*?\[]/, desc: 'rmSync 通配路径' },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*\/tmp\/dsh-/, desc: '删除 /tmp/dsh-*（DSH 运行时目录）' },
  { re: /\brm(?:dir)?Sync\s*\(\s*['"`]\/tmp\/dsh-/, desc: 'rmSync /tmp/dsh-*（DSH 运行时目录）' },
];
function tmpHits(code) {
  const out = [];
  for (const v of TMP_VIOLATIONS) { if (v.re.test(code)) out.push(v.desc); }
  return out;
}

// ── R-G2：系统运行时路径的破坏性操作 ──
// 只认「破坏性动词 + 系统路径」的**同一行**组合，避免把只读诊断误判为违规。
const SYS_PATHS = [
  { re: /(?:~|\$HOME)\/\.local\/state\/dsh-supervisor/, desc: '系统状态根 ~/.local/state/dsh-supervisor' },
  { re: /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/\.local\/state\/dsh-supervisor/, desc: '系统状态根（绝对路径）' },
  { re: /(?:~|\$HOME)\/\.dsh\b/, desc: 'DSH 数据目录 ~/.dsh' },
  { re: /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/\.dsh\b/, desc: 'DSH 数据目录（绝对路径）' },
  { re: /node_modules\/@dsh-sup\//, desc: '已安装的 @dsh-sup 包目录' },
];
const DESTRUCTIVE = /\brm\s|\brm(?:dir)?Sync\s*\(|\bmv\s|\bunlinkSync?\s*\(/;
function sysLineHits(code) {
  const out = [];
  for (const raw of code.split(String.fromCharCode(10))) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('import ') || l.startsWith('const ') || l.startsWith('let ') || l.startsWith('var ')) continue;
    if (!DESTRUCTIVE.test(l)) continue;
    for (const p of SYS_PATHS) { if (p.re.test(l)) out.push(p.desc + ' :: ' + l.slice(0, 60)); }
  }
  return out;
}

// ── 执行扫描 ──
const rG1 = [];
const rG2 = [];
const scanned = [];
for (const rel of files) {
  if (SKIP_FILE.has(path.basename(rel))) continue;
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  const code = stripComments(src);
  scanned.push(rel);
  for (const d of tmpHits(code)) rG1.push(rel + ' :: ' + d);
  for (const d of sysLineHits(code)) rG2.push(rel + ' :: ' + d);
}
check('R-G1 仓内脚本/测试不对 /tmp 使用通配或前缀删除',
  rG1.length === 0, rG1.slice(0, 6).join(' | ') || ('扫描 ' + scanned.length + ' 个可执行文件，零命中'));
check('R-G2 仓内脚本/测试不对系统运行时路径做破坏性操作',
  rG2.length === 0, rG2.slice(0, 6).join(' | ') || ('扫描 ' + scanned.length + ' 个可执行文件，零命中'));

// ── R-G3：反向非空转 —— 判据必须能识别真实违规样本 ──
{
  const badTmp = ['rm -rf /tmp/dsh-*', "fs.rmSync('/tmp/dsh-spill-abc', { recursive: true })", 'rm -rf /tmp/*.log'];
  const goodTmp = ["fs.rmSync('/tmp/xplat-test-1234', { recursive: true })", 'rm -rf ./ui/dist', "fs.rmSync(path.join(TMP, 'token.log'))"];
  const missBad = badTmp.filter((s) => tmpHits(stripComments(s)).length === 0);
  const hitGood = goodTmp.filter((s) => tmpHits(stripComments(s)).length > 0);
  check('R-G3a 判据识别违规样本（rm -rf /tmp/dsh-* 等）', missBad.length === 0, missBad.join(' | ') || '3/3 命中');
  check('R-G3b 判据不误伤具名/仓内路径（无假阳性）', hitGood.length === 0, hitGood.join(' | ') || 'ok');
  const badSys = ['rm -rf ~/.local/state/dsh-supervisor/supervisor', "fs.unlinkSync('/home/x/.dsh/foo')"];
  const goodSys = ['systemctl --user show dsh-supervisor.service -p NRestarts', "const p = path.join(home, '.local', 'state', 'dsh-supervisor');"];
  const missBadSys = badSys.filter((s) => sysLineHits(stripComments(s)).length === 0);
  const hitGoodSys = goodSys.filter((s) => sysLineHits(stripComments(s)).length > 0);
  check('R-G3c 判据识别系统路径的破坏性操作', missBadSys.length === 0, missBadSys.join(' | ') || '2/2 命中');
  check('R-G3d 判据不误伤只读诊断命令（systemctl show 等）', hitGoodSys.length === 0, hitGoodSys.join(' | ') || 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
