#!/usr/bin/env node
'use strict';

// 守卫自更新核心（self-update.js）测试：本地 HTTP 模拟「无服务器发布源」。
// 覆盖：基线 → 下载/校验/解包/软链翻转 → 同版本跳过 → sha256 篡改拒绝（current 不动）→ 旧版本保留与剪枝。

const http = require('node:http');
const path = require('node:path');
// 模拟标准产品形态（SEA npm 通道）：deploy.detect 依据此变量判 sea-binary（生产不设，走真实判定）
process.env.DSH_DEPLOY_FORM = 'sea-binary';
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-update-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

// self-update 模块已随 dist 域迁移至 src/domains/dist/self-update.js（2026-09）
const { apply, fetchManifest, currentDir, versionOf } = require(path.join(ROOT, 'src', 'domains', 'dist', 'self-update'));

function makeRelease(version) {
  const root = path.join(TMP, 'rel-' + version);
  const inner = path.join(root, 'dsh-supervisor-' + version);
  fs.mkdirSync(path.join(inner, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(inner, 'src'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'package.json'), JSON.stringify({ name: 'dsh-supervisor', version }, null, 2));
  fs.writeFileSync(path.join(inner, 'bin', 'dsh-supervisor'), '#!/usr/bin/env node\nconsole.log("guard ' + version + '");\n');
  fs.writeFileSync(path.join(inner, 'src', 'supervisor.js'), '// v' + version + '\nmodule.exports = {};\n');
  fs.writeFileSync(path.join(inner, 'VERSION'), version);
  const tar = path.join(TMP, 'release-' + version + '.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', root, 'dsh-supervisor-' + version]);
  return tar;
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function seedInstall(dirName, versions) {
  const installDir = path.join(TMP, dirName);
  for (const v of versions) {
    const d = path.join(installDir, 'v' + v);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(d, 'VERSION'), v);
  }
  if (versions.length) fs.symlinkSync('v' + versions[versions.length - 1], path.join(installDir, 'current'));
  return installDir;
}

