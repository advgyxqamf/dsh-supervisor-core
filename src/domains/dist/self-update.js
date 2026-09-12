'use strict';

// 守卫自更新核心（Phase2）：清单 → 下载 → SHA256 校验 → 解包 → 版本目录 + current 软链翻转 → 回滚保留。
// 与发行通道解耦：manifest 只要求 { version, url, sha256 }（GitHub Releases / CDN / 本地 HTTP 皆可）。
// 语义：installDir 下 v<version>/ 为版本目录，current 软链指向当前启用版本；失败不动 current（天然回滚）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const exec = require('../../platform/exec'); // 统一有界执行（sanityCheck 语法自检等）
const { extractTarGz } = require('../../platform/fs-utils');
// P1-1：版本排序必须用真正的 semver 比较，而非字符串比较（见 currentDir / prune）。
const { semverCompare } = require('./index');

async function httpGetBytes(url, timeoutMs = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

/** 下载源白名单：https 任意主机；http 仅限回环（本地部署/测试）。 */
function isUrlAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch { return false; }
}

async function fetchManifest(manifestUrl) {
  const raw = (await httpGetBytes(manifestUrl)).toString('utf8');
  const m = JSON.parse(raw);
  const version = String(m.version || '').trim();
  const url = String(m.url || '').trim();
  const sha256 = String(m.sha256 || '').trim().toLowerCase();
  if (!version.startsWith('v')) throw new Error('manifest.version 非法: ' + version);
  // 2026-09 安全加固：sha256 与 url 同来自 manifest（信任根在 manifest）——明文 HTTP 下 MITM 可同时
  // 换 url+sha256 走私恶意载荷。故非回环下载强制 https；回环（127.0.0.1/localhost）放行以支持本地
  // 部署与回归测试（回环不经过网络，不存在中间人）。
  if (!isUrlAllowed(url)) throw new Error('manifest.url 必须为 https（或回环 http，防 MITM 换 sha256）: ' + url);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('manifest.sha256 非法（需 64 位 hex）');
  return { version: version.slice(1), url, sha256 };
}

/** 读取某个版本目录的版本号（VERSION 文件或 package.json）。 */
function versionOf(dir) {
  try {
    const vf = path.join(dir, 'VERSION');
    if (fs.existsSync(vf)) return fs.readFileSync(vf, 'utf8').trim();
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.version) return String(pkg.version);
  } catch {}
  return null;
}

/** 当前启用的版本目录（current 软链优先，回退为版本号最大的目录）。 */
function currentDir(installDir) {
  const link = path.join(installDir, 'current');
  try {
    const t = fs.realpathSync(link);
    if (fs.statSync(t).isDirectory()) return t;
  } catch {}
  let entries;
  try { entries = fs.readdirSync(installDir); } catch { return null; } // 目录尚不存在 → 无当前版本
  let best = null;
  for (const e of entries) {
    const full = path.join(installDir, e);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (e === 'current') continue;
    const v = versionOf(full);
    // ⚠ P1-1 修复（2026-09-12）：用 semver 比较，不再用字符串 `>`。
    //   旧实现把 `v0.9.0` 判为大于 `v0.10.0`（字典序 '9' > '1'）→ 取错目录。
    if (v && (!best || semverCompare(v, best[0]) > 0)) best = [v, full];
  }
  return best ? best[1] : null;
}

async function downloadVerify(url, sha256, tmpFile) {
  const data = await httpGetBytes(url);
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== sha256) throw new Error('SHA256 校验失败：期望 ' + sha256 + ' 实得 ' + digest + '（拒绝安装）');
  fs.writeFileSync(tmpFile, data);
}

function extractArchive(file, destDir) {
  // 纯 Node 解包（无外部 tar 依赖，跨平台一致；发布物为 tar.gz）。
  // 原 execFileSync('tar') 在 Windows（无 GNU tar）使守卫自更新不可用（2026-09 审计修复）。
  extractTarGz(fs.readFileSync(file), destDir, { stripComponents: 1 });
}

