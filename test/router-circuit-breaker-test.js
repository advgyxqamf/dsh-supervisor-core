#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1-1/P1-2/P1-3：反代实例的**请求级熔断**此前完全失效（三处叠加）
//
// ## 三个缺陷为何必须一起看
//
// 它们都作用在「坏实例能否被自动重启」这一条链上，任一失效即整链失效：
//
//   P1-1  `markUsed` 在**请求发出前**无条件清零 `_unhealthyCount`，
//         而重启阈值是「连续 ≥2 次失败」→ 计数**数学上到不了 2**。
//   P1-2  断流自愈调用的是 `prov.markNetFail(acc)` —— **该方法全仓不存在**，
//         `typeof === 'function'` 恒 false → 调用是死代码。
//   P1-3  在途请求期间的重启被记为 `_restartPending` 但**无任何读取点**，
//         且 2 分钟退避**在延迟之前**就已置位 → 坏实例至少卡死 2 分钟。
//
// 后果：稳定 5xx/400（不触发 180s 超时）的坏实例会被持续选中吃流量，
//   只能靠另一套独立的 _monitorFails（探活）兜底。
//
// ## 锁定不变量
//   R-a  清零只发生在**请求成功后**（markUsed 不得再碰 _unhealthyCount）
//   R-b  `markNetFail` 不得再出现在调用位置（改用真实存在的 markInstanceNetFail）
//   R-c  `_restartPending` 必须有**读取点**（出现在某方法的实参位置）
//   R-d  退避 `_restartAt` 只在**真正执行**重启时置位（不得在延迟分支前）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const proxy = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy.js'), 'utf8');
const fwd = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'handlers', 'forward.js'), 'utf8');
const inflight = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'model', 'inflight.js'), 'utf8');

// ── R-a：清零时机 ──
{
  const m = proxy.match(/markUsed\(inst\) \{[\s\S]{0,200}?\n  \}/);
  check('R-a 定位到 markUsed', !!m, m ? 'ok' : '未找到');
  check('R-a markUsed **不再**清零 _unhealthyCount',
    !!m && !/_unhealthyCount\s*=/.test(m[0]), m ? '已移除' : '');
  check('R-a 存在 markRequestOk（成功后才清零）', /markRequestOk\(inst\)/.test(proxy), '有');
  // ⚠ 断言「调用了 markRequestOk」而不绑定具体实参名 ——
  //   P2 双事实源修复后实参已改为 instOf(...) 的结果（okInst），
  //   写死 `acc.instance` 会让「纯重构」误报（我第一版就踩了这个）。
  check('R-a handlers/forward 在 2xx 成功路径调用 markRequestOk',
    /markRequestOk\(\w+\)/.test(fwd), '已接入');
}

