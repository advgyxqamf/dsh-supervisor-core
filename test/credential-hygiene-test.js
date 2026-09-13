#!/usr/bin/env node
'use strict';

// 凭据卫生门禁（2026-09-13）—— 凭据管理标准的可执行部分
//
// ## 真实事故（本门禁要防的）
//   壳仓令牌原存于**实例附件目录**（.../instances/inst-<id>/data/.dsh/attachments/.../gh_token.txt）
//   ——那是 ephemeral 的，换个会话就没了 -> 「下午能推壳、现在找不到壳令牌」。
//   另有一份副本以 0664（全局可读）散落在 $HOME 根。
//
// ## 本门禁自身的教训（首版被 CI 打回）
//   首版直接断言**本机**凭据库存在 -> 本地全绿、CI 全红（C-1/C-2/C-3/C-4），
//   因为 CI 机器上根本没有那个库。**门禁必须宿主无关** ——
//   与 platform-layer-portability-test 同一条纪律，我却在写它时违反了。
//   修法（三段式）：D 组用临时夹具库测规则本身（任意宿主可跑）；
//   R 组真机审计（库存在才做，缺失显式 SKIP）；S 组仓库本地不变量（任何宿主成立）。
//
// ## 标准（见 CREDENTIALS-STANDARD.md 与库内 index.json 的 rules）
//   1. 凭据只允许存放在规范库（SSH 密钥可留 ~/.ssh）；禁止实例/附件目录（ephemeral）；
//   2. 库目录 0700、库内文件 0600；禁止令牌内嵌 remote URL；仓库文件不得含令牌值；
//   3. 令牌必须有清单条目，只存引用不存值；缺失要显式标 missing。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const CRED_SH = path.join(ROOT, 'release', 'scripts', 'cred.sh');

// 真实库用绝对路径：$HOME 被 DSH 重定向到实例数据目录，~/.dsh 不是这个目录。
const REAL_STORE = '/home/bowen/.dsh/credentials';
const LEGACY_ALIAS = '/home/bowen/.dsh/github-pat-advgyxqamf';
const HOME_ROOT_STRAYS = ['/home/bowen/gh_token.txt', '/home/bowen/gh_token', '/home/bowen/.gh_token'];

const results = [];
// Windows 无 POSIX 权限位（chmod 只切换只读位，mode 常为 666）——
//   D 组里所有**权限语义**断言必须平台自感知，否则只在 Windows 红。
const IS_POSIX = process.platform !== 'win32';
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const TOKEN_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/;
const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0'); } catch { return null; } };

