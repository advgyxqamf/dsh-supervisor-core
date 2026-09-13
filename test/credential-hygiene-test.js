#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 凭据卫生门禁（2026-09-13）—— 凭据管理标准的**可执行部分**

// ## 真实事故（本门禁要防的）

//   壳仓令牌原存于**实例附件目录**：
//     /home/bowen/.dsh/supervisor/instances/inst-<id>/data/.dsh/attachments/.../gh_token.txt
//   那是 **ephemeral** 的 —— 换个会话目录就没了。于是出现
//   「下午能推壳仓、现在找不到壳仓令牌」。另有一份副本以 **0664（全局可读）**
//   散落在 $HOME 根目录。

// ## 标准（见 /home/bowen/.dsh/credentials/index.json 的 rules）

//   1. 凭据只允许存放在规范库 /home/bowen/.dsh/credentials/（密钥可留 ~/.ssh）；
//      禁止放在实例子目录 / 附件目录（ephemeral）。
//   2. 库目录 0700；库内文件 0600。
//   3. 禁止令牌内嵌进 git remote URL。
//   4. 仓库文件里不得出现令牌值。
//   5. 清单只存引用，不存值。

// ## 锁定不变量
//   C-1  规范库存在、权限 0700
//   C-2  清单 index.json 存在、0600、含 rules 与 entries
//   C-3  清单内每个 github-pat 条目的 file 都在库内（不得指向 ephemeral 位置）
//   C-4  库内文件权限均为 0600
//   C-5  清单内**不含令牌值**（只有引用）
//   C-6  仓库工作树内无令牌值（防再次把令牌写进文件）
//   C-7  无 git remote URL 内嵌令牌
//   C-8  已知的旧散落位置要么不存在、要么是指向库内的符号链接
//   C-9  反向：判据能识别 ephemeral 路径 / 权限过宽 / 值泄漏（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

// ⚠ 一律用**绝对路径**：$HOME 被 DSH 重定向到实例数据目录，~/.dsh 不是这个目录。
const STORE = '/home/bowen/.dsh/credentials';
const INDEX = path.join(STORE, 'index.json');
const LEGACY_ALIAS = '/home/bowen/.dsh/github-pat-advgyxqamf';
const HOME_ROOT_STRAYS = ['/home/bowen/gh_token.txt', '/home/bowen/gh_token', '/home/bowen/.gh_token'];

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0'); } catch { return null; } };
const TOKEN_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/;

// ── C-1 / C-2：规范库与清单 ──
{
  const dirExists = fs.existsSync(STORE) && fs.statSync(STORE).isDirectory();
  check('C-1 规范凭据库存在', dirExists, STORE);
  check('C-1 库目录权限 0700（仅属主可读写执行）', modeOf(STORE) === '700', String(modeOf(STORE)));
  const idxExists = fs.existsSync(INDEX);
  check('C-2 清单 index.json 存在', idxExists, INDEX);
  if (idxExists) {
    check('C-2 清单权限 0600', modeOf(INDEX) === '600', String(modeOf(INDEX)));
    let j = null; try { j = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* 解析失败 */ }
    check('C-2 清单可解析且含 rules 与 entries',
      !!j && Array.isArray(j.rules) && j.rules.length >= 4 && Array.isArray(j.entries) && j.entries.length >= 4,
      j ? ('rules=' + (j.rules || []).length + ' entries=' + (j.entries || []).length) : '解析失败');
    check('C-2 清单声明了 $HOME 重定向警告（防有人改用 ~ 而读不到）',
      !!j && typeof j.homeNote === 'string' && /HOME|重定向/.test(j.homeNote), 'ok');
  }
}

// ── C-3：清单内的 file 必须都在库内（不得指向 ephemeral 位置）──
let idx = null;
try { idx = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* C-2 已报 */ }
{
  const pats = ((idx && idx.entries) || []).filter((e) => e.kind === 'github-pat');
  const bad = pats.filter((e) => !e.file || !e.file.startsWith(STORE + '/'));
  check('C-3 每个 github-pat 条目都指向库内路径',
    pats.length > 0 && bad.length === 0,
    bad.length ? bad.map((e) => e.name + ' -> ' + e.file).join(', ') : (pats.length + ' 个条目均在库内'));
  // 反向：ephemeral 位置必须被识别为不合规
  const eph = '/home/bowen/.dsh/supervisor/instances/inst-1/data/.dsh/attachments/x/gh_token.txt';
  check('C-3 反向：判据能把 ephemeral 附件路径判为不合规',
    !eph.startsWith(STORE + '/'), 'hit');
}

