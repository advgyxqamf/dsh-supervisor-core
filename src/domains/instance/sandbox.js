'use strict';

const platform = require('../../platform/os/index');

// 沙箱布局：沙箱根/数据/依赖目录推导、启动命令、systemd 属性与 env 装配、平台能力判决。
// 纯函数，rootDir 由组装根绑定后显式传入（无状态、无隐式 this）；能力判决只查 platform/os
// 的缓存能力矩阵（负结果 60s TTL），不直接 spawn。

const path = require('node:path');

/** 沙箱实例的独立根目录（其下 依赖目录 install/ + 数据目录 data/）。 */
function root(rootDir, inst) { return path.join(rootDir, inst.id); }
/** 该实例独立数据目录（作为实例运行的 HOME/XDG_CONFIG_HOME，内置独立 .dsh 等）。 */
function dataDir(rootDir, inst) { return path.join(root(rootDir, inst), 'data'); }
/** 该实例独立依赖目录（完整 DSH 安装处，node_modules 与原生隔离）。 */
function installDir(rootDir, inst) { return path.join(root(rootDir, inst), 'install'); }

/** 沙箱实例的启动命令：用「官方 npm install -g --prefix」装进该沙箱 install 目录的 DSH。 */
function sandboxCommand(rootDir, inst) {
  // -g --prefix 布局：<installDir>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
  const bin = path.join(installDir(rootDir, inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return [process.execPath, bin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}

/** 未配 command 时的默认启动命令：<node> <dshBin> web --port <port>。 */
function defaultCommand(dshBin, inst) {
  return [process.execPath, dshBin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}

/** 有效启动命令：沙箱用实例独立安装；用户显式配置优先；否则回退默认宿主命令。 */
function effectiveCommand(rootDir, dshBin, inst) {
  if (inst.domain === 'sandbox' && (!inst.command || !inst.command.length)) return sandboxCommand(rootDir, inst);
  if (inst.command && inst.command.length) return inst.command;
  return defaultCommand(dshBin, inst);
}

/** systemd transient 单元属性（业务约束以「属性」表达，域层不拼 systemd 参数）。 */
function unitProps(inst) {
  return [
    'KillMode=process',
    'MemoryMax=' + ((inst.sandbox && inst.sandbox.memoryMax) || '8G'),
    'CPUQuota=' + ((inst.sandbox && inst.sandbox.cpuQuota) || '200%'),
    'PrivateTmp=' + ((inst.sandbox && inst.sandbox.privateTmp) ? 'yes' : 'no'),
    'ProtectHome=' + ((inst.sandbox && inst.sandbox.protectHome) ? 'yes' : 'no'),
    'Restart=no',
  ];
}

/** 沙箱实例的环境与工作目录装配（native 无 env）。PATH 连接符用 path.delimiter（跨平台）。 */
function sandboxEnv(rootDir, inst) {
  const env = {};
  let workingDir = null;
  if (inst.domain === 'sandbox') {
    const data = dataDir(rootDir, inst);
    const install = installDir(rootDir, inst);
    const nodeBinDir = path.dirname(process.execPath);
    const paths = [nodeBinDir, path.join(install, 'bin'), process.env.PATH || ''].join(path.delimiter);
    env.HOME = data;
    env.XDG_CONFIG_HOME = data;
    env.XDG_DATA_HOME = data;
    env.PATH = paths;
    env.NODE_PATH = path.join(install, 'lib', 'node_modules');
    workingDir = data;
  }
  return { env, workingDir };
}

/** 平台能力判决（**实时**求值）：本平台是否支持沙箱实例（Linux + systemd-run）。
 *  override 非空则显式覆写（仅供测试/嵌入方）；否则实时问 platform/os/index.capabilities()，
 *  后者对工具负结果有 60s TTL，不会每次都 spawn 探测进程。 */
function supported(override) {
  if (override !== undefined && override !== null) return override === true;
  try {
    const caps = platform.capabilities();
    return !!(caps && caps.multiInstance === true);
  } catch { return false; }
}

module.exports = { root, dataDir, installDir, effectiveCommand, unitProps, sandboxEnv, supported };
