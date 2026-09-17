#!/usr/bin/env node
'use strict';

// 守卫「令牌不得驱动生命周期」回归测试（改写自 adopt 令牌接管测试）。
//
// == 为什么改成"反向"守卫（历史背景） ==
// 本文件原先锁定的是 _maybeReclaimAdoptToken 的观察窗语义：被接管的主 DSH 令牌空置 ->
// 观察窗（默认 20s）过后受控重建一次。该行为本身违反 SSOT §2：
//   · TK-1 令牌恒存在 —— 不存在"令牌不可达"这一状态；"拿不到"只能是我方捕捉链路的 bug；
//   · TK-2 令牌状态绝不驱动进程生命周期 —— 凭据维度与进程健康正交。
// 用杀进程去掩盖链路 bug 的代价是"莫名重启 DSH"，无预警中断用户正在运行的会话。
//
// == 本测试现在锁定什么 ==
//   ① 新不变量：令牌缺失不得触发任何 phase 迁移 / 重启（运行时场景 + 反向对照）；
//   ② 删除彻底：该方法与其专属状态（观察窗字段）在实例/原型上都不再存在；
//   ③ 删除没有变成"空转"：源码扫描判据对"旧形态"样本必须报违规（G8 式反向判据）。
// 独立门禁（TK-G2 等）属于别的分片；本文件只保证本分片自己的判据可执行、可失败。
//
// 运行：node --require ./test/_preload.js test/adopt-token-reclaim-test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-token-reclaim-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 被删除逻辑的符号名/字段名/事件 reason —— 源码与实例都不得再出现。
// 单独抽出来是为了让"反向判据"（防空转）能复用同一组判据，而不是另写一套。
const REMOVED_SYMBOLS = [
  '_maybeReclaimAdoptToken',
  '_tokenReclaimAt',
  '_tokenReclaimTried',
  'tokenReclaimGraceMs',
  'adopt_token_reclaim',
];

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  <- ' + extra : ''));
  }
}

function buildSupervisor(overrides = {}) {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    // 探测端口取本文件专属安全段，且**刻意无监听**：让每拍都落在 L1 离线分支。
    healthUrl: 'http://127.0.0.1:' + safePort('adopt-token-reclaim', 0) + '/',
    apiHost: '127.0.0.1', apiPort: safePort('adopt-token-reclaim', 1),
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    // 健康阈值拉高：本用例只关心「令牌 -> 迁移」，绝不让"端口无监听 -> 连续假死"
    // 这条**正当**的进程健康路径混进来，否则断言会被无关重启污染（且会掩盖真正的失败）。
    failThreshold: 1000,
    ...overrides,
  };
  const cfgPath = path.join(TMP, 'cfg-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const sup = new Supervisor(cfg, cfgPath);
  // L3b（daemon 模式）：守卫无本地 relay 能力，get lan 恒为 null —— 让收敛尾部的
  // this.lan.reconcile() 不真去建 relay（否则测试进程会写 ports.json / 起反代）。
  // 这是测试隔离手段，不改变本用例关心的「令牌 -> phase」路径。
  sup.lanDaemonEnabled = () => true;
  return sup;
}

/** 列出源码文件里命中的被删符号（返回去重后的符号名数组）。 */
function removedHits(src, symbols) {
  const hits = [];
  for (const s of symbols) if (src.indexOf(s) >= 0) hits.push(s);
  return hits;
}

/** 抓出 _dshConverge 里那个 phase 迁移 switch 的完整块（括号配平）。
 *  为什么单独抠出来：TK-2 的不变式是「phase 迁移决策不读令牌池」——必须能精确断言
 *  switch 内部干净，而不是只断言整个文件里没有某个名字。 */
function extractPhaseSwitch(src) {
  // ⚠ 2026-09-17 阶段六 B-2：controller.js 原地去 this 后 phase switch 变为 switch (d.state().phase())。
  //   判据改为**形态无关**：匹配任意接收者（this/d/…）的 .state().phase()。判据本意不变。
  //   兼容两种形态：this.state.phase()（state 为属性对象）与 d.state().phase()（state 为 deps 方法）。
  const m = /switch\s*\([\w.$()]*\.phase\(\)\s*\)/.exec(src);
  if (!m) return null;
  const i = m.index;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src.charAt(j);
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return null;
}

