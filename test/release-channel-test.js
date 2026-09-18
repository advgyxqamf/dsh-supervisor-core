#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 发布通道选版门禁（RELEASE-CHANNEL-CONTRACT §3）
//
// ## 锁定的不变量
//   RC-1  我们的包**优先信 latest**；latest 合法时绝不返回 versions 最高
//   RC-2  rollback 优先级**高于一切**（含灰度）
//   RC-3  第三方包**不得**套用通道语义——取 dist-tags ∪ versions 全量最高（旧语义不变）
//   RC-4  灰度是**定向**的：名单外机器看到 canary tag 也不得取它
//   RC-5  任一环节失败必须返回 null（明确失败），绝不猜
//   §3五步  ①②③④⑤ 逐条覆盖
//   收敛  选版算法只有一份实现（dist/index.js::pickReleaseVersion），调用点只负责拉取与分流
//   反向  判据能识别「取全量最高」的旧形态（门禁非空转）
//
// ## 为什么有本门禁
//   fetchNpmLatest 原先对**所有**包都「取全量最高」——对我们的包这会绕过通道控制
//   （BETA 的数字可能压过 RC，契约 §2 已论证）。现收口为 dist/index.js 导出的
//   唯一实现 pickReleaseVersion；本门禁把 §3 五步与「第三方不变」钉死。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
// 选版算法是 dist 导出的**唯一实现**（契约 §3）——本测试直接测它，不另建实现。
const channel = dist;
const { VERSION_RE, semverCompare } = dist;

const OPTS_MINE = { isOurs: true, isValid: (v) => VERSION_RE.test(v) };
const OPTS_THIRD = { isOurs: false, isValid: (v) => VERSION_RE.test(v) };
const meta = (tags, versions) => ({ 'dist-tags': tags, versions: versions || {} });
const obj = (arr) => arr.reduce((m, v) => { m[v] = {}; return m; }, {});

// ── 包归属判定（契约 §1 边界）──
{
  check('归属 我们的内核包 → isOurReleasePackage', channel.isOurReleasePackage('@dsh-sup/dsh-core-linux-x64') === true);
  check('归属 我们的壳发布包 → isOurReleasePackage', channel.isOurReleasePackage('@dsh-sup/shell-release') === true);
  check('归属 第三方 DSH 本体 → 非我们的', channel.isOurReleasePackage('@deepseek-ai/dsh') === false);
  check('归属 第三方代理包 → 非我们的', channel.isOurReleasePackage('commandcode-api-proxy') === false);
}

