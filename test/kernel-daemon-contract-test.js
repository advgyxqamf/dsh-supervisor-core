#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 内核守护进程契约门禁（D-1..D-5；KERNEL-DAEMON-CONTRACT.md）—— 2026-09-15
//
// 锁定内核侧「被壳拉起时必须提供什么」，防止回退成「内核自建服务/双启动器/端口不自报」：
//   D-1  daemon 自足：配置缺失时内嵌默认配置自建（不依赖外置模板）
//   D-2  对外声明实际端口：supervisor-api 写入 ports.json
//   D-3  /healthz 可用（壳的唯一就绪判据）
//   D-4  内核 install **不再**写服务定义/autostart（唯一所有者=壳）— 反向非空转
//   D-5  单实例：guard.lock 占用即退出非零
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const cli = read('bin/dsh-supervisor');

// ── D-1：daemon 自足（内嵌默认配置）──
check('D-1 配置缺失时 autoCopy 自建', /resolveConfigPath\(\{ autoCopy: true \}\)/.test(cli), 'ok');
check('D-1 内嵌 DEFAULT_CONFIG（不依赖外置模板）', /const DEFAULT_CONFIG = Object\.assign/.test(cli), 'ok');

// ── D-2：对外声明实际端口 ──
const sup = read('src/supervisor.js');
check('D-2 supervisor-api 写入 ports.json', /ports\.register\('supervisor-api'/.test(sup), 'ok');

// ── D-3：healthz ──
const apiSrc = ['src/api/index.js', 'src/api/lifecycle.js'].map((f) => { try { return read(f); } catch { return ''; } }).join('\n');
check('D-3 /healthz 路由存在', /\/healthz/.test(apiSrc), 'ok');

// ── D-4：install 不写服务定义/autostart（唯一所有者=壳）──
const installStart = cli.indexOf('function cmdInstall');
const installEnd = cli.indexOf('function cmdGuiAutostart');
const installBody = installStart >= 0 && installEnd > installStart ? cli.slice(installStart, installEnd) : '';
check('D-4 定位到 cmdInstall', installBody.length > 0, installBody.length ? 'ok' : '未找到');
check('D-4 install 不写 UNIT_PATH', !installBody.includes('UNIT_PATH'), 'ok');
check('D-4 install 不 enable systemd', !/systemctl[\s\S]{0,40}'enable'/.test(installBody), 'ok');
check('D-4 install 明确「由桌面壳负责」', /服务定义\/开机自启\/桌面入口由桌面壳负责/.test(installBody), 'ok');
// 反向：旧形态（写 unit + enable）必须能被识别为违规
const looksLikeDeploy = (body) => body.includes('writeFileSync(UNIT_PATH') || /systemctl[\s\S]{0,40}'enable'/.test(body);
const legacy = "fs.writeFileSync(UNIT_PATH, unit); execInherit('systemctl', ['--user', 'enable', 'dsh-supervisor.service']);";
check('D-4 反向：旧写服务定义形态被识别', looksLikeDeploy(legacy), 'ok');
check('D-4 反向：当前 install 不被误判', !looksLikeDeploy(installBody), 'ok');

// ── D-5：单实例 ──
check('D-5 acquireLock + 退出非零', /function acquireLock/.test(cli) && /已有守卫实例在运行/.test(cli) && /process\.exit\(1\)/.test(cli), 'ok');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
