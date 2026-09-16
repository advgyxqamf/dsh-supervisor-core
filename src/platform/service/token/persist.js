'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 统一持久化（DSH-TOKEN-CONTRACT §3/§2，TK-5/TK-6）
//
// ## 为什么只能有一个落盘点
//   令牌是**会话凭据**：落盘权限错了 = 同机其他用户能直接进面板；落盘位置多了
//   = 轮换时必然出现「新旧副本不一致」，某一份残留的旧令牌会持续可用（凭据无法
//   真正失效）。故本仓只认这一处写入：原子写 + 写后 0600 + 统一脱敏，其它模块
//   一律不得自行 fs.writeFileSync 令牌（TK-5）。
//
// ## TK-6：绝不静默销毁 —— 超限必须「轮转」
//   旧实现超限时 `fs.rmSync(fp)` 把**唯一持久链路**直接清空：一旦此后捕获链路
//   短暂失效（stdout 断、journal 滚出窗口），令牌就永久不可恢复了。
//   现改为**先原子备份、再截断**：任何时刻至少存在一份完整内容，且旧内容不会
//   无痕消失。备份用**固定槽位**（.bak-0..n-1，默认 2 个）轮转覆写：槽位数有界
//   （每份备份都含明文令牌，无限增长等于扩大暴露面），且**全程没有任何删除调用**
//   ——权威文件（primary）从头到尾没有被删除过，只在其内容已被完整备份进槽位后截断。
//   为什么不做"写时间戳备份 + 删旧备份"：门禁 TK-G3 把 persist.js 里任何
//   **整文件级**清空式删除（rmSync/rmdirSync；unlinkSync 作为附属物清理被显式排除）
//   都判为「唯一持久链路被销毁」的危险信号（有 rmSync 清空令牌文件的事故在先）；
//   固定槽位覆写既满足 TK-6 的"轮转"，又天然规避该危险形态。
//
// ## P3 历史教训（2026-09-13，失效模式 a+g）——必须保留
//   `appendFileSync(..., { mode: 0o600 })` 的 mode **只对新建文件生效**：
//   对**已存在**的文件被内核直接忽略，文件保留原有权限位。
//   后果：若文件曾以 0644 落盘（旧版本 / 备份还原 / 手工放置 / stateDir 权限退化），
//   此后每次令牌轮换都会把**新的明文会话令牌**继续追加进一个**世界可读**的文件；
//   该令牌即 DSH Web 会话凭据（可直接进面板）。
//   修法：写后显式 chmodSync 收口（同仓 frpmgr.js 已是「写后 chmod」的写法），
//   无论文件是新建还是既有，最终权限都收敛到 0600。
//   ⚠ Windows 上 POSIX mode 被忽略（NTFS 用 ACL）——跨平台那一半由目录级
//   保护承担（supervisor 对状态目录调 protectDir），本文件的 chmod 在 Windows
//   退化为 no-op，故绝不可把 chmod 当成 Windows 上的安全边界。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

/** 持久化阈值（集中在此，便于审计；旧实现散落在 token.js 内联字面量）。 */
const PERSIST_LIMITS = {
  /** 单个令牌文件超过此字节数即轮转（旧值 256KB，原样保留）。 */
  MAX_BYTES: 256 * 1024,
  /** 历史备份**槽位数**（固定名 .bak-0..n-1，按最旧优先覆写——只轮转、不删除）。 */
  KEEP_BACKUPS: 2,
  /** 读取文件尾部时的一次性字节窗口（恢复文件/journal 行都很短，64KB 足够）。 */
  TAIL_BYTES: 64 * 1024,
  /** 单行最大长度：超长行**截断后写入**（防畸形输出撑爆文件）。 */
  MAX_LINE_BYTES: 8 * 1024,
};

/** ANSI 转义序列（DSH 输出可能带终端着色，会把 URL 包在控制码里导致解析不到）。 */
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** 需要脱敏的键名（**刻意不含 `token`**：URL 行里的 ?token= 正是我们要保存的值）。 */
const SECRET_KEY_RE = /^(?:password|passwd|pwd|secret|client_?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|authorization|auth)$/i;

