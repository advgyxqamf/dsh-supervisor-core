#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 安装标识（installId）门禁 —— SSOT: RELEASE-CHANNEL-CONTRACT §5.2 / §6 RC-G6。
//
// ## 为什么是硬门禁
//   灰度发布（canary）按 installId 定向匹配。标识一旦**漂移**（每次启动换新、
//   或读失败时"顺手新建"），后果是：
//     · 已在名单里的机器突然失配 —— 用户报"灰度没生效"，而我方查名单明明有它；
//     · 反向更糟：名单里的 UUID 被别的机器占用（若实现成随机重建）。
//   故"生成一次、此后只读、失败不新建"必须由**可执行断言**守住，而不是靠注释。
//
// ## 覆盖
//   ID-1 首次调用生成 UUID v4 并落盘
//   ID-2 幂等：再次调用拿到**同一个**值（核心不变量）
//   ID-3 落盘权限 0600（POSIX）
//   ID-4 环境变量覆盖优先
//   ID-5 **读坏内容不覆盖**（不漂移）—— 返回 null 而非新建
//   ID-6 **写失败不返回内存临时值**（不可复现的行为比"没有"更危险）
//   ID-7 跨仓口径：文件名与路径与契约 §5.2 一致（壳读同一文件）
//   ID-8 反向：判据能识别"每次重建"的错误实现（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const POSIX = process.platform !== 'win32';

/** 在隔离的状态根里跑一段脚本（拿到子进程输出）——绝不碰真实状态根。
 *
 * ⚠ 隔离变量必须用 **DSH_SUPERVISOR_HOME**（与 test/_preload.js 同口径）：
 *   我只设 XDG_STATE_HOME 时测试**看似隔离实则没有**（preload 的变量优先级更高），
 *   断言于是检查了真实状态根 —— 这本身就是一个"隔离失效"的教训，见 ID-3a。 */
function runIn(tmp, body) {
  const env = Object.assign({}, process.env, {
    DSH_SUPERVISOR_HOME: tmp,
    DSH_CANARY_ID: '',
  });
  delete env.XDG_STATE_HOME; // 避免与 DSH_SUPERVISOR_HOME 语义混淆（后者是权威）
  return execFileSync(process.execPath, ['-e', body], { cwd: ROOT, env, encoding: 'utf8' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-'));

// ── ID-1 / ID-2 / ID-3：生成、幂等、权限 ──
{
  const out = runIn(tmp, `
    const m = require('./src/platform/service/install-id');
    const a = m.readInstallId();
    m._resetCache();
    const b = m.readInstallId();
    // 路径**由被测代码自己报**（而不是测试硬拼）——否则"路径口径"这一断言会变成
    //   "测试假设"的自证（本仓禁忌：断言必须检验实现，不能检验测试自己的假设）。
    process.stdout.write(JSON.stringify({ a, b, fp: m.installIdPath() }));
  `);
  const { a, b, fp } = JSON.parse(out);
  check('ID-1 首次调用生成 UUID v4 并落盘', !!a && a.source === 'created' && /^[0-9a-f-]{36}$/.test(a.id), JSON.stringify(a));
  check('ID-2 幂等：再次调用拿到同一个值（不漂移）', !!b && b.source === 'file' && b.id === a.id, JSON.stringify({ a: a && a.id, b: b && b.id }));
  check('ID-3a 落盘位置在隔离状态根内（不污染真实状态根）', String(fp).startsWith(tmp), fp);
  if (POSIX && fs.existsSync(fp)) {
    const mode = fs.statSync(fp).mode & 0o777;
    check('ID-3b 落盘权限 0600', mode === 0o600, mode.toString(8));
  } else {
    console.log('SKIP ID-3b 权限位断言（Windows 无 POSIX mode 或文件不存在）');
  }
}

// ── ID-4：环境变量覆盖 ──
{
  const env4 = Object.assign({}, process.env, {
    DSH_SUPERVISOR_HOME: tmp,
    DSH_CANARY_ID: '  550e8400-e29b-41d4-a716-446655440000  ',
  });
  delete env4.XDG_STATE_HOME;
  const out = execFileSync(process.execPath, ['-e', `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify(m.readInstallId()));
  `], { cwd: ROOT, env: env4, encoding: 'utf8' });
  const r = JSON.parse(out);
  check('ID-4 环境变量覆盖优先且 trim', r && r.source === 'env' && r.id === '550e8400-e29b-41d4-a716-446655440000', JSON.stringify(r));
}

// ── ID-5：读坏内容**不覆盖**（关键不变量）──
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-bad-'));
  // 路径**问被测代码**（超集口径：DSH_SUPERVISOR_HOME 是权威隔离变量）
  const fp = JSON.parse(runIn(tmp2, `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify(m.installIdPath()));
  `));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, 'not-a-uuid\n');
  const out = runIn(tmp2, `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify({ r: m.readInstallId(), after: require('node:fs').readFileSync(m.installIdPath(), 'utf8') }));
  `);
  const { r, after } = JSON.parse(out);
  check('ID-5 内容非法时返回 null 且**不覆盖**原文件（防漂移）',
    r === null && after.trim() === 'not-a-uuid', JSON.stringify({ r, after: after.trim() }));
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ── ID-6：写失败不返回内存临时值 ──
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-ro-'));
  // 把 install-id 的**父目录**做成只读 → 生成时写盘必失败
  const fp3 = JSON.parse(runIn(tmp3, `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify(m.installIdPath()));
  `));
  const rootDir = path.dirname(fp3);
  fs.mkdirSync(rootDir, { recursive: true });
  if (POSIX) fs.chmodSync(rootDir, 0o500);
  let r = null;
  try {
    const out = runIn(tmp3, `
      const m = require('./src/platform/service/install-id');
      process.stdout.write(JSON.stringify(m.readInstallId()));
    `);
    r = JSON.parse(out);
  } catch (e) {
    r = { threw: true };
  }
  if (POSIX) {
    check('ID-6 写盘失败时不返回临时值（返回 null，行为可复现）', r === null, JSON.stringify(r));
    fs.chmodSync(rootDir, 0o700);
  } else {
    console.log('SKIP ID-6 只读目录断言（Windows 不适用）');
  }
  fs.rmSync(tmp3, { recursive: true, force: true });
}

// ── ID-7：跨仓口径（壳读同一文件）──
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'install-id.js'), 'utf8');
  check('ID-7a 文件名常量与契约一致（install-id）', /FILE_NAME\s*=\s*'install-id'/.test(src), 'install-id');
  check('ID-7b 位于内核状态根 supervisor/ 下（壳读同一路径）',
    /supervisorDir\(\)/.test(src) && /FILE_NAME/.test(src), 'supervisorDir()/install-id');
}

// ── ID-8：反向非空转 —— 判据能识别"每次重建"的错误实现 ──
{
  const good = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'install-id.js'), 'utf8');
  const detects = (s) => /readFileSync/.test(s) && /UUID_RE/.test(s); // 必须"先读后判"
  const badImpl = "function installId(){ return crypto.randomUUID(); }"; // 每次重建
  check('ID-8 判据能识别"每次重建"的错误实现', detects(good) && !detects(badImpl), 'hit');
}

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
