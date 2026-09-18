#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 内核更新单写入者门禁（2026-09-15）—— A 方案「收敛为单写入者 = 桌面壳」。
//
// ## 解决的问题
//   内核 npm 包曾有两个写入者：内核自更新（POST /self-update/apply → runNpmInstall）
//   与桌面壳（core_apply）。两套版本判定、两种源策略，同一个全局 npm 包被两个进程写。
//   现契约：**安装/升级/重启守卫只有桌面壳一个写入者**；守卫只提供只读状态。
//
// ## 锁定不变量
//   SW-1  写端点已下架：/self-update/apply|restart-guard 返回 410 KERNEL_UPDATE_SINGLE_WRITER
//   SW-2  内核无写实现：settings-view 不再有 guardSelfUpdateApply/Restart；只读 status 保留
//   SW-3  surface 清单把两个写端点标为 deprecated（有替代说明）
//   SW-4  旧 manifest 通道死代码已删除（self-update.js / config 残留键 / extractTarGz）
//   SW-5  CLI self-update 不再安装（apply → 指引 + 退出码 2；check 保留）
//   SW-6  面板经消息桥请壳代执行（kernelUpdateBridge + AboutCard），不再调内核写端点
//   SW-7  反向：判据能识别旧的写实现（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const read = (rel) => {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return s.includes('\r') ? s.replace(/\r\n/g, '\n') : s;
};
// 剥离注释行（防止注释里提到被删方法名而误判「仍有写路径」）。
const codeOnly = (src) => src.split('\n')
  .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join('\n');

const guard = read('src/api/domains/guard.js');
// ⚠ 步骤 7（2026-09-16）：原 settings-view.js 已拆为 app/settings/{env,node-lts,versions,access,lan-panel}.js。
//   自更新只读状态 guardSelfUpdateStatus 现落在 versions.js（**不在** env.js）——故读**整组**，
//   否则「拆分即静默失去 SW-2 覆盖面」（只读 status 保留 / 无写实现两条判据会双双空转）。
const settings = [
  'src/app/settings/env.js',
  'src/app/settings/versions.js',
  'src/app/settings/node-lts.js',
  'src/app/settings/access.js',
  'src/app/settings/lan-panel.js',
].map(read).join(String.fromCharCode(10));
const surface = read('src/api/contract.js');
const cli = read('bin/dsh-supervisor');
const about = read('ui/src/features/supervisor/settings/AboutCard.tsx');
const client = read('ui/src/services/supervisor/client.ts');

// ── SW-1：写端点已下架（410 + 稳定错误码）──
check('SW-1 /self-update/apply 返回 410', /pathname === '\/self-update\/apply'/.test(guard) && /send\(410,/.test(guard), 'ok');
check('SW-1 restart-guard 同下架', /pathname === '\/self-update\/restart-guard'/.test(guard), 'ok');
check('SW-1 使用稳定错误码', /KERNEL_UPDATE_SINGLE_WRITER/.test(guard), 'ok');
check('SW-1 只读 status 仍在且调 guardSelfUpdateStatus', /pathname === '\/self-update\/status'/.test(guard) && /guardSelfUpdateStatus\(\)/.test(guard), 'ok');

// ── SW-2：内核无写实现 ──
const sc = codeOnly(settings);
check('SW-2 无 guardSelfUpdateApply 实现', !/guardSelfUpdateApply\s*\(/.test(sc), 'ok');
check('SW-2 无 guardSelfUpdateRestart 实现', !/guardSelfUpdateRestart\s*\(/.test(sc), 'ok');
check('SW-2 只读 guardSelfUpdateStatus 保留', /async guardSelfUpdateStatus\s*\(/.test(sc), 'ok');
const sup = codeOnly(read('src/supervisor.js'));
check('SW-2 无自更新预期版本状态', !/_selfUpdateExpectedVersion|_selfUpdatePending/.test(sup), 'ok');

// ── SW-3：surface 标注 deprecated ──
check('SW-3 apply 标 deprecated 且有替代说明',
  /path: '\/self-update\/apply'[^\n]*category: 'deprecated'[^\n]*(替代|下架)/.test(surface), 'ok');
check('SW-3 restart-guard 标 deprecated 且有替代说明',
  /path: '\/self-update\/restart-guard'[^\n]*category: 'deprecated'[^\n]*(替代|下架)/.test(surface), 'ok');

// ── SW-4：manifest 死代码已删 ──
check('SW-4 dist/self-update.js 已删除', !fs.existsSync(path.join(ROOT, 'src', 'platform', 'distribution', 'self-update.js')), 'ok');
const cfg = codeOnly(read('src/platform/service/config.js'));
check('SW-4 config 无 selfUpdateManifestUrl/Dir 残留键', !/selfUpdateManifestUrl|selfUpdateDir:/.test(cfg), 'ok');
const fsu = read('src/platform/util/fs.js');
check('SW-4 extractTarGz 死代码已删', !/function extractTarGz/.test(fsu) && !/extractTarGz/.test(fsu), 'ok');

// ── SW-5：CLI 不再安装 ──
check('SW-5 CLI apply 不 POST /self-update/apply', !/apiOne\('POST', '\/self-update\/apply'\)/.test(cli), 'ok');
check('SW-5 CLI apply 给指引并退出码 2', /内核更新由桌面壳执行/.test(cli) && /process\.exit\(2\)/.test(cli), 'ok');
check('SW-5 CLI 用法只剩 check', /self-update \[check\]/.test(cli), 'ok');

// ── SW-6：面板经消息桥请壳代执行 ──
const bridge = read('ui/src/services/supervisor/kernelUpdateBridge.ts');
check('SW-6 桥协议版本 = 1', /BRIDGE_PROTOCOL_VERSION = 1/.test(bridge), 'ok');
check('SW-6 无壳宿主时拒绝', /window\.parent !== window/.test(bridge), 'ok');
check('SW-6 请求类型为 dsh:kernel-update-request', /dsh:kernel-update-request/.test(bridge), 'ok');
check('SW-6 AboutCard 用 requestKernelUpdate', /requestKernelUpdate/.test(about), 'ok');
check('SW-6 AboutCard 无内核写端点调用', !/selfUpdateApply|selfUpdateRestart/.test(about), 'ok');
check('SW-6 client 无 selfUpdateApply/Restart', !/selfUpdateApply|selfUpdateRestart/.test(client), 'ok');

// ── SW-7：反向自检（判据能识别旧写实现）──
const guardHasWritePath = (src) => {
  const c = codeOnly(src);
  return /guardSelfUpdateApply\s*\(/.test(c) || /guardSelfUpdateRestart\s*\(/.test(c);
};
const legacy = '  async guardSelfUpdateApply() {\n    return this.dist.runNpmInstall({});\n  }';
check('SW-7 旧写实现必须被识别（非空转）', guardHasWritePath(legacy), 'ok');
check('SW-7 当前实现不被误判', !guardHasWritePath(settings), 'ok');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
