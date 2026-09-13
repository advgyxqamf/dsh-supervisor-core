#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：frpc 下载必须校验完整性（2026-09-13 P1 安全）
//
// ## 缺陷（失效模式 b）
//
// frpc 经**两个第三方代理前缀 + 最多 5 跳重定向**下载（downloadUrls/_download），
// 却只校验 HTTP 200 与 gzip/tar 可解析，随即 chmod 0755 落盘并 detached 执行。
// 而同仓「下载二进制」的另一处（dist/self-update.js）**强制**从 manifest 取 sha256
// 后才安装 —— 同一类操作两处实现分叉，前者无任何完整性校验。
// 后果：镜像或链路被劫持/投毒即在用户机上写盘并执行任意二进制，无检测信号。
//
// ## 修法（信任根设计）
//
// 校验和从**官方 GitHub 主机直连**取得（frp_<ver>_checksums.txt），**不经镜像前缀** ——
// 于是「只控制镜像的攻击者」无法同时伪造校验和。
// 取不到校验和时降级放行但记 warn（本仓可用性原则：有界失败即放行）；
// 一旦取得校验和，**不匹配即拒绝该镜像**并尝试下一个。
//
// ## 门禁（行为级：桩掉网络层，断言拒绝/放行语义）
//   A 校验和不匹配 → install 必须失败且**不落盘** frpc
//   B 校验和匹配 → install 成功
//   C 取不到校验和 → 降级放行但**记 warn**（不静默）
//   D 校验和取自官方主机（不经镜像前缀）——结构断言，防信任根被换回镜像
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

/** 造一个合法的 tar.gz（内含 <tag>/frpc），用于桩 _download。 */
function makeTarGz(frpcBody) {
  const tag = 'frp_0.61.1_linux_amd64';
  const file = 'frpc';
  const data = Buffer.from(frpcBody, 'utf8');
  const header = Buffer.alloc(512);
  header.write(tag + '/' + file, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('0'.repeat(7) + '\0', 148, 8, 'ascii'); // 类型 0 = 普通文件
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  const end = Buffer.alloc(1024);
  return zlib.gzipSync(Buffer.concat([header, data, pad, end]));
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13frp-'));
  const { FrpManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frpmgr.js'));
  check('A 定位到 FrpManager', typeof FrpManager === 'function', typeof FrpManager);

  const goodTgz = makeTarGz('#!/bin/sh\necho frpc\n');
  const goodSum = crypto.createHash('sha256').update(goodTgz).digest('hex');
  const asset = 'frp_0.61.1_linux_amd64.tar.gz';

  const mk = (sumText, tgz) => {
    const warns = [];
    const mgr = new FrpManager({
      dir: path.join(TMP, 's-' + Math.random().toString(36).slice(2)),
      logger: { warn: (m) => warns.push(String(m)), info() {}, error() {} },
    });
    mgr.frpTag = { os: 'linux', arch: 'amd64', tag: 'linux_amd64', exe: false };
    mgr._sumCache = {};
    // 桩网络层：官方校验表 + 归档下载
    mgr._download = async (url) => {
      if (url.indexOf('_checksums.txt') >= 0) {
        if (sumText === null) throw new Error('official unreachable');
        return Buffer.from(sumText, 'utf8');
      }
      return tgz;
    };
    return { mgr, warns };
  };

  console.log('== A 校验和不匹配必须拒绝 ==');
  {
    const wrong = 'f'.repeat(64);
    const { mgr, warns } = mk(wrong + '  ' + asset + '\n', goodTgz);
    const r = await mgr.install(() => {});
    check('A install 失败（拒绝不可信产物）', r.ok === false, JSON.stringify(r).slice(0, 120));
    check('A 错误信息指出校验失败', /SHA256 校验失败/.test(r.error || ''), (r.error || '').slice(0, 60));
    check('A **未落盘** frpc（不执行不可信二进制）', !fs.existsSync(mgr.binPath), String(fs.existsSync(mgr.binPath)));
    void warns;
  }

  console.log('== B 校验和匹配必须放行 ==');
  {
    const { mgr } = mk(goodSum + '  ' + asset + '\n', goodTgz);
    const r = await mgr.install(() => {});
    check('B install 成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    check('B frpc 已落盘', fs.existsSync(mgr.binPath), '存在');
  }

  console.log('== C 取不到校验和 → 降级放行但记 warn ==');
  {
    const { mgr, warns } = mk(null, goodTgz);
    const r = await mgr.install(() => {});
    check('C 降级放行（可用优先，不阻断安装）', r.ok === true, JSON.stringify(r).slice(0, 120));
    check('C 但**记了 warn**（不静默）',
      warns.some((w) => /校验和失败|sha256 校验/.test(w)), JSON.stringify(warns).slice(0, 120));
  }

  console.log('== D 信任根：校验和必须直连官方、不经镜像 ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'frpmgr.js'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    //   ⚠ 必须**按行定界**断言，不能用无锚点的子串匹配 ——
    //     前者在「MIRROR_PREFIXES[0] + 'https://github.com/...'」下仍会命中（假绿，已实测）。
    const sumLine = code.split('\n').find((l) => l.indexOf('_checksums.txt') >= 0 && l.indexOf('const url') >= 0) || '';
    check('D 校验表 URL 表达式存在', sumLine.length > 0, sumLine.trim().slice(0, 80));
    check('D 校验表 URL 走官方 github.com 直连（不经 MIRROR_PREFIXES）',
      sumLine.indexOf('MIRROR_PREFIXES') < 0
      && /^\s*const url = 'https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v'/.test(sumLine),
      sumLine.trim().slice(0, 80));
    check('D 反向：判据能识别「经镜像取校验和」的形态',
      ('const url = MIRROR_PREFIXES[0] + ' + "'https://github.com/x/_checksums.txt';").indexOf('MIRROR_PREFIXES') >= 0,
      'hit');
    check('D 下载后计算 sha256 并与期望比对',
      /crypto\.createHash\('sha256'\)\.update\(tgz\)\.digest\('hex'\)/.test(code), '有');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
