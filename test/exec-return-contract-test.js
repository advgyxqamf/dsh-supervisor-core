#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P0 回归：exec.run 的「成功/失败」判据必须与调用方语义一致（2026-09-13）
//
// ## 缺陷（一个根因，三处症状）
//
// `execFileSync` 在 stdio **不捕获 stdout**（'ignore' / ['ignore','ignore','ignore']）
// 时，**命令成功也返回 null**（不是空串、不是空 Buffer）。实测：
//     execFileSync('node',['--version'],{stdio:'ignore'})          === null
//     execFileSync('node',['--version'],{stdio:['ignore','pipe','pipe']}) === <Buffer>
//
// 而 `exec.run` 的契约是「失败/超时返回 null」，于是**每一个以 `!== null` 判成功的
// 调用方都把成功读成失败**：
//
//   ① `platform/os/index.js::hasTool` —— `ex.run(name,...,{stdio:'ignore'}) !== null`
//      → hasTool('node')/('systemctl')/('systemd-run') **恒 false**（实测）
//      → capabilities() 把 multiInstance/desktopNotify/autostart 一律降 false
//      → **Linux 上沙箱（多实例）功能对所有用户不可用**（UI 报「当前平台不支持」）。
//   ② `platform/os/file-protect.js::hasIcacls` —— 同形 → Windows 上敏感文件/目录的
//      icacls 收紧**静默失效**（一律返回 mode:'none'）。
//   ③ `platform/os/service.js` 的 run 包装**无条件** `Object.assign({stdio:'ignore'}, opts)`
//      → 即便调用方要读输出（isUnitActive 传 encoding）也被压掉 → isUnitActive **恒 false**：
//        · 实例就绪判定要求 unitActive() → 永不满足 → 升级在稳定期误判「未能启动」→ 误回滚；
//        · 删数据目录前的 isUnitActive 复核恒 false → 「仍活跃则不删」保护**永不生效**。
//
// ## 锁定不变量
//   A1  exec.run 成功必返回**非 null**（即使 stdio 不捕获输出）—— 核心判据
//   A2  exec.run 失败（ENOENT）仍返回 null —— 不能为了修 A1 把失败也变成"成功"
//   A3  hasTool 对**必然存在**的 node 返回 true（旧实现在此恒 false）
//   A4  service Provider 的 run 包装**不得**再强制 stdio:'ignore'（否则读输出恒空）
//   A5  Linux：capabilities().multiInstance 必须与「systemd-run 是否真的存在」一致
//   A6  Linux：isUnitActive 对**确实 active** 的单元返回 true
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const ex = require(path.join(ROOT, 'src', 'platform', 'util', 'exec.js'));
const osIdx = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// ── A1：成功必非 null（核心）──
{
  const r = ex.run('node', ['--version'], { stdio: 'ignore', timeoutMs: 5000 });
  check('A1 exec.run 成功且 stdio:ignore 时仍返回非 null（旧实现返回 null）',
    r !== null && r !== undefined, JSON.stringify(r));
  const r2 = ex.runOut('node', ['--version'], { timeoutMs: 5000 });
  check('A1 exec.runOut 成功返回版本串', typeof r2 === 'string' && /^v\d+/.test(r2.trim()), JSON.stringify(r2));
  // 反向：确认 stdio:'ignore' 确实"不捕获输出"，即 A1 测的正是那个边界
  const { execFileSync } = require('node:child_process');
  let raw = 'THREW';
  try { raw = execFileSync('node', ['--version'], { stdio: 'ignore' }); } catch (e) { raw = 'THREW:' + e.message; }
  check('A1 前提成立：裸 execFileSync 在 stdio:ignore 下确实返回 null',
    raw === null, String(raw));
}