(async () => {
  const tar2 = makeRelease('2.0.0');
  const tar3 = makeRelease('3.0.0');
  // 可变 serve 桶：manifest 与 blob 独立可换
  const serve = { manifest: { version: 'v2.0.0', url: '', sha256: sha256(tar2) }, blob: tar2 };
  // npm registry 模拟(2026-09 npm 通道): 返回 dist-tags + versions
  const servePkg = { tags: { latest: '2.0.0' }, versions: { '2.0.0': {} } };
  const server = http.createServer((q, s) => {
    const u = q.url || '';
    if (u === '/manifest.json') { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(serve.manifest)); return; }
    if (u === '/blob') { s.writeHead(200); s.end(fs.readFileSync(serve.blob)); return; }
    if (u === '/-/ping') { s.writeHead(200); s.end('{}'); return; } // npm registry 可达性探测
    if (u.includes('dsh-core-linux-x64')) { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ 'dist-tags': servePkg.tags, versions: servePkg.versions })); return; }
    s.writeHead(404); s.end('nf');
  });
  await new Promise((r) => server.listen(39230, '127.0.0.1', r));
  const manifestUrl = 'http://127.0.0.1:39230/manifest.json';
  const blobUrl = 'http://127.0.0.1:39230/blob';
  serve.manifest.url = blobUrl;

  // 1. manifest 校验
  check('M1 fetchManifest 拒绝坏 sha256', fetchManifest(manifestUrl).then(() => false).catch(() => true), '');
  serve.manifest.sha256 = '0'.repeat(64);
  check('M2 fetchManifest 拒绝全零 sha256', fetchManifest(manifestUrl).then(() => false).catch(() => true), '');
  serve.manifest.sha256 = sha256(tar2);

  // 2. 种子 v1.0.0 → 更新到 v2.0.0
  const installDir = seedInstall('install', ['1.0.0']);
  check('U1 基线 current=v1.0.0', versionOf(currentDir(installDir)) === '1.0.0', versionOf(currentDir(installDir)));
  const r1 = await apply({ manifestUrl, installDir });
  check('U2 更新成功到 v2.0.0', r1.ok === true && r1.version === '2.0.0' && r1.from === '1.0.0', JSON.stringify(r1));
  check('U3 current 软链翻转到 v2.0.0', versionOf(currentDir(installDir)) === '2.0.0', versionOf(currentDir(installDir)));
  check('U4 新版本目录内容完整', fs.existsSync(path.join(installDir, 'v2.0.0', 'bin', 'dsh-supervisor')) && fs.existsSync(path.join(installDir, 'v2.0.0', 'src', 'supervisor.js')), '');
  check('U5 旧版本保留（回滚可用）', fs.existsSync(path.join(installDir, 'v1.0.0')), '');

  // 3. 同版本 → 跳过
  const r2 = await apply({ manifestUrl, installDir });
  check('U6 同版本 upToDate 跳过', r2.ok === true && r2.upToDate === true, JSON.stringify(r2));

  // 4. 篡改 sha256（目标 v3.0.0 但校验值错误）→ 拒绝且 current 不动
  serve.manifest = { version: 'v3.0.0', url: blobUrl, sha256: 'f'.repeat(64) };
  serve.blob = tar3;
  const r3 = await apply({ manifestUrl, installDir }).catch((e) => ({ ok: false, error: e.message }));
  check('U7 篡改 sha256 被拒绝', r3.ok !== true && /校验失败/.test(r3.error || ''), JSON.stringify(r3));
  check('U8 拒绝后 current 仍为 v2.0.0', versionOf(currentDir(installDir)) === '2.0.0', versionOf(currentDir(installDir)));
  check('U9 拒绝后无残留下载临时文件', !fs.readdirSync(installDir).some((e) => e.startsWith('.dl-')), '');

  // 5. 剪枝：4 个旧版本 → 更新到 v3.0.0 → 只保留 keepOld+1
  serve.manifest = { version: 'v3.0.0', url: blobUrl, sha256: sha256(tar3) };
  const install2 = seedInstall('install-prune', ['0.1.0', '0.2.0', '0.3.0', '1.0.0']);
  const r4 = await apply({ manifestUrl, installDir: install2, keepOld: 2 });
  const kept = fs.readdirSync(install2).filter((e) => e.startsWith('v')).sort();
  check('U10 剪枝后保留 v3.0.0(current)+最近 keepOld+1', r4.ok === true && kept.length === 3 && kept.includes('v3.0.0'), JSON.stringify(kept));
  check('U11 剪枝后 current=3.0.0', versionOf(currentDir(install2)) === '3.0.0', versionOf(currentDir(install2)));

  // ── Supervisor 级集成：自更新状态/应用（清单复位为 v2.0.0）──
  serve.manifest = { version: 'v2.0.0', url: blobUrl, sha256: sha256(tar2) };
  serve.blob = tar2;

  // ── Supervisor 级集成：npm 通道(2026-09 收敛) —— mock registry + 假安装命令 ──
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const supDir = path.join(TMP, 'sup'); fs.mkdirSync(supDir, { recursive: true });
  // 假 npm 安装：写 marker 文件模拟装包成功(不真跑 npm)
  const fakeInstall = path.join(TMP, 'fake-install.js');
  fs.writeFileSync(fakeInstall, "#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(process.argv[3], 'installed');\n");
  fs.chmodSync(fakeInstall, 0o755);
  const supCfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:39232/',
    apiHost: '127.0.0.1', apiPort: 39233,
    stateFile: path.join(supDir, 'state.json'),
    logFile: path.join(supDir, 'events.log'),
    supervisorLogFile: path.join(supDir, 'sup.log'),
    dshLogFile: path.join(supDir, 'dsh.log'),
    upgradeLogFile: path.join(supDir, 'up.log'),
    corePackageName: '@dsh-sup/dsh-core-{os}-{arch}',
    registries: ['http://127.0.0.1:39230'],
    // 假安装命令模板: node <fake> <version> <marker> —— 模拟 npm i -g 成功
    installCommandTemplate: ['node', fakeInstall, '{version}', path.join(supDir, 'installed.marker')],
  };
  const supInst = new Supervisor(supCfg);
  const s1 = await supInst.guardSelfUpdateStatus();
  check('S1 状态：仓库版 vs npm latest v2.0.0 → 可更新', s1.ok === true && s1.updateAvailable === true && s1.latest === '2.0.0', JSON.stringify(s1));
  const a1 = await supInst.guardSelfUpdateApply();
  check('S2 应用更新 v2.0.0（restartRequired）', a1.ok === true && a1.version === '2.0.0' && a1.restartRequired === true, JSON.stringify(a1));
  const s2 = await supInst.guardSelfUpdateStatus();
  check('S3 更新后再查：仍报可更新（npm 装新二进制后需重启生效，restartRequired 已置）', s2.ok === true && s2.updateAvailable === true, JSON.stringify(s2));
  const supNoCfg = new Supervisor(Object.assign({}, supCfg, { corePackageName: null }));
  const s3 = await supNoCfg.guardSelfUpdateStatus();
  check('S4 未配置源 → 明确错误', s3.ok === false && /未配置/.test(s3.error || ''), JSON.stringify(s3));

  // DSH 即安即用：本体安装状态判定（命令指向 bin 可执行性）
  const d1 = supInst.dshenvStatus();
  check('S5 dshenv：命令 bin 缺失 → binOk=false', d1.binOk === false && d1.installed === null, JSON.stringify(d1));
  const mockBin = path.join(ROOT, 'test', 'mock-target.js');
  const supHave = new Supervisor(Object.assign({}, supCfg, {
    command: ['node', mockBin, '39234'],
    healthUrl: 'http://127.0.0.1:39234/',
    apiPort: 39235,
  }));
  const d2 = supHave.dshenvStatus();
  check('S6 dshenv：命令 bin 存在 → binOk=true', d2.binOk === true && d2.bin === mockBin, JSON.stringify(d2));
  const d3 = supHave.dshenvStatus();
  check('S7 dshenv：main 实例已纳管判定', typeof d3.managed === 'boolean', String(d3.managed));

  // 自更新「重启生效」衔接（A2）：SEA 形态自动允许自重启；本机无 systemd unit → 明确指引手动重启
  const rr = supInst.guardSelfUpdateRestart();
  check('S8 restart-guard 无 systemd 单元 → 明确指引', rr.ok === false && /systemd/.test(rr.error || ''), JSON.stringify(rr));

  // EnvCatalog 声明式视图（envStatus.catalog + summary.ready 语义）
  const e4 = supHave.envStatus();
  check('S9 envStatus.catalog 含 node/npm/dsh/selfUpdate 条目', e4.catalog && e4.catalog.items && e4.catalog.items.node && e4.catalog.items.dsh && e4.catalog.items.selfUpdate, JSON.stringify(e4.catalog && Object.keys((e4.catalog.items) || {})));
  check('S10 catalog.ready 语义（必填项 ok/configured 判定）', typeof e4.catalog.ready === 'boolean', String(e4.catalog && e4.catalog.ready));

  server.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
