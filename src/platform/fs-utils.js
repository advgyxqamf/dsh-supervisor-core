'use strict';

// 通用文件系统工具（infra 层：与业务无关，供各域复用）。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** 纯 Node 解包 tar.gz（无外部 tar 依赖，跨平台一致——2026-09 审计：
 *  self-update 原用 execFileSync('tar')，Windows 无 GNU tar 使守卫自更新不可用）。
 *  支持：GNU 长名（'L' 头）、目录、普通文件、符号链接、stripComponents。
 *  安全：member 名经规范化后必须落在 destDir 内（防 tar 路径穿越写任意位置）。
 *  @param {Buffer} tgzBuf gzip 压缩的 tar 数据
 *  @param {string} destDir 解包目标目录（自动创建）
 *  @param {object} opts { stripComponents?: number } 默认 1（剥离首层目录，如 pkg-1.0.0/）
 *  @returns {string[]} 解包出的文件相对路径 */
function extractTarGz(tgzBuf, destDir, opts) {
  const strip = (opts && opts.stripComponents !== undefined) ? opts.stripComponents : 1;
  const tarData = zlib.gunzipSync(tgzBuf);
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  const stripName = (name) => {
    const parts = String(name).split('/').filter((p) => p !== '' && p !== '.');
    const cut = Math.min(strip, parts.length - 1);
    const rel = parts.slice(cut).join('/');
    // 归一化并防穿越：任何残留 .. 段或绝对路径都拒绝
    if (!rel || rel.split('/').some((s) => s === '..') || rel.startsWith('/')) return null;
    return rel;
  };
  let offset = 0;
  let pendingLong = null;
  while (offset + 512 <= tarData.length) {
    const header = tarData.slice(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.slice(0, 100).toString('utf8').split('\0')[0];
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/[\0 ]/g, ''), 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const data = tarData.slice(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (pendingLong !== null) { name = pendingLong; pendingLong = null; }
    if (typeFlag === 'L') { pendingLong = name; continue; } // GNU 长名头：下一记录用此名
    const rel = stripName(name);
    if (rel === null) continue; // 剥离后为空（顶层目录）或非法（穿越）
    const target = path.join(destDir, rel);
    if (typeFlag === '5') { fs.mkdirSync(target, { recursive: true }); continue; } // 目录
    if (typeFlag === '2') { // 符号链接
      const linkTo = header.slice(157, 157 + 100).toString('utf8').split('\0')[0];
      try { fs.unlinkSync(target); } catch {}
      fs.symlinkSync(linkTo, target);
      continue;
    }
    // 普通文件（'0'/NUL/'\0'）：确保父目录存在后写入
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(rel);
  }
  return written;
}

/**
 * 同步统计目录体积（字节）。有界：最大遍历 200k 条目防失控；符号链接跳过（防循环/双计）。
 * 用于"某目录占多大"的展示统计（如已装插件体积）。
 */
function dirSizeBytes(root) {
  let total = 0;
  let seen = 0;
  const MAX = 200000;
  const walk = (dir) => {
    if (seen > MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      if (seen > MAX) return;
      const full = path.join(dir, en.name);
      if (en.isSymbolicLink()) continue; // 链接不递归（防循环）；其目标体积由真实目录统计
      if (en.isDirectory()) walk(full);
      else if (en.isFile()) {
        try { const st = fs.statSync(full); total += st.size; } catch {}
      }
      seen++;
    }
  };
  try { walk(root); } catch {}
  return total;
}

module.exports = { dirSizeBytes, extractTarGz };
