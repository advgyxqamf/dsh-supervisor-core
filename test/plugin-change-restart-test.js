#!/usr/bin/env node
'use strict';

// 卸载类测试（项目政策，2026-08-31）：本脚本含插件卸载（PluginManager.uninstall）场景，涉及卸载类操作，
// 已纳入 npm test（CI）自动测试链执行；测试结论只能由 CI 裁决，本地不单独复跑
// （如需排查，可显式执行 node test/plugin-change-restart-test.js 或 npm run test:plugin-change-restart）。

// 插件管理双机制（原生宿主 × 沙箱实例）核心行为测试：
//  - 卸载：官方 CLI + bundles 清理 + 跨层残留（home 补丁层/原生 overlay/profile 补丁层）清理
//    + 运行中实例自动重启；job 级核算（部分失败 → failed）
//  - 停用/启用：官方补丁层机制（$DSH_HOME/cordis.patch.yml）热载面，不动 bundles（防 reconcile 击穿），
//    无需重启；启用顺带清理 legacy overlay
//  - 更新：检测（registry 最高版 vs 已装版）+ 执行（update/add）+ 重启生效；本地/git 型拒绝
// 全部用桩（stub CLI/instances/registry），profile 目录用真实临时目录验证文件级行为。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
// 2026-09-16 步骤8a（DIRECTORY-STRUCTURE-DESIGN §4.5）：plugin 域补 index.js，
// 原 plugins.js 拆为 index/ops/jobs/store（market.js 由 pluginmarket.js 改名）。
const { PluginManager } = require(path.join(ROOT, 'src', 'domains', 'plugin'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(pm, jobId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = pm.installStatus(jobId);
    if (j && (j.state === 'done' || j.state === 'failed')) return j;
    await sleep(15);
  }
  return pm.installStatus(jobId);
}

function initProfileDir(dir, deps, bundles) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'profile', private: true, dependencies: deps || {},
    dsh: { profile: { bundles: bundles || ['@deepseek-ai/dsh-base'] } }
  }, null, 2) + String.fromCharCode(10));
}