/** 去掉 ANSI 控制码（**仅持久化路径**使用；解析仍在原文行上进行）。 */
function stripAnsi(line) {
  return String(line == null ? '' : line).replace(ANSI_RE, '');
}

/**
 * 统一脱敏入口（TK-5 的「统一脱敏」）。
 *   · 目的不是隐藏 DSH 会话令牌本身（保存它才有意义），而是**顺手清掉**同一条
 *     输出行里可能夹带的其它机密（代理/上游的 access_token、password、api_key…）。
 *   · 只做「值替换」不做「行删除」：行结构（含 ?token=）必须原样保留，恢复文件
 *     才能被 parseDshTokenLine 重新解析。
 *   · 已脱敏的值（<redacted>）不重复处理，避免二次替换产生嵌套标记。
 */
function sanitizeTokenLine(line) {
  let s = stripAnsi(line).replace(/\r?\n$/, '');
  // key=value / key: value / "key": "value" 三种常见形态；值到空白/引号/& 为止。
  s = s.replace(/([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(["']?)([^\s"'&,;]+)\2/g, (m, key, q, val) => {
    if (!SECRET_KEY_RE.test(key)) return m;
    if (val === '<redacted>') return m;
    return key + '=' + '<redacted>';
  });
  // Authorization: Bearer <credential> 形态（值和键名都不规则，单独处理）。
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>');
  return s;
}

/** 确保目录存在（持久化前调用；失败不抛，交由后续写入报错）。 */
function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* 交给写入报错 */ }
}

/**
 * 原子写：临时文件 → chmod → rename → 目标再 chmod。
 *   · 为什么临时文件：rename 在同一文件系统内是原子替换，读者永远看不到半个文件
 *     （旧实现是直接 append，进程被杀会留下截断行，恢复时可能解析到半截令牌）。
 *   · 为什么 rename 后**再** chmod 一次：mode 只在创建时生效的教训（见文件头）；
 *     rename 会在部分平台/文件系统上重写权限，故目标文件收口一次。
 * @returns {{ok:boolean, path:string, reason?:string}}
 */
function writeAtomic(file, data) {
  const fp = path.resolve(file);
  const tmp = fp + '.tmp' + process.pid;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch { /* 同上 */ }
    return { ok: true, path: fp };
  } catch (e) {
    // 失败清理：**截断而不删除**（门禁 TK-G3 只把 rmSync/rmdirSync 判为危险信号；
    // unlinkSync 作为附属物清理是允许的，此处仍选择截断）。截断后残留的是空文件，
    // 不含明文令牌，也不会被误当权威副本。
    try { if (fs.existsSync(tmp)) fs.truncateSync(tmp, 0); } catch { /* 清理失败不影响返回 */ }
    return { ok: false, path: fp, reason: (e && e.message) || String(e) };
  }
}

/** 轮转：把现有内容**完整备份进固定槽位**，备份落地成功后才截断原文件。
 *  任一步失败都返回 false 且**不截断**（宁可文件继续增长，也不丢唯一持久链路）。
 *  备份槽位的 mtime 即轮转时刻，故无需在备份内写时间戳头（备份应可原样恢复）。 */
function rotateByBackup(file, opts) {
  const fp = path.resolve(file);
  const keep = (opts && opts.keep) || PERSIST_LIMITS.KEEP_BACKUPS;
  try {
    const content = fs.readFileSync(fp);
    const slot = pickBackupSlot(fp, keep);
    const w = writeAtomic(slot, content);
    if (!w.ok) return false;
    // 备份确实完整落地后才截断——顺序反了就等于清空唯一持久链路。
    fs.truncateSync(fp, 0);
    try { fs.chmodSync(fp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    return true;
  } catch { return false; }
}

/** 选备份槽位：优先补空槽；槽位满则覆写 mtime 最旧的那个（固定名，全程无需删除）。 */
function pickBackupSlot(file, keep) {
  let oldest = { path: file + '.bak-0', mtime: Infinity };
  for (let i = 0; i < keep; i++) {
    const p = file + '.bak-' + i;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < oldest.mtime) oldest = { path: p, mtime: st.mtimeMs };
    } catch { return p; } // 空槽优先（不多占新槽位）
  }
  return oldest.path;
}

