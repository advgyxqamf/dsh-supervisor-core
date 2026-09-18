#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第八轮修复的回归（进程/部署/版本比较/壳拉起，2026-09-12）
//
// ## 缺陷
//
// P0-A `deploy.detect()` 只认「二进制 magic 头」，而发布形态**早已弃 SEA**
//   （build-launcher.sh:2 明写）→ 真实用户落 `source-shell` → 自更新永久不可用。
//
// P0-B `DaemonLifecycle.cmdMark` 传的是 `'router-daemon'`，而真实 cmdline 是
//   `node <pkg>/src/domains/router/daemon.js -c …` —— 子串**不匹配**（实测 -1）
//   → ctl 属主反查恒 null → 换代逻辑与「异主不接管」全线死代码。
//
// P1-C `semverCompare` 用 `split('-')` 只取前两段 → `1.0.0-beta-2` 的 `-2` 被丢弃
//   → 与 `1.0.0-beta-1` 判等（实测均为 0）。
//
// P1-D `self-update` 的 `prune`/`currentDir` 用**字符串**比较版本 →
//   `v0.10.0` 被排在 `v0.9.0` 之前 → prune 从下标 0 删，**删掉刚装的当前版本**。
//
// P1-E `_spawn()` 不接 `'error'`、不看 `child.pid` 就写身份 → ENOENT 时
//   异常逃逸（守卫自杀）+ 身份写成 undefined（每轮重复 spawn）。
//
// ## 锁定不变量
//   J-a  deploy.detect() 能识别 **launcher 形态**（同目录/上级有 core.cjs）
//   J-b  DaemonLifecycle 的标记**包含从 script 派生的路径**，且能匹配真实 cmdline
//   J-c  semverCompare 保留连字符后的完整 prerelease，且符合 semver 规范
//   J-d  self-update 的版本排序用 semverCompare（非字符串）
//   J-e  _spawn 接 'error'；无 pid 时不写身份并返回 failed
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// ⚠ 2026-09-16 步骤8a（DIRECTORY-STRUCTURE-DESIGN §4.5）：shell/plugin 两域已拆为
//   index/journal/restart 与 index/ops/store/market。本套源码级断言的**对象是「域」**
//   （restartShell 的 'error' 监听、插件 CLI 的 detached 杀树、市场重定向协议），
//   与文件切分无关 —— 故按域聚合读取，避免把判据搬走而静默失去覆盖面。
const readDomain = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => read(dir + '/' + f)).join(String.fromCharCode(10));

