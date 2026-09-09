'use strict';

// 守卫自更新核心（Phase2）：清单 → 下载 → SHA256 校验 → 解包 → 版本目录 + current 软链翻转 → 回滚保留。
// 与发行通道解耦：manifest 只要求 { version, url, sha256 }（GitHub Releases / CDN / 本地 HTTP 皆可）。
// 语义：installDir 下 v<version>/ 为版本目录，current 软链指向当前启用版本；失败不动 current（天然回滚）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process'); // sanityCheck 的 node --check 语法自检用
const { extractTarGz } = require('../../platform/fs-utils');

async function httpGetBytes(url, timeoutMs = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchManifest(manifestUrl) {
  const raw = (await httpGetBytes(manifestUrl)).toString('utf8');
  const m = JSON.parse(raw);
  const version = String(m.version || '').trim();
  const url = String(m.url || '').trim();
  const sha256 = String(m.sha256 || '').trim().toLowerCase();
  if (!version.startsWith('v')) throw new Error('manifest.version 非法: ' + version);
  if (!/^https?:\/\//.test(url)) throw new Error('manifest.url 必须为 http(s): ' + url);
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
    if (v && (!best || v > best[0])) best = [v, full];
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
    execFileSync(process.execPath, ['--check', bin], { stdio: 'pipe' }); // 零依赖：语法自检即冒烟
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
    .sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  const keep = keepOld + 1; // current 也算一个
  for (let i = 0; i < dirs.length - keep; i++) {
    try { fs.rmSync(path.join(installDir, dirs[i].e), { recursive: true, force: true }); } catch {}
  }
}

module.exports = { apply, fetchManifest, currentDir, versionOf };
