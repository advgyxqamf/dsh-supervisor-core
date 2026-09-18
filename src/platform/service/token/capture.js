'use strict';

// 捕捉层（DSH-TOKEN-CONTRACT 契约3/4，TK-1/TK-3/TK-7）。
// 令牌由 DSH 侧生成，我方只能从 DSH 输出中取出，共三种源与固定优先级：stdout 实时行最优先，其次本地恢复文件，最后 journald。
// 顺序不可颠倒：journal 优先会把陈旧或别的 unit 的旧 token 覆盖掉刚由 stdout 捕获的新 token。
// journal 必须按“最近一条含回环 URL 的行”查询而非固定最近 N 行，否则长驻实例的 token 行滚出窗口后永远捕获不到。
// 本层只做一次拉取，退避重试与周期兜底由 pool 的 scheduleCapture 与 ensureCaptured 负责。
// TK-7 用户配置类只登记不捕捉：remote-token/api-access-key/frp-auth 权威在配置存储，本层对非 captured 分类直接 no-op。

const ex = require('../../util/exec');
const persist = require('./persist');
const kinds = require('./kinds');

/** 解析 DSH 启动输出行中的回环访问令牌（全仓唯一实现）。
 *  只认 127.0.0.1 回环 URL，令牌限 base64url 安全字符集，找不到返回 null。
 *  正则为迁移前逐字保留；放宽字符集会吞进 URL 后续片段，改动须同步契约与门禁。 */
function parseDshTokenLine(line) {
  const m = /(?:dsh web:)?\s*(?:https?:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** journald 查询：按单元取“最近一条含回环 URL 的行”。 */
function captureFromJournal(unit, opts) {
  const logger = (opts && opts.logger) || console;
  try {
    // runOut 失败返回 null 且输出有上限，无需再包 try/catch。
    const out = ex.runOut('journalctl', ['--user', '-u', unit + '.service', '--no-pager', '-o', 'cat', '-g', '127\.0\.0\.1:.*token=', '-n', '1'], {
      timeoutMs: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!out) {
      logger.warn && logger.warn('[token] journal capture(' + unit + ') 命令失败或无输出');
      return null;
    }
    const lines = out.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(lines[i]);
      if (t) return { token: t, source: 'journal', line: lines[i] };
    }
    return null;
  } catch (e) {
    logger.warn && logger.warn('[token] journal capture(' + unit + ') failed: ' + ((e && e.message) || e));
    return null;
  }
}

/** 按来源顺序取“最新一条”URL 行的令牌；desc 形如 { kind, unit, file, lines }，找不到返回 null。 */
function captureOnce(desc, opts) {
  const src = desc || {};
  const logger = (opts && opts.logger) || console;
  // TK-7/TK-3：非捕捉分类（用户配置/派生/自签）只登记不捕捉。
  if (!kinds.isCaptured(src.kind)) return null;

  // stdout 实时行优先，spawn 托管下 feedLine 推送的当前进程 token 最权威。
  if (src.lines && src.lines.length) {
    for (let i = src.lines.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(src.lines[i]);
      if (t) return { token: t, source: 'stdout', line: src.lines[i] };
    }
  }

  // 本地恢复文件：stdout 管道断（守卫重启/收起）后从文件尾取最近 URL 行，使 main 无需为令牌被重建。
  if (src.file) {
    const tail = persist.readTailLines(src.file);
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(tail[i]);
      if (t) return { token: t, source: 'file', line: tail[i] };
    }
  }

  // journald（systemd 托管）：最后的回填兜底，须按单元取最近含 URL 的行。
  if (src.unit) {
    const hit = captureFromJournal(src.unit, opts);
    if (hit) return hit;
  }
  return null;
}

module.exports = { parseDshTokenLine, captureOnce };
