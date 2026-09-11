#!/usr/bin/env node
'use strict';

// 内核「全平台本地构建/发布」能力回归（2026-09-11）。
//
// 背景：私有仓 GitHub Actions 额度按倍率计费（macOS 10x / Windows 2x），本仓 mac/win 矩阵
//   约 110 分钟/次，免费额度 2000 分钟/月仅够约 18 次 —— 实测曾耗尽（run #25 起拿不到 runner）。
// 根治：launcher 是**纯 JS 产物**（内核 0 依赖、产物 0 个 .node），平台差异仅在 npm 元数据，
//   故可在单一机器上一次构建、派生四平台，完全不消耗 GitHub 额度。
//
// 本测试锁定的不变量（任一被破坏都会让发布链路静默退化）：
//   T1 平台矩阵来自 package.json 单一事实源，且为固定顺序的 4 条
//   T2 三个脚本都接入了 --all-platforms，且 release/ci 逐层传递
//   T3 npm scripts 已接线（用户入口存在）
//   T4 构建脚本内含「四平台 core.cjs 逐字节一致」断言（防未来改动破坏同源保证）
//   T5 workflow 的 precheck：已全部发布时跳过 mac/win 矩阵（省额度）
//   T6 「纯 JS 产物」这一前提本身（0 依赖 / esbuild 无平台参数 / 产物无原生二进制）

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 工作流解析统一入口（行尾归一化，防 Windows CRLF 事故）
const { readWorkflow, stripComments } = require(path.join(__dirname, '_workflow.js'));
const S = path.join(ROOT, 'release', 'scripts');

// 调用 _platforms.sh 的矩阵函数
function matrix() {
  const r = cp.spawnSync('bash', ['-c', '. "' + path.join(S, '_platforms.sh') + '"; dsh_platform_matrix'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}

// ── T1 平台矩阵单一事实源 ──
console.log('== T1 平台矩阵（单一事实源）==');
{
  const m = matrix();
  check('T1-a 矩阵为 4 条', m.length === 4, JSON.stringify(m));
  check('T1-b 含 linux linux x64', m[0] === 'linux linux x64', m[0]);
  check('T1-c 含 darwin win32 映射正确', m.some((x) => x === 'win win32 x64'), JSON.stringify(m));
  check('T1-d 顺序固定（linux→darwin-arm64→darwin-x64→win）',
    JSON.stringify(m) === JSON.stringify(['linux linux x64', 'darwin darwin arm64', 'darwin darwin x64', 'win win32 x64']),
    JSON.stringify(m));
  // 事实源校验：矩阵必须与 package.json 的声明一一对应
  const pkgs = require(path.join(ROOT, 'package.json')).npmPublish.packages;
  check('T1-e 与 package.json#npmPublish.packages 条数一致', pkgs.length === m.length, pkgs.length + ' vs ' + m.length);
  const derived = m.map((x) => { const p = x.split(' '); return 'dsh-core-' + p[0] + '-' + p[2]; });
  check('T1-f 矩阵可推出全部子包名', pkgs.every((p) => derived.includes(p)), JSON.stringify(derived));
}

// ── T2 脚本接入 ──
console.log('== T2 脚本已接入 --all-platforms ==');
{
  const build = read('release/scripts/build-launcher.sh');
  const pub = read('release/scripts/publish-core.sh');
  const ci = read('release/scripts/ci-core.sh');
  const rel = read('release/scripts/release-core.sh');
  check('T2-a build-launcher 接受 --all-platforms', /--all-platforms\)/.test(build) && /ALL=1/.test(build), 'ok');
  check('T2-b publish-core 接受 --all-platforms', /--all-platforms\)/.test(pub) && /ALL=1/.test(pub), 'ok');
  check('T2-c publish-core 自递归调用（单一路径，不复制逻辑）',
    /bash "\$ROOT\/release\/scripts\/publish-core\.sh"/.test(pub), 'ok');
  check('T2-d ci-core 透传 PLAT_ARGS', /PLAT_ARGS/.test(ci) && /--all-platforms/.test(ci), 'ok');
  check('T2-e release-core 接受 --all-platforms', /--all-platforms\)/.test(rel), 'ok');
  check('T2-f release-core 全平台走 ci-core --all-platforms', /ci-core\.sh --all-platforms/.test(rel), 'ok');
  check('T2-g release-core 全平台发布走 publish:core --all-platforms', /publish:core -- --publish --all-platforms/.test(rel), 'ok');
  // 平台清单一律来自 _platforms.sh，不得在别处硬编码平台列表
  check('T2-h build-launcher 从 _platforms.sh 取矩阵', /\. "\$ROOT\/release\/scripts\/_platforms\.sh"/.test(build), 'ok');
  check('T2-i publish-core 从 _platforms.sh 取矩阵', /\. "\$ROOT\/release\/scripts\/_platforms\.sh"/.test(pub), 'ok');
}