// ── A2：失败仍是 null ──
{
  const r = ex.run('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  check('A2 不存在的可执行文件仍返回 null（失败语义未被破坏）', r === null, JSON.stringify(r));
  const r2 = ex.runOut('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  check('A2 runOut 对不存在命令返回 null', r2 === null, JSON.stringify(r2));
  // 非零退出码也必须是 null（失败）
  const r3 = ex.run('node', ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  check('A2 非零退出码视为失败（null）', r3 === null, JSON.stringify(r3));
}

// ── A3：hasTool 对必然存在的命令为 true ──
{
  // node 必然存在（我们正跑在 node 上）。旧实现此处恒 false。
  check('A3 hasTool(node) === true（旧实现恒 false → 沙箱功能全禁）',
    osIdx.hasTool('node') === true, String(osIdx.hasTool('node')));
  // 反向：不存在的命令必须 false（不能为了修 A3 变成恒 true）
  check('A3 反向：hasTool(不存在的命令) === false',
    osIdx.hasTool('dsh-no-such-tool-xyz') === false, 'false');
}

// ── A3′：源码级防回潮 —— hasTool / hasIcacls 不得再写回致命形态 ──
//   为什么需要它（本测试的真实教训）：A3 的行为断言在**根因已修**的前提下，即使
//   把 hasTool 写回 `ex.run(...,{stdio:'ignore'}) !== null` 也仍然通过（因为 exec.run
//   现在成功返回非空）—— 即 A3 无法单独证伪 hasTool 那一处的回潮。
//   故补一条**源码形态**断言，直接锁住「不得再出现 run+stdio:ignore+!==null 组合」。
{
  const osRaw = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'index.js'), 'utf8');
  const osCode = osRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const fpRaw = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'), 'utf8');
  const fpCode = fpRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 形态：ex.run(...) / exec.run(...) 后接 !== null（正是"成功也返回 null"踩中的写法）
  const bad = /ex\.run\([^)]*\)\s*!==\s*null/;
  //   用 indexOf 而非再写一条正则 —— 少一层转义即少一个坑（本仓已多次被转义骗过）。
  const usesRunOut = (c) => c.indexOf('runOut(') >= 0;
  check('A3′ hasTool 不再用 run(...)!==null 判成功（应经 runOut）',
    !bad.test(osCode) && usesRunOut(osCode), '已改');
  check('A3′ hasIcacls 不再用 run(...)!==null 判成功（应经 runOut）',
    !bad.test(fpCode) && usesRunOut(fpCode), '已改');
  check('A3′ 反向：识别逻辑对该形态有效（门禁非空转）',
    bad.test("const ok = ex.run(name, args, { stdio: 'ignore' }) !== null;"), 'hit');
}

// ── A4：service Provider 不得再强制 stdio:'ignore' ──
{
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'service.js'), 'utf8');
  // 剥离注释后再断言（本仓多次被自己的说明文字骗过）
  const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('A4 service 包装不再强制 stdio:ignore（否则读输出恒空）',
    !/Object\.assign\(\{\s*stdio:\s*'ignore'\s*\}/.test(code), '已改');
  check('A4 service 包装把 opts 原样透传给 exec.run',
    /exec\.run\(cmd, args, opts \|\| \{\}\)/.test(code), '有');
}

// ── A5/A6：Linux 行为（systemd 真实存在时）──
if (process.platform === 'linux') {
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js')).current();
  // systemd-run 是否存在（用**可靠的** runOut 探测，而非本测试要验证的 hasTool）
  const hasRun = ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  const caps = osIdx.capabilities();
  check('A5 capabilities().multiInstance 与 systemd-run 实际存在一致',
    caps.multiInstance === hasRun,
    JSON.stringify({ multiInstance: caps.multiInstance, systemdRunExists: hasRun }));
  if (hasRun) {
    check('A5 反向：systemd-run 存在时必须为 true（旧实现恒 false）',
      caps.multiInstance === true, String(caps.multiInstance));
  }

  // A6：找一个确实 active 的 --user 单元，isUnitActive 必须为 true
  let activeUnit = null;
  try {
    const out = ex.runOut('systemctl', ['--user', 'list-units', '--state=active', '--no-legend', '--plain'], { timeoutMs: 5000 });
    if (out) activeUnit = ((out.trim().split('\n')[0] || '').trim().split(/\s+/)[0]) || null;
  } catch { /* 无 user session */ }
  if (activeUnit) {
    check('A6 isUnitActive(确实 active 的单元) === true（旧实现恒 false）',
      svc.isUnitActive(activeUnit) === true, activeUnit.slice(0, 50));
  } else {
    console.log('SKIP A6 本机无 active 的 --user 单元（非 Linux user session）—— 非通过，仅跳过');
  }
  check('A6 反向：不存在的单元 isUnitActive === false',
    svc.isUnitActive('dsh-no-such-unit-xyz.service') === false, 'false');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