async function main() {
  const SUP_PATH = path.join(ROOT, 'src', 'app', 'daemons', 'probe.js');
  // ⚠ 2026-09-16 步骤7：converge-view.js → app/main/controller.js（_dshConverge 所在）。
  //   phase switch 仍在该文件的 _dshConverge 内，判据语义不变。
  const CONV_PATH = path.join(ROOT, 'src', 'app', 'main', 'controller.js');
  // ⚠ 2026-09-16 步骤7：影子决策（_shadowExcluded/_shadowTickNote 等）已拆到 app/main/shadow.js。
  //   本测试的两组断言横跨 controller（phase switch）与 shadow（排除集），故 convSrc 读**两者**。
  const SHADOW_PATH = path.join(ROOT, 'src', 'app', 'main', 'shadow.js');
  const supSrc = fs.readFileSync(SUP_PATH, 'utf8');
  const convSrc = [CONV_PATH, SHADOW_PATH].map((p) => fs.readFileSync(p, 'utf8')).join(String.fromCharCode(10));

  console.log('== 源码静态：删除彻底（符号零残留 + phase switch 不读令牌） ==');
  {
    for (const f of [SUP_PATH, CONV_PATH]) {
      const src = fs.readFileSync(f, 'utf8');
      const name = path.basename(f);
      check(name + ' 无被删令牌回收符号', removedHits(src, REMOVED_SYMBOLS).length === 0, removedHits(src, REMOVED_SYMBOLS).join(','));
      // 源码里连 "token" 这个词都不该有：phase 迁移源一旦出现 token 标识符，
      // 就说明"凭据驱动生命周期"又回来了（含注释——注释留名会让 grep 门禁空转）。
      check(name + ' 源码零 token 引用（含注释）', src.indexOf('token') < 0);
      // TK-2 精确判据：phase 迁移 switch 内不得读令牌池。
      const sw = extractPhaseSwitch(src);
      if (f === CONV_PATH) {
        check('converge-view 能定位 phase switch', !!sw);
        check('phase switch 内不读令牌池', !!sw && sw.indexOf('token') < 0);
      }
    }
    // 影子排除集：令牌回收 reason 必须已移除，且排除机制本身仍在（不是把正则一并删空）。
    check('影子排除集已不含令牌回收 reason', convSrc.indexOf('adopt_token_reclaim') < 0);
    check('影子排除集仍保留异步钩子豁免', /_shadowExcluded\s*\(/.test(convSrc) && convSrc.indexOf('http_unhealthy') >= 0);

    // ── 反向判据（防空转，TK-G8 同义）──
    // 若判据本身失效（比如符号表写错、大小写不匹配），上面的断言会永远为真。
    // 用"旧形态"样本喂给**同一个判据函数**，必须报出违规——证明它能识别错误行为。
    const legacySample = 'class X { _maybeReclaimAdoptToken() { if (this._tokenReclaimAt === null) { this._tokenReclaimTried = true; this._beginRestart("adopt_token_reclaim"); } } }';
    check('反向判据：样本含 _maybeReclaimAdoptToken', removedHits(legacySample, REMOVED_SYMBOLS).indexOf('_maybeReclaimAdoptToken') >= 0);
    check('反向判据：样本含观察窗字段', removedHits(legacySample, REMOVED_SYMBOLS).indexOf('_tokenReclaimAt') >= 0);
    check('反向判据：样本含令牌回收 reason', removedHits(legacySample, REMOVED_SYMBOLS).indexOf('adopt_token_reclaim') >= 0);
    const legacySwitch = 'switch (this.state.phase()) { case "RUNNING": { const t = this.tokenService.get("main"); } }';
    const legacySw = extractPhaseSwitch(legacySwitch);
    check('反向判据：能抓到 switch 内读令牌', !!legacySw && legacySw.indexOf('token') >= 0);
    check('反向判据：能提取 switch 块', !!legacySw);
  }

  console.log('== 实例：删除方法不存在，且 phase 决策所在目录零残留 ==');
  {
    const sup = buildSupervisor({});
    check('原型上不存在 _maybeReclaimAdoptToken', typeof sup._maybeReclaimAdoptToken === 'undefined');
    try { sup._maybeReclaimAdoptToken(); check('调用已删除方法应抛错', false); }
    catch (e) { check('调用已删除方法抛 TypeError', e instanceof TypeError, String(e && e.message)); }
    // 该逻辑的两个瞬态字段声明在 src/supervisor.js 构造期（不在本分片文件范围内，由负责
    // 该文件的分片清理）。本分片能保证、也必须保证的是：所有 phase 决策方（mixin 目录）
    // 对它们零引用——只要没人读，字段即便残留也不会构成"令牌驱动生命周期"的路径。
    const mixinDir = path.join(ROOT, 'src', 'app', 'daemons');
    const leftover = [];
    for (const f of fs.readdirSync(mixinDir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(mixinDir, f), 'utf8');
      for (const s of REMOVED_SYMBOLS) if (src.indexOf(s) >= 0) leftover.push(f + ':' + s);
    }
    check('守卫 mixin 目录零残留（含全部 phase 决策文件）', leftover.length === 0, leftover.join(','));
  }

  console.log('== 运行时：令牌缺失不得触发 phase 迁移/重启 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 1 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => { restarts.push({ reason, opts }); };
    const stops = [];
    sup.stopProcess = (reason) => { stops.push(reason); };

    // 场景 A：RUNNING + 被接管（adoptedPid 非空、无 child、令牌空置）。
    // 观察窗参数给到 1ms —— 旧逻辑下这必然已经"超窗"，若错误路径还在就会立刻重建。
    // ⚠ 不用"伪造 isAlive"来表达存活/死亡（test-safety-gate A/B）：
    //   先前写 `pidlook.isAlive = () => true` 是对模块导出的属性赋值——对 CommonJS 值绑定无效
    //   （仍是真实 isAlive），既无效又误导。
    //   改用**真实事实**：isAlive 实现为 `process.kill(pid, 0)`，故
    //     · 存活 = 本进程 pid（一定活着）；  · 死亡 = 一个远超 pid_max 的 pid（一定不存在）。
    //   这样测的是真实判定路径，无需任何伪造，也不触碰共享模块状态。
    const ALIVE_PID = process.pid;
    const DEAD_PID = 4000000; // 远超 Linux pid_max（默认 4194304 上限内亦不存在的低位值）
    // 级 2：guardian 真身已迁入 state 协作方——补丁点随之改为 sup.state.guardian。
    const realGuardian = sup.state.guardian;

    // 场景 A：RUNNING + 被接管（adoptedPid 非空、无 child、令牌空置）。
    // 观察窗参数给到 1ms —— 旧逻辑下这必然已经"超窗"，若错误路径还在就会立刻重建。
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.observedOnly = false;
    sup.adoptedPid = process.pid; // 用存活的本进程 pid，避免把"进程真死了"的重启混进来
    sup.child = null;
    await sleep(20); // 远超旧观察窗，确保不是"还没到窗口"
    const phaseA0 = sup._mPhase();
    await sup._dshConverge();
    check('A: 令牌空置且被接管，phase 不迁移（无重建）', restarts.length === 0 && sup._mPhase() === phaseA0, JSON.stringify({ restarts, phaseA0, now: sup._mPhase() }));
    check('A: 未产生任何 stopProcess', stops.length === 0, JSON.stringify(stops));

    // 场景 B：RUNNING + 自 spawn（有 child 管道、令牌空置）——同样不得因令牌重启。
    sup.phase = 'RUNNING';
    sup.adopted = false;
    sup.child = { pid: process.pid, exitCode: null, signalCode: null };
    sup.adoptedPid = null;
    restarts.length = 0;
    await sup._dshConverge();
    check('B: 自 spawn 且令牌空置，不触发重建', restarts.length === 0, JSON.stringify(restarts));

    // 场景 C（反向对照）：被接管 pid 也"活着"，令牌空置，仍不得重启。
    // 这样即便有实现试图用"令牌缺失 + 接管进程不可达"合成重启，也绕不过去。
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = ALIVE_PID;
    sup.child = null;
    restarts.length = 0;
    await sup._dshConverge();
    check('C: 接管进程存活 + 令牌空置，不触发重建', restarts.length === 0, JSON.stringify(restarts));
    check('C: phase 仍为 RUNNING', sup._mPhase() === 'RUNNING', sup._mPhase());

    // 场景 D（反向对照）：接管 pid 不可达 + 守护开启 —— 即便走到"进程失联"，重启原因也
    // 必须是 adopted_exit（进程维度），绝不能是任何令牌维度。证明重启判据只认进程健康。
    // 守护开关置 true 是必要条件：守卫语义下 guardian=false 时进程死亡本就只停不拉，
    // 不置 true 会测出"无重启"，那是守护语义而非令牌语义，断言会失去区分度。
    sup.state.guardian = () => true;
    try {
      sup.phase = 'RUNNING';
      sup.adopted = true;
      sup.adoptedPid = DEAD_PID;
      sup.child = null;
      restarts.length = 0;
      await sup._dshConverge();
      const reasons = restarts.map((r) => r.reason);
      check('D: 进程失联仅以进程维度触发重启', reasons.length === 1 && reasons[0] === 'adopted_exit', JSON.stringify(reasons));
      check('D: 不存在任何令牌维度 reason', !reasons.some((x) => /token/i.test(x)), JSON.stringify(reasons));
    } finally { sup.state.guardian = realGuardian; }
  }

  console.log('== 阴影排除集：不再豁免任何令牌类 reason，但保留异步钩子豁免 ==');
  {
    const sup = buildSupervisor({});
    check('令牌回收 reason 不再被排除', sup._shadowExcluded('adopt_token_reclaim') === false);
    check('升级钩子仍被排除（排除机制未空转）', sup._shadowExcluded('upgrade_hold') === true);
    check('假死仍被排除', sup._shadowExcluded('http_unhealthy') === true);
    check('普通迁移（如 start_timeout）不被排除', sup._shadowExcluded('start_timeout') === false);
  }

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