// ── T3 npm scripts 接线 ──
console.log('== T3 npm scripts（用户入口）==');
{
  const sc = require(path.join(ROOT, 'package.json')).scripts;
  for (const k of ['build:launcher:all', 'publish:core:all', 'release:core:all', 'release:core:all:publish']) {
    check('T3 ' + k + ' 存在', typeof sc[k] === 'string' && /--all-platforms/.test(sc[k]), sc[k]);
  }
}

// ── T4 同源保证（构建期断言）──
console.log('== T4 四平台同源保证 ==');
{
  const build = read('release/scripts/build-launcher.sh');
  check('T4-a 全平台模式断言 core.cjs 逐字节一致', /一致性断言/.test(build) && /BASE_HASH/.test(build), 'ok');
  check('T4-b 不一致即失败（exit 1）', /core\.cjs 与基准不一致/.test(build) && /exit 1/.test(build), 'ok');
  check('T4-c 构建只做一次（esbuild 不在平台循环内）',
    (build.match(/esbuild bin\/dsh-supervisor/g) || []).length === 1,
    'esbuild 出现 ' + (build.match(/esbuild bin\/dsh-supervisor/g) || []).length + ' 次');
}

// ── T5 workflow precheck（tag 触发时的省额度闸）──
console.log('== T5 workflow precheck ==');
{
  // 经 _workflow.js 读取（行尾归一化）：本段断言本身是行首锚定（CRLF 安全），
  // 但统一走助手可杜绝后人加入 `\n` 锚定正则时重蹈 Windows CRLF 事故。
  const y = readWorkflow('build.yml');
  const code = stripComments(y);
  check('T5-a 存在 precheck job', /^\s{2}precheck:/m.test(code), 'ok');
  check('T5-b precheck 输出 need_build', /need_build:\s*\$\{\{\s*steps\.probe\.outputs\.need_build\s*\}\}/.test(code), 'ok');
  check('T5-c build 依赖 precheck', /needs:\s*precheck/.test(code), 'ok');
  check('T5-d build 仅在 need_build=true 时运行', /if:\s*needs\.precheck\.outputs\.need_build\s*==\s*.true./.test(code), 'ok');
  check('T5-e precheck 判据来自 npmPublish.packages（不硬编码平台）', /npmPublish/.test(code) && /packages/.test(code), 'ok');
  check('T5-f precheck 用 npm view 探测', /npm view/.test(code), 'ok');
  check('T5-g release 同时依赖 precheck 与 build', /needs:\s*\[precheck,\s*build\]/.test(code), 'ok');
}

// ── T6 「纯 JS 产物」前提（全平台本地构建的成立条件）──
console.log('== T6 纯 JS 产物前提 ==');
{
  const pkg = require(path.join(ROOT, 'package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  check('T6-a 内核零运行时依赖（无原生模块风险）', deps.length === 0, JSON.stringify(deps));
  const build = read('release/scripts/build-launcher.sh');
  check('T6-b esbuild 用 --platform=node（产物与宿主平台无关）', /--platform=node/.test(build), 'ok');
  check('T6-c esbuild 无 --target/--external 等平台相关参数',
    !/esbuild[^\n]*--target/.test(build) && !/esbuild[^\n]*--external/.test(build), 'ok');
  // 若已有构建产物，实测其中不含原生二进制
  const launcherDir = path.join(ROOT, 'dist', 'launcher');
  if (fs.existsSync(launcherDir)) {
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.name.endsWith('.node')) found.push(p);
      }
    })(launcherDir);
    check('T6-d 构建产物中无 .node 原生二进制', found.length === 0, JSON.stringify(found));
    // 实测四平台目录的 core.cjs 一致（若产物齐备）。
    // ⚠ 必须按**当前版本**过滤（2026-09-11 修复）：dist/launcher 会累积历史版本的平台目录，
    //   不过滤就会把「旧版 4 份 + 新版 4 份」一起比对 → **假失败**（实测 8 份 / 2 哈希）。
    //   与壳组装器同类的「缺版本过滤」缺陷 —— 一致性断言的语义是「同一版本的各平台必须一致」。
    const CUR_VER = require(path.join(ROOT, 'package.json')).version;
    const dirs = fs.readdirSync(launcherDir).filter((d) =>
      d.startsWith('dsh-supervisor-' + CUR_VER + '-') && fs.statSync(path.join(launcherDir, d)).isDirectory());
    if (dirs.length >= 2) {
      const hashes = dirs.map((d) => {
        const c = path.join(launcherDir, d, 'core.cjs');
        return fs.existsSync(c) ? require('node:crypto').createHash('sha256').update(fs.readFileSync(c)).digest('hex') : null;
      }).filter(Boolean);
      check('T6-e 实测：全部平台目录 core.cjs 哈希一致', new Set(hashes).size === 1, hashes.length + ' 份，唯一哈希 ' + new Set(hashes).size);
    } else {
      console.log('SKIP T6-e（产物不足 2 个平台目录；先跑 build:launcher:all 可覆盖）');
    }
  } else {
    console.log('SKIP T6-d/T6-e（尚无 dist/launcher 产物）');
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
