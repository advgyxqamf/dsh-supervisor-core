#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 破坏性操作防误伤门禁（2026-09-13）—— 源于一次**真实事故**
//
// ## 事故
//   做凭据门禁的**注入验证**时，先注入了「移除 DSH_CRED_DIR」以破坏夹具模式；
//   测试脚本随后的 `cred.sh put` 便**回落到真机库根**执行，把 16B 测试串
//   写进 kernel-advgyxqamf.pat，**覆盖了 93B 真令牌**（不可恢复）。
//   又因迁移时旧路径是符号链接，覆盖立即生效、无第二份副本。
//
// ## 教训（可推广的规律）
//   ① 任何**破坏性**子命令都必须对「真机」默认拒绝，而不是默默执行；
//   ② 测试夹具必须与真机**结构隔离**，且隔离失效时要**失败**而不是降级；
//   ③ 覆盖前必须留旧值备份，使操作**可逆**；
//   ④ 注入验证本身要选**非破坏性**的注入点。
//
// ## 锁定不变量
//   W-1  cred.sh 的 put 在真机库上默认拒绝（需显式确认）
//   W-2  真机库上未带确认执行 put -> exit 2 且**文件字节不变**
//   W-3  写入前会备份旧值（.bak-<时间戳>）
//   W-4  夹具模式（DSH_CRED_DIR）仍可正常写入
//   W-5  仓库内不存在任何指向真机库的**破坏性**测试调用（put/unlink 等）
//   W-6  反向：判据能识别「真机库 + put」这一危险组合
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const CRED_SH = path.join(ROOT, 'release', 'scripts', 'cred.sh');

// 真实用户 home：$HOME 被 DSH 重定向到实例数据目录，故与 cred.sh 同源解析 ——
//   不得硬编码机器路径。仅用于「真机库是否存在」的提示，不参与任何写入。
function realHome() {
  if (process.env.DSH_REAL_HOME) return process.env.DSH_REAL_HOME;
  if (process.platform === 'win32') return process.env.USERPROFILE || os.homedir();
  try {
    const u = os.userInfo().username;
    if (process.platform === 'darwin') {
      const h = execFileSync('dscl', ['.', '-read', '/Users/' + u, 'NFSHomeDirectory'], { encoding: 'utf8' }).trim().split(/s+/).pop();
      if (h && fs.existsSync(h)) return h;
    } else {
      const h = execFileSync('getent', ['passwd', u], { encoding: 'utf8' }).trim().split(':')[5];
      if (h && fs.existsSync(h)) return h;
    }
  } catch { /* 回退到 os.homedir() */ }
  return os.homedir();
}
const REAL_STORE = process.env.DSH_CRED_DIR || path.join(realHome(), '.dsh', 'credentials');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };
function cred(args, env) {
  try {
    const out = execFileSync('bash', [CRED_SH].concat(args), {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, env || {}),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: (e && e.status) || 1, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
  }
}

// ── W-5：仓库内不得存在指向真机库的破坏性调用 ──
{
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|sh)$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p);
      // 本门禁自身与工具本体除外（前者用隔离 helper，后者是 usage 注释）
      if (rel === 'test/destructive-op-safety-test.js' || rel === 'release/scripts/cred.sh') continue;
      const lines = fs.readFileSync(p, 'utf8').split(String.fromCharCode(10));
      lines.forEach((l, i) => {
        const t = l.trim();
        // 跳过注释行（本仓被自己的说明文字骗过多次）
        if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return;
        if (!/cred(\.sh)?[^\n]*\bput\b/.test(t) && !/CRED_SH[^\n]*'put'/.test(t)) return;
        // 危险组合：调 put 但**同一条语句/区块**没有 DSH_CRED_DIR 隔离
        const ctx = lines.slice(Math.max(0, i - 6), i + 3).join(String.fromCharCode(10));
        if (!/DSH_CRED_DIR/.test(ctx)) {
          offenders.push(path.relative(ROOT, p) + ':' + (i + 1) + '  ' + t.slice(0, 60));
        }
      });
    }
  };
  walk(ROOT);
  check('W-5 仓库内不存在未隔离就调 put 的位置（须在同一区块带 DSH_CRED_DIR）',
    offenders.length === 0, offenders.length ? offenders.slice(0, 3).join(' | ') : '未发现');
}