// ── J-a：deploy launcher 形态识别 ──
{
  const dep = require(path.join(ROOT, 'src', 'platform', 'contract', 'deploy.js'));
  check('J-a 导出 isLauncherForm', typeof dep.isLauncherForm === 'function', typeof dep.isLauncherForm);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depj-'));
  // ① 发布布局：<pkg>/bin/dsh-supervisor + <pkg>/core.cjs
  const pkg = path.join(tmp, 'pkg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  const tgt = path.join(pkg, 'bin', 'dsh-supervisor');
  fs.writeFileSync(tgt, '#!/usr/bin/env node\n');
  // ⚠ 顺序：先断言「无 core.cjs 时不识别」，再放 core.cjs 断言「识别」。
  //   （我第一版把断言写在创建 core.cjs 之前，却期望 true —— 自造的假失败。）
  check('J-a 尚未放 core.cjs → 不识别', dep.isLauncherForm(tgt) === false, 'false');
  fs.writeFileSync(path.join(pkg, 'core.cjs'), '//b');
  check('J-a 放上 core.cjs（发布布局）→ 识别为 launcher', dep.isLauncherForm(tgt) === true, 'true');
  // ② 源码布局：无 core.cjs
  const src = path.join(tmp, 'repo', 'bin');
  fs.mkdirSync(src, { recursive: true });
  const t2 = path.join(src, 'dsh-supervisor');
  fs.writeFileSync(t2, '#!/usr/bin/env node\n');
  check('J-a 源码布局（无 core.cjs）→ 不误判', dep.isLauncherForm(t2) === false, 'false');
  fs.rmSync(tmp, { recursive: true, force: true });
  // 反向：注释不得再声称产品形态是 SEA
  const srcTxt = read('src/platform/contract/deploy.js');
  check('J-a 头部注释已校正（不再称 SEA 为标准形态）',
    /弃 SEA|不再是 SEA/.test(srcTxt), '已校正');
}

// ── J-b：DaemonLifecycle 标记派生 ──
{
  const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'app', 'daemons', 'process.js'));
  const script = path.join(ROOT, 'src', 'domains', 'router', 'daemon.js');
  const lc = new DaemonLifecycle({
    name: 'router', script, args: ['-c', '/x/cfg.json'], ctlPort: 43107,
    cmdMark: 'router-daemon', identityFile: path.join(os.tmpdir(), 'j-b.json'),
  });
  check('J-b 标记含语义名', lc._cmdMarks.includes('router-daemon'), JSON.stringify(lc._cmdMarks));
  // ⚠ 2026-09-13 更正：标记**本来就统一为 "/"**（构造器用 norm() 归一化），
  //   故此处**正斜杠字面量是正确的**（我先前误改成 path.join，反而弄坏了它 —— 已回退）。
  check('J-b 标记含 script 绝对路径',
    lc._cmdMarks.some((m) => m.endsWith('/src/domains/router/daemon.js')), '有');
  // 行为级：真实 spawn 产生的 cmdline 必须被匹配。
  //   此处用**原生** cmdline（不手工归一化）—— 因为产品必须自己归一化：
  //   实测 Windows 上原生 cmdline 是反斜杠，而标记是正斜杠 → 曾是**真实产品缺陷**
  //   （daemon-lifecycle._ctlOwnerPid 在 Windows 永远认不出自己的 daemon）。
  //   修法见 src/platform/os/pidlookup.js 的 normCmdline + 三处调用点。
  //   下面这行因此同时是「测试」与「产品不变量」的检验。
  const realCmd = process.execPath + ' ' + script + ' -c /x/cfg.json';
  const norm = (x) => String(x).replace(/\\/g, '/');
  check('J-b 真实 cmdline 能被匹配（旧实现 indexOf=-1）',
    lc._cmdMarks.some((m) => m && norm(realCmd).indexOf(m) >= 0),
    'realCmd=' + realCmd.slice(0, 70));
  // 反向：确认旧写法（只用 this.cmdMark）已不在匹配点
  const dlSrc = read('src/app/daemons/process.js');
  check('J-b _ctlOwnerPid 用 _cmdMarks 匹配', /_cmdMarks\.some/.test(dlSrc), '已改');

  // -- J-b-2: cmdline 与标记的分隔符归一化（2026-09-13 新增，锁真实产品缺陷）--
  //
  //   缺陷：标记由构造器 norm() 成 "/"，而 readCmdline 返回原生分隔符；
  //     Windows 的 cmdline 是反斜杠 -> 直接 indexOf 永远 -1 ->
  //     认不出自己的 router/lan daemon（可能误判端口异主或重复拉起）。
  //   修法：pidlookup 导出 normCmdline，三处比较点先归一化。
  //   本节在 Linux 上也能拦住该回归（不依赖 Windows runner）。
  // ⚠ 2026-09-17 域结构改造：pidlookup 已拆为 pidlookup/{index,probe,norm}.js —— 按目录聚合读取。
  const pidSrc = readDomain('src/platform/os/pidlookup');
  check('J-b-2 pidlookup 导出 normCmdline',
    /module\.exports\s*=\s*\{[^}]*normCmdline[^}]*\}/.test(pidSrc), '已导出');
  for (const [f, label] of [
    ['src/app/daemons/process.js', 'daemon-lifecycle._ctlOwnerPid'],
    ['src/app/daemons/probe.js', 'supervise-view._routerDaemonActive'],
    // ⚠ 2026-09-16 步骤7：lan daemon 判定（_lanDaemonActive）与 router 判定同归 app/daemons/probe.js
    ['src/app/daemons/probe.js', 'control-view lan daemon 判定'],
  ]) {
    const src = read(f);
    check('J-b-2 ' + label + ' 比较前归一化 cmd',
      /normCmdline\(pidlook\.readCmdline\(pid\)/.test(src), '已归一化');
    const bare = /const cmd = pidlook\.readCmdline\(pid\) \|\| '';/.test(src);
    check('J-b-2 ' + label + ' 未回退为裸 readCmdline', !bare, bare ? '**发现裸用法**' : 'ok');
  }
  {
    const { normCmdline } = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const B = String.fromCharCode(92);
    const winCmd = 'C:' + B + 'a' + B + 'src' + B + 'domains' + B + 'router' + B + 'daemon.js -c x';
    check('J-b-2 Windows 风格 cmdline 归一化后可被标记命中',
      normCmdline(winCmd).indexOf('/src/domains/router/daemon.js') >= 0,
      normCmdline(winCmd).slice(0, 60));
    check('J-b-2 posix 风格 cmdline 归一化后不变',
      normCmdline('/usr/bin/node /x/src/domains/router/daemon.js') === '/usr/bin/node /x/src/domains/router/daemon.js', 'ok');
    check('J-b-2 空值安全', normCmdline(null) === '' && normCmdline(undefined) === '', 'ok');
  }
}

