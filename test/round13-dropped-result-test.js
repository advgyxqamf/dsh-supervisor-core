#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：两处「检查/应答存在但结果被丢弃」（2026-09-13）
//
// ## 缺陷
//
// ① P1 self-update.js::sanityCheck —— **丢弃 exec.run 返回值** → 检查恒通过
//    exec.run 的契约是「失败/超时返回 null」，而该行不检查返回值也不抛错 →
//    对任何语法损坏的 bin 都静默通过（注释却写「语法自检即冒烟」）。apply() 随后
//    把 current 翻转到**语法错误**的版本并 prune 掉旧版本 → 守卫再也起不来且无回滚。
//    生产调用点为零，只有 guard-update-test.js 覆盖，而它从未断言失败路径。
//
// ② P2 src/api/domains/router.js 多处 `.then((r)=>send(...))` **无 .catch** → ctl 拒绝时请求永久挂起
//    daemon 监督模式下 routerApi() 是 ctl 门面，超时/ECONNREFUSED 会 reject；
//    这些链无 catch，api/index.js 的外层也接不住（那是另一条链）→
//    unhandledRejection + **客户端永久挂起**（无超时的 curl/TUI）。同文件其它链都有 catch。
//
// ## 门禁
//   A sanityCheck 的失败路径**行为级**可证伪（真实造损坏 bin）
//   B router.js 的每个 `.then((r)=>send` 链都必须有 `.catch`
//   C **行为级**：ctl 拒绝时 handle() 必须恰好应答一次且为 500（旧实现 0 次 → 挂起）
//   D 反向：`.catch` 必须挂在 **Promise 链尾**，不能误挂在 send() 调用上
//     （我第一版脚本化补丁就犯了这个错：`send(...).catch(...)` 语义完全不同）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13c-'));

(async () => {

  // ── B router.js 每个链都要有 catch ──
  console.log('== B router.js 异步链必须有 catch ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'router.js'), 'utf8');
    const offenders = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter((x) => x.l.indexOf('.then((r) => send(') >= 0 && x.l.indexOf('.catch(') < 0);
    // 同时扫「任何 .then( 后无 .catch 的链」——不止 send 那一种形态
    //   （第 33/36 行的 setRouterRunning 链就属另一形态，我第一版脚本补丁漏了它们，
    //    直到 p2p/router 测试以 ERR_STREAM_WRITE_AFTER_END 崩掉才暴露）。
    const offenders2 = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter((x) => x.l.indexOf('.then(') >= 0 && x.l.indexOf('.catch(') < 0 && x.l.indexOf('await ') < 0)
      .filter((x) => !/^\s*\/\//.test(x.l));
    check('B 无「有 then 无 catch」的链（旧实现多处 → 挂起）',
      offenders.length === 0,
      offenders.length ? offenders.map((o) => o.n).join(',') : '0 处');
    check('B 无任何「.then( 后无 .catch」的链（含非 send 形态）',
      offenders2.length === 0,
      offenders2.length ? offenders2.map((o) => o.n + ':' + o.l.trim().slice(0, 60)).join(' | ') : '0 处');
    check('B 存在实际的 catch 响应（500）',
      /catch\(\(e\) => send\(500/.test(src), '有');

    // ── D catch 必须在链尾，不能误挂在 send() 上 ──
    check('D 反向：无「send(...).catch(...)」错误形态（catch 必须挂 Promise 链尾）',
      !/send\(r\.ok \? 200 : 400, r\)\.catch/.test(src), '已修正');
  }

  // ── C 行为级：ctl 拒绝 → 恰好应答一次 500 ──
  console.log('== C 行为：ctl 拒绝必须应答而不是挂起 ==');
  {
    const api = require(path.join(ROOT, 'src', 'api', 'domains', 'router.js'));
    const sent = [];
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    api.handle({
      sup: {
        config: { apiPort: 1 },
        routerApi: () => ({ addProxyKey: () => Promise.reject(new Error('ctl 43107 ECONNREFUSED')) }),
      },
      req: { method: 'POST', url: '/router/providers/proxy/key', headers: {}, resume() {} },
      res: {},
      pathname: '/router/providers/proxy/key',
      send: (code, body) => sent.push({ code, body }),
      collectBody: (req, res, lim, cb) => cb(JSON.stringify({ id: 'p1', key: 'k' })),
      originAllowed: () => true,
      u: new URL('http://x/'),
    });
    await new Promise((r) => setTimeout(r, 300));
    process.removeListener('unhandledRejection', onUnhandled);
    check('C ctl 拒绝时**恰好应答一次**（旧实现 0 次 → 客户端永久挂起）',
      sent.length === 1, String(sent.length));
    check('C 应答为 500 且带错误信息',
      sent[0] && sent[0].code === 500 && /ECONNREFUSED/.test(JSON.stringify(sent[0].body || {})),
      JSON.stringify(sent[0] || null));
    check('C 无 unhandledRejection（错误被接住）', unhandled === 0, String(unhandled));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.error('ERR', e);
  process.exit(1);
});