// ── §3 ①：rollback 最高优先级 ──
{
  const m = meta({ rollback: '0.1.5-BETA.6', canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', '0.1.5-BETA.6', '0.1.6-BETA.1']));
  check('① rollback 存在 → 返回它（即使同时有 canary+latest）',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === '0.1.5-BETA.6');
  check('RC-2 rollback 压过灰度（名单内也回退）',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === '0.1.5-BETA.6');
  check('RC-2 rollback 与版本高低无关（可低于 max）',
    channel.pickReleaseVersion(meta({ rollback: '0.1.0', latest: '0.2.0' }, obj(['0.1.0', '0.2.0'])), OPTS_MINE) === '0.1.0');
}

// ── §3 ②：灰度定向 ──
{
  const m = meta({ canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', '0.1.6-BETA.1']));
  check('② 名单内 + canary 合法 → 返回 canary',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === '0.1.6-BETA.1');
  check('RC-4 名单外 → 忽略 canary，取 latest',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: false }) === '0.1.4');
  check('RC-4 canary tag 全局存在但不影响非名单机器', channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('② canary 非法（脏 tag）→ 跳过，取 latest',
    channel.pickReleaseVersion(meta({ canary: 'not-a-version', latest: '0.1.4' }, {}), { ...OPTS_MINE, canary: true }) === '0.1.4');

  // ── 防回归（2026-09-16）：灰度判定**不得**以"名单包存在"为依据 ──
  //   曾经的错误实现：`_inCanaryList()` 里"装了 @dsh-sup/canary-allowlist 就算命中"。
  //   那是"全员灰度"（该包为所有候选机共用），与"定向"的初衷相反。
  //   契约 §5.3 已冻结正确语义（读**内容** + schema===1 + installId/hostnames 匹配）；
  //   且该包当前**未发布**（§5.3 预留），故判定应恒为"非灰度"，只走本地开关。
  // ⚠ 2026-09-17（域结构第三轮）：distribution 已拆分，按目录聚合读取。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const distSrc = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  check('防回归 灰度判定不得以"名单包存在"为依据（包存在 ≠ 在名单里）',
    !/canaryPkgPresent/.test(distSrc) && !/existsSync\([^)]*canary-allowlist/.test(distSrc), 'ok');
  check('防回归 当前只认本地开关（canary === true）',
    /isInCanaryList\([^)]*\)\s*\{[\s\S]{0,200}?canary === true/.test(distSrc), 'ok');
}

// ── §3 ③：优先信 latest（RC-1）──
{
  const m = meta({ latest: '0.1.4' }, obj(['0.1.4', '0.1.5-BETA.7', '0.1.6-BETA.1']));
  check('③ latest 存在 → 返回它（RC-1：不取全量最高）', channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('RC-1 反向：全量最高 ≠ latest 时不得取最高', channel.pickReleaseVersion(m, OPTS_MINE) !== '0.1.6-BETA.1');
  check('③ latest 为合法预发布号也可用',
    channel.pickReleaseVersion(meta({ latest: '0.2.0-RC.1' }, obj(['0.2.0-RC.1'])), OPTS_MINE) === '0.2.0-RC.1');
}

// ── §3 ④：latest 缺失/非法 → versions 最高（兼容兜底）──
{
  check('④ latest 缺失 → versions 最高',
    channel.pickReleaseVersion(meta({}, obj(['0.1.3', '0.1.5-BETA.7', '0.1.4'])), OPTS_MINE) === '0.1.5-BETA.7');
  check('④ latest 非法 → versions 最高',
    channel.pickReleaseVersion(meta({ latest: 'garbage' }, obj(['0.1.3', '0.1.4'])), OPTS_MINE) === '0.1.4');
  check('④ 兜底只认 versions（不含 dist-tags 中的低值）',
    channel.pickReleaseVersion(meta({ bad: '0.9.9' }, obj(['0.1.1', '0.1.2'])), OPTS_MINE) === '0.1.2');
}

// ── §3 ⑤：皆无 → null（绝不猜）──
{
  check('⑤ 空元数据 → null', channel.pickReleaseVersion(meta({}, {}), OPTS_MINE) === null);
  check('⑤ 全为非法版本 → null', channel.pickReleaseVersion(meta({ latest: 'x' }, obj(['1.0', 'v2'])), OPTS_MINE) === null);
  check('⑤ 缺 meta → null', channel.pickReleaseVersion(null, OPTS_MINE) === null);
  check('⑤ latest 非法且 versions 空 → null', channel.pickReleaseVersion(meta({ latest: 'garbage' }, {}), OPTS_MINE) === null);
}

// ── 第三方包：RC-3「取全量最高」语义不变 ──
{
  const m = meta({ latest: '1.0.0', alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0', '1.2.0-alpha.1']));
  check('RC-3 第三方包：取全量最高（不被 latest 钉住）', channel.pickReleaseVersion(m, OPTS_THIRD) === '1.2.0-alpha.1');
  check('RC-3 第三方包：即使带 rollback tag 也不套通道语义',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0', '1.1.0'])), OPTS_THIRD) === '1.1.0');
  check('RC-3 第三方包：即使本机在灰度名单也按全量最高',
    channel.pickReleaseVersion(meta({ canary: '2.0.0', latest: '1.0.0' }, obj(['1.0.0', '2.0.0'])), { ...OPTS_THIRD, canary: true }) === '2.0.0');
  check('RC-3 第三方包：仅 dist-tags 有值时也算候选', channel.pickReleaseVersion(meta({ latest: '3.0.0' }, {}), OPTS_THIRD) === '3.0.0');
  check('RC-3 第三方包：全非法 → null', channel.pickReleaseVersion(meta({ latest: 'x' }, {}), OPTS_THIRD) === null);
}

// ── 收敛为「唯一实现」：dist 不再自带一份选版算法 ──
{
  const distDirU = path.join(ROOT, 'src', 'platform', 'distribution');
  const dsrc = fs.readdirSync(distDirU).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDirU, f), 'utf8')).join(String.fromCharCode(10));
  check('唯一实现：release.js 定义 pickReleaseVersion 并导出（无第二份实现）',
    /^function pickReleaseVersion\(/m.test(dsrc) && /pickReleaseVersion,/.test(dsrc));
  {
    // fetchNpmLatest 体内不得再内联「遍历取最高」——那段逻辑只允许存在于 highestVersion。
    const fn = dsrc.match(/async function fetchNpmLatest\([^)]*\) \{[\s\S]*?\n\}/);
    check('唯一实现：fetchNpmLatest 体内不再内联「遍历取最高」循环',
      !!fn && !/for \(const v of/.test(fn[0]), fn ? 'ok' : '未定位到 fetchNpmLatest');
  }
  check('唯一实现：dist 经注入复用 VERSION_RE（不复制 semver 合法性知识）',
    /isValid: \(v\) => typeof v === 'string' && VERSION_RE\.test\(v\)/.test(dsrc));
  check('唯一实现：highestVersion 只在 dist 内定义一次（max 兜底步）',
    (dsrc.match(/function highestVersion\(/g) || []).length === 1);
}

// ── 反向：门禁非空转（判据能识别旧形态「取全量最高」）──
{
  const legacyPick = (m) => {
    const cands = [...Object.values(m['dist-tags'] || {}), ...Object.keys(m.versions || {})].filter((v) => VERSION_RE.test(v));
    let best = null;
    for (const v of cands) if (!best || semverCompare(v, best) > 0) best = v;
    return best;
  };
  const m = meta({ latest: '0.1.4' }, obj(['0.1.4', '0.1.6-BETA.1']));
  check('反向：旧形态「取全量最高」确实会取错（≠ latest）',
    legacyPick(m) === '0.1.6-BETA.1' && channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('反向：Δ 判据对两实现给出不同答案（非恒等，门禁非空转）',
    legacyPick(m) !== channel.pickReleaseVersion(m, OPTS_MINE));
}

// ── 契约一致性：§3 五步在契约正文中仍被声明（防契约单方漂移）──
{
  const contract = fs.readFileSync(path.join(ROOT, 'RELEASE-CHANNEL-CONTRACT.md'), 'utf8');
  check('P-契约 §3 含 rollback 分支且声明最高优先级',
    /① [^\n]*rollback/.test(contract) && /回退：最高优先级/.test(contract));
  check('P-契约 §3 含 canary 灰度分支', /② [^\n]*canary/.test(contract) && /灰度/.test(contract));
  check('P-契约 §3 含 latest 正式分支与全量最高禁令（RC-1）', /③ [^\n]*latest/.test(contract) && /RC-1/.test(contract));
  check('P-契约 §3 含 versions 最高兜底步', /④ [^\n]*versions/.test(contract));
  check('P-契约 §3 含返回 null 明确失败步（RC-5）', /⑤[^\n]*null/.test(contract) && /RC-5/.test(contract));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
