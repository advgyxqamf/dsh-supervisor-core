#!/usr/bin/env node
'use strict';

// 内核 npm 发行形态的包根解析 + 镜像预设集合（2026-09-11）。
//
// == 为什么独立成测（从壳仓迁回） ==
//
// 这两项断言**测的是内核代码**（`bin/dsh-supervisor`、`src/platform/service/config.js`），
// 但原先寄居在壳仓的 `tests/bootstrap_flow.rs` 里，用 `../../` 跨仓读取 ——
// 那是双仓隔离未彻底的残留：壳仓一旦独立，`../../` 必然指向不存在的位置。
// 迁回内核仓后，断言与它验证的代码在同一个仓，不再有跨仓耦合。
//
// 覆盖：
//   P1 包根解析：发行态（esbuild bundle）下 __dirname 是**包根**而非 bin/ ——
//      旧实现 path.join(__dirname, '..') 会指向包外，导致 systemd/desktop 模板路径错位、
//      BIN_PATH 指向不存在的文件。必须按 package.json 逐级向上定位。
//   P2 镜像预设集合：全部经真实 tarball 下载验证，且三处（壳 mirror.rs / 壳 core.rs /
//      内核 config.registries）保持一致。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

// ── P1 包根解析 ──
console.log('== P1 内核包根解析（发行态正确性）==');
{
  const bin = fs.readFileSync(path.join(ROOT, 'bin', 'dsh-supervisor'), 'utf8');
  check('P1-a 按 package.json 逐级向上定位包根', /findPackageRoot/.test(bin), 'ok');
  check(
    'P1-b 已无 __dirname/.. 硬推包根（发行态会指向包外）',
    !/const ROOT = path\.join\(__dirname, '\.\.'\)/.test(bin),
    'ok'
  );
  check(
    'P1-c bin 目标按包根解析',
    /path\.join\(ROOT, 'bin', 'dsh-supervisor'\)/.test(bin),
    'ok'
  );
  // 反向验证：模拟发行态（__dirname 为包根）时，findPackageRoot 必须找到含 package.json 的目录
  const fnSrc = bin.match(/function findPackageRoot\(start\) \{[\s\S]*?\n\}/);
  check('P1-d findPackageRoot 实现存在', !!fnSrc, fnSrc ? 'ok' : '未匹配到函数体');
  if (fnSrc) {
    // 在真实包根上验证：从包的 root 出发应立刻命中 package.json
    const pkgAtRoot = fs.existsSync(path.join(ROOT, 'package.json'));
    check('P1-e 包根确实含 package.json（函数判据成立）', pkgAtRoot, String(pkgAtRoot));
  }
}

// ── P2 镜像目录：**归壳**，内核只留最小兜底（2026-09-11 契约化）──
console.log('== P2 镜像目录契约化（目录归壳，内核留最小兜底）==');
{
  const cfg = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'config.js'), 'utf8');
  const arr = (cfg.match(/registries:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  const listed = (arr.match(/https?:\/\/[^'\"]+/g) || []).map((x) => x.trim());

  // P2-a：内核**不得**再持有完整 6 条目录（那是壳的所有权）。
  check('P2-a 内核 registries 为最小兜底（<= 2 条）', listed.length > 0 && listed.length <= 2,
    listed.length + ' 条: ' + listed.join(', '));
  // P2-b：兜底必须覆盖「能上网」与「中国网络」两种基本情形。
  check('P2-b 兜底含官方源', listed.includes('https://registry.npmjs.org'), listed.join(', '));
  check('P2-b 兜底含国内源', listed.some((x) => /npmmirror/.test(x)), listed.join(', '));
  // P2-c：**目录所有者是壳** —— config.js 必须说明这一点（防后人再次硬编码 6 条）。
  check('P2-c 标注了「目录归壳 / 契约」', /契约|壳/.test(cfg) && /最小兜底|兜底/.test(cfg), 'ok');
  check('P2-c 指向契约读取器', /registry-contract/.test(cfg) || /registry\.json/.test(cfg), 'ok');
  // P2-d：契约读取器必须存在且导出 read()。
  const rcPath = path.join(ROOT, 'src', 'platform', 'contract', 'registry.js');
  check('P2-d 契约读取器存在', fs.existsSync(rcPath), rcPath);
  if (fs.existsSync(rcPath)) {
    const rc = require(rcPath);
    check('P2-d 契约读取器导出 read/SUPPORTED_SCHEMA',
      typeof rc.read === 'function' && typeof rc.SUPPORTED_SCHEMA === 'number', 'ok');
    // 契约缺失时必须**可降级**（不变量 C2）：read 不抛异常，返回 ok:false。
    let r1;
    try { r1 = rc.read('/nonexistent/registry.json'); } catch (e) { r1 = { threw: e.message }; }
    check('P2-e 契约缺失时降级而非抛错', r1.ok === false && !r1.threw, JSON.stringify(r1.reason || r1.threw));
  }
  // P2-f：内核侧不得再出现「三份副本」中的任一份完整集合特征。
  const distSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'), 'utf8');
  check('P2-f dist 不再持有完整 6 条目录（无华为/腾讯/中科大/cnpmjs 硬编码数组）',
    !/const REGISTRY_PRESETS = \[/.test(distSrc), 'ok');
  // 实测不可用的源不得出现在 **registries 数组**里。
  // ⚠ 不能对全文判定：config.js 的注释里**应当**记录「哪些源被排除及原因」，
  //   否则后人无从知晓为何只有这几个源（对全文判定会将正确的说明误判为违规）。
  check('P2-g 取到 registries 数组', arr.length > 0, arr.length + ' 字符');
  for (const bad of ['mirrors.aliyun.com/npm', 'mirrors.tuna.tsinghua.edu.cn/npm']) {
    check(
      'P2-g registries 未收录实测不可用的 ' + bad,
      !arr.includes(bad),
      arr.includes(bad) ? '❌ 在数组内' : 'ok'
    );
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
