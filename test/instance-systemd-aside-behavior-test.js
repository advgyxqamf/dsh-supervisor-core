#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// D-2 行为级门禁：systemd 模板「让位」不得删除任何已有文件（2026-09-13）
//
// ## 缺陷
//
// `InstanceManager._prepareSystemd()` 把阻挡 systemd-run 的模板改名让位：
//
//   旧实现：aside = 模板路径 + '.disabled-by-dsh'（**固定名**）
//           try { fs.rmSync(aside, { force: true }); } catch {}
//           fs.renameSync(this.systemdTemplatePath, aside);
//
//   若**用户**（或更早的一次让位）恰好已有一个同名文件，那行 rmSync 会把它
//   **静默删除** —— 为了给一次改名动作腾位置而丢失用户数据。
//   概率极低，但**不可逆**，且与「让位而非删除」这一设计意图直接冲突。
//
// ## 修法
//
//   让位目标名带 **epoch 时间戳**（必要时再加序号）→ 天然唯一 → **无需先删**；
//   那行 rmSync 被彻底删除（不是加保护，而是让它不再必要）。
//
// ## 为什么这是**行为级**测试
//
//   「后缀带时间戳」用源码字符串断言很容易被自己写的注释骗过（本仓已发生两次），
//   故这里**真实调用 _prepareSystemd()**：造一个临时 systemd 目录，
//   预置一个与旧固定名同名的文件 + 待让位的模板，然后断言：
//     · 预置的同名文件**仍在**（字节不变）—— 这正是旧实现会失败之处；
//     · 模板已被移走（原路径不存在）；
//     · 让位目标存在且内容 == 原模板内容（放对地方，不是丢失）。
//
//   注入验证：把实现还原成「固定名 + 先 rmSync」→ 本测试 FAIL（预置文件被删）。
//
// ## 为什么用 require.cache 注入而非 patch 模块导出
//
//   `_prepareSystemd` 会调 `service.daemonReload()`（真实 systemctl --user reload）。
//   本测试不得对开发机产生真实副作用，故必须替换 service Provider。
//   ⚠ **不能**写 `service.daemonReload = ...` —— test/test-safety-gate-test.js 的
//     门禁 A 明令禁止「patch require 绑定的模块导出」（曾因此真跑了 npm uninstall）。
//     这里改用 `require.cache` **在加载实例模块之前**装入假的 service 模块，
//     属构造期注入，语义明确且不触碰任何真实系统调用。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ── 注入假 service Provider（必须在 require 实例模块**之前**）──
const servicePath = require.resolve(path.join(ROOT, 'src', 'platform', 'os', 'service'));
const instancePath = require.resolve(path.join(ROOT, 'src', 'domains', 'instance'));
const reloadCalls = [];
const fakeProvider = {
  kind: 'test-double',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { reloadCalls.push(Date.now()); return true; },
  stopUnit() { return true; },
  resetFailed() { return true; },
  isUnitActive() { return false; },
  transientUnitFile() { return null; },
  cleanTransient() {},
  startTransient() { return true; },
};
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    current: () => fakeProvider,
    CapabilityError: class CapabilityError extends Error {},
    kind: () => fakeProvider.kind,
    PLATFORM: process.platform,
  },
};
delete require.cache[instancePath];
const { InstanceManager } = require(instancePath);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-systemd-aside-'));

function makeMgr(systemdDir, events) {
  // ⚠ 域拆分后 systemdDir/events 必须在**构造期**注入（组装根持有 ctx，单实例字段后置赋值不再生效）。
  //   否则会落回真实 ~/.config/systemd/user —— 本测试绝不允许触碰开发机 systemd 配置。
  return new InstanceManager({
    dir: path.join(tmpRoot, 'sup-' + Math.random().toString(36).slice(2)),
    logger: { info() {}, warn() {}, error() {} },
    systemdDir,
    systemdTemplatePath: path.join(systemdDir, 'dsh-web@.service'),
    events,
  });
}

