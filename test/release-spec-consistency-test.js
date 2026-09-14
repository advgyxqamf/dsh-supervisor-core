#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 发布规范一致性门禁（2026-09-13）

// ## 解决的问题
//   发布流程此前散落在 5+ 份文档：同一事实（入口/矩阵/glibc 基座/凭据）重复 5–8 处，
//   必然漂移 —— 2026-09-13 的清理就修掉 4 处过时声明（旧仓库名、「Linux 本地生产」、
//   「三平台矩阵」、「待决策」）。
//   现确立 RELEASE-STANDARD.md 为**唯一事实源**，并由本门禁把「规范 = 现实」钉死：
//   **改代码不改规范、或改规范不改代码，本门禁即红。**

// ## 锁定不变量
//   P-1  规范里的每个入口文件存在；.sh 可执行
//   P-2  规范里的每个 `npm run X` 的 X 存在于 package.json#scripts
//   P-3  平台矩阵与 package.json#npmPublish.packages 逐项一致，且 CI build 矩阵覆盖同集合
//   P-4  CI job 名与 tag 模式与 workflow 一致
//   P-5  规范列出的门禁文件存在且在 scripts.test 链中
//   P-6  必需章节标题齐备
//   P-7  反向：判据能识别伪造入口 / 缺失文件（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
// ⚠ 凡按行解析 workflow **必须**经 _workflow.js（行尾归一）—— 参见该文件头的事故记录。
const { readWorkflow, jobSection } = require(path.join(__dirname, '_workflow.js'));
const SPEC = path.join(ROOT, 'RELEASE-STANDARD.md');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const specTxt = fs.readFileSync(SPEC, 'utf8');

// 抽取机器可读块：```json release-pipeline ... ```
function extractBlock(txt) {
  const start = txt.indexOf('```json release-pipeline');
  if (start < 0) return null;
  const body = txt.slice(start + '```json release-pipeline'.length);
  const end = body.indexOf('```');
  if (end < 0) return null;
  return body.slice(0, end);
}
let spec = null;
{
  const raw = extractBlock(specTxt);
  check('规范含机器可读块（json release-pipeline）', !!raw, raw ? String(raw.length) + ' 字节' : '缺失');
  try { spec = JSON.parse(raw); } catch (e) { /* 由下面断言报告 */ }
  check('机器可读块可解析为 JSON', !!spec, spec ? 'ok' : '解析失败');
}

if (spec) {
  const pkg = require(path.join(ROOT, 'package.json'));
  const npmScripts = pkg.scripts || {};

  // ── P-1 / P-2：入口存在且可执行 ──
  const badFiles = [];
  const badScripts = [];
  for (const [name, val] of Object.entries(spec.entries || {})) {
    if (val.startsWith('npm run ')) {
      const s = val.slice('npm run '.length).split(' ')[0];
      if (!npmScripts[s]) badScripts.push(name + ' -> ' + val);
      continue;
    }
    const f = path.join(ROOT, val.split(' ')[0]);
    if (!fs.existsSync(f)) { badFiles.push(name + ' -> ' + val); continue; }
    if (f.endsWith('.sh')) {
      try { fs.accessSync(f, fs.constants.X_OK); } catch { badFiles.push(name + ' -> ' + val + '（不可执行）'); }
    }
  }
  check('P-1 规范里的入口文件都存在且 .sh 可执行',
    badFiles.length === 0, badFiles.length ? badFiles.join(', ') : Object.keys(spec.entries).length + ' 个入口');
  check('P-2 规范里的 npm script 都存在',
    badScripts.length === 0, badScripts.length ? badScripts.join(', ') : 'ok');
  // 阶段命令也必须在 scripts 里（若为 npm run）
  const badStages = [];
  for (const st of spec.stages || []) {
    const m = /^npm run ([^ ]+)/.exec(st.cmd);
    if (m && !npmScripts[m[1]]) badStages.push(st.id + ' -> ' + st.cmd);
    const b = /^bash ([^ ]+)/.exec(st.cmd);
    if (b && !fs.existsSync(path.join(ROOT, b[1]))) badStages.push(st.id + ' -> ' + st.cmd);
  }
  check('P-2b 阶段命令引用的脚本/script 都存在',
    badStages.length === 0, badStages.length ? badStages.join(', ') : (spec.stages.length + ' 个阶段'));

  // ── P-2c：规范正文里出现的每个 `npm run X` 都必须在 package.json 存在 ──
  //   原缺陷：§3 表格曾列 `npm run publish:core:all`，而该 script 已被硬标准移除；
  //   正文表格不在机器块内，P-2 抓不到。本检查把「规范正文 = 现实」也钉死。
  {
    const allRuns = Array.from(specTxt.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)).map((m) => m[1]);
    const badRuns = Array.from(new Set(allRuns)).filter((s) => !npmScripts[s]);
    check('P-2c 规范正文里的每个 npm run X 都存在于 package.json#scripts',
      badRuns.length === 0, badRuns.length ? badRuns.join(', ') : (new Set(allRuns).size + ' 个唯一 script'));
  }

  // ── P-3：矩阵一致 ──
  const pub = (pkg.npmPublish && pkg.npmPublish.packages) || [];
  check('P-3 规范声明的矩阵来源 = package.json#npmPublish.packages',
    spec.matrixSource === 'package.json#npmPublish.packages', String(spec.matrixSource));
  const wf = fs.readFileSync(path.join(ROOT, spec.ciWorkflow), 'utf8');
  const runners = (spec.ciRunners || []);
  const missingRunner = runners.filter((r) => wf.indexOf('os: ' + r) < 0);
  check('P-3b CI build 矩阵含规范列出的全部 runner',
    missingRunner.length === 0 && runners.length === pub.length,
    missingRunner.length ? ('缺 ' + missingRunner.join(', ')) : (runners.length + ' 个 runner = ' + pub.length + ' 个子包'));
  // 规范 §2 的表必须列出每个子包
  const missingPkg = pub.filter((p) => specTxt.indexOf(p) < 0);
  check('P-3c 规范正文列出了全部 npm 子包名',
    missingPkg.length === 0, missingPkg.length ? missingPkg.join(', ') : pub.length + ' 个子包');

  // ── P-4：job 名与 tag 模式 ──
  const missingJob = (spec.ciJobs || []).filter((j) => !new RegExp('^  ' + j + ':', 'm').test(wf));
  check('P-4 CI job 名与规范一致',
    missingJob.length === 0, missingJob.length ? missingJob.join(', ') : spec.ciJobs.join(', '));
  check('P-4b tag 触发模式与规范一致',
    wf.indexOf("tags:") >= 0 && wf.indexOf("'") >= 0 && spec.tagPattern === 'v*', String(spec.tagPattern));

  // ── P-5：门禁文件存在且在链中 ──
  const chain = String(npmScripts.test || '');
  const badGates = [];
  for (const g of spec.specGates || []) {
    if (!fs.existsSync(path.join(ROOT, g))) { badGates.push(g + '（不存在）'); continue; }
    if (chain.indexOf(g) < 0) badGates.push(g + '（不在 scripts.test 链中）');
  }
  check('P-5 规范列出的门禁都存在且在 scripts.test 链中',
    badGates.length === 0, badGates.length ? badGates.join(', ') : (spec.specGates.length + ' 道门禁'));

  // ── P-6：必需章节 ──
  const missingSec = (spec.requiredSections || []).filter((s) => specTxt.indexOf(s) < 0);
  check('P-6 必需章节标题齐备',
    missingSec.length === 0, missingSec.length ? missingSec.join(', ') : (spec.requiredSections.length + ' 节'));
}

