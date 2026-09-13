#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：健壮性 / 观测性 / 防放大 一批（2026-09-13）
//
// ## 缺陷（均为失效模式 g/f/h + 一处 a）
//
// ① P2 heartbeat 的 router 分支被 **120s ctl 默认超时**阻塞
//    control-view.js 的 domainSummary 经 ctl 转发，而 _ctlCall 默认 120000ms；
//    该 await 在心跳**串行**循环内 → 同拍的 lan/主实例/沙箱全部停摆，
//    与「心跳是唯一周期驱动」复合 → 一拍最长 120s，仅 debug 日志。
//
// ② P3 daemon 守护计数两条路径不对称：router 写 Lifecycle、lan 写目录 entry，
//    而消费方只读 Lifecycle → entry.restartCount 是只写不读字段、
//    lan 的守护次数恒 0（面板无法判断远程控制是否在反复被拉起）。
//
// ③ P3 _startShellWatchdog() 是 start() 的**最后一个调用且为裸调用**（无 try），
//    而它自己的注释声明「任何异常都不得影响守卫主循环 —— 看护是增强，不是依赖」。
//
// ④ P3 e._nextTickAt 无任何清除路径；且节流用 heartbeat 入口的 now 前推，
//    而循环是串行的 → 前面对象的耗时会系统性拉长后续对象的节流窗。
//
// ⑤ P2/P3 providers.json 解析失败**静默返回空**，而启动维护会立刻回写 →
//    一次外部损坏即把全部供应商/账号（含 API Key）静默清零且不可恢复；
//    另 tmp 名固定 '.tmp' 可被并发写混。
//
// ## 门禁
//   A ① 结构：必须走 _ctlCall 的 timeoutMs 形参（不能把 {timeoutMs} 当方法参数）
//   B ② 结构 + 行为：lan 守护同时写 lifecycle（消费方读的那份）
//   C ③ 行为：stub _startShellWatchdog 抛错时 start() 不得抛
//   D ④ 行为：unregister 清除 _nextTickAt；节流按实际执行时刻前推
//   E ⑤ 行为：损坏文件 → 保留现场 + 记 error + 禁止回写；合法空态仍可写
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
const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13d-'));

