#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 发布通道门禁（内核侧）—— SSOT: RELEASE-CHANNEL-CONTRACT.md §6
//
// ## 断言
//   RC-G3 内核选版「优先读 latest」（结构断言 + 行为断言）
//         · 结构：src/platform/distribution/index.js 的 fetchNpmLatest 读 dist-tags.latest，
//                 且不再「dist-tags 全部值 ∪ versions 全部键」取最高
//         · 行为：假 registry 上 latest=0.1.6-RC.1 而 versions 另有数字更高的
//                 0.2.0-BETA.1 —— 契约 §3③ 要求返回 latest（通道控制）
//   RC-G4 发布脚本 release/scripts/publish-core.sh：'-RC.*' 分支必须带 '--tag latest'（RC-6）
//         · BETA → '--tag beta'（绝不碰 latest）；rc 只作发布后补打的别名
//         · rollback / canary 不由发布脚本设置（人工运维，契约 §4）
//   RC-G5 反向：判据能识别「仅取全量最高」的旧形态（门禁非空转）
//   附    RC-G1/G2 交叉断言：只读**壳仓** core.rs 源码（壳实现归分片1，本仓不改）
//
// ## 现状（如实记录；本文件不改实现）
//   RC-G3 在本门禁建立时**未落地**：fetchNpmLatest 仍是「tags ∪ versions 取最高」，
//   违反不变量 RC-1（BETA 数字可压过 RC）。壳仓 core.rs::latest_version 同形态，
//   且无 rollback 分支。故 RC-G3 / RC-G1-x / RC-G2-x 预期 FAIL，直到分片2 / 分片1 落地。
//   这是如实报告，不是门禁空转 —— RC-G5 证明判据能区分两种形态。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const splitLines = (s) => s.split(String.fromCharCode(10));