// ── P-7：反向（判据必须能识别违规）──
{
  const bogus = { entries: { x: 'release/scripts/__nonexistent__.sh' } };
  const missing = !fs.existsSync(path.join(ROOT, bogus.entries.x));
  check('P-7 反向：判据能识别不存在的入口文件', missing, 'hit');
  const badNpm = 'npm run __nonexistent_script__';
  const s = badNpm.slice('npm run '.length).split(' ')[0];
  check('P-7 反向：判据能识别不存在的 npm script',
    !(require(path.join(ROOT, 'package.json')).scripts || {})[s], 'hit');
  check('P-7 反向：机器块抽取在缺块时返回 null',
    extractBlock('no block here') === null, 'ok');
  check('P-7 反向：规范正文确实含矩阵来源声明（防删块仍绿）',
    specTxt.indexOf('npmPublish.packages') >= 0, 'ok');
}


// ── P-8：完整构建不得被条件跳过（2026-09-14 硬标准）──
//
//   原实现 build 受 `need_build == true` 门控 —— 版本已全平台发布时整块跳过，
//   于是「已发布版本之后的改动」**从未经过四平台构建验证**（PR 也照样能合）。
//   硬标准要求：**四平台完整构建在每次 push / PR 都跑**。发布才需要一次性闸。
{
  // ⚠ 必须经 _workflow.js 读取（CRLF 归一）—— 本门禁首版用 fs.readFileSync + 逐行等值比较，
  //   在 Windows 检出（CRLF）下 "  build:" 恒不命中 → **只在 Windows CI 红**（本仓既有该事故记录）。
  const wf = readWorkflow(spec.ciWorkflow.split("/").pop());
  const seg = jobSection(wf, "build");
  check("P-8 build job 存在（jobSection 取到体）", seg.length > 0, seg.length + " 字符");
  check("P-8 四平台完整构建**不得**被 need_build 之类条件跳过",
    !/^    if:/m.test(seg), (seg.match(/^    if:.*$/m) || ["(无 if)"])[0]);
  check("P-8 矩阵仍为四平台", (seg.match(/- os: /g) || []).length === 4,
    ((seg.match(/- os: /g) || []).length) + " 个 os");
  // 发布必须仍受一次性闸保护（否则会重复发布 → npm 409）
  check("P-8 发布步骤仍受 need_build 一次性闸保护",
    /needs.precheck.outputs.need_build/.test(seg), "ok");
  // 反向：判据能识别被门控的 build（构造一段带 if 的 build job）
  const probe = "  build:" + String.fromCharCode(10) + "    needs: precheck" + String.fromCharCode(10) + "    if: needs.precheck.outputs.need_build == 'true'";
  check("P-8 反向：判据能识别被条件门控的 build", /^    if:/m.test(probe), "hit");
  // 反向：CRLF 夹具 —— 经 jobSection 归一后仍能取到（防再次退化为裸 fs.readFileSync）
  // 夹具须含**前导换行**：jobSection 的正则要求 `\n  <name>:\n`（顶层 job 前必有其它行）
  const crlf = "name: x" + String.fromCharCode(13, 10) + "  build:" + String.fromCharCode(13, 10) + "    needs: precheck" + String.fromCharCode(13, 10) + "    runs-on: x";
  check("P-8 反向：CRLF 夹具经 jobSection 仍取到 build 段",
    jobSection(crlf, "build").includes("needs: precheck"), "hit");
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
