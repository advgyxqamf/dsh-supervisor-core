#!/usr/bin/env node
'use strict';

// 桌面壳更新安全网回归（2026-09-11）
//
// 覆盖：
//   R1 账本（markPending）与判定（evaluate）状态机
//   R2 健康确认：壳以目标版本上报 ready → confirmed
//   R3 有界回退：attempt 达阈值 → should-rollback（**核心价值**）
//   R4 防循环：回退后账本清空 + 坏版本进 pinnedVersions
//   R5 ⛔ 硬约束：安全网**绝不触碰内核更新机制**（不 import dist、不调用 runNpmInstall）
//   R6 物理隔离：壳状态目录（~/.dsh/shell）与内核状态目录（~/.dsh/supervisor）不同

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

// 测试主体包进 async IIFE：本套测试自 2026-09-11 起含 await（checkUpdate/restartShell），
// 而 CommonJS 顶层不允许 await —— 之前全同步掩盖了这一点。
(async () => {

  // 隔离 HOME，避免污染真实壳状态。
  // ⚠ 必须同时设 USERPROFILE：Node 的 os.homedir() 在 Windows 上**优先读 USERPROFILE**，
  //   只设 HOME 会退回真实用户目录 → 该测试在 Windows 上断言失败（实测 CI #22）。
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-net-'));
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
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
  check('R6-a 壳状态目录为 ~/.dsh/shell', dir === path.join(TMP, '.dsh', 'shell'), dir);
  check('R6-b 与内核状态目录不同', dir !== path.join(TMP, '.dsh', 'supervisor'));

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

  // ── R3 有界回退（核心） ──
  console.log('== R3 有界回退 ==');
  shell.markPending('0.2.0', '0.3.0');
  writeIdentity({ version: '0.2.0', attempt: 1, phase: 'boot' });
  check('R3-a attempt=1（未达阈值）→ pending', shell.evaluate().state === 'pending', shell.evaluate().state + '/' + shell.evaluate().reason);
  writeIdentity({ version: '0.2.0', attempt: 2, phase: 'boot' });
  const ev = shell.evaluate();
  check('R3-b attempt=2（达阈值）→ should-rollback', ev.state === 'should-rollback', ev.reason);
  check('R3-c 判定含当前与目标版本', ev.current === '0.2.0' && ev.target === '0.3.0', ev.current + '->' + ev.target);

  // ── R4 防循环 ──
  console.log('== R4 防循环 ==');
  const rb = shell.rollback('test');
  check('R4-a 坏版本进 pinnedVersions', rb.pinned === '0.3.0', JSON.stringify(shell.readJournal().pinnedVersions));
  check('R4-b 账本 to 清空', shell.readJournal().to === null);
  check('R4-c 回退后回到 idle（不反复判定）', shell.evaluate().state === 'idle', shell.evaluate().state);
  check('R4-d rolledBack 标记', shell.readJournal().rolledBack === true);

  // ── R5 硬约束：不触碰内核更新机制 ──
  console.log('== R5 硬约束：不触碰内核更新机制 ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'shell', 'index.js'), 'utf8');
    const code = src.split(String.fromCharCode(10)).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join(String.fromCharCode(10));
    check('R5-a 不 require dist（无安装执行器）', !/require\([^)]*domains\/dist/.test(code));
    check('R5-b 不调用 runNpmInstall', !/runNpmInstall/.test(code));
    check('R5-c 不写内核版本状态', !/_selfUpdateExpectedVersion|selfUpdateManifest/.test(code));
    check('R5-d 不触碰内核状态目录', !/supervisor['\"]/.test(code) && !/state\.json/.test(code));
  }

  // ── API 域：路由归属 ──
  console.log('== API 域归属 ==');
  {
    const apiShell = require(path.join(ROOT, 'src', 'api', 'shell.js'));
    check('R7-a owns /shell/status', apiShell.owns('/shell/status'));
    check('R7-b owns /shell/health', apiShell.owns('/shell/health'));
    check('R7-c 不 own 其它路径', !apiShell.owns('/status') && !apiShell.owns('/instances'));
    const surface = require(path.join(ROOT, 'src', 'api', 'surface.js'));
    const paths = surface.SURFACE.filter((e) => e.domain === 'shell').map((e) => e.path).sort();
    // 6 条：status / health / update-pending / check-update / restart / rollback
    check('R7-d surface 已登记 shell 域 6 条', paths.length === 6, JSON.stringify(paths));
    check('R7-e 含壳版本检测端点', paths.includes('/shell/check-update'), JSON.stringify(paths));
    check('R7-f 含壳重启端点', paths.includes('/shell/restart'), JSON.stringify(paths));
    check('R7-g /shell/check-update 不 own（属精确路由）', apiShell.owns('/shell/check-update'));
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
    // ⚠ 用 process.execPath（node 自身）而非 /bin/true —— 后者在 Windows 上不存在，
    //   会让该断言在 Windows CI 上失败（测试夹具的平台可移植性）。
    //   node 在 stdio 被 ignore（无 stdin）时立即退出，不会留下常驻进程。
    const r2 = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz', exePath: process.execPath });
    check('R9-b 有 exePath → 尝试拉起并返回 ok', r2.ok === true && r2.restarted === true, JSON.stringify(r2));
    check('R9-c 未杀任何真实进程（killed 为空）', Array.isArray(r2.killed) && r2.killed.length === 0, JSON.stringify(r2.killed));
  }

  // ── R10 跨仓契约：内核写 update-journal.json 的 pinnedVersions，**壳不消费** ──
  //   2026-09-13（P3 跨仓契约，失效模式 f + i）。
  //
  //   缺陷（声明与事实不符）：domains/shell/index.js 的 rollback 文档与
  //     api/surface.js 的 /shell/rollback note 都声称「壳门 0 读取 pinnedVersions 后不再用它」，
  //     但实测**壳仓 grep 零命中**（只有注释/文档）—— 该字段没有任何接收方。
  //
  //   ⛔ 关键：**不得**为了让声明成真而接线。内核 pinnedVersions 无过期，
  //     而壳 should_check 的 pinned 分支不查冷却 → 接线会重新引入「永久拉黑」。
  //
  //   本门禁锁定两件事：
  //     R10-a 内核侧**不得**再声称壳消费 pinnedVersions（除去说明「不消费」的注释）
  //     R10-b 壳侧**不得**出现读取 update-journal 的代码（防止有人偷偷接线 → 永久拉黑）
  console.log('== R10 跨仓契约：pinnedVersions 无接收方 ==');
  {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOTD = path.join(__dirname, '..');
    const shellSrc = fs.readFileSync(path.join(ROOTD, 'src', 'domains', 'shell', 'index.js'), 'utf8');
    const surfaceRaw = fs.readFileSync(path.join(ROOTD, 'src', 'api', 'surface.js'), 'utf8');
    // ⚠ 剥离注释行后再断言：本次修正的**说明注释里**必然引用旧句式
    //   （「本条 note 原写…」），不剥离就会自匹配 —— 本仓已第 9 次踩这个坑。
    //   旧缺陷位于 note: 字符串（代码），故只剥离 // 开头的整行注释是安全的。
    const surfaceSrc = surfaceRaw.split('\n')
      .filter((l) => !l.trim().startsWith('//')).join('\n');

    // R10-a-1：旧声明句式必须已消失
    check('R10-a rollback 不再声称「壳门 0 读取 pinnedVersions」',
      !/壳门 0 读取后不会再用它/.test(shellSrc), '已修正');
    check('R10-a surface 不再声称「拉黑后壳门 0 不再尝试」',
      !/拉黑后壳门 0 不再尝试/.test(surfaceSrc), '已修正');
    // R10-a-2：必须显式记录「壳不消费」这一事实（防未来又被写回成既成事实）
    check('R10-a rollback 显式记录「壳不消费该字段」',
      /壳自更新用的是|壳不消费|无接收方/.test(shellSrc), '有');
    check('R10-a 记录了「接线会重新引入永久拉黑」的风险',
      /不查冷却|永久拉黑/.test(shellSrc), '有');

    // R10-b：壳仓**不得**出现读取 update-journal 的代码。
    //   证明方式：扫壳仓 src-tauri/src/*.rs 与 bootstrap/*.js 中是否出现
    //   update-journal 作为**字符串字面量**（读取路径），注释行排除。
    const shellRepo = path.join(ROOTD, '..', 'dsh-supervisor-launcher');
    let shellCode = '';
    const collect = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'target' || e.name === 'node_modules' || e.name === 'docs') continue;
          collect(p);
        } else if (/\.(rs|js|ts|html)$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          // 剥离注释行（// 与 # 与 * 开头），避免命中说明文字
          shellCode += src.split('\n').filter((l) => {
            const t = l.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#');
          }).join('\n') + '\n';
        }
      }
    };
    collect(shellRepo);
    check('R10-b 壳仓代码中无 update-journal 引用（未接线，故无永久拉黑风险）',
      !/update-journal/.test(shellCode), '零命中');
    check('R10-b 壳仓代码中无 pinnedVersions 引用',
      !/pinnedVersions/.test(shellCode), '零命中');
    // 反向：确认扫描**真的读到了**壳仓代码（否则该断言恒真 = 假门禁）
    check('R10-b 反向：扫描确实读到壳仓源码（非空转）',
      shellCode.length > 5000 && /fn should_check|pub fn should_check/.test(shellCode),
      'len=' + shellCode.length);

    // ── R10-c：identity.json 的**护栏字段**只由壳写（内核不得成为第二写入方）──
    //   背景：壳仓 D-3（update.rs::write_identity_for）已把 identity.json 的
    //   attempt/pinned/pendingVersion 收敛为「壳本地 Guard 的投影」，并声明单一写入点。
    //   而内核 domains/shell/index.js::health() 原会写 attempt（不经 Guard）→
    //   第二个写入方，且 evaluate() 用 id.attempt 做回滚判定 → 可被伪造成 0。
    {
      const shellDomain = fs.readFileSync(path.join(ROOTD, 'src', 'domains', 'shell', 'index.js'), 'utf8');
      const codeOnly = shellDomain.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      //   ⚠ 判据必须排除比较运算：`id.attempt === 'number'`（读取）也会被
      //     `id\.attempt\s*=` 匹配到（=== 的首个 =）→ 假红。用 (?!==) 排除。
      const writeAttempt = /id\.attempt\s*=(?!=)/;
      check('R10-c 内核 health() 不再写 identity.json 的 attempt（D-3 单一写入点纪律）',
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
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);

})().catch((e) => { console.error("ERR", e); process.exit(1); });
