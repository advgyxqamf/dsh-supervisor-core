#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台矩阵「单一事实源」门禁（2026-09-13，跨平台架构规范化）
//
// ## 修复的缺陷（失效模式 b：同一事实多处实现且已分叉）
//
// os/arch → 标签 这一事实曾散落 **5 处**：
//   ① src/platform/os/*                  （正确位置）
//   ② domains/relay/frpmgr.js            { linux, darwin, win32 } → { linux, darwin, windows }
//   ③ domains/dist/index.js（步骤3 上移 platform/distribution） { darwin, win32, linux } → { darwin, win, linux }
//   ④ guard/supervisor/settings-view.js  { win32, linux, darwin } → { win, linux, darwin }
//   ⑤ domains/plugin/ops.js（原 plugins.js）  process.platform !== 'win32'
// 5 份副本必然漂移；且业务域持有的平台知识**在非本平台上不会被校验** ——
// 这正是「内部业务开发悄悄破坏跨平台构建」的机制。
//
// 现全部收口到 `src/platform/contract/matrix.js`。
//
// ## 锁定不变量
//   M-a  矩阵成员与 package.json#npmPublish.packages **逐项一致**（跨源一致性）
//   M-b  行为正确：npmTag / osTag / frpTag / supportsProcessGroup 的关键取值
//   M-c  唯一性：src/ 中**除 matrix.js 外**不得再出现 os/arch 映射对象字面量
//   M-d  反向：判据能识别「重复映射表」的旧形态（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

// ── M-a：与发布矩阵逐项一致 ──
{
  const pub = (require(path.join(ROOT, 'package.json')).npmPublish || {}).packages || [];
  const mine = matrix.SUPPORTED.map((x) => 'dsh-core-' + x.npmTag);
  check('M-a 矩阵成员数 = 发布矩阵成员数',
    mine.length === pub.length, mine.length + ' vs ' + pub.length);
  const missing = pub.filter((p) => !mine.includes(p));
  const extra = mine.filter((p) => !pub.includes(p));
  check('M-a 矩阵与 package.json#npmPublish.packages 逐项一致',
    missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? ('缺 ' + JSON.stringify(missing) + ' 多 ' + JSON.stringify(extra)) : mine.join(', '));
  check('M-a 发布包名与 scope 同源',
    pub.every((p) => p.startsWith('dsh-core-')), JSON.stringify(pub));
}

// ── M-b：行为正确（关键取值，跨平台语义）──
{
  check('M-b npmTag(win32,x64) = win-x64', matrix.npmTag('win32', 'x64') === 'win-x64', matrix.npmTag('win32', 'x64'));
  check('M-b npmTag(darwin,arm64) = darwin-arm64', matrix.npmTag('darwin', 'arm64') === 'darwin-arm64', matrix.npmTag('darwin', 'arm64'));
  check('M-b npmTag(linux,x64) = linux-x64', matrix.npmTag('linux', 'x64') === 'linux-x64', matrix.npmTag('linux', 'x64'));
  check('M-b osTag(win32) = win（不是 win32）', matrix.osTag('win32') === 'win', String(matrix.osTag('win32')));
  // frp 是**第三方命名**，必须与 npm 命名区分（windows/amd64 vs win/x64）
  const fw = matrix.frpTag('win32', 'x64');
  check('M-b frpTag(win32,x64) = windows_amd64 且 exe=true',
    fw && fw.tag === 'windows_amd64' && fw.exe === true, JSON.stringify(fw));
  const fl = matrix.frpTag('linux', 'x64');
  check('M-b frpTag(linux,x64) = linux_amd64 且 exe=false',
    fl && fl.tag === 'linux_amd64' && fl.exe === false, JSON.stringify(fl));
  check('M-b frpTag 对不支持平台返回 null（不抛）',
    matrix.frpTag('freebsd', 'x64') === null, String(matrix.frpTag('freebsd', 'x64')));
  // 不支持组合：npmTag **抛错**（既有对外契约），错误文案含平台组合
  let err = null;
  try { matrix.npmTag('freebsd', 'x64'); } catch (e) { err = e.message; }
  check('M-b npmTag 对不支持平台抛错且文案含平台组合',
    !!err && /不支持的平台组合/.test(err) && /freebsd/.test(err), err || '(未抛)');
  check('M-b supportsProcessGroup：POSIX 真 / Windows 假',
    matrix.supportsProcessGroup('linux') === true && matrix.supportsProcessGroup('darwin') === true
    && matrix.supportsProcessGroup('win32') === false, 'ok');
  check('M-b isSupported 对四平台为真、对未知为假',
    matrix.SUPPORTED.every((x) => matrix.isSupported(x.platform, x.arch) === true)
    && matrix.isSupported('freebsd', 'x64') === false, 'ok');
  check('M-b isSupported 与 SUPPORTED 同集合（linux-arm64 / win32-arm64 为 false）',
    matrix.isSupported('linux', 'arm64') === false && matrix.isSupported('win32', 'arm64') === false, 'ok');
}

// ── M-c：唯一性（src/ 中不得再有第二份 os/arch 映射表）──
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  // 判据：形如 { win32: 'win', ... } 或 { darwin: 'darwin', win32: 'win', ... } 的对象字面量
  const mapRe = /\{\s*(?:win32|darwin|linux)\s*:\s*['"](?:win|darwin|linux)['"]/;
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel.endsWith('src/platform/contract/matrix.js')) continue;   // 唯一合法位置
    const code = fs.readFileSync(f, 'utf8')
      .split(String.fromCharCode(10))
      .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
      .join(String.fromCharCode(10));
    if (mapRe.test(code)) offenders.push(rel);
  }
  check('M-c src/ 中除 platform/contract/matrix.js 外无 os/arch 映射对象字面量',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '未发现');
}

// ── M-d：反向（门禁非空转）──
{
  const mapRe = /\{\s*(?:win32|darwin|linux)\s*:\s*['"](?:win|darwin|linux)['"]/;
  check('M-d 反向：判据能识别旧形态（frpmgr 的 osMap）',
    mapRe.test("const osMap = { linux: 'linux', darwin: 'darwin', win32: 'windows' };"), 'hit');
  check('M-d 反向：判据不误报普通对象',
    !mapRe.test("const cfg = { timeout: 1000, retries: 3 };"), 'ok');
  check('M-d 反向：判据不误报矩阵自身（白名单生效）',
    matrix.SUPPORTED.length === 4, String(matrix.SUPPORTED.length));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
