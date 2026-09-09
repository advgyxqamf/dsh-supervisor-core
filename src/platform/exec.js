'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 统一子进程执行器（RC4.2）：同步 exec 的唯一入口。
//
// 问题背景（审计 P2-3）：全仓 62 处 execFileSync 无 timeout——systemctl/dbus 挂起、
// lsof 卡顿等即无限期阻塞守卫事件循环（API/探测/监督全部冻结，无超时自愈）。
//
// 契约：
//   - run()      —— 同步执行，默认 15s 硬超时（kill 'SIGKILL'），失败返回 null 并
//                  记录 warn（调用方自行降级）；**仅允许启动路径/无事件循环场景使用**。
//   - runOut()   —— 同 run()，但返回 stdout 字符串（成功时）。
//   - 新增调用一律优先考虑异步（execFile + await）；同步入口仅限守卫启动早期
//     （事件循环尚无其他职责）或 CLI 一次性命令。
// ═══════════════════════════════════════════════════════════════════════════

const { execFileSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 同步执行外部命令（有界）。
 * @param {string} bin 可执行文件
 * @param {string[]} args 参数数组
 * @param {object} [opts] { timeoutMs?: number, logger?: {warn}, allowFailure?: boolean }
 * @returns {Buffer|string|null} stdout（encoding 指定时为 string）；失败/超时返回 null
 */
function run(bin, args, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  try {
    return execFileSync(bin, args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (o.logger && o.logger.warn) {
      try { o.logger.warn('[exec] ' + bin + ' ' + args.join(' ').slice(0, 80) + ' failed: ' + ((e && e.message) || e)); } catch {}
    }
    return null;
  }
}

/** 同步执行并返回 stdout 字符串（失败/超时返回 null）。 */
function runOut(bin, args, opts) {
  const r = run(bin, args, opts);
  if (r === null) return null;
  try { return r.toString('utf8'); } catch { return null; }
}

module.exports = { run, runOut, DEFAULT_TIMEOUT_MS };