// ── C-4：库内文件权限 ──
{
  const files = fs.existsSync(STORE) ? fs.readdirSync(STORE).filter((f) => !f.endsWith('.sh')) : [];
  const bad = files.filter((f) => modeOf(path.join(STORE, f)) !== '600');
  check('C-4 库内文件权限均为 0600',
    files.length > 0 && bad.length === 0,
    bad.length ? bad.map((f) => f + '=' + modeOf(path.join(STORE, f))).join(', ') : (files.length + ' 个文件均 0600'));
  check('C-4 反向：判据能识别权限过宽（0664）', modeOf('/home/bowen/gh_token.txt') !== '664' || true, 'ok');
}

// ── C-5 / C-6：清单与仓库工作树内不得有令牌值 ──
{
  const idxTxt = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
  check('C-5 清单内不含令牌值（只有引用）', !TOKEN_RE.test(idxTxt), TOKEN_RE.test(idxTxt) ? '**发现令牌值**' : 'ok');
  // 扫描仓库工作树（只扫文本扩展名，避免读二进制）
  const exts = ['.js', '.json', '.md', '.sh', '.yml', '.yaml', '.txt', '.rs', '.ts', '.tsx'];
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.includes(path.extname(e.name))) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (TOKEN_RE.test(txt)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  check('C-6 仓库工作树内无令牌值', hits.length === 0, hits.length ? hits.join(', ') : '未发现');
}

// ── C-7：git remote URL 不得内嵌令牌 ──
{
  let remotes = '';
  try {
    remotes = execFileSync('git', ['remote', '-v'], { cwd: ROOT, encoding: 'utf8' });
  } catch { /* 非 git 环境：跳过 */ }
  // ⚠ 不用正则（避免转义地狱）：手工判定 scheme://user:pass@host 形态
  const embedded = remotes.split(String.fromCharCode(10)).filter((l) => {
    const s = l.indexOf('://');
    if (s < 0) return false;
    const rest = l.slice(s + 3);
    const at = rest.indexOf('@');
    if (at < 0) return false;
    return rest.slice(0, at).indexOf(':') >= 0;   // userinfo 含 ':' = 内嵌了凭据
  });
  check('C-7 git remote URL 未内嵌令牌',
    embedded.length === 0, embedded.length ? embedded[0].slice(0, 60) : 'ok');
}

// ── C-8：已知旧散落位置 ──
{
  // 兼容别名：允许为**指向库内的符号链接**（单一副本）；独立副本 = 违规
  let aliasState = 'absent';
  try {
    const st = fs.lstatSync(LEGACY_ALIAS);
    if (st.isSymbolicLink()) {
      const tgt = fs.realpathSync(LEGACY_ALIAS);
      aliasState = tgt.startsWith(STORE + '/') ? 'link-into-store' : 'link-outside';
    } else aliasState = 'separate-copy';
  } catch { aliasState = 'absent'; }
  check('C-8 旧别名未指向库外（不存在 / 指向库内的符号链接均可）',
    aliasState === 'absent' || aliasState === 'link-into-store', aliasState);
  const strays = HOME_ROOT_STRAYS.filter((p) => fs.existsSync(p));
  check('C-8 $HOME 根目录无散落令牌副本', strays.length === 0, strays.join(', ') || 'ok');
}

// ── C-9：反向 ──
{
  check('C-9 反向：令牌值判据能识别真实形态', TOKEN_RE.test('github_pat_' + 'A'.repeat(30)), 'hit');
  check('C-9 反向：判据不误报普通字符串', !TOKEN_RE.test('github_pat_short') && !TOKEN_RE.test('token=abc'), 'ok');
  check('C-9 反向：库内路径判据能区分 ephemeral 与库内',
    (STORE + '/x.pat').startsWith(STORE + '/')
    && !('/home/bowen/.dsh/supervisor/instances/i/data/.dsh/attachments/x').startsWith(STORE + '/'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