// 用给定库根跑 cred.sh，返回 {code, out}
function runCred(dir, args) {
  try {
    const out = execFileSync('bash', [CRED_SH].concat(args), {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { DSH_CRED_DIR: dir }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: (e && e.status) || 1, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
  }
}

// 造夹具库；opts.kernelMissing=true 时该条目置 missing
function fixture(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const kf = path.join(dir, 'kernel-test.pat');
  fs.writeFileSync(kf, 'dummy-not-a-real-token');
  fs.chmodSync(kf, 0o600);
  const idx = {
    version: 1,
    storeDir: dir,
    homeNote: 'HOME 被重定向 -> 一律绝对路径',
    rules: ['a', 'b', 'c', 'd'],
    entries: [{
      name: 'kernel', kind: 'github-pat', account: 'x', file: kf,
      verify: { method: 'file' }, status: o.kernelMissing ? 'missing' : 'active',
    }],
    history: [],
  };
  const idxPath = path.join(dir, 'index.json');
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  fs.chmodSync(idxPath, 0o600);
  return { dir: dir, idxPath: idxPath, kf: kf };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'credgate-'));

// ── D 组：规则本身（夹具库，任意宿主可跑）──
{
  const d1 = path.join(TMP, 'ok');
  fixture(d1);
  const r1 = runCred(d1, ['doctor']);
  check('D-1 夹具库齐全时 cred.sh doctor 通过（退出 0）', r1.code === 0, 'exit=' + r1.code);
  // Windows 无 POSIX 权限位：doctor 会显式 SKIP，此处断言该 SKIP（而非要求 0700/0600）
  check('D-1 doctor 权限检查（POSIX 报 0700 / Windows 显式 SKIP）',
    IS_POSIX ? /OK\s+库目录 0700/.test(r1.out) : /SKIP.*POSIX 权限位/.test(r1.out),
    IS_POSIX ? 'POSIX 模式' : 'Windows SKIP');
  check('D-1 doctor 报告文件 0600（POSIX）/ Windows 跳过',
    IS_POSIX ? /kernel-test[.]pat 0600/.test(r1.out) : true,
    IS_POSIX ? 'ok' : 'Windows 无 POSIX 权限位');
  check('D-1 doctor 报告无缺项', /OK\s+无缺项/.test(r1.out), 'ok');

  const d2 = path.join(TMP, 'loose');
  const f2 = fixture(d2);
  fs.chmodSync(f2.kf, 0o644);
  const r2 = runCred(d2, ['doctor']);
  // Windows 无 POSIX 权限位：chmod 0644 不会被判为「过宽」→ doctor 不会失败。
  //   故仅在 POSIX 上断言该失败语义；Windows 断言改为「doctor 完成且不因权限误报」。
  check('D-2 库内文件权限过宽（0644）-> doctor 失败（POSIX）/ Windows 跳过',
    IS_POSIX ? r2.code !== 0 : true,
    IS_POSIX ? 'exit=' + r2.code : 'Windows 无 POSIX 权限位');
  check('D-2 失败原因指向该文件（POSIX）/ Windows 跳过',
    IS_POSIX ? /kernel-test[.]pat 权限 644/.test(r2.out) : true,
    IS_POSIX ? 'ok' : 'Windows 无 POSIX 权限位');

  const d3 = path.join(TMP, 'missing');
  fixture(d3, { kernelMissing: true });
  const r3 = runCred(d3, ['doctor']);
  check('D-3 条目 status=missing -> doctor 失败（缺项可见）', r3.code !== 0, 'exit=' + r3.code);
  check('D-3 输出点名缺哪个条目', /kernel/.test(r3.out) && /缺/.test(r3.out), 'ok');

  const d4 = path.join(TMP, 'outside');
  const f4 = fixture(d4);
  const j4 = JSON.parse(fs.readFileSync(f4.idxPath, 'utf8'));
  j4.entries[0].file = '/home/bowen/.dsh/supervisor/instances/inst-1/data/.dsh/attachments/x/gh_token.txt';
  fs.writeFileSync(f4.idxPath, JSON.stringify(j4, null, 2));
  const r4 = runCred(d4, ['doctor']);
  check('D-4 条目指向 ephemeral 附件路径 -> doctor 失败', r4.code !== 0, 'exit=' + r4.code);
  check('D-4 失败信息含该条目名与路径', /kernel/.test(r4.out) && /attachments/.test(r4.out), 'ok');

  const r5 = runCred(d1, ['list']);
  check('D-5 list 输出条目名与状态', /kernel/.test(r5.out) && /active/.test(r5.out), 'ok');
  const r5b = runCred(d1, ['path', 'kernel']);
  // 绝对路径：POSIX 以 / 开头；Windows 形如 C:/... 或 C:\...
  const absPath = /^([A-Za-z]:[\\/]|\/)/.test(r5b.out.trim());
  check('D-5 path 输出库内绝对路径', /kernel-test[.]pat/.test(r5b.out) && absPath, r5b.out.trim());
  const r5c = runCred(d1, ['get', 'kernel']);
  check('D-5 get 返回文件内容（供脚本消费）', r5c.out.trim() === 'dummy-not-a-real-token', 'ok');
  const r5d = runCred(d1, ['get', 'nonexistent']);
  check('D-5 get 未知条目 -> 非零退出', r5d.code !== 0, 'exit=' + r5d.code);

  const d6 = path.join(TMP, 'put');
  fixture(d6, { kernelMissing: true });
  try {
    execFileSync('bash', ['-c', 'printf %s new-secret-value | bash "$0" put kernel', CRED_SH],
      { encoding: 'utf8', env: Object.assign({}, process.env, { DSH_CRED_DIR: d6 }) });
  } catch (e) { /* 由下方断言判定 */ }
  const kf6 = path.join(d6, 'kernel-test.pat');
  // Windows 上 chmod 不产生 POSIX 0600（常为 666）——仅断言文件确实写入
  check('D-6 put 写入文件且权限 0600（POSIX）/ Windows 仅断言写入',
    fs.existsSync(kf6) && (IS_POSIX ? modeOf(kf6) === '600' : true),
    IS_POSIX ? String(modeOf(kf6)) : 'Windows 无 POSIX 权限位');
  check('D-6 put 后该条目 status 变为 active',
    JSON.parse(fs.readFileSync(path.join(d6, 'index.json'), 'utf8')).entries[0].status === 'active', 'ok');
  check('D-6 put 后 doctor 通过（缺项已消）', runCred(d6, ['doctor']).code === 0, 'ok');
}

// ── S 组：仓库本地不变量（任何宿主都成立）──
{
  const exts = ['.js', '.json', '.md', '.sh', '.yml', '.yaml', '.txt', '.rs', '.ts', '.tsx'];
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.includes(path.extname(e.name))) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (TOKEN_RE.test(txt)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  check('S-1 仓库工作树内无令牌值', hits.length === 0, hits.length ? hits.join(', ') : '未发现');

  let remotes = '';
  try { remotes = execFileSync('git', ['remote', '-v'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { /* 非 git 环境 */ }
  const embedded = remotes.split(String.fromCharCode(10)).filter((l) => {
    const s = l.indexOf('://');
    if (s < 0) return false;
    const rest = l.slice(s + 3);
    const at = rest.indexOf('@');
    if (at < 0) return false;
    return rest.slice(0, at).indexOf(':') >= 0;
  });
  check('S-2 git remote URL 未内嵌凭据', embedded.length === 0, embedded.length ? embedded[0].slice(0, 60) : 'ok');

  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { /* 非 git 环境 */ }
  const keyFiles = tracked.split(String.fromCharCode(10)).filter((f) => /[.](pat|pem|key)$/.test(f));
  check('S-3 未被跟踪任何凭据/密钥文件（*.pat / *.pem / *.key）',
    keyFiles.length === 0, keyFiles.length ? keyFiles.join(', ') : 'ok');
}

// ── R 组：真机审计（库存在才做；缺失显式 SKIP）──
{
  if (!fs.existsSync(REAL_STORE)) {
    console.log('SKIP R 组：本机无规范凭据库（' + REAL_STORE + '）—— CI/新机属正常；规则本身已由 D 组用夹具库确定性验证。');
  } else {
    check('R-1 真机库目录权限 0700', modeOf(REAL_STORE) === '700', String(modeOf(REAL_STORE)));
    const idx = path.join(REAL_STORE, 'index.json');
    check('R-2 真机清单存在且 0600', fs.existsSync(idx) && modeOf(idx) === '600', String(modeOf(idx)));
    const files = fs.readdirSync(REAL_STORE).filter((f) => !f.endsWith('.sh'));
    const loose = files.filter((f) => modeOf(path.join(REAL_STORE, f)) !== '600');
    check('R-3 真机库内文件权限均 0600', files.length > 0 && loose.length === 0,
      loose.length ? loose.join(', ') : (files.length + ' 个文件均 0600'));
    const rr = runCred(REAL_STORE, ['doctor']);
    const permFail = rr.out.split(String.fromCharCode(10)).filter((l) => l.indexOf('FAIL') === 0 && /权限|库内路径/.test(l));
    check('R-4 真机 doctor 的权限与路径检查通过（缺项单列，不视为卫生问题）',
      permFail.length === 0, permFail.length ? permFail[0].slice(0, 70) : 'ok');
    const missLine = rr.out.split(String.fromCharCode(10)).filter((l) => l.indexOf('缺') >= 0 && l.indexOf('OK') < 0);
    if (missLine.length) console.log('     （提示）真机存在缺项：' + missLine[0].trim());
    let aliasState = 'absent';
    try {
      const st = fs.lstatSync(LEGACY_ALIAS);
      if (st.isSymbolicLink()) {
        aliasState = fs.realpathSync(LEGACY_ALIAS).startsWith(REAL_STORE + '/') ? 'link-into-store' : 'link-outside';
      } else aliasState = 'separate-copy';
    } catch (e) { aliasState = 'absent'; }
    check('R-5 旧别名不存在或指向库内（单一副本）',
      aliasState === 'absent' || aliasState === 'link-into-store', aliasState);
    const strays = HOME_ROOT_STRAYS.filter((p) => fs.existsSync(p));
    check('R-6 $HOME 根目录无散落令牌副本', strays.length === 0, strays.join(', ') || 'ok');
  }
}

// ── 持久化断言（2026-09-13）：库必须在**实例目录之外** ──
//   为什么单独锁：$HOME 被 DSH 重定向到 .../instances/<id>/data，
//   若有人把库「改良」成 ~/.dsh/credentials，它就会落在**实例目录内** ——
//   换会话即失效（正是历史事故的形态：凭据存在实例附件目录 → 下游会话找不到）。
{
  const homedir = os.homedir();
  check('持久化-1 凭据库不在被重定向的 $HOME 之下（否则换会话即失效）',
    !REAL_STORE.startsWith(homedir + path.sep) && REAL_STORE !== homedir,
    'STORE=' + REAL_STORE + '  HOME=' + homedir);
  check('持久化-2 凭据库路径不含 /instances/（实例目录是 ephemeral 的）',
    REAL_STORE.indexOf('/instances/') < 0, REAL_STORE);
  check('持久化-3 凭据库是绝对路径（禁止 ~ 依赖）',
    REAL_STORE.startsWith('/') && REAL_STORE.indexOf('~') < 0, REAL_STORE);
  if (fs.existsSync(REAL_STORE)) {
    const pats = fs.readdirSync(REAL_STORE).filter((x) => x.endsWith('.pat'));
    check('持久化-4 真机令牌文件非空且长度合理（未被清空/占位）',
      pats.length > 0 && pats.every((x) => {
        const sz = fs.statSync(path.join(REAL_STORE, x)).size;
        return sz >= 40;
      }), pats.map((x) => x + '=' + fs.statSync(path.join(REAL_STORE, x)).size + 'B').join(', '));
  } else {
    console.log('SKIP 持久化-4：本机无规范凭据库（CI/新机属正常）');
  }
}

// ── 反向 ──
{
  check('反向：令牌值判据能识别真实形态', TOKEN_RE.test('github_pat_' + 'A'.repeat(30)), 'hit');
  check('反向：判据不误报普通字符串', !TOKEN_RE.test('github_pat_short') && !TOKEN_RE.test('token=abc'), 'ok');
  check('反向：D 组夹具确实被创建（非空转）', fs.readdirSync(TMP).length >= 5, String(fs.readdirSync(TMP).length) + ' 个夹具库');
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
