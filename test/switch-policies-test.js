#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// router 纯策略单测（DF-6）：只 require policies/switch 与 policies/failure，
// 给假 state / 假 ctx，不构造 RouterService、不碰 provider、零 IO。
// 覆盖：选号序列（selected/sticky/rotate/clearSelected/excludeKeys/反代就绪优先）
//       与失败动作映射（credits/window/banned/transient/none + retryMs 阈值）。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const { pickAccount } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'switch'));
const { decideFailure, headerRetryMs, bodyResetMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'failure'));

// ── S1 选号策略 ──
{
  const state = { accounts: [{ keyId: 'k1', usable: true }, { keyId: 'k2', usable: false }], kind: 'direct', cursor: 0 };
  const d = pickAccount(state, {});
  check('S1 轮换选中首个可用账号', d.keyId === 'k1' && d.reason === 'rotate', JSON.stringify(d));
  check('S1 nextCursor 递增', d.nextCursor === 1, String(d.nextCursor));
  check('S1 无可用返回 keyId=null', pickAccount({ accounts: [{ keyId: 'k1', usable: false }], cursor: 0 }, {}).keyId === null, '');

  const sel = pickAccount({ accounts: [{ keyId: 'k1', usable: true }], selectedAccountKeyId: 'k1', cursor: 5 }, {});
  check('S1 锁定可用 → selected 且 cursor 不动', sel.keyId === 'k1' && sel.reason === 'selected' && sel.nextCursor === 5, JSON.stringify(sel));

  const sticky = pickAccount({ accounts: [{ keyId: 'k1', usable: true }], activeAccountKeyId: 'k1', cursor: 5 }, {});
  check('S1 无锁但 active 可用 → 粘滞', sticky.keyId === 'k1' && sticky.reason === 'sticky', JSON.stringify(sticky));

  const dead = pickAccount({ accounts: [{ keyId: 'k1', status: 'banned', usable: false }, { keyId: 'k2', usable: true }], selectedAccountKeyId: 'k1', cursor: 0 }, {});
  check('S1 锁定账号永久失效 → clearSelected 并换号', dead.clearSelected === true && dead.keyId === 'k2', JSON.stringify(dead));

  const frozen = pickAccount({ accounts: [{ keyId: 'k1', status: 'frozen', usable: false }, { keyId: 'k2', usable: true }], selectedAccountKeyId: 'k1', cursor: 0 }, {});
  check('S1 锁定账号临时冻结 → 不清锁，落到可用号', frozen.clearSelected === false && frozen.keyId === 'k2', JSON.stringify(frozen));

  const excl = pickAccount({ accounts: [{ key: 'a', keyId: 'k1', usable: true }], kind: 'direct', cursor: 0 }, { excludeKeys: new Set(['a']) });
  check('S1 excludeKeys 强制排除 → null', excl.keyId === null, JSON.stringify(excl));

  const proxy = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }, { keyId: 'k2', usable: true, running: true }], kind: 'proxy', cursor: 0 }, {});
  check('S1 反代优先选实例已运行账号', proxy.keyId === 'k2', JSON.stringify(proxy));
  const proxyFallback = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }], kind: 'proxy', cursor: 0 }, {});
  check('S1 无就绪账号降级全可用池', proxyFallback.keyId === 'k1', JSON.stringify(proxyFallback));
}

// ── S2 失败反应策略：动作映射 + retryMs ──
{
  const credits = decideFailure('credits', { status: 400, key: '...k9' });
  check('S2 credits → retry + needEffect', credits.action === 'retry' && credits.needEffect === true, JSON.stringify(credits));

  const win = decideFailure('window', { status: 429, headers: { 'retry-after': '60' }, key: '...k9' });
  check('S2 window Retry-After=60 → retryMs=60000', win.action === 'retry' && win.retryMs === 60000, JSON.stringify(win));
  const winBody = decideFailure('window', { status: 429, body: 'resets in 5 min', key: 'k' });
  check('S2 window body "resets in 5 min" → 300000', winBody.retryMs === 300000, JSON.stringify(winBody));

  const banned = decideFailure('banned', { status: 403, key: '...k9' });
  check('S2 banned → passthrough + needEffect', banned.action === 'passthrough' && banned.needEffect === true && /BANNED/.test(banned.log), JSON.stringify(banned));

  const tr = decideFailure('transient', { status: 503, key: 'k' });
  check('S2 transient → retry + transient 且不施加 effect', tr.action === 'retry' && tr.transient === true && tr.needEffect === false, JSON.stringify(tr));

  const none = decideFailure('none', { status: 400, body: 'x', key: 'k' });
  check('S2 none → passthrough（绝不误切）', none.action === 'passthrough' && none.needEffect === false, JSON.stringify(none));
  const unknown = decideFailure('whatever', { status: 500, key: 'k' });
  check('S2 unknown → passthrough', unknown.action === 'passthrough', JSON.stringify(unknown));
}

// ── retry 时长解析与 providers/base 逐字对齐（防两处漂移）──
{
  const base = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  // 绝对时刻样本（retry-after 的 HTTP-date、resets at <ISO>）返回「距该时刻的剩余 ms」，
  // 两侧各自调用 Date.now()，相隔的毫秒差会让 === 偶发假红（Windows CI 实测 1ms）。
  // 容差 50ms 远小于任何语义差异（样本间隔为秒/小时级），不会掩盖真实漂移。
  const sameMs = (x, y) => (x === y) ||
    (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 50);
  for (const h of [{}, { 'retry-after': '120' }, { 'retry-after': new Date(Date.now() + 90000).toUTCString() }, { 'x-ratelimit-reset-ms': String(Date.now() + 5000) }]) {
    check('S2 headerRetryMs 与 base 一致 ' + JSON.stringify(h), sameMs(headerRetryMs(h), base.headerRetryMs(h)), String(headerRetryMs(h)));
  }
  for (const b of ['resets in 5 min', 'retry in 30 sec', 'resets in 2 hour', 'resets at ' + new Date(Date.now() + 7200000).toISOString(), 'no time info']) {
    check('S2 bodyResetMs 与 base 一致', sameMs(bodyResetMs(b), base.bodyResetMs(b)), b);
  }
  // 反向：判据非空转
  check('反向：window 无 Retry-After/体时间 → retryMs=0（上层走默认）', decideFailure('window', { status: 429, key: 'k' }).retryMs === 0, '');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
