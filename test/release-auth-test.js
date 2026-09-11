#!/usr/bin/env node
'use strict';

// 发布链路标准化回归（2026-09-10）：
//   R1 认证解析**单源**（_npm-auth.sh 被 publish-core / configure-credentials 共同 source）
//   R2 「真实 home」解析不受沙箱 $HOME 覆盖影响（这是「同一台机器上 A 沙箱能发版、B 沙箱 ENEEDAUTH」的根因）
//   R3 NPM_TOKEN → 临时 userconfig（0600、退出即删、env 精确恢复）
//   R4 规范位置（真实 home/.npmrc）可被命中
//   R5 发布脚本**不得**执行 npm config set（回归：曾永久改开发机 registry + 明文写入 ~/.npmrc）
//   R6 CI 矩阵不含 ubuntu（Linux 已改本地生产）
//   R7 release-core 有平台闸（非 Linux 拒绝真发布，防与 CI 二次发布）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'release', 'scripts');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-auth-'));

function runBash(script, env) {
  const f = path.join(TMP, 's' + Math.random().toString(36).slice(2) + '.sh');
  fs.writeFileSync(f, script);
  return cp.execFileSync('bash', [f], { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
}

// ── R1 单源 ──
console.log('== R1 认证解析单源 ==');
{
  const lib = path.join(S, '_npm-auth.sh');
  check('R1-a _npm-auth.sh 存在', fs.existsSync(lib));
  for (const f of ['publish-core.sh', 'configure-credentials.sh']) {
    const src = fs.readFileSync(path.join(S, f), 'utf8');
    check('R1-b ' + f + ' source _npm-auth.sh', /_npm-auth\.sh/.test(src));
  }
}

// ── R2 真实 home 解析 ──
console.log('== R2 真实 home 不受沙箱 HOME 影响 ==');
{
  const lib = path.join(S, '_npm-auth.sh');
  const out = runBash('source "' + lib + '"' + String.fromCharCode(10) + 'echo "REAL=$(dsh_real_home)"' + String.fromCharCode(10) + 'echo "CANON=$(dsh_canonical_npmrc)"', { HOME: '/nonexistent-sandbox-home' });
  const real = (out.match(/^REAL=(.*)$/m) || [])[1];
  const canon = (out.match(/^CANON=(.*)$/m) || [])[1];
  check('R2-a 解析出真实 home（非被覆盖的 HOME）', !!real && real !== '/nonexistent-sandbox-home' && fs.existsSync(real), real);
  check('R2-b 规范 npmrc 指向真实 home', canon === real + '/.npmrc', canon);
  check('R2-c DSH_REAL_HOME 可显式覆盖（测试/特殊部署）', runBash('source "' + lib + '"' + String.fromCharCode(10) + 'dsh_real_home', { DSH_REAL_HOME: '/tmp' }).trim() === '/tmp');
}

// ── R3 NPM_TOKEN 临时 userconfig ──
console.log('== R3 NPM_TOKEN 临时 userconfig ==');
{
  const lib = path.join(S, '_npm-auth.sh');
  const script = [
    'source "' + lib + '"',
    // 记录调用前的**小写**值：经 `npm test`/`npm run` 运行时，npm 自身会注入
    // npm_config_userconfig=$HOME/.npmrc —— 这正是 CI 里顶掉我们大写变量的元凶。
    // 故断言应是「cleanup 还原到调用前的值」，而非固定为 unset。
    'echo "PRE_LOWER=${npm_config_userconfig:-unset}"',
    'unset NPM_CONFIG_USERCONFIG',
    'NPM_TOKEN=secret-xyz dsh_npm_auth_setup >/dev/null',
    'echo "SRC=$(dsh_npm_auth_describe)"',
    'echo "FILE=$DSH_NPM_AUTH_TMP"',
    // ⚠ stat 的权限格式在 GNU 与 BSD 上不同：Linux 用 `-c %a`，macOS 用 `-f %Lp`。
    //   旧写法只有 GNU 版，导致该断言在 macOS CI 上恒为空 → 失败（实测 CI #16）。
    'echo "PERM=$(stat -c %a "$DSH_NPM_AUTH_TMP" 2>/dev/null || stat -f %Lp "$DSH_NPM_AUTH_TMP" 2>/dev/null)"',
    'echo "HAS=$(grep -c secret-xyz "$DSH_NPM_AUTH_TMP")"',
    // ⚠ 大小写必须同时设置：npm 把两者都映射为 userconfig，**小写优先**。
    //   CI 中 `npm run` 会注入 npm_config_userconfig=$HOME/.npmrc，若我们只设大写就会被它顶掉
    //   → npm 去读无 token 的文件 → **ENEEDAUTH**（mac/win 发布长期失败的真正根因）。
    //   注意：以下三项必须在 cleanup **之前**采样。
    'echo "LOWER=${npm_config_userconfig:-unset}"',
    'echo "BOTH_SAME=$([ "${NPM_CONFIG_USERCONFIG:-x}" = "${npm_config_userconfig:-y}" ] && echo yes || echo no)"',
    'dsh_npm_auth_cleanup',
    'echo "GONE=$([ -f "$DSH_NPM_AUTH_TMP" ] && echo no || echo yes)"',
    'echo "ENVRESTORED=${NPM_CONFIG_USERCONFIG:-unset}"',
    'echo "LOWER_AFTER=${npm_config_userconfig:-unset}"',
  ].join(String.fromCharCode(10));
  const out = runBash(script);
  check('R3-a 命中 NPM_TOKEN 路径', /SRC=NPM_TOKEN/.test(out), (out.match(/^SRC=(.*)$/m) || [])[1]);
  // ⚠ POSIX-only 断言：Windows 的 NTFS ACL 不映射到 POSIX 权限位，`chmod 600` 实为无操作，
  //   stat 报 644 —— 原断言在 Windows CI 上恒失败（且这并非产品缺陷：该文件的保护在
  //   Windows 上依赖用户目录 ACL，而非 0600 位）。
  if (process.platform === 'win32') {
    console.log('SKIP R3-b（Windows 无 POSIX 权限位，0600 不适用）');
  } else {
    check('R3-b 临时 userconfig 权限 600', /PERM=600/.test(out), (out.match(/^PERM=(.*)$/m) || [])[1]);
  }
  check('R3-c token 已写入临时文件', /HAS=1/.test(out), (out.match(/^HAS=(.*)$/m) || [])[1]);
  check('R3-d cleanup 删除临时文件', /GONE=yes/.test(out), (out.match(/^GONE=(.*)$/m) || [])[1]);
  check('R3-e cleanup 精确恢复 env', /ENVRESTORED=unset/.test(out), (out.match(/^ENVRESTORED=(.*)$/m) || [])[1]);
  check('R3-f 小写 npm_config_userconfig 也已设置（防被 npm run 顶掉）', /^LOWER=\/tmp|^LOWER=\/var\/folders|^LOWER=\/private\/var/m.test(out) || /^LOWER=(?!unset).+$/m.test(out), (out.match(/^LOWER=(.*)$/m) || [])[1]);
  check('R3-g 大小写指向同一文件', /BOTH_SAME=yes/.test(out), (out.match(/^BOTH_SAME=(.*)$/m) || [])[1]);
  // 还原语义：cleanup 后小写必须等于调用前的值（而不是残留我们设的临时文件）。
  const preLower = (out.match(/^PRE_LOWER=(.*)$/m) || [])[1];
  const afterLower = (out.match(/^LOWER_AFTER=(.*)$/m) || [])[1];
  check('R3-h cleanup 后小写还原为调用前的值（不残留临时文件）',
    preLower !== undefined && afterLower !== undefined && preLower === afterLower,
    'pre=' + preLower + ' after=' + afterLower);
}

// ── R4 规范位置命中 ──
console.log('== R4 规范位置（真实 home/.npmrc）命中 ==');
{
  const lib = path.join(S, '_npm-auth.sh');
  const fakeHome = path.join(TMP, 'fakehome');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.npmrc'), '//registry.npmjs.org/:_authToken=canon-token' + String.fromCharCode(10), { mode: 0o600 });
  const script = [
    'source "' + lib + '"',
    'unset NPM_CONFIG_USERCONFIG',
    'unset NPM_TOKEN; unset NODE_AUTH_TOKEN',
    'if dsh_npm_auth_setup; then echo "HIT=$(dsh_npm_auth_describe)"; echo "CFG=$NPM_CONFIG_USERCONFIG"; else echo "HIT=none"; fi',
  ].join(String.fromCharCode(10));
  const out = runBash(script, { DSH_REAL_HOME: fakeHome });
  check('R4-a 命中真实 home 规范文件', /HIT=真实 home/.test(out), (out.match(/^HIT=(.*)$/m) || [])[1]);
  // ⚠ 分隔符归一化：`dsh_canonical_npmrc` 用 "$(dsh_real_home)/.npmrc" 拼路径（硬编码 '/'），
  //   而 path.join 在 Windows 上产出 '\\' → 原断言在 Windows 上必失败（仅分隔符差异）。
  const sepNorm = (s) => String(s).replace(/[\\/]+/g, '/');
  check('R4-b 指向该规范文件',
    sepNorm(out).includes(sepNorm('CFG=' + path.join(fakeHome, '.npmrc'))),
    (out.match(/^CFG=(.*)$/m) || [])[1]);
  const noneOut = runBash(script, { DSH_REAL_HOME: path.join(TMP, 'emptyhome') });
  check('R4-c 无 token 时不误报成功', /HIT=none/.test(noneOut), (noneOut.match(/^HIT=(.*)$/m) || [])[1]);
}

// ── R5 不污染开发机 npm 配置 ──
console.log('== R5 发布脚本不得执行 npm config set ==');
{
  for (const f of ['ci-core.sh', 'release-core.sh', 'publish-core.sh', 'configure-credentials.sh']) {
    const src = fs.readFileSync(path.join(S, f), 'utf8');
    // 允许出现在注释中，但不得是可执行语句
    const code = src.split(String.fromCharCode(10)).filter((l) => !/^\s*#/.test(l)).join(String.fromCharCode(10));
    check('R5 ' + f + ' 无可执行的 npm config set', !/npm\s+config\s+set/.test(code));
  }
}

// ── R6 CI 平台分工 ──
console.log('== R6 CI 矩阵不含 ubuntu ==');
{
  const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  const code = y.split(String.fromCharCode(10)).filter((l) => !/^\s*#/.test(l)).join(String.fromCharCode(10));
  // ⚠ 断言范围必须精确到「build 发布矩阵」这一 job（2026-09-11 两次修正）：
  //   linux-x64 由**本地**发布，故 CI 的 npm 发布矩阵不得含 ubuntu；
  //   但使用 ubuntu 的 job 是正当存在的 —— `precheck`（探测是否已全部发布）与
  //   `release`（汇总 artifact → 挂 GitHub Release，不发 npm）。
  //   故必须按 job 名切分，而非按「全文」或「release 之前的所有内容」。
  const jobSection = (name) => {
    const parts = code.split(/\n  [a-z][a-z0-9_-]*:\n/);
    const idx = code.split(/\n  ([a-z][a-z0-9_-]*):\n/).reduce((acc, seg, i, arr) => {
      if (i % 2 === 1 && seg === name) acc.push(arr[i + 1] || '');
      return acc;
    }, []);
    return idx.join('\n');
  };
  const buildSection = jobSection('build');
  const releaseSection = jobSection('release');
  const precheckSection = jobSection('precheck');
  check('R6-a 发布矩阵不含 ubuntu', !/os:\s*ubuntu/.test(buildSection) && !/runs-on:\s*ubuntu/.test(buildSection), buildSection.match(/os:\s*\S+/g));
  check('R6-b build 用 matrix.os', /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/.test(buildSection) && /windows-latest/.test(y));
  check('R6-c 含 macos', /macos-latest/.test(y) && /macos-14/.test(y));
  check('R6-d release job 只挂资产、不发布 npm', releaseSection.length > 0 && !/npm\s+publish/.test(releaseSection) && !/ci-core\.sh/.test(releaseSection), releaseSection.length ? 'ok' : '未取到 release job');
  // release 现为 needs: [precheck, build]（全平台本地发布后要能按 precheck 决定是否挂资产）
  check('R6-e release job 仅 tag 触发且依赖 build',
    /needs:\s*\[[^\]]*\bbuild\b[^\]]*\]/.test(releaseSection) && /startsWith\(github\.ref/.test(releaseSection),
    (releaseSection.match(/needs:[^\n]*/) || [])[0]);
  // precheck：全平台本地发布后跳过昂贵矩阵（省额度），其自身不得发布 npm
  check('R6-f 存在 precheck 且不发布 npm', precheckSection.length > 0 && !/npm\s+publish/.test(precheckSection), precheckSection.length ? 'ok' : '未取到');
  check('R6-g precheck 用 ubuntu（1x 计费，成本远低于 mac 10x）', /runs-on:\s*ubuntu/.test(precheckSection), 'ok');
}

// ── R7 平台闸 ──
console.log('== R7 真发布平台闸 ==');
{
  const src = fs.readFileSync(path.join(S, 'release-core.sh'), 'utf8');
  check('R7-a 有非 Linux 真发布拒绝', /PUBLISH.*1.*PLAT.*!=.*linux|PLAT.*!=.*"linux"/.test(src), 'ok');
  check('R7-b 委托 ci-core.sh（薄编排，不重复实现）', /ci-core\.sh/.test(src));
  check('R7-c 不重复实现 npm test（避免与 ci-core 双份维护）', !/^\s*npm test\s*$/m.test(src));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);