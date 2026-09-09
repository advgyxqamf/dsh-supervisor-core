'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 部署形态判定（A1 结构修复）：内核自更新的"安装目标必须=运行目标"。
//
// 产品标准形态：npm i -g @dsh-sup/dsh-core-<os>-<arch> → SEA 单文件二进制常驻
//   （bin/dsh-supervisor 是 148MB ELF，内嵌 __DSH_VERSION__ 编译期常量）。
// 非标准形态：源码开发部署 —— bin/dsh-supervisor 是 24KB node 脚本壳，require 开发目录
//   的 src/ 源码运行；npm i -g 装出的新 SEA 二进制与它毫无关系，装了也永远不生效。
//
// 本模块是「形态与安装目标」的唯一判定点：
//   - detect() → { form: 'sea-binary' | 'source-shell' | 'unknown', runningTarget, updatable }
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
 *   form='sea-binary'  → 标准产品形态：npm 装的 SEA 单文件，可自更新
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
  // 非 magic 头 → node 脚本壳：npm i -g 的新二进制与它无关，自更新必然无效
  return {
    form: 'source-shell',
    runningTarget: target,
    updatable: false,
    reason: '当前为源码开发形态（bin 脚本壳指向源码目录），npm 自更新不适用；请以标准产品形态（npm i -g ' +
      '或桌面壳安装）部署后使用自更新',
  };
}

module.exports = { detect, isBinaryExecutable, runningTarget };
