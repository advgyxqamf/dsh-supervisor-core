#!/usr/bin/env node
'use strict';

// 桌面壳更新安全网回归（2026-09-11）
//
// 覆盖：
//   R1 账本（markPending）与判定（evaluate）状态机
//   R2 健康确认：壳以目标版本上报 ready → confirmed
//   R3 强制更新：attempt 再高也不回退（永不回退）
//   R4 反回归：回退机构（rollback/pinnedVersions/should-rollback）不得复活
//   R5 ⛔ 硬约束：安全网**绝不触碰内核更新机制**（不 import dist、不调用 runNpmInstall）
//   R6 物理隔离：壳状态目录（<状态根>/shell）与内核状态目录（<状态根>/supervisor）不同
//   R10 反回归：内核侧回退/拉黑机构不得复活（壳侧反回归归壳仓自身测试）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };
const LF = String.fromCharCode(10);
// 源码级断言必须区分「代码」与「说明代码的文字」：剥离整行注释后再匹配（本仓已多次踩坑）。
// 注释剥离统一走 test/_strip.js（阶段六）。原实现丢「// 或块注释续行（星号或块开符）开头的整行」——
// 新实现语义等价且**字符串/正则感知**，并只丢「整行都是注释」的行：像『块注释开头的代码行』
// （形如：块开符 + 注释 + 代码）原先会被**整行丢掉**（丢代码），现已修正为保留。
const { dropCommentLines: stripCommentLines } = require('./_strip');
{
  const G = 'src/' + String.fromCharCode(42, 42);
  check('S-3 剥离：// 行注释里的 glob 不吞后续代码',
    stripCommentLines('// ' + G + LF + 'const K = 1;').indexOf('K = 1') >= 0, 'ok');
  check('S-3 剥离：块注释开头的代码行不再被整行丢掉',
    stripCommentLines('/* c */ const K = 2;').indexOf('K = 2') >= 0, 'ok');
  check('S-3 剥离：纯块注释整行被丢掉',
    stripCommentLines('/* only */' + LF + 'const K = 3;').indexOf('only') < 0, 'ok');
}

