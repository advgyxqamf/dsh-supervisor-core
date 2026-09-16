#!/usr/bin/env node
'use strict';

// 跨平台规范回归（能力矩阵见 PLATFORM-CAPABILITY-MATRIX.md）：
//   P0 可执行解析：Windows 扩展名/PATHEXT、标准目录跨平台差异、PATH 连接符
//   P1 文件保护：Unix chmod / Windows icacls（平台条件断言）
//   P2 无硬编码 ':' 连接 PATH
// 自包含，不触碰生产文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xplat-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(function () {
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect'));

  // ── P0 可执行解析 ──
  console.log('== P0 跨平台可执行解析 ==');
  const unixNames = ep.candidateNames('dsh-supervisor', 'linux');
  check('unix 候选名无扩展名', unixNames.length === 1 && unixNames[0] === 'dsh-supervisor', JSON.stringify(unixNames));
  const winNames = ep.candidateNames('dsh-supervisor', 'win32');
  check('win 首选 .exe', winNames[0] === 'dsh-supervisor.exe', JSON.stringify(winNames));
  check('win 含 .cmd 垫片', winNames.includes('dsh-supervisor.cmd'), JSON.stringify(winNames));
  check('win 无扩展名兜底在末位', winNames[winNames.length - 1] === 'dsh-supervisor', JSON.stringify(winNames));

  const dl = ep.standardDirs('linux', '/h');
  check('linux 标准目录含 .local/bin 与 .npm-global/bin', dl.includes(path.join('/h', '.local', 'bin')) && dl.includes(path.join('/h', '.npm-global', 'bin')), JSON.stringify(dl));
  const dm = ep.standardDirs('darwin', '/h');
  check('darwin 追加 Homebrew 路径', dm.includes('/opt/homebrew/bin') && dm.includes('/usr/local/bin'), JSON.stringify(dm));
  const dw = ep.standardDirs('win32', 'C:/U/X');
  // ⚠ 旧写法 replace(/\\\\/g, '/') 匹配的是**两个**反斜杠，而 Windows 路径是单个反斜杠，
  //   于是 replace 不生效 → 该断言在 Windows CI 上恒失败（Linux 因 standardDirs 返回正斜杠而侥幸通过）。
  //   改为归一化「任意连续的分隔符」，与平台无关。
  const norm = (d) => d.replace(/[\\/]+/g, '/');
  check('win 含 .local/bin 兼容目录', dw.some((d) => norm(d).endsWith('/.local/bin')), JSON.stringify(dw));

  // 真实解析：当前平台的 node 应可解析到
  const nodeHit = ep.resolveExecutable(process.platform === 'win32' ? 'node' : 'node');
  check('resolveExecutable(node) 命中真实文件', !!nodeHit && fs.statSync(nodeHit).isFile(), String(nodeHit));
  check('resolveExecutable(不存在) 返回 null', ep.resolveExecutable('dsh-nonexistent-xyz-123') === null, '');

  // daemonCommand/guiCommand 必须返回绝对路径（不再硬拼无扩展名的猜测）
  const autostart = require(path.join(ROOT, 'src', 'platform', 'os', 'autostart'));
  const dc = autostart.daemonCommand();
  check('daemonCommand 返回绝对路径', path.isAbsolute(dc), dc);
  if (process.platform === 'win32') check('win daemonCommand 含扩展名', /\.(exe|cmd|bat)$/i.test(dc), dc);
  const gc = autostart.guiCommand();
  check('guiCommand 返回绝对路径', path.isAbsolute(gc), gc);

  // ── P1 文件保护 ──
  console.log('== P1 跨平台文件保护 ==');
  const dir = path.join(TMP, 'priv');
  const pr = fp.ensurePrivateDir(dir);
  check('ensurePrivateDir 成功', pr.ok === true, JSON.stringify(pr));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(dir).mode & 0o777;
    check('unix 目录权限 0700', mode === 0o700, mode.toString(8));
    const f = path.join(dir, 'secret.json');
    const fr = fp.writePrivate(f, '{"token":"x"}');
    check('writePrivate 成功', fr.ok === true, JSON.stringify(fr));
    check('unix 文件权限 0600', (fs.statSync(f).mode & 0o777) === 0o600, (fs.statSync(f).mode & 0o777).toString(8));
    check('writePrivate 内容正确', JSON.parse(fs.readFileSync(f, 'utf8')).token === 'x', '');
    check('writePrivate 无残留 tmp', !fs.readdirSync(dir).some((n) => n.includes('.tmp')), JSON.stringify(fs.readdirSync(dir)));
  } else {
    check('win 保护走 icacls 或明确降级', pr.mode === 'icacls-dir' || pr.mode === 'none', JSON.stringify(pr));
  }
  check('protectFile 对不存在文件返回失败而非抛出', (() => { try { const r = fp.protectFile(path.join(TMP, 'nope')); return r.ok === false; } catch { return false; } })(), '');

  // ── P2 无硬编码 PATH 连接符 ──
  console.log('== P2 PATH 连接符 ==');
  // ⚠ 2026-09-16 步骤8a：instance 拆为 index/core/ops/upgrade 四文件，
  //   判据须读**整域**（否则文件拆分即静默失去覆盖面）。见 DIRECTORY-STRUCTURE-DESIGN §4.5。
  // ⚠ instance 域已拆为 8 文件；按目录聚合读取，新增/改名文件自动纳入覆盖面（不再硬编码文件名）。
  const instSrc = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
    .join(String.fromCharCode(10));
  check("instance 无 join(':') 拼 PATH", !/process\.env\.PATH[^\n]*\.join\(':'\)/.test(instSrc), '');
  check('instance 使用 path.delimiter', instSrc.includes('path.delimiter'), '');

  // ── P1-2 bin 安装跨平台 ──
  console.log('== P1-2 bin 安装 ==');
  const binSrc = fs.readFileSync(path.join(ROOT, 'bin', 'dsh-supervisor'), 'utf8');
  check('bin 安装有 Windows 分支（.cmd 垫片）', /IS_WINDOWS/.test(binSrc) && binSrc.includes('.cmd'), '');
  check('bin 无裸 symlinkSync（受平台分支保护）', /if \(IS_WINDOWS\)/.test(binSrc), '');

  // ── §7.1 分层不变量：平台命令不得出现在域层/编排层 ──
  console.log('== 分层不变量（平台命令收敛）==');
  {
    const forbidden = ['systemctl', 'systemd-run', 'launchctl', 'schtasks', 'taskkill', 'netstat', 'lsof', 'wmic', 'osascript', 'notify-send', 'xdg-open'];
    // ⚠ 2026-09-16 步骤6：guard/ → app/（编排层重组，DIRECTORY-STRUCTURE-DESIGN §2.1）。
    //   平台命令收敛扫描须覆盖编排层新目录名，否则判据静默失去覆盖面。
    const scanDirs = ['domains', 'app', 'api'];
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const cmd of forbidden) {
          // 匹配 execFileSync('cmd' / execFile('cmd' / spawn('cmd' —— 仅实际调用（排除注释里的出现）
          const re = new RegExp("(execFileSync|execFile|spawnSync|spawn)\\(\\s*['\"]" + cmd + "['\"]");
          if (re.test(src)) offenders.push(path.relative(ROOT, p) + ' → ' + cmd);
        }
      }
    };
    for (const d of scanDirs) walk(path.join(ROOT, 'src', d));
    check('域层/guard/api 无裸平台命令调用', offenders.length === 0, offenders.join('; ') || 'clean');
    // supervisor.js（编排层）同样不得裸调
    const supSrc = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
    const supBad = forbidden.filter((cmd) => new RegExp("(execFileSync|execFile|spawn)\\(\\s*['\"]" + cmd + "['\"]").test(supSrc));
    check('supervisor（编排层）无裸平台命令调用', supBad.length === 0, supBad.join(', ') || 'clean');
  }

  // ── §7.1 服务管理器 Provider ──
  console.log('== 服务管理器 Provider ==');
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service'));
  const cur = svc.current();
  const expectedKind = process.platform === 'linux' ? 'systemd' : process.platform === 'darwin' ? 'launchd' : process.platform === 'win32' ? 'windows-service' : 'none';
  check('provider kind 匹配平台', cur.kind === expectedKind, cur.kind + ' vs ' + expectedKind);
  const iface = ['daemonReload', 'stopUnit', 'resetFailed', 'isUnitActive', 'transientUnitFile', 'cleanTransient', 'startTransient'];
  check('provider 接口完整', iface.every((m) => typeof cur[m] === 'function'), iface.filter((m) => typeof cur[m] !== 'function').join(',') || 'ok');
  check('provider 声明能力', typeof cur.supportsUnits === 'boolean' && typeof cur.supportsTransient === 'boolean', '');
  if (process.platform !== 'linux') {
    check('非 Linux startTransient 抛 CapabilityError', (() => { try { cur.startTransient({ unit: 'x', cmd: ['node'] }); return false; } catch (e) { return e.name === 'CapabilityError' || e.code === 'CAPABILITY_UNSUPPORTED'; } })(), '');
  } else {
    check('Linux startTransient 可用', cur.supportsTransient === true, '');
  }

  // ── 状态暴露 ──
  console.log('== 保护状态可观测 ==');
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const s = new Supervisor({
    command: ['node', '-e', '0'], healthUrl: 'http://127.0.0.1:28031/', probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28030,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'e.log'),
    supervisorLogFile: path.join(TMP, 's.log'), dshLogFile: path.join(TMP, 'd.log'), upgradeLogFile: path.join(TMP, 'u.log'),
  });
  check('statusSummary 暴露 dataDirProtected', s.statusSummary().dataDirProtected === true, String(s.statusSummary().dataDirProtected));

  // ── A1 断点修复：能力矩阵接线（后端暴露 → 前端类型 → UI 呈现）──
  console.log('== A1 能力矩阵接线 ==');
  {
    const env = s.envStatus();
    check('A1-a envStatus 暴露 capabilities', env.capabilities && typeof env.capabilities === 'object', JSON.stringify(env.capabilities));
    const c = env.capabilities || {};
    check('A1-b capabilities 含平台/能力字段',
      typeof c.platform === 'string' && typeof c.multiInstance === 'boolean' && typeof c.pidAdoption === 'boolean' && typeof c.hostService === 'string',
      JSON.stringify(c));
    check('A1-c capabilities 与 capabilityProfile 一致', c.hostService === require(path.join(ROOT, 'src', 'platform', 'os', 'index')).capabilityProfile().hostService, String(c.hostService));
    // 前端类型 + UI 消费（静态契约）
    const typesTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
    check('A1-d 前端声明 PlatformCapabilities 且 EnvStatus 引用', /interface PlatformCapabilities/.test(typesTs) && /capabilities\?:\s*PlatformCapabilities/.test(typesTs), 'ok');
    const instTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'InstancesPage.tsx'), 'utf8');
    check('A1-e UI 消费 capabilities 并前置提示', instTsx.includes('envStatus()') && instTsx.includes('multiInstance') && instTsx.includes('sandboxUnsupported'), 'ok');
    // 误导性错误指引已修正：不再指向不存在的裸字段路径
    // ⚠ 2026-09-16 步骤8a：instance 拆为 index/core/ops/upgrade 四文件，
  //   判据须读**整域**（否则文件拆分即静默失去覆盖面）。见 DIRECTORY-STRUCTURE-DESIGN §4.5。
  // ⚠ instance 域已拆为 8 文件；按目录聚合读取，新增/改名文件自动纳入覆盖面（不再硬编码文件名）。
  const instSrc = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
    .join(String.fromCharCode(10));
    check('A1-f 沙箱错误指引指向真实端点/字段',
      instSrc.includes('GET /env/status') && instSrc.includes('capabilities.multiInstance'),
      'ok');
  }

  // ── A4 断点修复：changelog 入口 ──
  console.log('== A4 changelog 接线 ==');
  {
    const clientTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    check('A4-a client 有 dshChangelog / guardChangelog', /dshChangelog:\s*\(\)\s*=>\s*getText\("\/changelog"\)/.test(clientTs) && /guardChangelog/.test(clientTs), 'ok');
    check('A4-b client 实现 getText（text/plain 端点）', /async function getText/.test(clientTs), 'ok');
    const aboutTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'AboutCard.tsx'), 'utf8');
    check('A4-c AboutCard 提供更新日志入口', aboutTsx.includes('dshChangelog') && aboutTsx.includes('guardChangelog') && aboutTsx.includes('Dialog'), 'ok');
    // 命名统一：后端话术指向「概览 · 版本与升级」
    const guardApi = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'guard.js'), 'utf8');
    check('A4-d 后端话术命名与 UI 位置统一', guardApi.includes('概览 · 版本与升级'), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