// ── J-c：semverCompare 规范符合性 ──
{
  const { semverCompare } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
  const cases = [
    ['1.0.0-beta-2', '1.0.0-beta-1', '>'],   // 连字符后不再被截断
    ['1.0.0-rc-10', '1.0.0-rc-2', '<'],      // 非纯数字标识符 → 字典序（规范）
    ['1.0.0-rc.10', '1.0.0-rc.2', '>'],      // 点分数字 → 数值
    ['1.0.0', '1.0.0-rc.1', '>'],            // release > prerelease
    ['1.2.3', '1.2.10', '<'],
    ['1.0.0-rc.1+b5', '1.0.0-rc.1', '='],    // build metadata 忽略
  ];
  let bad = 0;
  for (const [a, b, want] of cases) {
    const r = semverCompare(a, b);
    const got = r > 0 ? '>' : r < 0 ? '<' : '=';
    if (got !== want) { bad++; console.log('    ❌ ' + a + ' vs ' + b + ' → ' + got + '（期望 ' + want + '）'); }
  }
  check('J-c semverCompare 全部符合规范（含连字符 prerelease）', bad === 0, bad + ' 处不符');
  // 反向：确认旧的 split('-') 写法已消失
  const dsrc = readDomain('src/platform/distribution');
  check('J-c 不再用 split(\'-\') 解构 core/pre',
    !/const \[core, pre\] = clean\.split\('-'\)/.test(dsrc), '已改');
}

