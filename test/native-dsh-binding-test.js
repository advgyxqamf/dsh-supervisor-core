#!/usr/bin/env node
'use strict';

// 原生 DSH「检测 → 绑定 → 接管」契约回归（2026-09-16 架构修正）。
//
// 缺陷（真机）：原生 DSH 只被静态 config.command[1]（出厂默认裸名 'dsh'）定义 →
//   fs.existsSync('dsh') 恒 false → 「已安装」判不出来，与「安装」分支形成**两套相反逻辑**
//   （系统已装 DSH 却报未安装 → 面板去装第二个 DSH 顶替原生的那个）。
// 本测试用**假 npm 前缀**驱动真实解析：检测得到真实入口、版本可读、未装如实为 false。
// 自包含，不触碰生产文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bind-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const EMPTY_HOME = path.join(TMP, 'emptyhome');
fs.mkdirSync(EMPTY_HOME, { recursive: true });
const EMPTY_PREFIX = path.join(TMP, 'empty-prefix');
fs.mkdirSync(EMPTY_PREFIX, { recursive: true });

function fakePkg(prefix, version) {
  const js = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return js;
}
const PREFIX = path.join(TMP, 'npm');
const JS = fakePkg(PREFIX, '9.9.9');

const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'Path', 'APPDATA', 'LOCALAPPDATA', 'DSH_BIN'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
/** 隔离所有「可能命中真实 dsh」的环境来源，使负例确定。 */
function isolate() {
  process.env.HOME = EMPTY_HOME; process.env.USERPROFILE = EMPTY_HOME;
  process.env.PATH = ''; process.env.Path = '';
  process.env.APPDATA = path.join(EMPTY_HOME, 'appdata');
  process.env.LOCALAPPDATA = path.join(EMPTY_HOME, 'localappdata');
  delete process.env.DSH_BIN;
}
function restore() {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}