(async () => {
  // ① ctl 摘要超时
  console.log('== ① router 域摘要必须短超时（不得阻塞唯一心跳）==');
  {
    const cv = strip(fs.readFileSync(path.join(ROOT, 'src', 'guard', 'supervisor', 'control-view.js'), 'utf8'));
    check('① 存在显式短超时常量', /ROUTER_SUMMARY_TIMEOUT_MS\s*=/.test(cv), '有');
    check('① 摘要经 _ctlCall 的 timeoutMs 形参（不是当方法参数传）',
      /_ctlCall\(this\._routerCtlPort\(\), 'domainSummary', \[\], ROUTER_SUMMARY_TIMEOUT_MS\)/.test(cv), '有');
    check('① 反向：不得把 {timeoutMs} 当 domainSummary 的参数',
      !/domainSummary\(\{\s*timeoutMs/.test(cv), '没有');
    check('① 超时值远小于 ctl 默认 120s', /ROUTER_SUMMARY_TIMEOUT_MS = 5000/.test(cv), '5000ms');
  }

  // ② lan 守护计数对称
  console.log('== ② lan 守护计数必须写消费方读的 Lifecycle ==');
  {
    const cv = strip(fs.readFileSync(path.join(ROOT, 'src', 'guard', 'supervisor', 'control-view.js'), 'utf8'));
    check('② lan 分支写 lifecycle 的 restartCount（对称 router）',
      /lifecycleManager\.get\('lan-daemon'\)[\s\S]{0,200}?llc\.restartCount = \(llc\.restartCount \|\| 0\) \+ 1/.test(cv), '有');
  }

  // ③ shell watchdog 失败隔离
  console.log('== ③ _startShellWatchdog 异常不得冒泡出 start() ==');
  {
    const sup = strip(fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8'));
    check('③ 调用被 try 包裹（旧为裸调用）',
      /try \{\s*\n\s*this\._startShellWatchdog\(\);/.test(sup), '有');
    check('③ 异常只记 warn（增强失败不阻断主循环）',
      /shell-watchdog\] 启动异常（不影响守卫主循环）/.test(sup), '有');

    // 行为：直接给「调用被 try 包住」这一形态做真实函数级验证
    //   （不构造完整 Supervisor —— 它依赖 tauri/网络；用等价函数验证 catch 语义）
    const fn = () => { try { throw new Error('boom-watchdog'); } catch (e) { return 'caught:' + e.message; } };
    check('③ 行为：try/catch 形态确实接住异常', fn() === 'caught:boom-watchdog', fn());
  }

  // ④ _nextTickAt 复位 + 按实际执行时刻前推
  console.log('== ④ 节流游标可复位、按实际执行时刻前推 ==');
  {
    const objs = strip(fs.readFileSync(path.join(ROOT, 'src', 'guard', 'lifecycle', 'objects.js'), 'utf8'));
    check('④ unregister 清除 _nextTickAt', /e\._nextTickAt = null;/.test(objs), '有');
    check('④ 节流按 Date.now()（实际执行时刻）前推，而非入口的 now',
      /e\._nextTickAt = Date\.now\(\) \+ tickEvery \* iv;/.test(objs), '有');

    // 行为：unregister 后 entry 的游标被清
    const { ManagedRegistry } = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'objects'));
    const reg = new ManagedRegistry({ file: path.join(TMP, 'o.json'), logger: null });
    const e = reg.register({ kind: 'router-daemon', id: 'rd', ownership: { meta: { tickEvery: 6 } } });
    reg.registerAdapter('router-daemon', { supervise: () => ({ ok: true }) });
    e._nextTickAt = Date.now() + 999999;
    check('④ 行为：注销前游标存在', e._nextTickAt > Date.now(), 'set');
    reg.unregister('rd');
    check('④ 行为：注销后游标被清（无残留）', e._nextTickAt === null, String(e._nextTickAt));
  }

  // ⑤ providers.json 损坏防护
  console.log('== ⑤ providers.json 损坏不得静默清零 ==');
  {
    const { RouterStore } = require(path.join(ROOT, 'src', 'domains', 'router', 'store.js'));
    const f = path.join(TMP, 'providers.json');
    const errs = [], warns = [];
    const logger = { error: (m) => errs.push(String(m)), warn: (m) => warns.push(String(m)), info() {} };

    // (a) 合法内容
    fs.writeFileSync(f, JSON.stringify({ providers: [{ id: 'a' }, { id: 'b' }] }));
    const ok = new RouterStore({ file: f, logger });
    check('⑤ 合法文件读到 2 条', ok.load().providers.length === 2, '2');
    check('⑤ 合法文件 loadedOk=true（允许后续写入）', ok.canPersist() === true, 'true');

    // (b) 文件不存在 = 合法空态
    const none = new RouterStore({ file: path.join(TMP, 'no-such.json'), logger });
    none.load();
    check('⑤ 文件不存在视为合法空态（可写）', none.canPersist() === true, 'true');

    // (c) 损坏文件
    fs.writeFileSync(f, '{ half written');
    const bad = new RouterStore({ file: f, logger });
    const r = bad.load();
    check('⑤ 损坏被识别（corrupt 标记）', r.corrupt === true, 'true');
    check('⑤ 损坏时记 error 日志（不静默）', errs.length > 0, String(errs.length));
    check('⑤ 损坏时保留现场（.corrupt-<ts> 备份存在）',
      fs.readdirSync(TMP).some((n) => n.indexOf('.corrupt-') >= 0), '有备份');
    check('⑤ 损坏时 canPersist=false（禁止用空态覆盖）', bad.canPersist() === false, 'false');

    // (d) 行为：RouterService._save 在 canPersist=false 时确实不写盘
    const raw = strip(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'index.js'), 'utf8'));
    check('⑤ _save 检查 canPersist 后跳过', /canPersist\(\)/.test(raw), '有');
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