// ── J-e：daemon _spawn 的缺陷防护 ──
{
  const dl = read('src/app/daemons/process.js');
  const m = dl.match(/_spawn\(\) \{[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  check('J-e 定位到 _spawn', !!m, m ? 'ok' : '未找到');
  check("J-e 监听 'error'（不再逃逸为 uncaughtException）", /child\.on\('error'/.test(body), '有');
  check('J-e 无 pid 时不写身份并返回 failed', /if \(!child\.pid\)/.test(body) && /mode: 'failed'/.test(body), '有');
  // ⚠ 必须用**最后**一次 _writeIdentity 出现位置：注释里会提前提到它（我第一版踩了这个）。
  check('J-e 身份写入在 pid 校验之后',
    body.lastIndexOf('_writeIdentity') > body.indexOf('if (!child.pid)'),
    'write@' + body.lastIndexOf('_writeIdentity') + ' check@' + body.indexOf('if (!child.pid)'));
  // 壳拉起的同类缺陷（P0-1 of shell）
  const sh = readDomain('src/domains/shell');
  check("J-e shell.restartShell 也监听 'error'", /child\.on\('error'/.test(sh), '有');
  check('J-e shell.restartShell 校验 child.pid', /if \(!child\.pid\)/.test(sh), '有');
}

// ── J-f：detect() 的消费方必须接受 launcher 形态（P0-A 配套）──
//   若只看 form==='sea-binary'，则真实 launcher 用户读不到磁盘版本、
//   updatePending 恒 false、面板永不提示「已装好待重启」。
{
  // ⚠ 2026-09-16 步骤7：settings-view.js 拆为 6 模块，_readBinarySelfVersion 归 app/settings/versions.js。
  const sv = read('src/app/settings/versions.js');
  check('J-f _readBinarySelfVersion 用 updatable 而非 form 硬判',
    /if \(!dep\.updatable \|\| !dep\.runningTarget\) return null;/.test(sv), '已改');
  check('J-f status 的磁盘版本读取用 updatable 判定',
    /if \(dep\.updatable\) diskVersion = [\w.$]*readBinarySelfVersion\(\);/.test(sv), '已改');
  // 反向：剥离注释后不得再有 `form === 'sea-binary'` 的**代码**判定
  const codeOnly = sv.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  check("J-f 无残留的 form === 'sea-binary' 硬判（会漏掉 launcher）",
    !/dep\.form === 'sea-binary'/.test(codeOnly), '已清理');
}

// ── J-g：插件域的两个 P1 ──
{
  // 域改造后 HTTP 原语（getJson/getText）落在 market-net.js（SSOT §5.4）。
  const pm = read('src/domains/plugin/market-net.js');
  const pg = readDomain('src/domains/plugin');
  // P1-3：重定向目标必须校验协议（file:// 会让 http.get 同步抛 → uncaughtException）
  const guards = (pm.match(/重定向到不支持的协议/g) || []).length;
  check('J-g getJson/getText 均校验重定向协议', guards >= 2, guards + ' 处');
  check('J-g 保留跳数上限（防重定向环）', /redirectsLeft <= 0/.test(pm), '有');
  // P1-6：registry 为 null 时不得写进 env（Node 会把 null 转成 'null'）
  check('J-g 仅在 reg 非空时注入 npm_config_registry',
    /if \(reg\) \{ envBase\.npm_config_registry = reg;/.test(pg), '已改');
  check('J-g 无可用镜像时如实记日志', /无可用的 registry 镜像/.test(pg), '有');
  // 反向：确认旧的「无条件注入」写法已消失（那正是缺陷本体）
  check('J-g 旧的 Object.assign(..., { npm_config_registry: reg }) 已消失',
    !/npm_config_registry: reg, NPM_CONFIG_REGISTRY: reg \}\);/.test(pg), '已改');

  // P1-5：停用插件的 entryId 匹配不得用子串（会误伤 dsh-tool-extra）
  const m = pg.match(/async _patchEntryIdsForPlugin\(target, name\) \{[\s\S]*?\n  \}/);
  const fbody = m ? m[0] : '';
  check('J-g 定位到 _patchEntryIdsForPlugin', !!m, m ? 'ok' : '未找到');
  check('J-g 不再用 moduleName.includes(name) 子串匹配',
    !/\.includes\(name\)/.test(fbody), '已改');
  check('J-g 改为包名边界匹配（相等 / 子路径 / 带版本）',
    /mn === name/.test(fbody) && /mn\.startsWith\(name \+ '\/'\)/.test(fbody) && /mn\.startsWith\(name \+ '@'\)/.test(fbody),
    '有');
  // 行为级：复现边界判定
  {
    const name = '@scope/dsh-tool';
    const hit = (mn) => mn === name || mn.startsWith(name + '/') || mn.startsWith(name + '@');
    check('J-g 行为：dsh-tool-extra **不**被匹配（误伤修复）', hit('@scope/dsh-tool-extra') === false, 'false');
    check('J-g 行为：dsh-tool 自身被匹配', hit('@scope/dsh-tool') === true, 'true');
    check('J-g 行为：子路径被匹配', hit('@scope/dsh-tool/lib/x.js') === true, 'true');
  }
}

// ── J-h：daemon stop 必须如实回报（P2-2）──
//   超时是唯一的失败信号，此前被丢弃：仍 return ok:true 且抹掉身份 →
//   对 SIGTERM 无响应的 daemon 成为「无人知道 pid」的孤儿。
{
  const dl = read('src/app/daemons/process.js');
  const m = dl.match(/async stop\(\) \{[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  check('J-h 定位到 stop', !!m, m ? 'ok' : '未找到');
  // ⚠ 必须断言「`ok:false` 的返回**位于** `!dead` 分支内」——
  //   只做两处字符串存在性检查时，把 `if (!dead)` 改成 `if (false)` 仍会通过（我第一版如此）。
  // ⚠ 必须匹配**独立的 guard 行**（行首 `if (!dead) {`）——
  //   我第一版用 `indexOf('if (!dead)')`，命中的却是上面那行 `if (!dead) this.logger.warn(...)`，
  //   于是把 guard 改成 `if (false)` 仍然通过（假门禁）。
  const iGuardDead = body.search(/^\s*if \(!dead\) \{$/m);
  const iFailRet = body.indexOf('ok: false, stopped');
  const iClearFn = body.lastIndexOf('_clearIdentity()');
  check('J-h 存在独立的 `if (!dead) {` guard 行', iGuardDead >= 0, 'guard@' + iGuardDead);
  check('J-h 进程未死时返回 ok:false（且在 guard 之后）',
    iGuardDead >= 0 && iFailRet > iGuardDead, 'guard@' + iGuardDead + ' ret@' + iFailRet);
  check('J-h 失败分支位于 clearIdentity 之前（结构正确）',
    iFailRet > 0 && iClearFn > iFailRet, 'ret@' + iFailRet + ' clear@' + iClearFn);
  // ⚠ 剥离注释行后定位 —— 说明文字里会提到 `_clearIdentity`（我第一版数错了位置）。
  const codeLines = body.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  const iClear = codeLines.lastIndexOf('_clearIdentity()');
  const iGuard = codeLines.indexOf('if (!dead)');
  check('J-h 进程未死时**不**清身份（保留可寻址性）',
    iClear > iGuard && iGuard >= 0, 'clear@' + iClear + ' guard@' + iGuard);
  check('J-h 失败时记事件供面板可见', /daemon_stop_timeout/.test(body), '有');
  // 配套：调用方必须消费返回值（否则记录又丢了）
  // ⚠ 2026-09-16 步骤7：shutdownAll 已从 supervisor.js 下沉 app/session/shutdown.js
  //   （薄壳后 supervisor.js 不再持有业务方法体）。判据对象随之更新。
  const sup = read('src/app/session/shutdown.js');
  check('J-h shutdownAll 消费 stop() 返回值',
    /r\.ok === false/.test(sup) && /shutdown_daemon_stop_incomplete/.test(sup), '已改');
}

// ── J-i：插件 CLI 超时必须杀**整棵树**（P1-7）──
//   原实现只 child.kill() 直接子进程 → pnpm 的孙进程成孤儿，占 profile/store 锁。
{
  const pg = readDomain('src/domains/plugin');
  // 2026-09-16（SSOT NO-CONSOLE-WINDOW-STANDARD W1）：插件 CLI 的 spawn 已收口到
  //   platform/os/spawn.js 的 piped({detached:true}) —— windowsHide 由封装固定，不再出现在调用点。
  //   本断言的**意图不变**（插件 CLI 必须自成进程组），故改为断言「经统一封装 + 显式 detached:true」。
  check('J-i 插件 CLI spawn 用 detached（自成进程组）',
    /spawn\.piped\(argv0, \[\.\.\.argvPrefix, \.\.\.cliArgs, \.\.\.args\], \{ env, detached: true \}\)/.test(pg),
    '已改');
  check('J-i 超时经 killTree（POSIX 杀进程组 -pid）',
    /process\.kill\(-child\.pid, sig\)/.test(pg), '有');
  check('J-i 保留 SIGTERM → SIGKILL 升级',
    /killTree\('SIGTERM'\)/.test(pg) && /killTree\('SIGKILL'\)/.test(pg), '有');
  // 反向：确认旧的「只 kill 直接子进程」写法已消失
  check('J-i 超时分支不再只用 child.kill（单进程）',
    !/try \{ child\.kill\('SIGTERM'\); \} catch \{\}/.test(pg), '已改');
  // 对照：dist/index.js 的 npm 安装早已用同模式（证明这才是本仓的既有正确做法）
  const dist = readDomain('src/platform/distribution');
  check('对照：dist 的 npm 安装早已用 detached + -pid',
    /detached: o\.detached !== false/.test(dist) && /process\.kill\(-child\.pid, 'SIGKILL'\)/.test(dist), '是');
}

// ── J-j：内核写 registry.json 时必须保留壳的 v2 字段（P2 双写）──
//   该文件所有权在壳（registry-contract.js 声明），壳也会读回（core.rs:150）；
//   内核若整份覆盖，会抹掉 catalog/probe/selected，削弱壳的镜像解析。
{
  const dmSrc = readDomain('src/platform/distribution');
  const m = dmSrc.match(/function saveRegistryConfig\([\s\S]*?\n\}/);
  check('J-j 定位到 saveRegistryConfig', !!m, m ? 'ok' : '未找到');
  check('J-j 写前读回原文档（保留未知字段）', /readFileSync\(f, 'utf8'\)/.test(dmSrc), '有');
  check('J-j 只覆盖内核拥有的三键',
    /doc\.mode = /.test(dmSrc) && /doc\.origins = /.test(dmSrc) && /doc\.manualOrigin = /.test(dmSrc), '有');
  check('J-j 不再整份序列化 registryConfig',
    !/JSON\.stringify\(this\.registryConfig, null, 2\)/.test(dmSrc), '已改');
  // 行为级：壳字段必须存活，内核字段必须更新
  const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
  const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), 'regj-'));
  const rf = path.join(tmpR, 'registry.json');
  fs.writeFileSync(rf, JSON.stringify({
    schema: 2, writtenBy: 'shell', catalog: ['https://a.example/', 'https://b.example/'],
    probe: { kind: 'package-metadata', pathTemplate: 'x', timeoutMs: 6000 },
    selected: { origin: 'https://a.example/', latencyMs: 12, checkedAt: 1 },
    mode: 'auto', origins: ['https://a.example/'], manualOrigin: 'https://a.example/',
  }, null, 2));
  const dm = Object.create(DistributionManager.prototype);
  dm.registryFile = rf;
  dm.logger = { warn() {}, info() {}, debug() {} };
  dm.registryConfig = { mode: 'manual', origins: ['https://c.example/'], manualOrigin: 'https://c.example/' };
  dm._saveRegistryConfig();
  const after = JSON.parse(fs.readFileSync(rf, 'utf8'));
  check('J-j 行为：壳的 v2 字段全部保留',
    after.schema === 2 && after.writtenBy === 'shell' && (after.catalog || []).length === 2 && !!after.probe && !!after.selected,
    JSON.stringify({ schema: after.schema, writtenBy: after.writtenBy, catalog: (after.catalog || []).length, probe: !!after.probe, selected: !!after.selected }));
  check('J-j 行为：内核三键已更新',
    after.mode === 'manual' && after.origins[0] === 'https://c.example/' && after.manualOrigin === 'https://c.example/',
    JSON.stringify({ mode: after.mode, origins: after.origins }));
  fs.rmSync(tmpR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);