// ── R-b：markNetFail 死调用 ──
// 剥离注释后不得再有 markNetFail 的**调用**（形如 .markNetFail( ）
{
  // 注释剥离统一走 test/_strip.js（阶段六）。原实现只丢「// 开头的整行」——语义等价且字符串/正则感知，
  // 并额外丢掉「整行都是块注释」的行（原先会被当代码）。glob 用拼接构造，避免源码出现危险序列。
  const { dropCommentLines } = require('./_strip');
  const strip = dropCommentLines;
  {
    const G = 'src/' + String.fromCharCode(42, 42);
    check('R-b 剥离：// 行注释里的 glob 不吞后续代码',
      strip('// ' + G + '\nconst K = 1;').indexOf('K = 1') >= 0, 'ok');
    check('R-b 剥离：字符串里的 glob 不吞代码',
      strip("const P = '" + G + "';\nconst K = 2;").indexOf('K = 2') >= 0, 'ok');
  }
  check('R-b handlers/forward 不再调用不存在的 markNetFail',
    !/\.markNetFail\s*\(/.test(strip(fwd)), '已改');
  check('R-b 改用真实存在的 markInstanceNetFail',
    /markInstanceNetFail/.test(strip(fwd)), '已改');
  check('R-b 该方法确实定义在 proxy.js',
    /markInstanceNetFail\s*\(instOrAcc\)/.test(proxy), '有定义');

  // ── R-b 升级（P3-B）：从「字符串出现过」升级为「实参正确 + 确实计数」的行为断言 ──
  //   旧断言只查 markInstanceNetFail 字符串存在，故 forward.js 传错实参也绿。
  //   真实缺陷：markInstanceProblem 以 instOrAcc.pid 判定实参是否为实例；传累加器 acc
  //   （无 pid）会**静默早退、完全不计数** —— 流式中断不进熔断（forward.js:132 与 :229）。
  //   ⚠ 本断言为硬判据，必须与修复 forward.js 两处实参的改动**同批提交**。
  const fwdCode = strip(fwd);
  const callArgs = [];
  for (const line of fwdCode.split(String.fromCharCode(10))) {
    const mm = line.match(/(?:markInstanceNetFail|markInstanceProblem)\s*\(([^)]*)/);
    if (mm) callArgs.push(mm[1].trim());
  }
  check('R-b 定位到熔断调用点（forward.js）', callArgs.length >= 1, '共 ' + callArgs.length + ' 处');
  const BARE_ACC = /^(?:acc|okAcc|activeAcc|rt\.acc)$/;
  const bare = callArgs.filter((a) => BARE_ACC.test(a));
  check('R-b 熔断调用点不得传无 pid 的累加器实参（缺陷形态 markInstanceNetFail(acc)）',
    bare.length === 0, bare.length ? ('缺陷实参: ' + bare.join(', ')) : 'ok');
  const INST_SHAPED = /instOf\s*\(|\.instance\b|\binst\b|\w*[Ii]nst\b/;
  const unshaped = callArgs.filter((a) => !INST_SHAPED.test(a));
  check('R-b 熔断调用点实参须为实例形态（instOf()/inst/ .instance）',
    unshaped.length === 0, unshaped.length ? ('可疑实参: ' + unshaped.join(', ')) : 'ok');
  check('R-b 反向：缺陷样本 (acc) 被检出', BARE_ACC.test('acc') === true, 'hit');
  check('R-b 反向：正确样本 parse.instOf(prov, acc) 不误报',
    BARE_ACC.test('parse.instOf(prov, acc)') === false, 'miss');
  check('R-b 反向：正确样本 inst 不误报', BARE_ACC.test('inst') === false, 'miss');

  // ── 行为面：沙箱内执行真实的 markInstanceProblem 本体，证明「计数」语义与实参形状要求 ──
  const mBody = proxy.match(/markInstanceProblem\(instOrAcc, reason\) \{[\s\S]*?\n  \}/);
  check('R-b 定位到 markInstanceProblem 实现', !!mBody, mBody ? 'ok' : '未找到');
  let impl = null;
  if (mBody) {
    try {
      const inner = mBody[0].replace(/^markInstanceProblem\(instOrAcc, reason\)\s*\{/, '');
      impl = new Function('instOrAcc', 'reason', inner.slice(0, inner.lastIndexOf(String.fromCharCode(10) + '  }')));
    } catch { impl = null; }
  }
  check('R-b 行为断言前提：本体可在沙箱求值（不 require 产品状态根）', typeof impl === 'function', typeof impl);
  if (typeof impl === 'function') {
    const restarts = [];
    const stub = { restartInstance: (inst, why) => { restarts.push(why); } };
    const inst = { pid: 4242 };
    impl.call(stub, inst, 'net-error');
    check('R-b 行为：实例实参被计数（_unhealthyCount 1 / healthy=false）',
      inst._unhealthyCount === 1 && inst.healthy === false, JSON.stringify({ n: inst._unhealthyCount, healthy: inst.healthy }));
    const acc = { key: 'k', instance: inst };
    impl.call(stub, acc, 'net-error');
    check('R-b 行为：累加器实参（无 pid）静默不计数 —— 即缺陷形态',
      acc._unhealthyCount === undefined, JSON.stringify({ accN: acc._unhealthyCount }));
    const inst2 = { pid: 7 };
    impl.call(stub, inst2, 'net-error');
    impl.call(stub, inst2, 'net-error');
    check('R-b 行为：连续 2 次计入 -> 触发重启一次并清零点',
      restarts.length === 1 && inst2._unhealthyCount === 0, JSON.stringify({ restarts: restarts.length, n: inst2._unhealthyCount }));
  }
}

// ── R-c：_restartPending 必须有读取点 ──
{
  // 写入点是赋值；读取点应出现在 `if (... _restartPending)` 或实参位置
  const hasRead = /if\s*\([^)]*_restartPending\s*\)/.test(proxy)
    || /flushRestartPending\([^)]*_restartPending/.test(proxy)
    || /const\s+\w+\s*=\s*inst\._restartPending/.test(proxy);
  check('R-c _restartPending 存在读取点（不再只写不读）', hasRead, '有');
  check('R-c 存在 flushRestartPending 消费方法', /flushRestartPending\(inst\)/.test(proxy), '有');
  check('R-c handlers/forward 在 inflight 归零时执行 flushRestartPending',
    /prov\.flushRestartPending\([^)]+\)/.test(fwd), '已接入');
  // ★ 行为修复锁（PG-D3-4）：单一 end() 产生 flushRestartPending effect，
  //   且流式成功/中断两条路径共用 endInflight（旧缺陷：成功路径漏补重启）。
  check('R-c 单一 end() 生成 flushRestartPending effect',
    /kind:\s*'flushRestartPending'/.test(inflight), '有');
  check('R-e 流式成功与中断路径共用 endInflight（修复漏补重启）',
    (fwd.match(/endInflight\(acc,\s*prov\)/g) || []).length >= 2, '共用');
}

// ── R-d：退避置位时机 ──
{
  const m = proxy.match(/restartInstance\(inst, reason\) \{[\s\S]*?\n  \}/);
  check('R-d 定位到 restartInstance', !!m, m ? 'ok' : '未找到');
  if (m) {
    const body = m[0];
    const iPending = body.indexOf('_restartPending = reason');
    const iBackoff = body.indexOf('_restartAt = Date.now()');
    check('R-d 退避置位在**在途延迟分支之后**（不再提前置位）',
      iPending >= 0 && iBackoff > iPending, 'pending@' + iPending + ' backoff@' + iBackoff);
  }
}

// ── 反向：成功路径仍要清零（防「修成永不清零」）──
check('反向：成功路径保留了清零语义（markRequestOk 内有赋值）',
  /markRequestOk\(inst\) \{[\s\S]{0,120}?_unhealthyCount\s*=\s*0/.test(proxy), '保留');
check('反向：markInstanceProblem 仍累加（熔断本身没被删）',
  /_unhealthyCount\s*=\s*\(inst\._unhealthyCount \|\| 0\) \+ 1/.test(proxy), '保留');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);