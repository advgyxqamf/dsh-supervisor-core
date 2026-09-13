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
//   T5 workflow：**四平台完整构建不得被 need_build 跳过**（2026-09-14 硬标准）
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

// ── T2 脚本接入（**2026-09-13 硬标准改版**）──
//
// 硬标准：**任何平台构建/发布都必须经 GitHub CI**；本地不得有全平台路径。
// 故：
//   · build-launcher.sh --all-platforms  **仅 CI 内允许**（CI test job 需四平台产物）
//   · publish-core.sh --all-platforms     **一律拒绝**（本地不得全平台发布）
//   · ci-core.sh --all-platforms          **一律拒绝**
//   · release-core.sh                     **已删除**（纯本地编排器，CI 从不调用）
console.log('== T2 硬标准：本地无全平台构建/发布路径 ==');
{
  const build = read('release/scripts/build-launcher.sh');
  const pub = read('release/scripts/publish-core.sh');
  const ci = read('release/scripts/ci-core.sh');
  const pkg = require(path.join(ROOT, 'package.json'));

  check('T2-a build-launcher 的 --all-platforms 受 GITHUB_ACTIONS 守卫（CI-only）',
    /--all-platforms\)/.test(build) && /GITHUB_ACTIONS/.test(build), 'ok');
  check('T2-a2 本地调用确实被拒绝（exit 2 且带说明）',
    /GITHUB_ACTIONS:-\}\" != 'true'/.test(build) && /只允许在 GitHub CI 内运行/.test(build), 'ok');
  check('T2-a3 CI 内仍放行（CI test job 需四平台产物供 T6-d/T6-e）',
    /ALL=1/.test(build), 'ok');
  check('T2-b publish-core 的 --all-platforms 一律拒绝（本地不得全平台发布）',
    /--all-platforms\)/.test(pub) && /已废弃/.test(pub) && /exit 2/.test(pub), 'ok');
  check('T2-d ci-core 的 --all-platforms 一律拒绝',
    /--all-platforms\)/.test(ci) && /已废弃/.test(ci) && /exit 2/.test(ci), 'ok');

  // release-core.sh 已删除（纯本地编排器）
  check('T2-e release-core.sh 已删除（不再有本地发布编排）',
    !fs.existsSync(path.join(ROOT, 'release', 'scripts', 'release-core.sh')), '已删除');
  check('T2-f 无任何文件再引用 release-core',
    !read('release/scripts/ci-core.sh').includes('release-core.sh 编排调用'),
    'ok');

  // npm scripts：本地发布入口必须不存在；仅保留 CI 用的构建入口
  const gone = ['release:core', 'release:core:publish', 'release:core:all', 'release:core:all:publish', 'publish:core:all'];
  const still = gone.filter((k) => pkg.scripts[k]);
  check('T2-g 本地发布类 npm script 已全部移除', still.length === 0, still.join(', ') || '已移除 ' + gone.length + ' 个');
  check('T2-h 仅保留 CI 内的四平台构建入口 build:launcher:all',
    typeof pkg.scripts['build:launcher:all'] === 'string'
    && /--all-platforms/.test(pkg.scripts['build:launcher:all']), pkg.scripts['build:launcher:all']);

  // 平台清单一律来自 _platforms.sh，不得在别处硬编码平台列表
  check('T2-i build-launcher 从 _platforms.sh 取矩阵', /\. "\$ROOT\/release\/scripts\/_platforms\.sh"/.test(build), 'ok');
  check('T2-j publish-core 从 _platforms.sh 取矩阵', /\. "\$ROOT\/release\/scripts\/_platforms\.sh"/.test(pub), 'ok');
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
  // ⭐ 2026-09-14 反转：build 段内**不得**有 job 级 if:（不得被 need_build 跳过）。
  //   旧断言「build 仅在 need_build=true 时运行」是**省额度时代**的规则，
  //   它锁住了「矩阵被跳过」这一隐藏问题的成因；硬标准（构建/发布一律经 CI）下必须反转。
  {
    const _l = code.split(String.fromCharCode(10));
    const _bs = _l.findIndex((l) => l === '  build:');
    let _be = _bs + 1;
    while (_be < _l.length && !/^  [a-z][a-z-]*:$/.test(_l[_be])) _be++;
    const _seg = _l.slice(_bs, _be).join(String.fromCharCode(10));
    check('T5-d build **不得**被 need_build 门控（四平台完整构建每次都跑）',
      _bs >= 0 && !/^    if:/m.test(_seg),
      (_seg.match(/^    if:.*$/m) || ['(无 if)'])[0]);
    check('T5-d2 反向：判据能识别被门控的 build',
      /^    if:/m.test('  build:' + String.fromCharCode(10) + '    if: needs.precheck.outputs.need_build'), 'hit');
    check('T5-g 发布仍受 need_build 一次性闸保护（防同版本重发）',
      /needs\.precheck\.outputs\.need_build/.test(_seg), 'ok');
  }
  check('T5-e precheck 判据来自 npmPublish.packages（不硬编码平台）', /npmPublish/.test(code) && /packages/.test(code), 'ok');
  check('T5-f precheck 用 npm view 探测', /npm view/.test(code), 'ok');
  check('T5-h release 同时依赖 precheck 与 build', /needs:\s*\[precheck,\s*build\]/.test(code), 'ok');
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
      // 2026-09-13：CI 会先跑 build:launcher:all 并设 DSH_LAUNCHER_REQUIRED=1；
      // 此时产物不足即**硬失败**，不得静默跳过（否则该断言在产线上永不检查）。
      if (process.env.DSH_LAUNCHER_REQUIRED === '1') {
        check('T6-e 需要真实产物（已声明 DSH_LAUNCHER_REQUIRED=1，不得静默跳过）', false,
          '当前版本 ' + CUR_VER + ' 的平台目录不足 2 个');
      }
    }
  } else {
    console.log('SKIP T6-d/T6-e（尚无 dist/launcher 产物）');
    if (process.env.DSH_LAUNCHER_REQUIRED === '1') {
      check('T6-d/T6-e 需要真实产物（已声明 DSH_LAUNCHER_REQUIRED=1，不得静默跳过）', false,
        'dist/launcher 不存在（CI 应先跑 npm run build:launcher:all）');
    }
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
