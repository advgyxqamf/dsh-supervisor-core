#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P1：relay 必须有**来源闸**（回环 ∪ RFC1918），补上 config.js 长期声称的白名单
//
// ## 缺陷
//
// `platform/service/config.js` 的注释写着：
//     「不配置 = 维持现状（LAN 受 RFC1918 白名单约束，FRP 暴露仍强制 remoteToken）」
// 但全仓**从未实现**该 RFC1918 判定（grep 零命中）。
//
// 而 relay 监听 `0.0.0.0`（局域网可见），且会把 Origin/Referer **改写为回环权威**
// （「回环呈现」，用于让 DSH 的信任围栏放行特权方法面：settings/credentials/host.*）。
// 于是「谁连得上」就等于「谁拿到 DSH 特权面」。
//
// 叠加 `tokenGate` 的语义 —— `token === ''` 时**恒放行**：
//   · 用户只开了「远程控制」开关、没设 remoteToken（UI 不强制）
//   · → 同网段任何设备（访客 Wi-Fi / 被入侵的 IoT / 邻居）零认证驱动 DSH 特权接口。
//
// FRP（公网）侧本就有「强制 remoteToken」的闸（manager.js:105），故**不是**同一问题；
// 缺的是 LAN 这一档。
//
// ## 为什么 FRP 路径不受本次修复影响（重要）
//
// frpc 的配置是 `localIP = "127.0.0.1"` + `localPort = <wanPort>` —— 即：
//   公网请求先进 frpc，frpc **以回环身份**连 relay。
// 故 relay 看到的 remoteAddress 是 127.0.0.1 → 来源闸**放行**（正确，FRP 另有 token 闸）。
// 若来源闸基于「公网 IP」而非 socket 地址，反而会误杀 FRP 路径。
//
// ## 锁定不变量
//   S-a  存在来源闸函数，且复用 api/identity 的同一份 RFC1918 判定（不重写第二份）
//   S-b  HTTP 与 **WS 升级**两条路径都接入了该闸（WS 只挡一处会留下绕过）
//   S-c  回环、私有网段放行；公网拒绝（行为级）
//   S-d  FRP 路径（回环身份）不被误杀 —— 由 C 保证
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ⚠ 域改造后来源闸从 index.js 迁到服务本体（SSOT §5.2：proxy.js 承载来源闸/令牌闸/
//   HTTP/WS/热更新面）——单文件读取会静默失去覆盖面，故按**整域聚合**读取。
//   S-a 原判据断言的是**注释串** api/identity（注释一精简即失败）——改为语义判据：
//   闸所在文件必须以 require 引入共享 IP 实现，且该实现与 src/shared/ip.js **同一对象**。
const relayDir = path.join(ROOT, 'src', 'domains', 'relay');
const relayFiles = fs.readdirSync(relayDir).filter((f) => f.endsWith('.js')).sort();
/** 去注释：源码级判据必须区分「代码」与「说明代码的文字」。 */
const stripAll = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const src = relayFiles.map((f) => fs.readFileSync(path.join(relayDir, f), 'utf8')).join(String.fromCharCode(10));
const srcCode = relayFiles.map((f) => stripAll(fs.readFileSync(path.join(relayDir, f), 'utf8'))).join(String.fromCharCode(10));

// ── S-a：存在闸 + 复用**同一份**判定（不重写第二份 RFC1918）──
check('S-a 存在 isTrustedSource 来源闸', /function\s+isTrustedSource\s*\(/.test(srcCode), '有');
{
  const sharedIp = require(path.join(ROOT, 'src', 'shared', 'ip.js'));
  let reuse = false;
  for (const f of relayFiles) {
    const code = stripAll(fs.readFileSync(path.join(relayDir, f), 'utf8'));
    if (!/isPrivateIpv4\s*\(/.test(code)) continue;
    for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      let mod;
      try { mod = require(path.resolve(relayDir, m[1])); } catch { continue; }
      if (mod && mod.isPrivateIpv4 === sharedIp.isPrivateIpv4
        && mod.isLoopbackAddress === sharedIp.isLoopbackAddress) { reuse = true; break; }
    }
    if (reuse) break;
  }
  check('S-a 来源闸复用共享 IP 判定（与 shared/ip 同一实现，不重写第二份）',
    reuse, reuse ? '复用' : '未复用共享实现');
}
// 反向：域内不得自己定义第二份 isPrivateIpv4（那才是「两处实现」）
check('S-a 域内未定义第二份 isPrivateIpv4',
  !/function\s+isPrivateIpv4\s*\(/.test(srcCode), '未重写');

// ── S-b：两条路径都接入 ──
const httpHas = /if \(!isTrustedSource\(req\)\)/.test(srcCode);
const wsHas = /if \(!isTrustedSource\(req, socket\)\)/.test(srcCode);
check('S-b HTTP 路径接入来源闸', httpHas, '有');
check('S-b WS 升级路径接入来源闸（只挡 HTTP 会留绕过）', wsHas, '有');

// ── S-c：行为级 —— 直接验证判定逻辑 ──
//   把 identity 的判定按 relay 的归一逻辑跑一遍（含 IPv4-mapped 形态）。
const { isLoopbackAddress, isPrivateIpv4 } = require(path.join(ROOT, 'src', 'api', 'identity.js'));
function trusted(addr) {
  if (!addr) return false;
  const norm = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
    ? addr.replace(/^::ffff:/i, '')
    : addr.toLowerCase();
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
}

check('S-c 127.0.0.1 放行（本机）', trusted('127.0.0.1') === true);
check('S-c ::1 放行（本机 IPv6）', trusted('::1') === true);
check('S-c ::ffff:127.0.0.1 放行（IPv4-mapped）', trusted('::ffff:127.0.0.1') === true);
check('S-c 192.168.x 放行（局域网）', trusted('192.168.1.9') === true);
check('S-c 10.x 放行', trusted('10.0.0.5') === true);
check('S-c 172.16.x 放行', trusted('172.16.0.7') === true);
check('S-c 公网 8.8.8.8 拒绝', trusted('8.8.8.8') === false);
check('S-c 公网 IPv6 拒绝', trusted('2001:4860:4860::8888') === false);
check('S-c 边界 172.32.x 拒绝（非私有）', trusted('172.32.0.1') === false);
check('S-c 空地址拒绝', trusted('') === false);

// ── S-d：FRP 路径不被误杀（frpc 以回环身份转发）──
{
  // frp 配置随域改造可能从 frpmgr.js 改名/搬移（SSOT §5.2：frp.js / frp-install.js）——
  //   按整域聚合读取。
  check('S-d frpc 的 localIP 是 127.0.0.1（故来源闸会放行 FRP 流量）',
    /localIP = "127\.0\.0\.1"/.test(src), '确认');
  check('S-d 因此回环判定必须放行（否则 FRP 会被误杀）', trusted('127.0.0.1') === true, '放行');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);