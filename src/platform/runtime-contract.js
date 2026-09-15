'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 运行期启动契约读取器（**壳写、内核读**）—— 与壳 `src-tauri/src/runtime_contract.rs` 成对。
//
// 契约文件：`~/.dsh/supervisor/runtime.json`（schema 2），由桌面壳写。
//
// ## 为什么内核要读它（根因）
//
//   内核自身也要执行 npm（自更新 / 装 DSH / 装插件）。旧实现用 ambient PATH 的裸 `npm`
//   与 `process.env`。而 GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm 目录 ——
//   于是出现「壳能装、内核自己装不了」的分叉。同一台机器上 npm 是**一个**事实，
//   必须只有一处解析：壳（供给层，R1）解析并投放，内核消费产物（R3-②）。
//
// ## 缺失/损坏时的行为（不变量 C2：内核可降级运行）
//
//   契约不可用时返回 null / 退回调用方给的 ambient 解析 —— **绝不因此启动失败**。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 本内核理解的契约 schema。 */
const SUPPORTED_SCHEMA = 2;

/** 契约文件路径。 */
function file() {
  return path.join(require('./state-root').supervisorDir(), 'runtime.json');
}

/** 读取契约（缺失/损坏返回 null）。兼容 schema 1（仅有 nodePath/nodeVersion/minNode）。 */
function read() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const node = (j.node && typeof j.node === 'object') ? j.node : {};
  const npm = (j.npm && typeof j.npm === 'object') ? j.npm : {};
  return {
    schema: Number(j.schema) || 1,
    nodePath: j.nodePath || node.path || null,
    nodeBinDir: j.nodeBinDir || node.binDir || null,
    npmPath: j.npmPath || npm.path || null,
    // 外壳可只提供包内 JS（npmPath=node，npmArgs=[npm-cli.js]）——消费者必须带上 args。
    npmArgs: Array.isArray(j.npmArgs) ? j.npmArgs : (Array.isArray(npm.args) ? npm.args : []),
    minNode: j.minNode || null,
    writtenBy: j.writtenBy || null,
    raw: j,
  };
}

/** npm 可执行：契约优先；缺失/不可用退回 fallback（函数或字符串）。 */
function npmBin(fallback) {
  const c = read();
  if (c && c.npmPath) {
    try { if (fs.existsSync(c.npmPath)) return c.npmPath; } catch {}
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** 在给定 env 上注入契约 PATH（nodeBinDir 首位）；无契约时原样返回副本。 */
function withPath(env) {
  const e = Object.assign({}, env || {});
  const c = read();
  if (c && c.nodeBinDir) {
    const cur = e.PATH || e.Path || '';
    e.PATH = c.nodeBinDir + path.delimiter + cur;
  }
  return e;
}

module.exports = { SUPPORTED_SCHEMA, file, read, npmBin, withPath };
