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

// ── J-a：deploy launcher 形态识别 ──
{
  const dep = require(path.join(ROOT, 'src', 'platform', 'deploy.js'));
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
  const srcTxt = read('src/platform/deploy.js');
  check('J-a 头部注释已校正（不再称 SEA 为标准形态）',
    /弃 SEA|不再是 SEA/.test(srcTxt), '已校正');
}

// ── J-b：DaemonLifecycle 标记派生 ──
{
  const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'guard', 'proc', 'daemon-lifecycle.js'));
  const script = path.join(ROOT, 'src', 'domains', 'router', 'daemon.js');
  const lc = new DaemonLifecycle({
    name: 'router', script, args: ['-c', '/x/cfg.json'], ctlPort: 43107,
    cmdMark: 'router-daemon', identityFile: path.join(os.tmpdir(), 'j-b.json'),
  });
  check('J-b 标记含语义名', lc._cmdMarks.includes('router-daemon'), JSON.stringify(lc._cmdMarks));
  check('J-b 标记含 script 绝对路径', lc._cmdMarks.some((m) => m.endsWith('/src/domains/router/daemon.js')), '有');
  // 行为级：真实 spawn 产生的 cmdline 必须被匹配
  const realCmd = process.execPath + ' ' + script + ' -c /x/cfg.json';
  check('J-b 真实 cmdline 能被匹配（旧实现 indexOf=-1）',
    lc._cmdMarks.some((m) => m && realCmd.indexOf(m) >= 0), '匹配');
  // 反向：确认旧写法（只用 this.cmdMark）已不在匹配点
  const dlSrc = read('src/guard/proc/daemon-lifecycle.js');
  check('J-b _ctlOwnerPid 用 _cmdMarks 匹配', /_cmdMarks\.some/.test(dlSrc), '已改');
}

// ── J-c：semverCompare 规范符合性 ──
{
  const { semverCompare } = require(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'));
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
  const dsrc = read('src/domains/dist/index.js');
  check('J-c 不再用 split(\'-\') 解构 core/pre',
    !/const \[core, pre\] = clean\.split\('-'\)/.test(dsrc), '已改');
}

// ── J-d：self-update 版本排序用 semver ──
{
  const su = read('src/domains/dist/self-update.js');
  check('J-d prune 用 semverCompare 排序', /sort\(\(a, b\) => semverCompare\(a\.v, b\.v\)\)/.test(su), '已改');
  check('J-d currentDir 用 semverCompare 比较', /semverCompare\(v, best\[0\]\)/.test(su), '已改');
  check('J-d 不再用字符串比较版本', !/\.sort\(\(a, b\) => \(a\.v < b\.v/.test(su), '已改');
  // 行为级：prune 的排序语义（用真实 semverCompare 复现排序结果）
  const { semverCompare } = require(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'));
  const dirs = ['v0.7.0', 'v0.8.0', 'v0.9.0', 'v0.10.0'].map((v) => ({ v })).sort((a, b) => semverCompare(a.v, b.v));
  check('J-d 行为：v0.10.0 排在最后（不再被 prune 优先删除）',
    dirs[dirs.length - 1].v === 'v0.10.0', JSON.stringify(dirs.map((d) => d.v)));
}

// ── J-e：daemon _spawn 的缺陷防护 ──
{
  const dl = read('src/guard/proc/daemon-lifecycle.js');
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
  const sh = read('src/domains/shell/index.js');
  check("J-e shell.restartShell 也监听 'error'", /child\.on\('error'/.test(sh), '有');
  check('J-e shell.restartShell 校验 child.pid', /if \(!child\.pid\)/.test(sh), '有');
}

// ── J-f：detect() 的消费方必须接受 launcher 形态（P0-A 配套）──
//   若只看 form==='sea-binary'，则真实 launcher 用户读不到磁盘版本、
//   updatePending 恒 false、面板永不提示「已装好待重启」。
{
  const sv = read('src/guard/supervisor/settings-view.js');
  check('J-f _readBinarySelfVersion 用 updatable 而非 form 硬判',
    /if \(!dep\.updatable \|\| !dep\.runningTarget\) return null;/.test(sv), '已改');
  check('J-f status 的磁盘版本读取用 updatable 判定',
    /if \(dep\.updatable\) diskVersion = this\._readBinarySelfVersion\(\);/.test(sv), '已改');
  // 反向：剥离注释后不得再有 `form === 'sea-binary'` 的**代码**判定
  const codeOnly = sv.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  check("J-f 无残留的 form === 'sea-binary' 硬判（会漏掉 launcher）",
    !/dep\.form === 'sea-binary'/.test(codeOnly), '已清理');
}

// ── J-g：插件域的两个 P1 ──
{
  const pm = read('src/domains/plugin/pluginmarket.js');
  const pg = read('src/domains/plugin/plugins.js');
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

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);