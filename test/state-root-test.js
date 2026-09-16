#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 产品状态根门禁（SR-1..SR-6；2026-09-15 架构纠偏）
//
// 本产品**管控 DSH**，状态不得寄在被管控对象的 ~/.dsh 下。内核侧单一事实源 =
//   src/platform/service/state-root.js（XDG + DSH_SUPERVISOR_HOME 覆盖 + 前向自愈迁移）。
//   · SR-1 schema=1（与壳 env.rs 的 STATE_ROOT_SCHEMA 握手）
//   · SR-2 DSH_SUPERVISOR_HOME 覆盖优先
//   · SR-3 默认根**不在** ~/.dsh 之下（独立于 DSH）
//   · SR-4 supervisor/shell 子目录
//   · SR-5 迁移：旧 ~/.dsh/{supervisor,shell} 按条目搬到新根
//   · SR-6 负向：产品代码不得再直拼 ~/.dsh/supervisor|shell（state-root.js 除外）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const sr = require(path.join(ROOT, 'src', 'platform', 'service', 'state-root.js'));

// ── SR-1：schema 握手 ──
check('SR-1 schema = 1（与壳 STATE_ROOT_SCHEMA 握手）', sr.SCHEMA === 1, String(sr.SCHEMA));

// ── SR-2：覆盖优先 ──
const tmpNew = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-new-'));
process.env.DSH_SUPERVISOR_HOME = tmpNew;
check('SR-2 DSH_SUPERVISOR_HOME 覆盖优先', sr.root() === path.resolve(tmpNew), sr.root());
check('SR-2 supervisor/shell 子目录正确',
  sr.supervisorDir() === path.join(path.resolve(tmpNew), 'supervisor')
  && sr.shellDir() === path.join(path.resolve(tmpNew), 'shell'), sr.supervisorDir());

// ── SR-3：默认根独立于 DSH 的 ~/.dsh ──
delete process.env.DSH_SUPERVISOR_HOME;
const realHome = os.homedir();
const def = sr.root();
check('SR-3 默认根不在 ~/.dsh 之下', !def.startsWith(path.join(realHome, '.dsh')),
  def + ' (home=' + realHome + ')');
check('SR-3 默认根不是 ~/.dsh 本身', def !== path.join(realHome, '.dsh'), def);

// ── SR-4：source 断言（默认值也走 state-root 单一入口）──
const cfg = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'config.js'), 'utf8');
check('SR-4 config 默认路径经 state-root', /require\('\.\/state-root'\)\.supervisorDir\(\)/.test(cfg), 'ok');
check('SR-4 config 不再硬编码 ~/.dsh/supervisor', !/stateFile:\s*'~\.dsh\/supervisor/.test(cfg), 'ok');

// ── SR-5：迁移行为（隔离 HOME + 新根覆盖）──
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-'));
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-dst-'));
  const saveHome = process.env.HOME; const saveUp = process.env.USERPROFILE;
  process.env.HOME = fakeHome; process.env.USERPROFILE = fakeHome;
  process.env.DSH_SUPERVISOR_HOME = newRoot;
  fs.mkdirSync(path.join(fakeHome, '.dsh', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.dsh', 'supervisor', 'config.json'), '{}');
  fs.mkdirSync(path.join(fakeHome, '.dsh', 'shell'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.dsh', 'shell', 'identity.json'), '{}');
  const moved = sr.migrateLegacy();
  check('SR-5 迁移旧 supervisor 配置到新根',
    fs.existsSync(path.join(newRoot, 'supervisor', 'config.json')), JSON.stringify(moved));
  check('SR-5 迁移旧 shell 身份到新根',
    fs.existsSync(path.join(newRoot, 'shell', 'identity.json')), JSON.stringify(moved));
  // 不覆盖已存在文件
  fs.writeFileSync(path.join(newRoot, 'supervisor', 'config.json'), '{"keep":1}');
  fs.mkdirSync(path.join(fakeHome, '.dsh', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.dsh', 'supervisor', 'config.json'), '{"old":1}');
  sr.migrateLegacy();
  check('SR-5 迁移不覆盖已存在的新文件',
    fs.readFileSync(path.join(newRoot, 'supervisor', 'config.json'), 'utf8') === '{"keep":1}', 'ok');
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(newRoot, { recursive: true, force: true });
  if (saveHome !== undefined) process.env.HOME = saveHome; else delete process.env.HOME;
  if (saveUp !== undefined) process.env.USERPROFILE = saveUp; else delete process.env.USERPROFILE;
  delete process.env.DSH_SUPERVISOR_HOME;
}

// ── SR-6：负向扫描（产品代码不得再直拼 ~/.dsh/supervisor|shell）──
{
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const files = walk(path.join(ROOT, 'src'), []).concat([path.join(ROOT, 'bin', 'dsh-supervisor')]);
  const offenders = [];
  for (const f of files) {
    if (path.basename(f) === 'state-root.js') continue; // 迁移用的旧路径在此定义
    const code = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10))
      .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
      .join(String.fromCharCode(10));
    if (/homedir\(\), '\.dsh', 'supervisor'/.test(code) || /homedir\(\), '\.dsh', 'shell'/.test(code)) {
      offenders.push(path.relative(ROOT, f));
    }
  }
  check('SR-6 产品代码不再直拼 ~/.dsh/supervisor|shell', offenders.length === 0, offenders.join(', ') || 'clean');
  // 反向：旧形态必须被该判据识别
  const looksHardcoded = (src) => /homedir\(\), '\.dsh', 'supervisor'/.test(src);
  check('SR-6 反向：旧形态被识别', looksHardcoded("path.join(os.homedir(), '.dsh', 'supervisor')"), 'ok');
}

// ── SR-7：测试隔离 hygiene（防回归：测试不得再写真实 HOME 的产品状态）──
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test || '';
  // ⚠ 2026-09-17：接受 `-r`（--require 的短形式）—— 二者语义相同。
  //   改用短形式是为压 scripts.test 长度以适配 **Windows cmd.exe 8191 命令行上限**
  //   （CI 实测 windows-latest 报 "The command line is too long."，Linux/macOS 不受限）；
  //   本判据的意图（链经 _preload 注入隔离、不依赖 shell 语法）不变。
  check('SR-7 测试链经 _preload 注入隔离（跨平台，不依赖 shell 语法）',
    /(?:-r|--require) .*_preload\.js/.test(chain), 'ok');
  check('SR-7 _preload 设置为 DSH_SUPERVISOR_HOME',
    /DSH_SUPERVISOR_HOME/.test(fs.readFileSync(path.join(ROOT, 'test', '_preload.js'), 'utf8')), 'ok');
  // 测试文件不得硬编码产品状态旧位置（注释除外）
  const testFiles = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const f of testFiles) {
    // 两个门禁**故意**持有旧形态字符串作为反例/负向断言，豁免扫描。
    if (f === 'state-root-test.js' || f === 'kernel-daemon-contract-test.js') continue;
    const code = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').split(String.fromCharCode(10))
      .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
      .join(String.fromCharCode(10));
    if (/'\\.dsh', 'supervisor'/.test(code) || /'\\.dsh', 'shell'/.test(code)) bad.push(f);
  }
  check('SR-7 测试文件不再硬编码 ~/.dsh/{supervisor,shell}', bad.length === 0, bad.join(', ') || 'clean');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
