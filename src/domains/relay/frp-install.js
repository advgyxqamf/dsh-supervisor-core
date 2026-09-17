'use strict';

const zlib = require('node:zlib');

// frp 安装：平台标签 / 镜像 URL / 下载 / sha256 完整性校验 / 纯 JS 解压。
// 与进程托管（frp.js）按副作用生命周期切开，便于独立单测。
// 信任根：校验和从官方 GitHub 主机直连取得（frp_<ver>_checksums.txt），不经镜像前缀，
// 于是只控制镜像的攻击者无法同时伪造校验和。取不到时降级放行并记 warn；取得后不匹配即拒绝该镜像。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
// 平台知识唯一事实源：os/arch 到标签的映射只在 src/platform/contract/matrix.js。
const matrix = require('../../platform/contract/matrix');

const FRP_VERSION = '0.61.1';

// 下载镜像前缀（国内镜像优先，GitHub 官方兜底）。URL 主体按平台动态生成。
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  '', // GitHub 官方直连
];

/** FRP 官方发布平台标签：委托 matrix（唯一事实源），保持"不支持返回 null"不变。 */
function frpPlatformTag(platform, arch) {
  return matrix.frpTag(platform, arch);
}

function downloadUrls(asset) {
  const base = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/' + asset;
  return MIRROR_PREFIXES.map((p) => p + base);
}

/** HTTP(S) 下载（最多 5 跳重定向），返回完整 Buffer。 */
function download(url, report) {
  return new Promise((resolve, reject) => {
    const get = (u, redirectsLeft) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'dsh-supervisor' }, timeout: 60000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return get(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length']) || 0;
        const chunks = [];
        let got = 0;
        res.on('data', (c) => { chunks.push(c); got += c.length; if (total && report) report('progress ' + Math.round(got / total * 100) + '%'); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    };
    get(url, 5);
  });
}

/** 取官方校验和表里的期望 sha256（**直连官方主机，不经镜像**）。
 *  返回 null 表示取不到（离线/官方不可达）——调用方按「有界失败即放行」处理并记 warn。
 *  结果按 asset 缓存到调用方传入的 cache（一次安装只需取一次）。
 */
async function expectedSha256({ asset, download: dl, report, logger, cache }) {
  const c = cache || {};
  if (c[asset] !== undefined) return c[asset];
  const url = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/frp_' + FRP_VERSION + '_checksums.txt';
  try {
    const buf = await dl(url, () => {});
    const text = String(buf || '');
    // 官方格式：每行 "<64hex>  <filename>"
    const want = new RegExp('^([0-9a-fA-F]{64})\\s+\\*?' + asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm');
    const m = want.exec(text);
    const sum = m ? m[1].toLowerCase() : null;
    c[asset] = sum;
    if (!sum) {
      if (report) report('warn: 官方校验表中未找到 ' + asset + '，跳过完整性校验');
      if (logger && logger.warn) logger.warn('[frp] 校验表中未找到 ' + asset + '，跳过 sha256 校验（已直连官方取得校验表）');
    }
    return sum;
  } catch (e) {
    // 不缓存失败：离线一次不得让生命周期级 _sumCache 在本进程内永久跳过 sha256
    if (report) report('warn: 取官方校验和失败(' + e.message + ')，跳过完整性校验');
    if (logger && logger.warn) logger.warn('[frp] 取官方校验和失败：' + e.message + ' —— 本次不做 sha256 校验（镜像仍受 https 保护）');
    return null;
  }
}

/** 从 tar.gz 提取 frpc 二进制（纯 Node 实现 gzip+tar 解析）。 */
async function extractFrpc(tgzBuf, { destDir, binPath, frpTag }) {
  const tarData = await new Promise((resolve, reject) => {
    zlib.gunzip(tgzBuf, (e, d) => e ? reject(e) : resolve(d));
  });
  let offset = 0;
  while (offset + 512 <= tarData.length) {
    const header = tarData.slice(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.slice(0, 100).toString('utf8').split('\0')[0];
    const sizeStr = header.slice(124, 136).toString('utf8').replace(/[\0 ]/g, '');
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    // 平台化：Windows 官方产物内二进制为 frpc.exe；其余平台 frpc。
    const exe = !!(frpTag && frpTag.exe);
    const wantName = exe ? 'frpc.exe' : 'frpc';
    if ((name.endsWith('/' + wantName) || name === wantName) && (typeFlag === '0' || typeFlag === '\0')) {
      const data = tarData.slice(dataStart, dataStart + size);
      fs.writeFileSync(path.join(destDir, wantName), data);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!fs.existsSync(binPath)) throw new Error('frpc not found in archive (' + (frpTag ? frpTag.tag : 'unsupported') + ')');
}

/** 安装 frpc：镜像回退下载，完整性校验，解压，chmod。 */
async function installFrpc(ctx, onProgress) {
  const report = (msg) => { if (onProgress) try { onProgress(msg); } catch {} };
  fs.mkdirSync(ctx.binDir, { recursive: true });
  if (!ctx.frpTag) {
    const cur = matrix.current();
    if (ctx.events) ctx.events.append('frpc_install_failed', { detail: '当前平台无 frpc 官方产物: ' + cur.platform + '/' + cur.arch });
    return { ok: false, error: '当前平台不支持 FRP（' + cur.platform + '/' + cur.arch + '），仅 linux/darwin/win32 × x64/arm64' };
  }
  const asset = 'frp_' + FRP_VERSION + '_' + ctx.frpTag.tag + '.tar.gz';
  const urls = downloadUrls(asset);
  const expected = await expectedSha256({ asset, download: ctx.download, report, logger: ctx.logger, cache: ctx.sumCache });
  let lastErr = null;
  for (const url of urls) {
    try {
      report('download: ' + url.slice(0, 60) + '…');
      const tgz = await ctx.download(url, report);
      if (expected) {
        const got = crypto.createHash('sha256').update(tgz).digest('hex');
        if (got !== expected) {
          throw new Error('SHA256 校验失败（期望 ' + expected.slice(0, 12) + '… 实得 ' + got.slice(0, 12) + '…）——该镜像产物不可信，已拒绝');
        }
        report('SHA256 校验通过');
      }
      report('downloaded ' + Math.round(tgz.length / 1024) + 'KB, extracting…');
      await extractFrpc(tgz, { destDir: ctx.binDir, binPath: ctx.binPath, frpTag: ctx.frpTag });
      fs.chmodSync(ctx.binPath, 0o755);
      report('installed: ' + ctx.binPath);
      if (ctx.events) ctx.events.append('frpc_installed', {});
      return { ok: true, binPath: ctx.binPath };
    } catch (e) {
      lastErr = e;
      report('failed: ' + e.message + ', trying next mirror…');
    }
  }
  if (ctx.events) ctx.events.append('frpc_install_failed', { detail: lastErr ? lastErr.message : '' });
  return { ok: false, error: lastErr ? lastErr.message : 'all mirrors failed' };
}

module.exports = {
  frpPlatformTag,
  downloadUrls,
  download,
  installFrpc,
};