/** 剥离 JS 注释（保留字符串字面量），避免注释里的示例文字参与结构判定。 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const BT = String.fromCharCode(96);
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === BT) { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } else { out += ' '; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n') ? c : ' ';
      i++; continue;
    }
    if (c === '\\') { out += c + (n || ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === BT)) state = 'code';
    out += c; i++;
  }
  return out;
}

/** 剥离整行注释（// 或 # 开头）——用于 Rust / shell 的结构判定。 */
function withoutCommentLines(src) {
  return splitLines(src).map((l) => (/^\s*(\/\/|#)/.test(l) ? '' : l)).join(String.fromCharCode(10));
}

// ── 判据（正/反共用；RC-G5 对它们做反向断言，证明门禁非空转）──

/** 「优先读 dist-tags.latest」形态判据（JS / Rust 通用）。 */
function readsLatestTag(src) {
  return /\btags\s*\.\s*latest\b/.test(src)
    || /\btags\s*\[\s*['"]latest['"]\s*\]/.test(src)
    || /get\(\s*['"]dist-tags['"]\s*\)[\s\S]{0,120}get\(\s*['"]latest['"]\s*\)/.test(src);
}

/** 「仅取全量最高」旧形态判据：dist-tags 的全部值 ∪ versions 的全部键后取最高。 */
function isUnionMax(src) {
  const jsUnion = /new Set\(\s*\[[\s\S]{0,160}\bversions\b/.test(src);
  const rustUnion = /get\(\s*['"]dist-tags['"]\s*\)/.test(src) && /get\(\s*['"]versions['"]\s*\)/.test(src);
  return jsUnion || rustUnion;
}

/** 旧「全量最高」算法的本地复现（仅用于 RC-G5 反向，不触碰生产代码）。 */
function legacyUnionMax(meta) {
  const tags = (meta && meta['dist-tags']) || {};
  const versions = Object.keys((meta && meta.versions) || {});
  const cands = Array.from(new Set([].concat(Object.values(tags), versions)));
  let best = null;
  for (const v of cands) if (!best || semverCompare(v, best) > 0) best = v;
  return best;
}

const DIST_DIR = 'src/platform/distribution';
const SCRIPT_REL = 'release/scripts/publish-core.sh';
/** ⚠ 2026-09-17（域结构第三轮）：distribution 已拆分（release/policies/registry/install + index 门面），
 *  结构断言的对象是「分发能力」而非单文件，故按目录聚合读取（读取面随文件搬移同步，判据语义不变）。 */
const readDist = () => fs.readdirSync(path.join(ROOT, DIST_DIR)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, DIST_DIR, f), 'utf8')).join(String.fromCharCode(10));

// fixture：契约 §3③ 与「全量最高」在**同一份元数据**上给出不同答案
const META_A = {
  name: '@dsh-sup/dsh-core-test-x64',
  'dist-tags': { latest: '0.1.6-RC.1', beta: '0.2.0-BETA.1' },
  versions: { '0.1.5-BETA.7': {}, '0.1.6-RC.1': {}, '0.2.0-BETA.1': {} },
};
const META_B = {
  name: '@dsh-sup/dsh-core-test-x64',
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': {}, '9.9.9': {} },
};

const { DistributionManager, semverCompare } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));

/** 假 registry：只提供被测包元数据与 /-/ping，门禁不依赖真实网络。 */
function startFakeRegistry() {
  const state = { meta: META_A };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(String(req.url || '').split('?')[0]);
    if (url === '/-/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (url === '/' + META_A.name) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.meta));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port,
        set: (m) => { state.meta = m; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  // ═══ RC-G3 结构 ═══
  console.log('== RC-G3 内核选版优先读 latest（结构）==');
  {
    const src = stripJsComments(readDist());
    check('RC-G3-a fetchNpmLatest 存在（内核「我们的包」选版入口）',
      /\bfetchNpmLatest\s*\(/.test(src), DIST_DIR);
    check('RC-G3-b 选版读 dist-tags.latest（RC-1）',
      readsLatestTag(src), readsLatestTag(src) ? 'ok' : '未见 tags.latest 读取点（仍按全量最高）');
    check('RC-G3-c 选版不再并集 versions 取最高（RC-1）',
      !isUnionMax(src), isUnionMax(src) ? '检测到 dist-tags ∪ versions 取最高（旧形态）' : 'ok');
    const rc = read('src/platform/contract/registry.js');
    check('RC-G3-d 镜像契约 selected 不含版本字段（latest 只来自 registry 元数据）',
      !/dist-?tags/.test(rc), 'ok');
  }

  // ═══ RC-G4 发布脚本 ═══
  console.log('== RC-G4 publish-core.sh：-RC.* 必须带 --tag latest ==');
  {
    const sh = read(SCRIPT_REL);
    const ls = splitLines(sh);
    const rcLine = ls.find((l) => /^\s*\*-RC\.\*\)/.test(l));
    const betaLine = ls.find((l) => /^\s*\*-BETA\.\*\)/.test(l));
    check('RC-G4-a case 分支 -RC.* 存在', !!rcLine, rcLine ? rcLine.trim() : '未找到');
    check('RC-G4-b -BETA.* 带 --tag beta（不碰 latest）',
      !!betaLine && /--tag\s+beta\b/.test(betaLine), betaLine ? betaLine.trim() : '未找到');
    check('RC-G4-c -RC.* 带 --tag latest（RC-6：正式发布必更新 latest）',
      !!rcLine && /--tag\s+latest\b/.test(rcLine), rcLine ? rcLine.trim() : '未找到');
    check('RC-G4-d RC 分支不再以 rc 为主标签（不得 --tag rc）',
      !!rcLine && !/--tag\s+rc\b/.test(rcLine), 'ok');

    const code = withoutCommentLines(sh);
    const addIdx = code.indexOf('dist-tag add');
    const pubIdx = code.indexOf('npm publish --access public');
    check('RC-G4-e rc 别名经 npm dist-tag add ... rc 在 publish 之后补打',
      addIdx > 0 && pubIdx > 0 && addIdx > pubIdx && /dist-tag add\s+"\$PKG_NAME@\$VER"\s+rc/.test(sh),
      'dist-tag add@' + addIdx + ' / publish@' + pubIdx);

    const autoChannel = splitLines(code)
      .filter((l) => /dist-tag\s+(add|rm)/.test(l) && /\b(rollback|canary)\b/.test(l));
    check('RC-G4-f 发布脚本不自动设置 rollback / canary（人工运维，§4）',
      autoChannel.length === 0, autoChannel.length ? autoChannel.join(' | ') : '无自动设置点');

    const manualLine = ls.find((l) => /^\s*#/.test(l) && /rollback/.test(l) && /canary/.test(l) && /人工/.test(l));
    check('RC-G4-g 脚本注释声明 rollback / canary 由人工运维设置（§4）',
      !!manualLine, manualLine ? manualLine.trim() : '未找到');

    check('RC-G4-h 防误发保护：默认 dry-run（PUBLISH=0）+ 显式 --publish 且仅 CI',
      /防误发/.test(sh) && /PUBLISH=0\b/.test(sh) && /npm publish --dry-run/.test(sh) && /GITHUB_ACTIONS/.test(sh),
      'ok');
  }

  // ═══ RC-G5 反向 ═══
  console.log('== RC-G5 反向：判据能识别「取全量最高」旧形态（门禁非空转）==');
  {
    const LEGACY = "const candidates = new Set([...Object.values(tags), ...versions].filter((v) => VERSION_RE.test(v)));";
    const CONFORMING = "const tags = (j && j['dist-tags']) || {}; const latest = tags.latest; if (latest) return latest;";
    const RUST_LEGACY = 'let obj = j.get("dist-tags"); let obj2 = j.get("versions");';
    const RUST_CONFORMING = 'let latest = j.get("dist-tags").and_then(|x| x.get("latest")).and_then(|x| x.as_str());';

    check('RC-G5-a 判据把 tags 值 ∪ versions 键 取最高判为旧形态', isUnionMax(LEGACY), 'hit');
    check('RC-G5-b 判据不误报契约形态（只读 tags.latest）', !isUnionMax(CONFORMING), 'ok');
    check('RC-G5-c 判据能识别契约形态的 latest 读取点', readsLatestTag(CONFORMING), 'hit');
    check('RC-G5-d 判据把 Rust 旧形态判为旧形态', isUnionMax(RUST_LEGACY), 'hit');
    check('RC-G5-e 判据不误报 Rust 契约形态',
      !isUnionMax(RUST_CONFORMING) && readsLatestTag(RUST_CONFORMING), 'ok');
    check('RC-G5-f 同一 fixture 上旧算法给出与契约不同的答案（判据有分辨力）',
      legacyUnionMax(META_A) === '0.2.0-BETA.1' && META_A['dist-tags'].latest === '0.1.6-RC.1',
      '旧算法=' + String(legacyUnionMax(META_A)) + '；契约期望=' + META_A['dist-tags'].latest);
  }

  // ═══ RC-G1 / RC-G2 交叉（只读壳仓源码；实现归分片1）═══
  console.log('== RC-G1/G2 交叉：壳仓 core.rs（只读；实现归分片1）==');
  {
    const shellCore = path.join(ROOT, '..', 'dsh-supervisor-launcher', 'src-tauri', 'src', 'core.rs');
    if (!fs.existsSync(shellCore)) {
      check('RC-G1-x 壳 core.rs 含 rollback 分支（交叉）', true,
        '壳仓工作树不可见 → 跳过（实现归分片1）');
      check('RC-G2-x 壳 core.rs 优先读 latest（交叉）', true, '壳仓工作树不可见 → 跳过');
    } else {
      const core = withoutCommentLines(fs.readFileSync(shellCore, 'utf8'));
      const hasRollback = /["']rollback["']/.test(core);
      check('RC-G1-x 壳 core.rs 含 rollback 分支且优先（交叉）', hasRollback,
        hasRollback ? 'ok' : '未见 rollback 分支（分片1 待落地）');
      const union = isUnionMax(core);
      check('RC-G2-x 壳 core.rs 优先读 latest（交叉）', !union,
        union ? '检测到 dist-tags ∪ versions 取最高（旧形态；分片1 待落地）' : 'ok');
    }
  }

  // ═══ RC-G3 行为（假 registry）═══
  console.log('== RC-G3 内核选版优先读 latest（行为，假 registry）==');
  {
    const fake = await startFakeRegistry();
    try {
      const dist = new DistributionManager({ registries: [fake.origin], registryFile: null, logger: { warn() {} } });
      dist._reloadContractIfStale = () => {};
      dist.selectRegistry = async () => fake.origin;
      dist.selectedRegistry = {
        origin: fake.origin, latencyMs: 1, checkedAt: Date.now(), manual: false, probes: [],
      };

      fake.set(META_A);
      const gotA = await dist.fetchNpmLatest(META_A.name, { authoritative: true });
      check('RC-G3-e 行为：latest=RC 时返回 latest（BETA 数字更高不得压过）',
        gotA === META_A['dist-tags'].latest,
        '返回 ' + String(gotA) + '（契约 §3③ 期望 ' + META_A['dist-tags'].latest + '）');

      fake.set(META_B);
      const gotB = await dist.fetchNpmLatest(META_B.name, { authoritative: true });
      check('RC-G3-f 行为：latest=1.0.0 / max=9.9.9 → 仍返回 latest（不得猜最高）',
        gotB === '1.0.0', '返回 ' + String(gotB) + '（契约 §3③ 期望 1.0.0）');
    } finally {
      await fake.close();
    }
  }
}

main().then(() => {
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  if (failed.length) {
    console.log('说明：RC-G3-* / RC-G1-x / RC-G2-x 是契约 §6 的待落地项（分片2 / 分片1 负责）；');
    console.log('      本门禁如实报告现状，判据有分辨力（见 RC-G5），非空转。');
  }
  process.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.log('FAIL 门禁运行异常: ' + ((e && e.stack) || e));
  process.exit(1);
});