// ── W-1/W-2/W-3：真机库保护（用 DSH_REAL_HOME 把「真机库」指向临时目录）──
// ⚠ 关键设计：**不依赖真机库的状态，也不复制/改写脚本**。
//   cred.sh 的「真机库」= dsh_real_home()/.dsh/credentials；_npm-auth.sh 支持 DSH_REAL_HOME 覆盖。
//   故设 DSH_REAL_HOME=<tmp> 即可在任意宿主确定性验证真机保护，且**完全不动真实凭据**。
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'realsim-'));
  fs.chmodSync(T, 0o700);
  const fakeHome = path.join(T, 'fakehome');
  const fakeReal = path.join(fakeHome, '.dsh', 'credentials');
  fs.mkdirSync(fakeReal, { recursive: true, mode: 0o700 });
  const kf = path.join(fakeReal, 'k.pat');
  fs.writeFileSync(kf, 'original-secret-value');
  fs.chmodSync(kf, 0o600);
  fs.writeFileSync(path.join(fakeReal, 'index.json'), JSON.stringify({
    version: 1, storeDir: fakeReal, homeNote: 'x', rules: ['a', 'b', 'c', 'd'],
    entries: [{ name: 'kernel', kind: 'github-pat', account: 'x', file: kf, verify: { method: 'file' }, status: 'active' }],
    history: [],
  }));
  fs.chmodSync(path.join(fakeReal, 'index.json'), 0o600);

  const runReal = (args, env) => {
    try {
      const out = execFileSync('bash', [CRED_SH].concat(args), {
        encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, { DSH_REAL_HOME: fakeHome }, env || {}),
      });
      return { code: 0, out: String(out) };
    } catch (e2) {
      return { code: (e2 && e2.status) || 1, out: String((e2 && e2.stdout) || '') + String((e2 && e2.stderr) || '') };
    }
  };
  const before = sha(kf);
  const rDeny = runReal(['put', 'kernel']);        // 无确认 —— 必须被拒
  const afterDeny = sha(kf);
  check('W-1 「真机库」上 put 无确认时被拒绝（exit 2）', rDeny.code === 2, 'exit=' + rDeny.code);
  check('W-2 被拒绝时凭据文件**字节未变**', before !== null && before === afterDeny, before + ' vs ' + afterDeny);
  check('W-1 拒绝信息解释原因并给出两种正确用法',
    /显式确认/.test(rDeny.out) && /DSH_CRED_DIR/.test(rDeny.out), 'ok');
  // 带确认 -> 应成功且**自动备份旧值**
  let rAllow = { code: -1, out: '' };
  try {
    const out = execFileSync('bash', ['-c', 'printf %s rotated-value | bash "$0" put kernel', CRED_SH], {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { DSH_REAL_HOME: fakeHome, DSH_CRED_ALLOW_OVERWRITE: '1', DSH_CRED_FORCE: '1' }),
    });
    rAllow = { code: 0, out: String(out) };
  } catch (e3) { rAllow = { code: (e3 && e3.status) || 1, out: String((e3 && e3.stderr) || '') }; }
  const baks = fs.readdirSync(fakeReal).filter((f) => f.includes('.bak-'));
  check('W-3 覆盖前自动备份旧值（.bak-<时间戳>）', baks.length >= 1, baks.join(', ') || '(无备份)');
  check('W-3 备份内容 = 覆盖前的原值', baks.length >= 1
    && fs.readFileSync(path.join(fakeReal, baks[0]), 'utf8') === 'original-secret-value', 'ok');
  check('W-4 显式确认后写入成功（新值生效）',
    fs.readFileSync(kf, 'utf8') === 'rotated-value', fs.readFileSync(kf, 'utf8'));
  fs.rmSync(T, { recursive: true, force: true });
}
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wbak-'));
    fs.chmodSync(T, 0o700);
    const kf = path.join(T, 'a.pat');
    fs.writeFileSync(kf, 'old-value');
    fs.chmodSync(kf, 0o600);
    fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({
      version: 1, storeDir: T, homeNote: 'x', rules: ['a', 'b', 'c', 'd'],
      entries: [{ name: 'a', kind: 'github-pat', account: 'x', file: kf, verify: { method: 'file' }, status: 'active' }],
      history: [],
    }));
    fs.chmodSync(path.join(T, 'index.json'), 0o600);
    try {
      execFileSync('bash', ['-c', 'printf %s new | bash "$0" put a', CRED_SH],
        { encoding: 'utf8', env: Object.assign({}, process.env, { DSH_CRED_DIR: T }) });
    } catch (err) { /* 断言判定 */ }
    const baks = fs.readdirSync(T).filter((f) => f.includes('.bak-'));
    check('W-3 覆盖前自动备份旧值（.bak-<时间戳>）', baks.length >= 1, baks.join(', ') || '(无备份)');
    check('W-4 夹具模式仍可正常写入（不被真机保护阻断）',
      fs.existsSync(kf) && fs.readFileSync(kf, 'utf8') === 'new', 'ok');
    fs.rmSync(T, { recursive: true, force: true });
}
if (!fs.existsSync(REAL_STORE)) {
  console.log('SKIP 真机库存在性检查：本机无规范凭据库（CI/新机属正常）'
    + ' —— 保护逻辑已由上面的 fakeReal 模拟确定性验证。');
}

// ── W-6：反向（判据能识别危险组合；且保护代码确实在源码里）──
{
  const src = fs.readFileSync(CRED_SH, 'utf8');
  check('W-6 cred.sh 含真机覆盖保护（DSH_CRED_ALLOW_OVERWRITE 闸）',
    /DSH_CRED_ALLOW_OVERWRITE/.test(src), 'ok');
  check('W-6 cred.sh 含覆盖前备份逻辑（.bak-）', /\.bak-\$\(date/.test(src), 'ok');
  const danger = (line, ctx) => /cred[^\n]*\bput\b/.test(line) && !/DSH_CRED_DIR/.test(ctx);
  check('W-6 反向：判据能识别未隔离的 put 调用',
    danger('bash release/scripts/cred.sh put kernel', 'no isolation here') === true, 'hit');
  check('W-6 反向：判据对已隔离的调用不误报',
    danger('DSH_CRED_DIR=$T bash release/scripts/cred.sh put kernel', 'DSH_CRED_DIR=$T') === false, 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
