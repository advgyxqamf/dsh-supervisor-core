'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 部署形态判定（A1 结构修复）：内核自更新的"安装目标必须=运行目标"。
//
// 标准产品形态（**2026-09 起为 Node launcher，不再是 SEA**）：
//   npm i -g @dsh-sup/dsh-core-<os>-<arch> 展开后：
//     <pkg>/bin/dsh-supervisor   文本 launcher（`require('../core.cjs')`）
//     <pkg>/core.cjs             esbuild 单文件 bundle（平台无关）
//     <pkg>/ui-react/            面板产物
// 非标准形态：源码开发部署 —— bin/dsh-supervisor require 开发目录的 src/ 运行；
//   npm i -g 装出的新包与它毫无关系，装了也永远不生效。
//
// ⚠ 2026-09-12 修正（P0）：**本模块此前只认「二进制 magic 头」**，
//   而其头部注释声称产品形态是「SEA 单文件二进制（148MB ELF）」——
//   但发布产线早已 **全平台弃 SEA**（release/scripts/build-launcher.sh:2 明写；
//   原因：Node SEA 在 macOS 注入后即段错误，属上游缺陷）。
//   于是真实发布形态（文本 launcher）必然落到 `source-shell` → updatable=false →
//   **自更新对全部真实用户永久不可用**，而注释仍宣称它工作。
//
//   现判据改为「**运行目标旁边是否有 core.cjs**」（launcher 形态的结构特征），
//   同时**保留**二进制 magic 识别（兼容历史 SEA 安装与任何未来单文件形态）。
//
// 本模块是「形态与安装目标」的唯一判定点：
//   - detect() → { form, runningTarget, updatable, reason }
//   - self-update 相关调用方（apply/restart/面板按钮显隐）一律消费本模块，不再各自猜测。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

/** SEA 单文件二进制识别：文件头是 ELF/PE/Mach-O magic（node 脚本文本不可能以这些字节开头）。 */
function isBinaryExecutable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46; // ELF
      const pe = head[0] === 0x4d && head[1] === 0x5a; // MZ（PE/DOS stub）
      const macho = (head[0] === 0xcf && head[1] === 0xfa) || (head[0] === 0xca && head[1] === 0xfe);
      return elf || pe || macho;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** launcher 形态识别（P0 修复，2026-09-12）：发布产物的结构特征。
 *
 *  发布布局（build-launcher.sh）：
 *    <pkg>/bin/dsh-supervisor   文本 launcher（`require('../core.cjs')`）
 *    <pkg>/core.cjs             esbuild bundle
 *  故运行目标若是 `<pkg>/bin/dsh-supervisor`，其**上级目录**有 core.cjs；
 *  若调用方直接指向 core.cjs 本身，则**同目录**有它。两处都查，兼容两种 argv[1]。
 *
 *  ⚠ 不用「文本内容是否含 require('../core.cjs')」判定：那与实现细节耦合，
 *    而「core.cjs 存在」是发布布局的结构事实。
 */
function isLauncherForm(target) {
  try {
    const dir = path.dirname(target);
    if (fs.existsSync(path.join(dir, 'core.cjs'))) return true;
    if (fs.existsSync(path.join(dir, '..', 'core.cjs'))) return true;
    return false;
  } catch { return false; }
}

/** 当前守卫的"运行目标"：argv[1]（bin 脚本或 SEA 二进制本体）做 realpath 消解 symlink。 */
function runningTarget() {
  try {
    const a1 = process.argv[1];
    if (!a1) return null;
    return fs.realpathSync(path.resolve(a1));
  } catch { return null; }
}

/**
 * 部署形态判定。
 * @returns {{ form: string, runningTarget: string|null, updatable: boolean, reason: string|null }}
 *   form='launcher'    → 标准产品形态（2026-09 起）：npm 装的文本 launcher + core.cjs，可自更新
 *   form='sea-binary'  → 历史/兼容的单文件二进制形态（保留 magic 头识别），可自更新
 *   form='source-shell'→ 源码开发形态：bin 壳脚本 require 源码目录；npm 自更新不可用
 *   form='unknown'     → 无法判定（argv 缺失等）；保守禁用自更新
 */
function detect() {
  // 测试/CI 注入口：强制形态（生产不设置该变量，走真实判定）——
  // mock 驱动的集成测试需要在不装 SEA 二进制的环境里模拟标准产品形态。
  const forced = process.env.DSH_DEPLOY_FORM;
  const target = runningTarget();
  if (forced === 'sea-binary') {
    return { form: 'sea-binary', runningTarget: target, updatable: true, reason: null };
  }
  if (!target) {
    return { form: 'unknown', runningTarget: null, updatable: false, reason: '无法定位当前运行文件' };
  }
  if (isBinaryExecutable(target)) {
    return { form: 'sea-binary', runningTarget: target, updatable: true, reason: null };
  }
  // ⚠ 2026-09-12（P0 修复）：launcher 形态识别。
  //   发布产物是**文本 launcher**（`<pkg>/bin/dsh-supervisor` 内容为 require('../core.cjs')），
  //   其结构特征是「同目录（或上级目录）存在 core.cjs」——这正是 npm i -g 安装的形态。
  //   源码开发部署没有 core.cjs（那是 esbuild 的构建产物）。
  //   故：有 core.cjs ⇒ 标准产品形态（可自更新）；无 ⇒ 源码开发形态。
  if (isLauncherForm(target)) {
    return { form: 'launcher', runningTarget: target, updatable: true, reason: null };
  }
  // 既非二进制、又无 core.cjs → node 脚本壳指向源码目录：npm i -g 的新包与它无关
  return {
    form: 'source-shell',
    runningTarget: target,
    updatable: false,
    reason: '当前为源码开发形态（bin 脚本壳指向源码目录），npm 自更新不适用；请以标准产品形态（npm i -g ' +
      '或桌面壳安装）部署后使用自更新',
  };
}

module.exports = { detect, isBinaryExecutable, isLauncherForm, runningTarget };