function sanityCheck(versionDir) {
  const bin = path.join(versionDir, 'bin', 'dsh-supervisor');
  if (fs.existsSync(bin)) {
    // 有界（2026-09-11，门禁 G9）：自更新解包出的脚本若异常（巨型文件/挂起），
    //   同步 execFileSync 无超时会冻结整个守卫。经统一执行器（默认 15s + SIGKILL）。
    //
    // ⚠ P1 修复（2026-09-13，失效模式 a+h+e）：**返回值必须检查**，否则本检查恒通过。
    //
    //   缺陷：exec.run 的契约是「失败/超时返回 null」，而本行**丢弃返回值**、也不抛错 ——
    //     于是 sanityCheck 对任何语法损坏的 bin 都静默通过（注释却写「语法自检即冒烟」）。
    //   后果：apply() 随后 symlink+rename 把 current **翻转到语法错误的版本**，
    //     并 prune 掉旧版本 → 守卫再也起不来，且**无回滚**（current 已翻转）。
    //   为什么长期未被发现：self-update 的生产调用点为零（门禁走 npm 通道），
    //     只有 test/guard-update-test.js 覆盖，而它**从未断言过 sanityCheck 的失败路径**
    //     —— 典型的「测试全绿掩盖检查从未生效」。
    //   修法：失败即抛（由 apply 的调用方按「任何一步失败：不动 current」处理）。
    if (exec.run(process.execPath, ['--check', bin], { stdio: 'pipe' }) === null) {
      throw new Error('sanityCheck 失败：bin/dsh-supervisor 未通过语法自检（包可能已损坏）');
    }
  }
  const pkg = path.join(versionDir, 'package.json');
  if (fs.existsSync(pkg)) JSON.parse(fs.readFileSync(pkg, 'utf8')); // 结构自检
}

/**
 * 执行一次更新：manifest → 下载校验 → 解包到 v<version> → 冒烟 → 软链翻转。
 * installDir 内 current 保留 v<新>；旧版本目录保留（回滚），超过 keepOld 个删除最旧的。
 * 任何一步失败：不动 current（当前版本完整可用）。
 */
async function apply({ manifestUrl, installDir, keepOld = 2 }) {
  fs.mkdirSync(installDir, { recursive: true });
  const manifest = await fetchManifest(manifestUrl);
  const cur = currentDir(installDir);
  const curV = cur ? versionOf(cur) : null;
  if (curV === manifest.version) return { ok: true, upToDate: true, version: manifest.version };

  const tmp = path.join(installDir, '.dl-' + crypto.randomBytes(4).toString('hex') + '.tar.gz');
  const target = path.join(installDir, 'v' + manifest.version);
  try {
    await downloadVerify(manifest.url, manifest.sha256, tmp);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    extractArchive(tmp, target);
    versionOf(target) || fs.writeFileSync(path.join(target, 'VERSION'), manifest.version); // 兜底写版本
    sanityCheck(target);
    // 软链翻转（原子）：先写 current.tmp 再 rename 覆盖
    const link = path.join(installDir, 'current');
    const tmpLink = link + '.tmp';
    try { fs.unlinkSync(tmpLink); } catch {}
    fs.symlinkSync(path.basename(target), tmpLink);
    try { if (fs.existsSync(link) || fs.lstatSync(link)) fs.unlinkSync(link); } catch {}
    fs.renameSync(tmpLink, link);
    // 回滚保留：删除最旧的额外目录（current 与 keepOld-1 个保留）
    prune(installDir, keepOld);
    return { ok: true, version: manifest.version, from: curV || null, current: target };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function prune(installDir, keepOld) {
  const dirs = fs.readdirSync(installDir)
    .filter((e) => e.startsWith('v') && fs.statSync(path.join(installDir, e)).isDirectory())
    .map((e) => ({ e, v: versionOf(path.join(installDir, e)) || e }))
    // ⚠ P1-1 修复（2026-09-12）：**必须 semver 排序，不能字符串排序**。
    //   旧实现按字典序升序：['v0.7.0','v0.8.0','v0.9.0','v0.10.0'] → v0.10.0 排最前，
    //   而 prune 从**下标 0** 开删 → keep=3 时删掉的正是刚装上的 v0.10.0。
    //   后果：apply() 翻转 current 后立即删它 → current 悬空/回退，「回滚保留」语义被破坏。
    .sort((a, b) => semverCompare(a.v, b.v));
  const keep = keepOld + 1; // current 也算一个
  for (let i = 0; i < dirs.length - keep; i++) {
    try { fs.rmSync(path.join(installDir, dirs[i].e), { recursive: true, force: true }); } catch {}
  }
}

module.exports = { apply, fetchManifest, currentDir, versionOf };
