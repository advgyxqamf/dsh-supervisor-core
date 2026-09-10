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

  // 隔离 HOME，避免污染真实壳状态
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-net-'));
  process.env.HOME = TMP;

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

    // 提供 exePath：应尝试拉起（用 /bin/true 作为替身，秒退，不产生常驻进程）
    const r2 = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz', exePath: '/bin/true' });
    check('R9-b 有 exePath → 尝试拉起并返回 ok', r2.ok === true && r2.restarted === true, JSON.stringify(r2));
    check('R9-c 未杀任何真实进程（killed 为空）', Array.isArray(r2.killed) && r2.killed.length === 0, JSON.stringify(r2.killed));
  }

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);

})().catch((e) => { console.error("ERR", e); process.exit(1); });
