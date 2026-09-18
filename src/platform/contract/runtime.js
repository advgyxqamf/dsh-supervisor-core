'use strict';

const stateRoot = require('../service/state-root');

// 运行期启动契约读取器（壳写、内核读），与壳 src-tauri/src/runtime_contract.rs 成对。
// 契约文件：<产品状态根>/supervisor/runtime.json（schema 2）。
// 内核自身也要执行 npm（自更新/装 DSH/插件），而 GUI 或服务环境 PATH 常缺 nvm/fnm 的 npm；
// 壳在供给层解析一次并投放，内核消费产物，避免壳能装而内核装不了的分叉。
// 不变量 C2：契约不可用时返回 null 或退回调用方的 ambient 解析，绝不因此启动失败。

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_SCHEMA = 2;

function file() {
  return path.join(stateRoot.supervisorDir(), 'runtime.json');
}

/** 读取契约；缺失/损坏返回 null。兼容 schema 1（仅 nodePath/nodeVersion/minNode）。 */
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
    // 外壳可只提供包内 JS（npmPath=node，npmArgs=[npm-cli.js]），消费者必须带上 args。
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

/** 在给定 env 上注入契约 PATH（nodeBinDir 置于首位）；无契约时原样返回副本。 */
function withPath(env) {
  const e = Object.assign({}, env || {});
  const c = read();
  if (c && c.nodeBinDir) {
    const cur = e.PATH || e.Path || '';
    e.PATH = c.nodeBinDir + path.delimiter + cur;
  }
  return e;
}

// file() 必须导出：测试需要把契约写到 read() 实际读取的那个路径（SSOT 在此，测试不得重推导）。
// 曾按「仅 read() 内部使用」删除，CI run 35196507963 以 rc.file is not a function 检出（test 消费漏检）。
module.exports = { SUPPORTED_SCHEMA, file, read, npmBin, withPath };
