'use strict';

// 域：原生 DSH（app/native）—— 真实安装探测 / 版本读取 / 端口健康（IO）。
// 依赖：node:fs / node:path / node:os / platform/os/exec-path / ./policies。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const execPath = require('../../platform/os/exec-path');
const policies = require('./policies');

/** 真实安装检测（唯一入口）：已绑定/显式且非裸名则尊重之；否则跨平台解析。 */
function detected(host) {
  const cmd = Array.isArray(host.config.command) ? host.config.command : [];
  const configured = cmd[1];
  if (!policies.isBareCommand(configured)) {
    return { bin: configured, runtime: cmd[0] || null, isJs: /\.(js|cjs|mjs)$/i.test(configured) };
  }
  try { return execPath.resolveDsh({ npmRoot: host.npmRoot }); } catch { return null; }
}

/** 入口路径：检测到用真实入口；否则如实返回配置原值（绝不伪造）。 */
function binPath(host) {
  const d = detected(host);
  if (d && d.bin) return d.bin;
  const bin = host.config.command && host.config.command[1];
  if (!bin) return null;
  return bin === '~' ? os.homedir() : (bin.startsWith('~/') ? path.join(os.homedir(), bin.slice(2)) : bin);
}

/** 读 package.json 的 name/version；不存在/无 name 返回 null。 */
function readPkgVersion(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.name) return String(j.version || '');
  } catch {}
  return null;
}

/** 从 bin 所在目录向上最多 8 层找 package.json。 */
function versionNearBin(bin) {
  try {
    let dir = path.dirname(fs.realpathSync(bin));
    for (let i = 0; i < 8; i++) {
      const v = readPkgVersion(path.join(dir, 'package.json'));
      if (v !== null) return v;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

/** 已安装版本：显式 installedPkgJsonPath 优先，否则从 bin 向上找 package.json。未装 null。 */
function installedVersion(host) {
  if (host.config.installedPkgJsonPath) {
    try {
      const j = JSON.parse(fs.readFileSync(host.config.installedPkgJsonPath, 'utf8'));
      if (j.name) return String(j.version || '');
    } catch { return null; }
  }
  const bin = binPath(host);
  if (!bin || !fs.existsSync(bin)) return null;
  return versionNearBin(bin);
}

/** 原生 DSH 目标端口（从 healthUrl 提取）。 */
function targetPort(config) {
  try { return Number(new URL(config.healthUrl).port) || null; } catch { return null; }
}

/** 托管单元名（恒为 null）：健康验证只按端口 + 稳定期。 */
function mainUnit() { return null; }

/** 升级后健康验证：端口在线 + 稳定期（unit 恒 null）。返回 { ok, reason }。 */
async function waitNativeHealthy(host, port, unit, timeoutMs) {
  if (!host.dist) return { ok: false, reason: 'dist 分发服务不可用' };
  return host.dist.waitPortHealthy({ host: '127.0.0.1', port, unit, timeoutMs });
}

module.exports = { detected, binPath, installedVersion, targetPort, mainUnit, waitNativeHealthy };
