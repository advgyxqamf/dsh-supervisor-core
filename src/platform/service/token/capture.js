'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 捕捉层（DSH-TOKEN-CONTRACT §3/§4，TK-1/TK-3/TK-7）
//
// ## 为什么「捕捉」要独立成层
//   令牌由 DSH 侧生成（§1 side=dsh），我方拿不到生成动作，只能从 DSH 的**输出**
//   里把它捞出来。输出有两种形态，且各有各的坑：
//     · spawn 托管（main）：stdout 管道逐行推送 —— 实时、最新，但管道随守卫重启断开；
//     · systemd 托管（沙箱实例）：输出只进 journald —— 进程重启后仍在，但要按单元拉取；
//     · 本地恢复文件：我方自己写的「原文行」缓存 —— 覆盖前两者都不可达的窗口
//       （守卫重启后 main 免重建，2026-09 实证）。
//   把这三种源及其**优先级**收敛在此，pool 才能只关心「值 + 代」，不再到处写 I/O。
//
// ## 捕捉顺序（顺序错了会捕获到旧令牌）
//   stdout 实时行 → 本地恢复文件 → journald。
//   2026-09 实证：若 journal 优先，journal 里陈旧/别的 unit 的旧 token 会覆盖
//   刚由 stdout 捕获的新 token（main 远程一直注入中）。
//
// ## TK-7：用户配置类**只登记、不捕捉**
//   remote-token / api-access-key / frp-auth 由用户填写，权威在配置存储；去 DSH
//   输出里「捕捉」它们既无意义，更会诱使有人把配置值写进令牌池文件。故捕捉层
//   对非 captured 分类直接 no-op（见 kinds.isCaptured），且**没有**任何写配置的路径。
//
// ## 历史教训（必须保留）
//   · journal 取「最近一条含回环 URL 的行」而非固定最近 N 行：
//     长驻实例启动时的 token 行会随日志增长滚出最近 400 行窗口 → 令牌永远捕获不到
//     → 远程 relay 无 cookie 401（2026-09 实证 inst-…920 启动 18h+ 未重启即此症）。
//     故用 journalctl -g '127.0.0.1:.*token=' -n 1，而不是 tail。
//   · 「端口先起、URL 后打印」的窗口内首次捕获可能拿到空/旧令牌 → 由 pool 的
//     退避重试（scheduleCapture）与周期兜底（ensureCaptured）负责，本层只做一次拉取。
// ═══════════════════════════════════════════════════════════════════════════

const ex = require('../../util/exec');
const persist = require('./persist');
const kinds = require('./kinds');

/** 解析 DSH 启动输出行中的回环访问令牌（唯一实现，全仓共用）。
 *  形如：dsh web: http://127.0.0.1:3080/?token=xxx (LAN: http://192.168.x.x:3080/?token=xxx)
 *  只认 127.0.0.1 回环 URL；令牌限安全字符集（base64url）。找不到返回 null。
 *
 *  ⚠ 本函数由原单文件 src/platform/service/token.js 原样迁移而来（正则与语义**逐字未改**）——
 *    它是全仓唯一的解析实现，任何「顺手优化」都会改变令牌边界（例如放宽字符集
 *    会把 URL 里的后续片段吞进令牌）。改动必须同时更新契约与门禁。 */
function parseDshTokenLine(line) {
  const m = /(?:dsh web:)?\s*(?:https?:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** journald 查询：按单元取「最近一条含回环 URL 的行」。 */
function captureFromJournal(unit, opts) {
  const logger = (opts && opts.logger) || console;
  try {
    // 经统一执行器：runOut 失败返回 null（不再依赖 try/catch），且输出有上限。
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

/**
 * 按来源顺序取「最新一条」URL 行的令牌。
 * @param {object} desc 源描述 { kind, unit, file, lines }
 * @returns {{token:string, source:string, line:string}|null}
 */
function captureOnce(desc, opts) {
  const src = desc || {};
  const logger = (opts && opts.logger) || console;
  // TK-7/TK-3：非捕捉分类（用户配置/派生/自签）不参与捕捉——只登记不捕捉。
  if (!kinds.isCaptured(src.kind)) return null;

  // 1) stdout 实时行优先（spawn 托管 feedLine 推送的当前进程 token 最权威）。
  if (src.lines && src.lines.length) {
    for (let i = src.lines.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(src.lines[i]);
      if (t) return { token: t, source: 'stdout', line: src.lines[i] };
    }
  }

  // 2) 本地恢复文件（main 专用）：stdout 管道断（守卫重启/收起）后从文件尾取最近 URL 行——
  //    使 main 无需为令牌被重建（会话中断修复 2026-09）。文件由本组件持久化（0600 + 已脱敏）。
  if (src.file) {
    const tail = persist.readTailLines(src.file);
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(tail[i]);
      if (t) return { token: t, source: 'file', line: tail[i] };
    }
  }

  // 3) journald（systemd 托管）：最后的回填兜底（见文件头「journal 取最近行」教训）。
  if (src.unit) {
    const hit = captureFromJournal(src.unit, opts);
    if (hit) return hit;
  }
  return null;
}

module.exports = { parseDshTokenLine, captureOnce, captureFromJournal };