function scenario() {
  const systemdDir = fs.mkdtempSync(path.join(tmpRoot, 'user-'));
  const template = path.join(systemdDir, 'dsh-web@.service');
  fs.writeFileSync(template, '[Unit]\nDescription=legacy\n');
  // 用户/历史遗留的**同名文件**（旧实现的 rmSync 目标）
  const userFile = template + '.disabled-by-dsh';
  const userBody = 'USER-OWNED-CONTENT-DO-NOT-DELETE\n';
  fs.writeFileSync(userFile, userBody);
  return { systemdDir, template, userFile, userBody };
}

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  delete require.cache[servicePath];
  delete require.cache[instancePath];
}

try {
  const s = scenario();
  const events = [];
  const mgr = makeMgr(s.systemdDir, { append: (k, d) => events.push({ k, d }) });

  const ok = mgr._prepareSystemd();
  check('让位动作返回 true（未抛错）', ok === true, String(ok));
  check('走了注入的 daemonReload（证明 provider 被替换）', reloadCalls.length === 1, String(reloadCalls.length));

  // ① 核心断言：预置的同名文件必须**仍在且内容不变**
  const stillThere = fs.existsSync(s.userFile);
  check('预置的同名文件未被删除（旧实现的 rmSync 会删掉它）', stillThere, stillThere ? '仍在' : '**已被删除**');
  if (stillThere) {
    check('预置文件内容逐字未变', fs.readFileSync(s.userFile, 'utf8') === s.userBody, 'ok');
  }

  // ② 模板已被移走
  check('原模板路径已不存在（已让位）', !fs.existsSync(s.template), String(fs.existsSync(s.template)));

  // ③ 让位目标存在、内容 == 原模板内容、且名带时间戳
  const asideFiles = fs.readdirSync(s.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-dsh-'));
  check('存在带时间戳的让位文件', asideFiles.length === 1, asideFiles.join(', '));
  if (asideFiles.length === 1) {
    const asidePath = path.join(s.systemdDir, asideFiles[0]);
    check('让位文件内容 == 原模板内容（没丢数据）',
      fs.readFileSync(asidePath, 'utf8') === '[Unit]\nDescription=legacy\n', 'ok');
    check('让位文件名带 epoch 时间戳',
      /^dsh-web@\.service\.disabled-by-dsh-\d+$/.test(asideFiles[0]), asideFiles[0]);
  }

  // ④ 记了可追溯事件
  const moved = events.filter((e) => e.k === 'systemd_template_moved_aside');
  check('记了 systemd_template_moved_aside 事件', moved.length === 1, String(moved.length));

  // ⑤ 再跑一次：模板已不在 → 不再让位、也不该动任何文件（幂等、无副作用）
  const before = fs.readdirSync(s.systemdDir).sort().join(',');
  mgr._prepareSystemd();
  check('模板已让位后再调用无新副作用',
    fs.readdirSync(s.systemdDir).sort().join(',') === before, before);

  // ⑥ 让位目标重名时加序号（绝不覆盖已有文件）
  const s2 = scenario();
  const mgr2 = makeMgr(s2.systemdDir);
  // 冻结 Date.now → 让第一次让位目标名确定，然后放回模板重跑，验证加序号
  const realNow = Date.now;
  const freeze = 1700000000000;
  Date.now = () => freeze;
  try {
    mgr2._prepareSystemd();
    const first = 'dsh-web@.service.disabled-by-dsh-' + freeze;
    check('首次让位用 <模板>.disabled-by-dsh-<epoch>',
      fs.existsSync(path.join(s2.systemdDir, first)), fs.readdirSync(s2.systemdDir).join(', '));
    // 放回模板（模拟再次出现），此时 first 已存在 → 必须改用带序号的新名，绝不覆盖
    const firstBody = fs.readFileSync(path.join(s2.systemdDir, first), 'utf8');
    fs.writeFileSync(s2.template, '[Unit]\nDescription=second\n');
    mgr2._prepareSystemd();
    check('重名时首个让位文件未被覆盖',
      fs.readFileSync(path.join(s2.systemdDir, first), 'utf8') === firstBody, 'ok');
    const withSeq = fs.readdirSync(s2.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-dsh-' + freeze + '-'));
    check('重名时改用带序号的新名', withSeq.length === 1, withSeq.join(', '));
  } finally {
    Date.now = realNow;
  }
} finally {
  cleanup();
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
