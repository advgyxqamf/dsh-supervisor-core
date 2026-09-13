#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 前端门禁必须真的被调用（第四轮 P1，2026-09-12）
//
// ## 缺陷：声称的门禁不存在，前端测试从未运行
//
// `ui/package.json` 提供 `verify = typecheck + lint + test + build`，
// 且 `ui/src` 下有 3 个 .test.ts（15 个用例，实测全绿）——
// 但**没有任何自动化路径会跑到它们**：
//
//   · `.github/workflows/build.yml` 的注释写「前端门禁已移出 CI，
//     现由本地发布前置（release-core.sh 的 **[3/7] UI 门禁**）承担」——
//     而 `release-core.sh` **只有 [1/5]–[3/5]，不存在 [3/7]**；
//   · 其 [3/5] 委托的 `ci-core.sh` 只调 `build-ui.sh`，而后者**只构建、不测试**。
//
// 即：一个「已完成」的门禁迁移，实际把前端测试从「CI 里跑」变成了「哪里都不跑」。
// 这与本仓反复出现的「门禁空转」同族，但更隐蔽：**迁移记录本身就写错了目标**。
//
// ## 锁定不变量
//   U-a  ci-core.sh 必须在**构建之前**执行前端 verify（或至少 test）
//   U-b  必须存在可被真正调用的前端测试入口（ui/package.json 的 test）
//   U-c  CI 注释不得再指向不存在的阶段号（[3/7]）—— 防再次误导
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const ciCore = fs.readFileSync(path.join(ROOT, 'release', 'scripts', 'ci-core.sh'), 'utf8');
const buildUi = fs.readFileSync(path.join(ROOT, 'release', 'scripts', 'build-ui.sh'), 'utf8');
const uiPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'package.json'), 'utf8'));
// release-core.sh 已于 2026-09-13 删除（硬标准：构建/发布均经 GitHub CI）
// ⚠ 必须经 `_workflow.js` 读取（门禁 W4 强制）：它做 CRLF/CR/LF 归一化，
//   裸 readFileSync 在 Windows 检出下会让按行解析失配（本仓已有该事故记录）。
const W = require(path.join(__dirname, '_workflow.js'));
const ciYml = W.readWorkflow('build.yml');

// ── U-a：ci-core 必须在构建之前跑前端门禁 ──
// ⚠ 必须匹配**前端 verify**，而非 `npm run verify:versions`（后者是版本自洽校验，早已存在）——
//   用 `indexOf('npm run verify')` 会命中 verify:versions 而**假通过**（我第一版就是这样）。
//   判据：向前是 `cd ui && npm run verify` 且**不是** `verify:` 开头。
const verifyRe = /cd ui && npm run verify(?!:)/g;
const mVerify = verifyRe.exec(ciCore);
const iVerify = mVerify ? mVerify.index : -1;
// ⚠ 同理：判据必须指向**实际调用行**（`bash release/scripts/build-ui.sh`），
//   而不是注释里提到的 `build-ui.sh`（我自己的说明注释就在 verify 之前，会误判）。
const mBuild = /^\s*bash release\/scripts\/build-ui\.sh/m.exec(ciCore);
const iBuild = mBuild ? mBuild.index : -1;
check('U-a ci-core.sh 调用前端 verify（非 verify:versions）', iVerify >= 0, iVerify >= 0 ? '已接入' : '未接入');
check('U-a verify 在 build-ui 之前（类型/测试不过就不该产出镜像）',
  iVerify >= 0 && iBuild >= 0 && iVerify < iBuild, 'verify@' + iVerify + ' build@' + iBuild);
// 反向：确认判据本身能区分两者（防门禁再次假通过）
check('反向：判据不匹配 verify:versions（该命令存在但不是前端门禁）',
  /npm run verify:versions/.test(ciCore) && !/cd ui && npm run verify:versions/.test(ciCore),
  '可区分');

// ── U-b：前端测试入口存在且可用 ──
check('U-b ui/package.json 有 test 脚本', typeof uiPkg.scripts?.test === 'string', uiPkg.scripts?.test);
check('U-b ui/package.json 有 verify（typecheck+lint+test+build）',
  typeof uiPkg.scripts?.verify === 'string', uiPkg.scripts?.verify);
check('U-b verify 串包含 typecheck/lint/test/build 四步',
  /typecheck/.test(uiPkg.scripts.verify) && /lint/.test(uiPkg.scripts.verify)
  && /test/.test(uiPkg.scripts.verify) && /build/.test(uiPkg.scripts.verify),
  uiPkg.scripts.verify);
{
  const testFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) testFiles.push(p);
    }
  })(path.join(ROOT, 'ui', 'src'));
  check('U-b ui/src 下存在测试文件（非空跑）', testFiles.length > 0, testFiles.length + ' 个');
}

// ── U-c：注释不得再指向不存在的阶段号 ──
// ⚠ 断言「不再**声称**」，而非「文本中不出现」—— 校正说明里会**引用**旧措辞，
//   用简单的 includes 会把说明文字当成仍然有效的声明（我第一版就踩了这个假阳性）。
//   判据：不得存在「以肯定语气指向 [3/7]」的句子（排除标记为「原写/校正/并不存在」的说明行）。
{
  // 2026-09-13：release-core.sh 已删除（硬标准：构建/发布均经 GitHub CI），[3/7] 之争随之终结。
  //   改为断言：CI 注释里不得再出现该历史阶段的「有效声称」（说明性行不算）。
  const liveClaim = ciYml
    .split(String.fromCharCode(10))
    .filter((l) => /release-core.sh/.test(l))
    .filter((l) => !/已删除|删除|原写|校正|不存在|2026-09-13/.test(l));
  check('U-c CI 注释不再把 release-core.sh 当作现行编排器',
    liveClaim.length === 0, liveClaim.length ? liveClaim.join(' | ').slice(0, 80) : '已清理');
}

// ── 反向：build-ui 只构建不测试（说明为何必须由 ci-core 补上 verify）──
check('反向：build-ui.sh 自身不跑 test（故上游必须显式补）',
  !/npm (run )?test/.test(buildUi), '确认只构建');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);