/** 真实临时 profile 目录 + 桩 CLI/instances/registry。opts: running/pnpmResult/pnpmError/bundlesClean/installedOnTargets/nativeRestart/distLatest */
function makePM(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pm-'));
  const nativeProfile = path.join(tmp, 'native', 'profiles', 'web');
  const aProfile = path.join(tmp, 'inst-a', 'profiles', 'web');
  initProfileDir(nativeProfile, { '@x/p': '^1.0.0' }, ['@deepseek-ai/dsh-base', '@x/p']);
  initProfileDir(aProfile, { '@x/p': '^1.0.0' }, ['@deepseek-ai/dsh-base', '@x/p']);
  const overlayFile = path.join(tmp, 'plugin-states.patch.yml');
  fs.writeFileSync(overlayFile, JSON.stringify([{ id: 'include:p', disabled: true }], null, 2));

  const installedOnTargets = opts.installedOnTargets || ['native', 'inst-a'];
  const events = [];
  const instances = {
    calls: [],
    states: { 'inst-a': opts.running !== false, 'inst-b': false, 'main': opts.running !== false },
    probeInstance(id) { this.calls.push('probe:' + id); return { pid: 1, running: !!this.states[id] }; },
    stopInstance(id) { this.calls.push('stop:' + id); this.states[id] = false; return { ok: true }; },
    async startInstance(id) { this.calls.push('start:' + id); this.states[id] = true; return { ok: true }; },
  };
  const NATIVE = { id: 'native', name: '原生实例', kind: 'native', profileDir: nativeProfile, profileName: 'web' };
  const A = { id: 'inst-a', name: '沙箱甲', kind: 'sandbox', profileDir: aProfile, profileName: 'web' };
  const pm = new PluginManager({
    dshBin: 'dsh', profileName: 'web', profileDir: nativeProfile, overlayFile,
    dshPort: 3080, instances: null, tasks: null, logger: { info() {}, warn() {}, error() {} },
    events: { append: (t, d) => events.push({ t, d }) },
    onNativeRestart: opts.nativeRestart || (() => { instances.calls.push('native-restart'); return { ok: true }; }),
    dist: { fetchNpmLatest: async (n) => (opts.distLatest !== undefined ? opts.distLatest[n] : '2.0.0') },
  });
  pm.instances = instances;
  pm._allSandboxTargets = () => [A];
  pm.resolveTargets = (str) => {
    if (str === 'native') return { ok: true, targets: [NATIVE] };
    if (str === 'all') return { ok: true, targets: [NATIVE, A] };
    if (str === 'inst-a') return { ok: true, targets: [A] };
    return { ok: false, error: 'no target ' + str };
  };
  pm.installedOn = (t) => installedOnTargets.includes(t.id) ? [{ name: '@x/p', version: '1.0.0', source: '@x/p', bundle: true }] : [];
  pm._runCli = async (target, args) => {
    instances.calls.push('cli:' + target.id + ':' + args.join(' '));
    const preset = typeof opts.pnpmResult === 'function' ? opts.pnpmResult(target, args) : opts.pnpmResult;
    if (preset) return { ok: true, error: null };
    return { ok: false, error: (opts.pnpmError !== undefined ? opts.pnpmError : '退出码 1') };
  };
  pm.inventory = async () => ({ entries: [{ entryId: 'e1', moduleName: '@x/p-something' }] });
  pm.saveOverlayEntries = (entries) => fs.writeFileSync(overlayFile, JSON.stringify(entries, null, 2) + String.fromCharCode(10));
  return { pm, instances, events, tmp, aProfile, nativeProfile, overlayFile };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const homePatchFile = (profileDir) => path.join(path.dirname(path.dirname(profileDir)), 'cordis.patch.yml');
const eventsOf = (arr, type) => (arr || []).some((e) => e.t === type);

(async () => {
  // ── A. 卸载成功 + 运行中沙箱 → 重启；bundles 移除 ──
  {
    const { pm, instances, events, aProfile } = makePM({ running: true, pnpmResult: true });
    const before = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []).slice();
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    const after = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []);
    check('A1 卸载 job done', job.state === 'done', job.state);
    check('A2 运行中沙箱被重启', instances.calls.includes('stop:inst-a') && instances.calls.includes('start:inst-a'), instances.calls.join(','));
    check('A3 已发 plugin_uninstall_done', eventsOf(events, 'plugin_uninstall_done'), '');
    check('A4 bundles 移除', before.includes('@x/p') && !after.includes('@x/p'), JSON.stringify(after));
    check('A5 重启日志入列', (job.targets[0].log || []).some((l) => /已重启/.test(l)), '');
  }
  // ── B. 卸载成功 + 实例未运行 → 不重启 ──
  {
    const { pm, instances } = makePM({ running: false, pnpmResult: true });
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('B1 卸载 job done', job.state === 'done', job.state);
    check('B2 未运行的实例不重启', !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'), instances.calls.join(','));
    check('B3 提示下次启动生效', (job.targets[0].log || []).some((l) => /下次启动/.test(l)), '');
  }
  // ── C. pnpm 报「依赖已不存在」+ bundles 已清理 → 视为成功并重启 ──
  {
    const { pm, instances } = makePM({
      running: true, pnpmResult: false,
      pnpmError: "ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS Cannot remove '@x/p': no such dependency found", bundlesClean: true
    });
    pm._removeFromProfileBundles = () => true;
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('C1 依赖已移除判定为成功', job.state === 'done', job.state);
    check('C2 成功路径仍重启', instances.calls.includes('start:inst-a'), instances.calls.join(','));
  }
  // ── D. 硬失败（无 bundles 变更）→ job failed，不重启 ──
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: false, pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('D1 硬失败 job failed', job.state === 'failed', job.state);
    check('D2 失败不重启', !instances.calls.includes('stop:inst-a'), instances.calls.join(','));
  }
  // ── E. native 目标变更 + 运行中 → onNativeRestart；不直接碰 systemd ──
  {
    let nativeRestartCalls = 0;
    const { pm, instances } = makePM({ running: true, pnpmResult: true, nativeRestart: () => { nativeRestartCalls++; return { ok: true }; } });
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('E1 原生卸载 job done', job.state === 'done', job.state);
    check('E2 原生走 supervisor 重启回调', nativeRestartCalls === 1, 'calls=' + nativeRestartCalls);
    check('E3 未直接操作 systemd', !instances.calls.some((c) => c.startsWith('stop:main')), '');
  }
  // ── F0. 行保留回归：禁用/启用不得误删补丁层中的非 disabled 用户行/insert 行（2026-09 审计修复）──
  {
    const { pm, aProfile } = makePM({ running: true });
    const hpFile = homePatchFile(aProfile);
    // 预置：本插件既有 disabled:false 行 + 与插件同 id 的 insert 型行 + 其它插件行
    fs.writeFileSync(hpFile, JSON.stringify([
      { id: '@x/p', enabled: true },                    // 用户手动配置行（非 disabled）
      { insert: [{ id: 'x-util', name: '@x/p' }] },      // insert 型行（引用该插件）
      { id: '@y/q', disabled: true },                    // 其它插件禁用行（不得受影响）
    ], null, 2));
    // 禁用：应保留 enabled/insert/其它插件行，仅将 @x/p 行置 disabled
    await pm.setBundleEnabled('@x/p', false, 'inst-a');
    let hp = readJson(hpFile) || [];
    const ownRow = hp.find((e) => e && e.id === '@x/p');
    check('F0.1 禁用后本插件行 disabled=true', !!ownRow && ownRow.disabled === true, JSON.stringify(hp));
    check('F0.2 禁用保留 insert 型行', hp.some((e) => Array.isArray(e.insert) && e.insert.some((r) => r.name === '@x/p')), JSON.stringify(hp));
    check('F0.3 禁用保留其它插件禁用行', hp.some((e) => e.id === '@y/q' && e.disabled === true), JSON.stringify(hp));
    // 启用：应移除本插件 disabled 行（禁用态整体移除为本产品语义），但 insert/其它插件行绝不丢
    await pm.setBundleEnabled('@x/p', true, 'inst-a');
    hp = readJson(hpFile) || [];
    check('F0.4 启用后无本插件 disabled 行', !hp.some((e) => e && e.id === '@x/p'), JSON.stringify(hp));
    check('F0.5 启用保留 insert 型行', hp.some((e) => Array.isArray(e.insert) && e.insert.some((r) => r.name === '@x/p')), JSON.stringify(hp));
    check('F0.6 启用保留其它插件行', hp.some((e) => e.id === '@y/q'), JSON.stringify(hp));
  }
  // ── F1. 禁用（沙箱）：写 home 补丁层，不动 bundles，不重启（热应用）──
  {
    const { pm, instances, events, aProfile } = makePM({ running: true });
    const res = await pm.setBundleEnabled('@x/p', false, 'inst-a');
    const hp = readJson(homePatchFile(aProfile)) || [];
    const bundles = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []);
    const disabledRow = hp.find((e) => e.id === '@x/p');
    check('F1.1 返回 rows=1', res.ok === true && res.rows === 1, JSON.stringify(res));
    check('F1.2 home 补丁层写入 disabled 行', !!disabledRow && disabledRow.disabled === true, JSON.stringify(hp));
    check('F1.3 不动 bundles（防 reconcile 击穿）', bundles.includes('@x/p'), JSON.stringify(bundles));
    check('F1.4 不重启（热应用）', !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'), instances.calls.join(','));
    check('F1.5 事件 hot:true', eventsOf(events, 'plugin_disabled'), '');
  }
  // ── F2. 启用（沙箱）：移除禁用行 ──
  {
    const { pm, aProfile } = makePM({ running: true });
    await pm.setBundleEnabled('@x/p', false, 'inst-a');
    const res2 = await pm.setBundleEnabled('@x/p', true, 'inst-a');
    const hp = readJson(homePatchFile(aProfile)) || [];
    check('F2.1 启用后禁用行移除', res2.rows === 1 && !hp.some((e) => e.id === '@x/p'), JSON.stringify(hp));
  }
  // ── G. 安装成功 + 运行中沙箱 → 不自动重启，仅提示 ──
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: true });
    const r = await pm.install('@x/p', { target: 'inst-a' });
    const job = await waitJob(pm, r.jobId, 3000);
    check('G1 安装 job done', job.state === 'done', job.state);
    check('G2 安装不自动重启', !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'), instances.calls.join(','));
    check('G3 提示下次重启加载', (job.targets[0].log || []).some((l) => /下次重启|实例重启后/.test(l)), '');
  }
  // ── H. all：native 失败 + 沙箱成功 → job failed（部分目标失败）──
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: (t) => t.kind === 'sandbox', pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'all');
    const job = await waitJob(pm, r.jobId, 5000);
    check('H1 部分失败 job failed', job.state === 'failed', job.state);
    check('H2 失败目标 error 记录', (job.targets.find((t) => t.id === 'native') || {}).error === 'registry timeout', '');
    check('H3 成功目标仍重启', instances.calls.includes('start:inst-a'), instances.calls.join(','));
  }
  // ── I. _removeFromProfileBundles 真实写盘：幂等 ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-rm-'));
    const profileDir = path.join(tmp, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@x/p'] } } }, null, 2));
    const pm = new PluginManager({ dshBin: 'x', profileName: 'web', profileDir: '/nonexistent', overlayFile: '/nonexistent', dshPort: 1, logger: console });
    const removed = pm._removeFromProfileBundles({ profileDir }, '@x/p');
    const after = readJson(path.join(profileDir, 'package.json'));
    check('I1 bundles 移除返回 true', removed === true, String(removed));
    check('I2 插件从 bundles 消失', !(after.dsh.profile.bundles || []).includes('@x/p'), '');
    check('I3 二次移除返回 false（幂等）', pm._removeFromProfileBundles({ profileDir }, '@x/p') === false, '');
  }
  // ── J. 卸载残留清理（home 补丁层 / overlay / profile 补丁层 JSON）──
  {
    const { pm, aProfile, overlayFile } = makePM({ running: true, pnpmResult: true });
    const hpFile = homePatchFile(aProfile);
    fs.writeFileSync(hpFile, JSON.stringify([{ id: '@x/p', disabled: true }], null, 2) + String.fromCharCode(10));
    fs.writeFileSync(path.join(aProfile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'x-util', name: '@x/p' }] }], null, 2) + String.fromCharCode(10));
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    const hpAfter = readJson(hpFile) || [];
    const ppAfter = readJson(path.join(aProfile, 'cordis.patch.yml')) || [];
    check('J1 卸载 job done', job.state === 'done', job.state);
    check('J2 home 补丁层残留已清', !hpAfter.some((e) => e.id === '@x/p'), JSON.stringify(hpAfter));
    check('J3 profile 补丁层 insert 残留已清（纯 JSON 可安全改写）', !ppAfter.some((e) => (e.insert || []).some((row) => row.name === '@x/p')), JSON.stringify(ppAfter));
    check('J4 日志含清理记录', (job.targets[0].log || []).some((l) => /残留|补丁层/.test(l)), '');
  }
  // ── K. 启用 native：清 legacy overlay 禁用行 ──
  {
    const { pm, overlayFile } = makePM({ running: true });
    const before = readJson(overlayFile) || [];
    if (before.some((e) => e.id === 'include:p')) {
      const res = await pm.setBundleEnabled('@x/p', true, 'native');
      const after = readJson(overlayFile) || [];
      check('K1 启用时清理 legacy overlay', res.rows >= 1 && !after.some((e) => e.id === 'include:p'), JSON.stringify(after));
    } else { check('K1 启用时清理 legacy overlay', false, 'seed missing'); }
  }
  // ── L. 更新：检测 + 执行 + 重启 ──
  {
    const { pm, instances, events } = makePM({ running: true, pnpmResult: true, distLatest: { '@x/p': '2.0.0' } });
    const chk = await pm.checkUpdates();
    const uc = (chk.plugins || []).find((x) => x.name === '@x/p');
    check('L1 检测到可更新', !!uc && uc.updateAvailable === true && uc.specType === 'npm', JSON.stringify(uc));
    check('L2 检测含目标明细', !!uc && uc.targets.length === 2 && uc.targets.every((t) => t.updateAvailable), '');
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('L3 更新 job done', job.state === 'done', job.state);
    check('L4 更新走官方 update 命令', instances.calls.some((c) => c.startsWith('cli:inst-a:update @x/p@2.0.0')), instances.calls.join(','));
    check('L5 更新后重启', instances.calls.includes('start:inst-a'), instances.calls.join(','));
    check('L6 更新事件', eventsOf(events, 'plugin_update_done'), '');
  }
  // ── M. 更新已是最新 → 跳过不执行 ──
  {
    const { pm, instances } = makePM({ running: true, distLatest: { '@x/p': '1.0.0' } });
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('M1 已最新 job done', job.state === 'done', job.state);
    check('M2 不执行更新命令', !instances.calls.some((c) => c.startsWith('cli:inst-a:update')), instances.calls.join(','));
    check('M3 不重启', !instances.calls.includes('start:inst-a'), '');
  }
  // ── N. 本地型插件更新 → 拒绝并失败 ──
  {
    const { pm, instances } = makePM({ running: true, distLatest: { '@x/p': '2.0.0' } });
    pm.installedOn = (t) => [{ name: '@x/p', version: '1.0.0', source: 'file:/home/me/dev/x', bundle: true }];
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('N1 本地型更新 job failed', job.state === 'failed', job.state + ' / ' + (job.error || ''));
    check('N2 本地型不执行 CLI', !instances.calls.some((c) => c.startsWith('cli:inst-a:update')), instances.calls.join(','));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
