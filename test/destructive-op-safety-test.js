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
const REAL_STORE = '/home/bowen/.dsh/credentials';

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

// ── W-1/W-2/W-3：真机库保护（真机存在才测）──
// ⚠ 关键设计：**不依赖真机库的状态**。
//   真机令牌可能缺失（条目 missing）—— 那样「保护是否生效」就没被验证到（首版即如此 SKIP）。
//   改为：复制 cred.sh 到临时目录，把其中的真机库常量**改写**为临时路径，
//   于是「真机保护」逻辑在**任意宿主**上都能确定性验证，且**完全不动真机凭据**。
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'realsim-'));
  fs.chmodSync(T, 0o700);
  const fakeReal = path.join(T, 'fakereal');
  fs.mkdirSync(fakeReal, { mode: 0o700 });
  const kf = path.join(fakeReal, 'k.pat');
  fs.writeFileSync(kf, 'original-secret-value');
  fs.chmodSync(kf, 0o600);
  fs.writeFileSync(path.join(fakeReal, 'index.json'), JSON.stringify({
    version: 1, storeDir: fakeReal, homeNote: 'x', rules: ['a', 'b', 'c', 'd'],
    entries: [{ name: 'kernel', kind: 'github-pat', account: 'x', file: kf, verify: { method: 'file' }, status: 'active' }],
    history: [],
  }));
  fs.chmodSync(path.join(fakeReal, 'index.json'), 0o600);
  // 复制并改写「真机库」常量 -> 指向 fakeReal
  //
  // ⚠ 注入前必须 **POSIX 化**：Windows 路径含反斜杠，写进 shell 脚本后在双引号串里
  //   被当作转义（\U \A 被吃）→ 路径变成 C:UsersRUNNER~1...，清单找不到、put 返回 1 而非 2。
  //   该缺陷只在 Windows CI 暴露。Git Bash / MSYS 接受正斜杠，故统一转 /。
  const sim = path.join(T, 'cred-sim.sh');
  const fakeRealSh = fakeReal.split(path.sep).join('/');
  fs.writeFileSync(sim, fs.readFileSync(CRED_SH, 'utf8')
    .split(REAL_STORE).join(fakeRealSh));
  const runSim = (args, env) => {
    try {
      const out = execFileSync('bash', [sim].concat(args), {
        encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, env || {}),
      });
      return { code: 0, out: String(out) };
    } catch (e2) {
      return { code: (e2 && e2.status) || 1, out: String((e2 && e2.stdout) || '') + String((e2 && e2.stderr) || '') };
    }
  };
  const before = sha(kf);
  const rDeny = runSim(['put', 'kernel']);        // 无确认 —— 必须被拒
  const afterDeny = sha(kf);
  check('W-1 「真机库」上 put 无确认时被拒绝（exit 2）', rDeny.code === 2, 'exit=' + rDeny.code);
  check('W-2 被拒绝时凭据文件**字节未变**', before !== null && before === afterDeny, before + ' vs ' + afterDeny);
  check('W-1 拒绝信息解释原因并给出两种正确用法',
    /显式确认/.test(rDeny.out) && /DSH_CRED_DIR/.test(rDeny.out), 'ok');
  // 带确认 -> 应成功且**自动备份旧值**
  let rAllow = { code: -1, out: '' };
  try {
    rAllow = execFileSync('bash', ['-c', 'printf %s rotated-value | bash "$0" put kernel', sim], {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { DSH_CRED_ALLOW_OVERWRITE: '1', DSH_CRED_FORCE: '1' }),
    }) ? { code: 0, out: '' } : { code: 0, out: '' };
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