// 测试主体包进 async IIFE：本套测试自 2026-09-11 起含 await（checkUpdate/restartShell），
// 而 CommonJS 顶层不允许 await —— 之前全同步掩盖了这一点。
(async () => {

  // 隔离 HOME，避免污染真实壳状态。
  //  必须同时设 USERPROFILE：Node 的 os.homedir() 在 Windows 上**优先读 USERPROFILE**，
  //   只设 HOME 会退回真实用户目录 → 该测试在 Windows 上断言失败（实测 CI #22）。
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-net-'));
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  // 产品状态根隔离（独立于 DSH）：DSH_SUPERVISOR_HOME=TMP ⇒ <TMP>/{shell,supervisor}。
  process.env.DSH_SUPERVISOR_HOME = TMP;
  if (process.platform === 'win32') {
    // 双保险：os.homedir() 在 USERPROFILE 缺失时的回退来源
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = '';
  }

  const shell = require(path.join(ROOT, 'src', 'domains', 'shell', 'index.js'));
  const dir = shell.shellDir();
  fs.mkdirSync(dir, { recursive: true });

  const writeIdentity = (o) => fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(o));

  // ── R6 隔离 ──
  console.log('== R6 状态目录物理隔离 ==');
  check('R6-a 壳状态目录为 <状态根>/shell', dir === path.join(TMP, 'shell'), dir);
  check('R6-b 与内核状态目录不同', dir !== path.join(TMP, 'supervisor'));

  // ── R1 账本 ──
  console.log('== R1 账本与初始判定 ==');
  check('R1-a 初始无更新 → idle', shell.evaluate().state === 'idle', shell.evaluate().state);
  const rec = shell.markPending('0.1.0', '0.2.0');
  check('R1-b markPending 写入 to', rec.to === '0.2.0' && rec.from === '0.1.0', JSON.stringify({ to: rec.to, from: rec.from }));

  // ── R2 健康确认 ──
  console.log('== R2 健康确认 ==');
  writeIdentity({ version: '0.2.0', attempt: 0, phase: 'boot' });
  const h = shell.health({ phase: 'ready', version: '0.2.0' });
  check('R2-a ready + 版本匹配 → confirmed', h.state === 'confirmed', h.state);
  check('R2-b 账本 confirmed=true', shell.readJournal().confirmed === true);

  // ── R3 强制更新：attempt 再高也不回退（永不回退）──
  console.log('== R3 强制更新：永不回退 ==');
  shell.markPending('0.2.0', '0.3.0');
  writeIdentity({ version: '0.2.0', attempt: 1, phase: 'boot' });
  check('R3-a attempt=1 → pending', shell.evaluate().state === 'pending', shell.evaluate().state + '/' + shell.evaluate().reason);
  writeIdentity({ version: '0.2.0', attempt: 99, phase: 'boot' });
  const ev = shell.evaluate();
  check('R3-b attempt 极高仍为 pending（不回退）', ev.state === 'pending', ev.state + '/' + ev.reason);
  check('R3-c 判定含当前与目标版本', ev.current === '0.2.0' && ev.target === '0.3.0', ev.current + '->' + ev.target);
  check('R3-d evaluate() 不再产生 should-rollback', !/should-rollback/.test(String(ev.state)), String(ev.state));
  check('R3-e 模块不再导出 rollback', typeof shell.rollback !== 'function', typeof shell.rollback);
  const st = shell.status();
  check('R3-f status() 不含 pinned 字段', !('pinned' in st), JSON.stringify(Object.keys(st)));

  // ── R4 反回归：回退机构不得复活 ──
  console.log('== R4 反回归：回退机构已移除 ==');
  {
    const code = stripCommentLines(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'shell', 'index.js'), 'utf8'));
    check('R4-a 无 rollback 函数定义', !/function rollback/.test(code), '无');
    check('R4-b 无 pinnedVersions 引用', !/pinnedVersions/.test(code), '无');
    check('R4-c 无 should-rollback 判定', !/should-rollback/.test(code), '无');
    check('R4-d 无 maxAttempts 阈值', !/maxAttempts/.test(code), '无');
    check('R4-e evaluate() 不读 identity.attempt', !/id\.attempt/.test(code), '无');
    check('R4-f 账本无 rolledBack 字段', !/rolledBack/.test(code), '无');
    const wdCode = stripCommentLines(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'shell', 'watchdog.js'), 'utf8'));
    check('R4-g watchdog 不再读账本 rolledBack 字段', !/\.rolledBack/.test(wdCode), '无');
  }

  // ─ R5 硬约束：不触碰内核更新机制 ──
  console.log('== R5 硬约束：不触碰内核更新机制 ==');
  {
    const code = stripCommentLines(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'shell', 'index.js'), 'utf8'));
    check('R5-a 不 require dist（无安装执行器）', !/require\([^)]*domains\/dist/.test(code));
    check('R5-b 不调用 runNpmInstall', !/runNpmInstall/.test(code));
    check('R5-c 不写内核版本状态', !/_selfUpdateExpectedVersion|selfUpdateManifest/.test(code));
    check('R5-d 不触碰内核状态目录', !/supervisor['"]/.test(code) && !/state\.json/.test(code));
  }

  // ── API 域：路由归属 ──
  console.log('== API 域归属 ==');
  {
    const apiShell = require(path.join(ROOT, 'src', 'api', 'domains', 'shell.js'));
    check('R7-a owns /shell/status', apiShell.owns('/shell/status'));
    check('R7-b owns /shell/health', apiShell.owns('/shell/health'));
    check('R7-c 不 own 其它路径', !apiShell.owns('/status') && !apiShell.owns('/instances'));
    const surface = require(path.join(ROOT, 'src', 'api', 'contract.js'));
    const paths = surface.SURFACE.filter((e) => e.domain === 'shell').map((e) => e.path).sort();
    // 5 条：status / health / update-pending / check-update / restart（rollback 已移除）
    check('R7-d surface 已登记 shell 域 5 条', paths.length === 5, JSON.stringify(paths));
    check('R7-e 含壳版本检测端点', paths.includes('/shell/check-update'), JSON.stringify(paths));
    check('R7-f 含壳重启端点', paths.includes('/shell/restart'), JSON.stringify(paths));
    check('R7-g /shell/check-update 不 own（属精确路由）', apiShell.owns('/shell/check-update'));
    check('R7-h /shell/rollback 不再登记', !paths.includes('/shell/rollback'), JSON.stringify(paths));
  }

  // ── R8 壳版本检测（内核只查版本，不做安装）──
  console.log('== R8 壳版本检测 ==');
  {
    // 写一份 identity：壳当前版本 1.0.1
    writeIdentity({ version: '1.0.1', attempt: 0, phase: 'ready' });

    const fakeDist = (latest) => ({
      fetchLatestVersion: async () => latest,
    });

    const up = await shell.checkUpdate(fakeDist('1.0.2'), {});
    check('R8-a 远端更高 → updateAvailable=true', up.ok === true && up.updateAvailable === true, JSON.stringify(up));
    check('R8-b 回报 installed 与 latest', up.installed === '1.0.1' && up.latest === '1.0.2', JSON.stringify(up));

    const same = await shell.checkUpdate(fakeDist('1.0.1'), {});
    check('R8-c 相同版本 → updateAvailable=false', same.ok === true && same.updateAvailable === false, JSON.stringify(same));

    const older = await shell.checkUpdate(fakeDist('1.0.0'), {});
    check('R8-d 远端更低 → 不报可更新（不降级）', older.updateAvailable === false, JSON.stringify(older));

    const none = await shell.checkUpdate(fakeDist(null), {});
    check('R8-e 查不到版本 → ok=false 明确报错', none.ok === false && !!none.error, JSON.stringify(none));

    const noDist = await shell.checkUpdate(null, {});
    check('R8-f 分发服务缺失 → ok=false（不抛异常）', noDist.ok === false, JSON.stringify(noDist));

    const boom = await shell.checkUpdate({ fetchLatestVersion: async () => { throw new Error('network down'); } }, {});
    check('R8-g 查询抛错 → 捕获为 ok=false', boom.ok === false && /network down/.test(boom.error || ''), JSON.stringify(boom));
  }

  // ── R9 壳重启（安全：绝不误杀真实进程）──
  console.log('== R9 壳重启 ==');
  {
    // 用一个**不存在的**进程名，确保不会碰到开发者本机正在运行的壳。
    const r = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz' });
    check('R9-a 无壳进程且无 exePath → ok=false 明确失败', r.ok === false && !!r.error, JSON.stringify(r));

    // 提供 exePath：应尝试拉起。
    //  用 process.execPath（node 自身）而非 /bin/true —— 后者在 Windows 上不存在，
    //   会让该断言在 Windows CI 上失败（测试夹具的平台可移植性）。
    //   node 在 stdio 被 ignore（无 stdin）时立即退出，不会留下常驻进程。
    const r2 = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz', exePath: process.execPath });
    check('R9-b 有 exePath → 尝试拉起并返回 ok', r2.ok === true && r2.restarted === true, JSON.stringify(r2));
    check('R9-c 未杀任何真实进程（killed 为空）', Array.isArray(r2.killed) && r2.killed.length === 0, JSON.stringify(r2.killed));
  }

  // ── R10 反回归：内核侧回退机构不得复活（**只读内核源码**）──
  //   产品规则（用户确认）：壳与内核同一套升级逻辑 —— 有新版必须强制更新，
  //     **不得回退、不得跳过、不得按版本拉黑、不得冷却抑制**。
  //     → 内核侧壳回退机构（rollback/pinnedVersions/should-rollback）已整体移除。
  //   壳侧「不得重新引入 attempt / pendingVersion / update-journal」属**壳仓自身**约束，
  //   由壳仓测试负责（src-tauri/src/update.rs::t5 与壳仓反回归测试）。
  //   内核**不读壳仓源码** —— 两仓按账号/仓库隔离（见 RELEASE-STANDARD.md §0）。
  //   本组锁定两件事：
  //     R10-a 内核侧回退机构不得复活（shell 域 + api/domains/shell.js + contract 登记）
  //     R10-c identity.json 的护栏字段只由壳写（内核不得成为第二写入方）
  console.log('== R10 反回归：回退机构不得复活 ==');
  {
    // ⚠ 2026-09-16 步骤8a（DIRECTORY-STRUCTURE-DESIGN §4.5）：shell 域已拆为
    //   index/journal/restart 三文件，health()（写 phase/version/lastSeenAt）迁至
    //   journal.js。本组断言的对象是**整个 shell 域源码**（R10-c 的意图 = 「内核不得
    //   成为 identity.json 第二写入方」），与文件切分无关 —— 故按域聚合读取，
    //   而不是把判据从 index.js 搬走（那会让断言静默失去覆盖面）。
    const shellSrc = ['index', 'journal', 'restart']
      .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'shell', f + '.js'), 'utf8'))
      .join(LF);
    const apiShellSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'shell.js'), 'utf8');
    const surfaceSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'contract.js'), 'utf8');
    const shellSrcCode = stripCommentLines(shellSrc);
    const apiShellCode = stripCommentLines(apiShellSrc);
    const surfaceCode = stripCommentLines(surfaceSrc);

    // R10-a-1：内核侧回退机构已移除（代码级；注释已剥离，避免说明文字自匹配）
    check('R10-a 内核 shell 域无 rollback 函数', !/function rollback/.test(shellSrcCode), '无');
    check('R10-a 内核 shell 域无 pinnedVersions', !/pinnedVersions/.test(shellSrcCode), '无');
    check('R10-a 内核 shell 域无 should-rollback', !/should-rollback/.test(shellSrcCode), '无');
    check('R10-a api/domains/shell.js 无 /shell/rollback 分支', !/\/shell\/rollback/.test(apiShellCode), '无');
    check('R10-a api/domains/shell.js 不调用 shell.rollback', !/shell\.rollback/.test(apiShellCode), '无');
    check('R10-a surface 无 /shell/rollback 登记', !/\/shell\/rollback/.test(surfaceCode), '无');
    check('R10-a surface 前缀清单不含 rollback', !/update-pending\|rollback/.test(surfaceCode), '无');

    // ── R10-c：identity.json 只由壳写（内核不得成为第二写入方）──
    //   背景：壳仓 update.rs::write_identity_for 是 identity.json 的唯一写入点；
    //   内核 domains/shell/journal.js::health() 只兜底写运行时字段（原 index.js，步骤8a 拆分）。
    //   护栏/回退字段（attempt/pendingVersion）已随壳回退整体废除。
    {
      const codeOnly = stripCommentLines(shellSrc);
      //    判据必须排除比较运算：id.attempt === 'number'（读取）也会被
      //     id\.attempt\s*= 匹配到（=== 的首个 =）→ 假红。用 (?!==) 排除。
      const writeAttempt = /id\.attempt\s*=(?!=)/;
      check('R10-c 内核 health() 不再写 identity.json 的 attempt（单一写入点纪律）',
        !writeAttempt.test(codeOnly), '已移除');
      check('R10-c 内核仍保留 phase/version/lastSeenAt（运维端点可用）',
        /id\.phase\s*=/.test(codeOnly) && /id\.lastSeenAt\s*=/.test(codeOnly), '有');
      // 反向：确认 audit 的判据有效（对旧形态命中）
      check('R10-c 反向：判据能识别「写 attempt」的形态',
        writeAttempt.test("if (typeof p.attempt === 'number') id.attempt = p.attempt;"), 'hit');
      check('R10-c 反向：判据不误报「读 attempt」（=== 比较）',
        !writeAttempt.test("const attempt = (id && typeof id.attempt === 'number') ? id.attempt : 0;"), 'no-false-positive');
    }
  }

  const failed = results.filter((r) => !r);
  console.log(LF + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);

})().catch((e) => { console.error("ERR", e); process.exit(1); });
