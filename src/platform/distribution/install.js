'use strict';

// npm 安装执行 + 端口健康验证 + 版本检查（IO）。
// 全具名导出、显式收参（state 用于镜像选择/灰度事实），不碰跨文件 this。

const net = require('node:net');
const spawnOS = require('../os/spawn');
const { npmBin } = require('../os/exec-path');
const runtimeContract = require('../contract/runtime');
const service = require('../os/service').current();
const { VERSION_RE } = require('../../shared/version');
const release = require('./release');
const registry = require('./registry');
const policies = require('./policies');

/** npm registry 最新版（用选中镜像；失败回退候选；null 表示不可达）。 */
async function fetchNpmLatest(state, pkg, opts) {
  if (!pkg) return null;
  const o = opts || {};
  let origin = null;
  if (o.authoritative) {
    // 发布权威源解析：版本真相源 = 官方 npm registry。镜像同步有延迟，把「镜像未同步」
    // 误判为「没有新版本」是真相源错误。优先级：配置里显式的官方源 > 注入的非官方列表 > 默认官方。
    const list = registry.registryOrigins(state);
    origin = list.find((x) => /registry\.npmjs\.org/.test(x)) || list[0] || 'https://registry.npmjs.org';
  } else {
    origin = await registry.selectRegistry(state, false);
  }
  if (!origin) return null; // 全部镜像不可达：明确失败（checkUpdate 据此报错而非误报最新）
  try {
    const base = policies.normalizeOrigin(origin);
    // 拉包完整元数据（dist-tags + versions）；选版算法不在这里：
    //   我们的包走 release.pickReleaseVersion，第三方包取全量最高。
    const res = await fetch(base + '/' + encodeURIComponent(pkg), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j = await res.json();
    const picked = release.pickReleaseVersion(j, {
      isOurs: release.isOurReleasePackage(pkg),
      canary: policies.isInCanaryList(state), // 仅 isOurs 分支消费
      isValid: (v) => typeof v === 'string' && VERSION_RE.test(v),
    });
    if (picked) return picked;
    // 兜底：元数据里没有任何可用版本（例如仅 pkg/latest 端点有）——属「版本缺失」
    // 而非「通道选择」，与选版算法无关，故留在调用点。
    const lr = await fetch(base + '/' + encodeURIComponent(pkg) + '/latest', { signal: AbortSignal.timeout(8000) });
    if (!lr.ok) return null;
    const lj = await lr.json();
    return (lj && typeof lj.version === 'string' && VERSION_RE.test(lj.version)) ? lj.version : null;
  } catch (e) { return null; }
}

/** GitHub Releases 最新 tag（去除可选 v 前缀）。返回版本号。 */
async function fetchGithubLatest(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest',
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dsh-supervisor' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
    if (!tag) return null;
    return String(tag).replace(/^v/, '');
  } catch (e) { return null; }
}

/** 统一版本检查：channel = 'npm' | 'github'。返回最新版本字符串或 null。
 *  @param {object} [opts] { authoritative?: boolean } */
async function fetchLatestVersion(state, pkg, channel, opts) {
  const ch = channel || 'npm';
  const o = opts || {};
  if (ch === 'github') {
    const slash = String(pkg).split('/');
    if (slash.length >= 2) return fetchGithubLatest(slash[0], slash.slice(1).join('/'));
    return null;
  }
  return fetchNpmLatest(state, pkg, { authoritative: o.authoritative === true });
}

/** 安装执行器（统一 npm 安装）：镜像注入 / 超时 / 行日志 / 退出码 / 进程树清理。
 *
 *  @param {object} opts
 *   - pkg / version（version 必须显式）/ prefix（沙箱） / registry / timeoutMs / detached / onLine
 *  @returns Promise<{ ok, error, output }> */
function runNpmInstall(opts) {
  const o = opts || {};
  const pkg = o.pkg || '@deepseek-ai/dsh';
  if (!o.version) return Promise.resolve({ ok: false, error: 'runNpmInstall: 缺少 version（必须显式携带）', output: [] });
  // 唯一安装执行器：commandTemplate 支持完整替换命令（测试/特殊环境注入 fake-npm 等）。
  let argv;
  // 经统一解析（Windows 下为 npm.cmd），不得硬编码裸 'npm'（会 ENOENT）。
  let bin = runtimeContract.npmBin(npmBin);
  if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
    argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version).replace(/{prefix}/g, o.prefix || ''));
    // 模板首项通常就是逻辑名 'npm'，同样需要跨平台解析；仅在首项恰为逻辑名时解析。
    bin = (argv[0] === 'npm') ? runtimeContract.npmBin(npmBin) : argv[0];
    argv = argv.slice(1);
  } else {
    argv = ['install', '-g', '--no-audit', '--no-fund'];
    if (o.prefix) argv.push('--prefix', o.prefix);
    argv.push(pkg + '@' + o.version);
  }
  // 契约 PATH 注入（nodeBinDir 首位）：内核自身执行的 npm 也必须能找到 node。
  const envVars = runtimeContract.withPath(process.env);
  if (o.registry) { envVars.npm_config_registry = o.registry; envVars.NPM_CONFIG_REGISTRY = o.registry; }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnOS.piped(bin, argv, { env: envVars, detached: o.detached !== false });
    } catch (e) {
      return resolve({ ok: false, error: e.message, output: [] });
    }
    const out = [];
    const killTree = () => {
      if (!child || child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    };
    const timer = setTimeout(() => {
      killTree();
      resolve({ ok: false, error: '安装超时', output: out });
    }, o.timeoutMs || 600000);
    const onLine = (buf) => {
      for (const l of String(buf).split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        out.push(t.slice(0, 200));
        if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch { /* 回调失败不阻断 */ } }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, output: out }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : 'npm install 退出码 ' + code, output: out });
    });
  });
}

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 健康验证器（统一端口 + systemd 单元 + 稳定期）。
 *
 *  DSH 进程可能先监听端口、随后因插件兼容崩溃，只探测端口会误判成功 ——
 *  必须同时检查 systemd 单元仍 active，并留稳定期防「延迟崩溃」。 */
async function waitPortHealthy(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = Number(o.port);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port };
  const unit = o.unit || null;
  const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
  const unitActive = () => service.isUnitActive(unit); // 平台层判定（无单元视为通过）
  const deadline = Date.now() + (o.timeoutMs || 60000);
  while (Date.now() < deadline) {
    if ((await portListening(host, port)) && unitActive()) {
      // 稳定期：用**剩余预算**做缩短的稳定期复检（慢启动实例不得被误判失败，也不超 deadline）。
      const remain = deadline - Date.now();
      const wait = Math.max(0, Math.min(stabilityMs, remain));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // 稳定期复查必须同时复检端口：只查单元会漏掉进程在稳定期内崩溃（端口已空）。
      if ((await portListening(host, port)) && unitActive()) return { ok: true };
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, remain)));
  }
  return { ok: false, reason: '端口 ' + port + ' 未就绪' + (unit ? ' 或单元 ' + unit + ' 未保持 active' : '') };
}

module.exports = {
  fetchNpmLatest,
  fetchGithubLatest,
  fetchLatestVersion,
  runNpmInstall,
  waitPortHealthy,
};
