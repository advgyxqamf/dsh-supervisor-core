'use strict';

// 域：原生 DSH（app/native）—— npm 调用（IO：exec / spawn 经 platform 统一封装）。
// npm 可执行经 host._npmBin 构造期注入。

const execPath = require('../../platform/os/exec-path');
const ex = require('../../platform/util/exec');

/** npm 可执行：优先注入值（测试），否则跨平台解析（Windows 用 npm.cmd）。
 *  经模块对象调用而非解构：解构是值绑定，无法被测试替换。 */
function npmExe(host) { return (host && host._npmBin) || execPath.npmBin(); }

/** 注入的前置参数（仅测试；生产恒为空）：以 node 执行包内 JS 时使用。 */
function npmExeArgs(host) {
  return (host && Array.isArray(host._npmBinArgs)) ? host._npmBinArgs.slice() : [];
}

/** 优先注入值（测试）。 */
function resolveNpmRoot(host) {
  if (host.npmRoot) return host.npmRoot;
  const r = ex.runOut(npmExe(host), npmExeArgs(host).concat(['root', '-g']));
  return r ? r.trim() : null;
}

function checkEnvironment(host) {
  const errors = [];
  const nv = ex.runOut('node', ['--version']);
  if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
  const npmv = ex.runOut(npmExe(host), npmExeArgs(host).concat(['--version']));
  if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
  return { ok: errors.length === 0, errors, npmRoot: resolveNpmRoot(host) };
}

/** 最新版本（统一分发通道；packageName 默认第三方包语义——取全量最高版本）。 */
async function latestVersion(host) {
  if (!host.dist || !host.config.packageName) throw new Error('分发服务未初始化，无法查询最新版本');
  const channel = host.config.releaseChannel || 'npm';
  return host.dist.fetchLatestVersion(host.config.packageName, channel);
}

/** 选最快可达镜像（网络环境自适应）。 */
async function selectRegistry(host) {
  if (!host.dist) return null;
  try { return await host.dist.selectRegistry(true); } catch { return null; }
}

/** 安装执行（唯一入口 = dist.runNpmInstall）；行日志回写升级日志 +（安装中）安装日志。 */
function runInstall(host, version, registry) {
  if (!host.dist) return Promise.resolve({ ok: false, error: 'dist 分发服务不可用，无法安装', output: [] });
  const pkg = host.config.packageName || '@deepseek-ai/dsh';
  const tpl = host.config.installCommandTemplate;
  return host.dist.runNpmInstall({
    pkg,
    version,
    registry,
    commandTemplate: Array.isArray(tpl) && tpl.length ? tpl : null,
    timeoutMs: host.config.upgradeTimeoutMs || 600000,
    onLine: (l) => {
      host._appendUpgradeLog(l);
      if (host.installing) host._appendInstallLog(l);
    },
  });
}

module.exports = { npmExe, npmExeArgs, resolveNpmRoot, checkEnvironment, latestVersion, selectRegistry, runInstall };