/**
 * 追加一行（**经统一脱敏与权限收口**）；超限时先轮转再追加。
 *   · 轮转失败（磁盘满等）时**仍然追加**：宁可文件超限，也不让当前令牌丢失
 *     ——「令牌恒存在」优先于「文件不超限」（TK-1）。
 *   · 追加本身用 O_APPEND，崩溃最多丢最后一行，不会破坏既有内容。
 * @returns {{ok:boolean, path:string, rotated?:boolean, reason?:string}}
 */
function appendByRotation(file, line, opts) {
  const fp = path.resolve(file);
  const maxBytes = (opts && opts.maxBytes) || PERSIST_LIMITS.MAX_BYTES;
  let text = sanitizeTokenLine(line);
  if (Buffer.byteLength(text, 'utf8') > PERSIST_LIMITS.MAX_LINE_BYTES) {
    text = text.slice(0, PERSIST_LIMITS.MAX_LINE_BYTES); // 超长畸形行截断（不会命中令牌行）
  }
  let rotated = false;
  try {
    ensureDir(path.dirname(fp));
    let size = 0;
    try { size = fs.statSync(fp).size; } catch { /* 不存在 = 0 */ }
    if (size > maxBytes) rotated = rotateByBackup(fp, opts);
    fs.appendFileSync(fp, text + '\n', { mode: 0o600 });
    // P3 教训：mode 只对新建生效 → 写后显式收口（见文件头）。
    try { fs.chmodSync(fp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    return { ok: true, path: fp, rotated: rotated };
  } catch (e) {
    return { ok: false, path: fp, rotated: rotated, reason: (e && e.message) || String(e) };
  }
}

/** 读文件尾部若干字节并按行切分（恢复文件用；不整文件读入，避免大文件拖慢捕获）。
 *  @returns {string[]} 行数组（含空行；文件不存在返回 []） */
function readTailLines(file, opts) {
  const fp = path.resolve(file);
  const bytes = (opts && opts.bytes) || PERSIST_LIMITS.TAIL_BYTES;
  let fd;
  try {
    if (!fs.existsSync(fp)) return [];
    fd = fs.openSync(fp, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return String(buf).split(/\r?\n/);
  } catch { return []; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 关闭失败无影响 */ } }
}

// ═══ DS-G4：恢复文件名注入（platform 去域名词，§4.2 反转法）═══
// 平台**不**硬编码业务文件名。恢复文件默认名由 app/ 装配期经 configureTokenFileName
// 注入（声明在 app/settings/token-kinds.js，由唯一装配点 app/assembly/compose.js
// 在构造令牌服务前 require）。未注入时为**通用名** —— 生产路径始终注入，行为逐字不变。
const DEFAULT_TOKEN_FILE_NAME = 'token.log';
let _tokenFileName = DEFAULT_TOKEN_FILE_NAME;

/** 注入令牌恢复文件名（装配期调用；非空字符串才生效，幂等）。 */
function configureTokenFileName(name) {
  if (typeof name === 'string' && name) _tokenFileName = name;
}

/** 当前恢复文件名（供装配自检/测试）。 */
function tokenFileBaseName() { return _tokenFileName; }

/** 目标状态目录下的令牌恢复文件名（路径规则集中一处，调用方不再各拼字符串）。
 *  文件名来自注入（configureTokenFileName）；未注入时为通用默认名。 */
function tokenFileName(stateFile) {
  return path.join(path.dirname(path.resolve(stateFile)), _tokenFileName);
}

module.exports = {
  PERSIST_LIMITS,
  stripAnsi,
  sanitizeTokenLine,
  writeAtomic,
  appendByRotation,
  readTailLines,
  tokenFileName,
  configureTokenFileName,
  tokenFileBaseName,
};