const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
const { NativeManager } = require(path.join(ROOT, 'src', 'app', 'native', 'installer'));
// macOS 下 /tmp、/var 是符号链接（realpath 得到 /private/...）——比较前统一规范化，跨平台稳定。
const canon = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const mkNM = (command, npmRoot) => new NativeManager({
  config: { command, packageName: '@deepseek-ai/dsh' },
  npmRoot,
  stateDir: TMP,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

isolate();

// 1) resolveDsh：DSH_BIN 显式覆盖（最高优先级）
process.env.DSH_BIN = JS;
const d1 = ep.resolveDsh({});
check('resolveDsh(DSH_BIN) 返回真实 JS 入口', d1 && d1.isJs === true && canon(d1.bin) === canon(JS), d1 && d1.bin);

// 2) resolveDsh：npmRoot 分支（PATH 无 dsh、home 为空）
delete process.env.DSH_BIN;
const d2 = ep.resolveDsh({ npmRoot: PREFIX });
check('resolveDsh(npmRoot) 命中包内 lib/bin.js', d2 && canon(d2.bin) === canon(JS), d2 && d2.bin);

// 3) NativeManager：已绑定绝对入口 → 已安装 + 版本可读
const bound = mkNM(['node', JS, 'web'], PREFIX);
check('已绑定入口 → installed=true', bound.status().installed === true, bound.binPath());
check('已绑定入口 → 读到真实版本', bound.installedVersion() === '9.9.9', String(bound.installedVersion()));

// 4) NativeManager：裸名 + 无任何可解析安装 → 如实未安装（不再伪造）
const bare = mkNM(['node', 'dsh', 'web'], EMPTY_PREFIX);
check('裸名且无可解析安装 → installed=false（如实）', bare.status().installed === false, String(bare.binPath()));

// 5) 反向可判别：同一 config，注入真实安装后即判为已安装（检测驱动，非静态写死）
process.env.DSH_BIN = JS;
const adopted = mkNM(['node', 'dsh', 'web'], EMPTY_PREFIX);
check('检测到真实安装 → installed=true（检测驱动）', adopted.status().installed === true, adopted.binPath());

// 6) 结构不变量：绑定先于消费者；exec-path 导出解析器
//
// ⚠ 步骤 7 回归收敛（2026-09-16）：机械下沉把本段断言的三处路径全部改址，旧路径已不存在 ——
//   ① _bindNativeDshCommand 从 src/supervisor.js 下沉到 src/app/assembly/bootstrap.js；
//   ② 「绑定 → 消费者」的调用序从 supervisor.js 迁到 src/app/assembly/compose.js
//      （构造期唯一 DI 点：先 host._bindNativeDshCommand() 再 new InstanceManager(...)）；
//   ③ 插件 CLI 的 runtime 承载从 src/domains/plugin/plugins.js 迁到 plugins 拆分后的 ops.js。
//   为什么不能继续断言 supervisor.js：它是薄壳（DS-G7 ≤200 行），只保留组装与启动，
//   若仍按旧路径取文件将 ENOENT 崩溃（或恒 false）——断言的是「实现所在文件」而非契约本身。
//   故改为断言**契约的不变量**：绑定方法存在、且调用序先于消费者（跨文件，仍可机器校验）。
//   本测试不 spawn 任何子进程、不创建锁文件（纯 require + 读文件），隔离无风险。
const sup = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'bootstrap.js'), 'utf8');
// R3 严值 DF-2：compose.js 拆为 compose/{core,domains,observers}.js；绑定→消费者的调用序在 domains 步。
const compose = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'compose', 'domains.js'), 'utf8');
check('bootstrap 定义 _bindNativeDshCommand', /_bindNativeDshCommand\(/.test(boot), 'ok');
// 装配序不变量锁定在 compose.js：绑定调用必须早于 InstanceManager 构造（消费者）。
// 注意：组装点是自由函数，用 host 而非 this 调用 —— 断言需匹配 `host._bindNativeDshCommand()`。
const bindIdx = compose.indexOf('host._bindNativeDshCommand();');
const instIdx = compose.indexOf('new InstanceManager(');
check('检测→绑定先于 InstanceManager（消费者）', bindIdx > 0 && instIdx > 0 && bindIdx < instIdx, bindIdx + ' < ' + instIdx);
// 插件 CLI 的 JS 入口承载：plugins.js 已拆为 index/ops/jobs/store（步骤8a），
// 域改造后 runtime 目标解析落在 targets.js（SSOT §5.4）——按整域聚合读取，
// 避免文件一搬该断言静默失去覆盖面。
const plugDir = path.join(ROOT, 'src', 'domains', 'plugin');
const plug = fs.readdirSync(plugDir).filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(plugDir, f), 'utf8')).join('\n');
check('插件 CLI 经 runtime 承载 JS 入口（跨平台）', /target\.runtime/.test(plug), 'ok');
// 薄壳不变量：supervisor.js 不得再持有绑定实现（防止实现回流 root 破坏分层）。
check('supervisor.js 不再持有 _bindNativeDshCommand 实现', !/_bindNativeDshCommand\(\)\s*\{/.test(sup), 'ok');
check('exec-path 导出 resolveDsh/dshJsIn', typeof ep.resolveDsh === 'function' && typeof ep.dshJsIn === 'function', 'ok');

// 7) 契约读回：npmArgs 透传（壳可只提供包内 JS；内核消费者必须带上 args）
const rc = require(path.join(ROOT, 'src', 'platform', 'contract', 'runtime'));
const rcFile = rc.file();
fs.mkdirSync(path.dirname(rcFile), { recursive: true });
fs.writeFileSync(rcFile, JSON.stringify({ schema: 2, nodePath: '/usr/bin/node', nodeBinDir: '/usr/bin', npmPath: '/usr/bin/node', npmArgs: ['/x/npm-cli.js'] }));
const rcGot = rc.read();
check('runtime-contract 透出 npmArgs（包内 JS 场景）',
  rcGot && rcGot.npmPath === '/usr/bin/node' && Array.isArray(rcGot.npmArgs) && rcGot.npmArgs[0] === '/x/npm-cli.js',
  JSON.stringify(rcGot && rcGot.npmArgs));
try { fs.rmSync(path.dirname(rcFile), { recursive: true, force: true }); } catch {}

restore();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);