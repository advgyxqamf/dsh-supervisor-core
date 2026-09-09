'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 领域：DSH 会话访问令牌服务（DshTokenService）—— 全系统唯一的令牌节点。
//
// 架构定位（单一事实源，替代旧的分散实现）：
//   「DSH 的访问令牌怎么获得」只属于系统中的一个节点（本服务）。其余任何模块
//   （守卫生命周期 / 实例管理 / 远程控制 relay / API 呈现）只做两件事：
//     1) 通过统一接口把「该从哪里拿令牌」登记给本服务（attach + 源描述）；
//     2) 订阅 tokenUpdated 事件消费令牌（relay 热换 cookie、API 生成直连 URL）。
//   原生 DSH 与沙箱实例没有两套获取逻辑——全部经同一统一方法（attach 登记源 →
//   capture 统一捕获 → 任源命中即持久化恢复文件），区别只在「源的形态」：
//     · spawn 托管的主实例：stdout 管道逐行推送（feedLine，实时、最新）；
//     · systemd 托管（沙箱实例）：journald 拉取（按单元、取最新行）；
//     · 恢复文件（所有 DSH 统一，0600 私有）：任源首次拿到令牌即回写原文行，
//       守卫重启后从文件尾恢复——main 免重建、沙箱在 journal 清空后仍可恢复（2026-09）。
//   捕获顺序统一：活跃 stdout → 本地恢复文件 → journald。
//   捕获策略（退避重试、周期回填、轮换收敛）在服务内统一实现，调用方不再复制任何逻辑。
//
// 关键语义：
//   - 令牌随 DSH 重启轮换：每一次捕获都以「最新一条 URL 行」为权威（journald 倒序 /
//     stdout 最近行优先），任何历史行都不会覆盖新令牌；
//   - “端口先起、URL 后打印”的窗口内，首次捕获可能拿到空/旧令牌 → 进入运行后必须
//     反复捕获直至窗口结束（scheduleCapture），另由周期 ensureCaptured 兜底；
//   - 守卫重启后内存令牌清空 → 对已运行目标由 capture 统一回填：stdout → 本地恢复文件
//     → journald（恢复文件为任源命中的持久化缓存，0600；main 免重建、沙箱 journal 清空兜底）；
//   - 令牌为本服务私有：绝不写入 instances.json 等配置文件；恢复文件仅为守卫私有
//     stateDir 下的运行时令牌缓存（0600，不进任何用户配置），重启后据此/再捕获恢复。
// ═══════════════════════════════════════════════════════════════════════════

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 解析 DSH 启动输出行中的回环访问令牌（唯一实现，全仓共用）。
 *  形如：dsh web: http://127.0.0.1:3080/?token=xxx (LAN: http://192.168.x.x:3080/?token=xxx)
 *  只认 127.0.0.1 回环 URL；令牌限安全字符集（base64url）。找不到返回 null。 */
function parseDshTokenLine(line) {
  const m = /(?:dsh web:)?\s*(?:https?:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** 进入 RUNNING 后的捕获退避时间（ms）——覆盖 “端口先起、URL 后打印” 的典型窗口。 */
const CAPTURE_RETRY_MS = [0, 1500, 4000, 8000, 15000, 30000];
/** 空令牌周期回填的节流（ms）。 */
const BACKFILL_THROTTLE_MS = 30000;
/** stdout 行缓冲上限（只保留最近的 URL 候选，防止无限增长）。 */
const MAX_PENDING_LINES = 20;
/** journald 一次读取的最近行数窗口。 */
const JOURNAL_LINES = 400;
/** 本地恢复文件一次读取的尾部字节窗口。 */
const FILE_TAIL_BYTES = 64 * 1024;

class DshTokenService {
  /**
   * @param {object} opts { logger, events }
   */
  constructor(opts) {
    this.logger = (opts && opts.logger) || console;
    this.events = (opts && opts.events) || null;
    this._tokens = new Map();    // id -> { token, source, updatedAt }（唯一令牌存储）
    this._sources = new Map();   // id -> { unit: string|null, file: string|null, lines: string[] }（令牌来源登记）
    this._listeners = new Set(); // 令牌变化订阅（relay 热更 / 其它消费方）
    this._schedules = new Map(); // id -> { seq, i, timer }（退避重试调度状态）
    this._seq = 0;               // 调度轮次序号（新入口使旧轮次作废）
    this._backfillAt = new Map(); // id -> 最近回填时间（节流）
  }

  /* ═══════ 来源登记（统一接入点）═══════ */
  /**
   * 登记/更新目标的令牌来源。同一目标重复 attach 幂等（保留已推送的 stdout 行）。
   * @param {string} id   目标标识（'main' 或实例 id，即 dsh-web@ 单元后缀）
   * @param {object} src  { unit?: string, file?: string }
   *   - unit: systemd 单元名（journald 源）；spawn 模式传 null/省略
   *   - file: 本地原文输出恢复文件（守卫 spawn main 专用 0600）——守卫重启后从文件尾恢复令牌
   */
  attach(id, src) {
    if (!id) return;
    const prev = this._sources.get(id);
    const unit = (src && src.unit) || (prev && prev.unit) || null;
    const file = (src && src.file) || (prev && prev.file) || null;
    this._sources.set(id, { unit, file, lines: (prev && prev.lines) || [] });
  }

  /** 注销目标的来源与全部令牌状态（实例删除 / 模式切换永久放弃时调用）。 */
  detach(id) {
    this.clear(id);
    this._sources.delete(id);
  }

  /* ═══════ 统一捕获（源无关）═══════ */
  /**
   * 按来源顺序取「最新一条」URL 行的令牌：journald（systemd 托管）→ stdout 行缓冲（spawn 托管）。
   * 有变化则入库并广播。返回当前令牌（或 null）。
   */
  capture(id) {
    const src = this._sources.get(id);
    if (!src) return null;
    let token = null;
    let source = null;
    let tokenLine = null; // 命中令牌的原文行（统一持久化到恢复文件）
    // stdout 实时行优先（spawn 托管 feedLine 推送的当前进程 token 最权威）；
    // journal 仅作 systemd 托管/无 stdout 缓冲时的回填兜底——顺序反了会让 journal 里
    // 陈旧/别的 unit 的旧 token 覆盖刚捕获的新 token（2026-09 实证 main 远程一直注入中）。
    if (src.lines && src.lines.length) {
      for (let i = src.lines.length - 1; i >= 0; i--) {
        const t = parseDshTokenLine(src.lines[i]);
        if (t) { token = t; source = "stdout"; tokenLine = src.lines[i]; break; }
      }
    }
    // 本地恢复文件（main 专用）：stdout 管道断（守卫重启/收起）后从文件尾取最近 URL 行——
    // 使 main 无需为令牌被重建（会话中断修复 2026-09）。文件由守卫追加原文行（0600 未脱敏）。
    if (!token && src.file) {
      try {
        const fp = path.resolve(src.file);
        if (fs.existsSync(fp)) {
          let fd;
          try {
            fd = fs.openSync(fp, 'r');
            const st = fs.fstatSync(fd);
            const len = Math.min(st.size, FILE_TAIL_BYTES);
            const buf = Buffer.alloc(len);
            if (len > 0) {
              fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
              const tail = String(buf).split(/\r?\n/);
              for (let i = tail.length - 1; i >= 0; i--) {
                const t = parseDshTokenLine(tail[i]);
                if (t) { token = t; source = 'file'; tokenLine = tail[i]; break; }
              }
            }
          } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
        }
      } catch (e) { this.logger.warn && this.logger.warn('[token] file capture(' + id + ') failed: ' + e.message); }
    }
    if (!token && src.unit) {
      try {
        // 用 -g（journald grep）取「最近一条含回环 URL 的行」而非固定最近 N 行——
        // 长驻实例启动时的 token 行会随日志增长滚出最近 400 行窗口 → 令牌永远捕获不到
        // → 远程 relay 无 cookie 401（2026-09 实证 inst-…920 启动 18h+ 未重启即此症）。
        const out = execFileSync('journalctl', ['--user', '-u', src.unit + '.service', '--no-pager', '-o', 'cat', '-g', '127\.0\.0\.1:.*token=', '-n', '1'], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = out.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const t = parseDshTokenLine(lines[i]);
          if (t) { token = t; source = 'journal'; tokenLine = lines[i]; break; }
        }
      } catch (e) {
        this.logger.warn && this.logger.warn('[token] journal capture(' + id + '/' + src.unit + ') failed: ' + e.message);
      }
    }
    if (!token && src.lines && src.lines.length) {
      for (let i = src.lines.length - 1; i >= 0; i--) {
        const t = parseDshTokenLine(src.lines[i]);
        if (t) { token = t; source = 'stdout'; break; }
      }
    }
    if (!token) return null;
    // 统一持久化：任何源拿到令牌后，若有配置恢复文件 → 把命中令牌的原文行写入（0600）。
    // main 与沙箱共用同一恢复文件机制——守卫重启后无论从 stdout/恢复文件/journal 哪个源
    // 恢复，都能回写并保持文件为最新权威缓存。
    if (src.file && tokenLine) this._persistTokenFile(id, src.file, tokenLine);
    return this._setIfChanged(id, token, source);
  }

  /**
   * spawn 托管路径：推送一行 DSH stdout（不触发 journalctl，免逐行 I/O）。
   * 命中 URL 行且令牌变化时立即入库并广播（最快路径）。
   */
  feedLine(id, line) {
    if (!id || !line) return null;
    const src = this._sources.get(id) || this._sources.set(id, { unit: null, lines: [] }).get(id);
    src.lines.push(String(line));
    if (src.lines.length > MAX_PENDING_LINES) src.lines.splice(0, src.lines.length - MAX_PENDING_LINES);
    const t = parseDshTokenLine(line);
    if (t) {
      if (src.file) this._persistTokenFile(id, src.file, line); // 统一持久化恢复文件
      return this._setIfChanged(id, t, 'stdout');
    }
    return null;
  }

  /* ═══════ 捕获策略（服务内统一）═══════ */
  /** 进入 RUNNING 后按退避计划重试捕获，直至捕获窗口结束（每次取最新行，天然收敛到当前进程令牌）。
   *  新进入轮次（seq 递增）或 detach 会使旧轮次的挂起重试作废。 */
  scheduleCapture(id) {
    if (!this._sources.has(id)) return;
    const seq = ++this._seq;
    const st = { seq, i: 0, timer: null };
    this._schedules.set(id, st);
    const tryOnce = () => {
      if (!this._schedules.has(id) || this._schedules.get(id).seq !== seq) return; // 轮次作废
      this.capture(id);
      st.i += 1;
      if (st.i < CAPTURE_RETRY_MS.length) {
        st.timer = setTimeout(tryOnce, CAPTURE_RETRY_MS[st.i]);
      }
    };
    tryOnce();
  }

  /** 周期兜底：令牌仍为空（守卫重启后不落盘 / 首次窗口错过）时按节流从来源回填。幂等，可每 tick 调用。 */
  ensureCaptured(id) {
    if (this._tokens.has(id)) return; // 已有令牌无需回填（最新性由轮换时的 scheduleCapture 保证）
    const last = this._backfillAt.get(id) || 0;
    const now = Date.now();
    if (now - last < BACKFILL_THROTTLE_MS) return;
    this._backfillAt.set(id, now);
    this.capture(id);
  }

  /* ═══════ 生命周期 ═══════ */
  /** 清空某目标的令牌与调度（令牌轮换开始时调用；不做持久化，之后由捕获重新获取）。 */
  clear(id) {
    const st = this._schedules.get(id);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
    this._schedules.delete(id);
    this._backfillAt.delete(id);
    this._tokens.delete(id);
  }

  /* ═══════ 查询与订阅 ═══════ */
  /** 当前令牌（空串表示未捕获到）。 */
  get(id) {
    const t = this._tokens.get(id);
    return t ? t.token : '';
  }

  /** 订阅令牌变化：fn(id, token)。返回取消订阅函数。 */
  onChange(fn) {
    if (typeof fn === 'function') this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /* ── 内部 ── */
  /** 把命中令牌的原文行持久化到该 id 的恢复文件（0600，追加+超限裁剪）。
   *  main 与沙箱统一：任源(journal/stdout捕获)首次拿到令牌即回写，文件始终是最新权威缓存。 */
  _persistTokenFile(id, file, tokenLine) {
    try {
      const fp = path.resolve(file);
      const dir = path.dirname(fp);
      if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
      let size = 0;
      try { size = fs.statSync(fp).size; } catch {}
      if (size > 256 * 1024) { try { fs.rmSync(fp); } catch {} } // 超限重置只留新行
      fs.appendFileSync(fp, String(tokenLine).replace(/\r?\n$/, '') + '\n', { mode: 0o600 });
    } catch (e) { this.logger.warn && this.logger.warn('[token] persist file(' + id + ') failed: ' + e.message); }
  }

  _setIfChanged(id, token, source) {
    const prev = this._tokens.get(id);
    if (prev && prev.token === token) return token;
    this._tokens.set(id, { token, source: source || 'unknown', updatedAt: Date.now() });
    if (this.events) this.events.append('dsh_token_captured', { id, source: source || 'unknown' });
    if (this.logger && this.logger.info) this.logger.info('[token] captured for ' + id + ' (source=' + (source || 'unknown') + ')');
    for (const fn of this._listeners) {
      try { fn(id, token); } catch (e) { this.logger.warn && this.logger.warn('[token] listener(' + id + ') error: ' + e.message); }
    }
    return token;
  }
}

module.exports = { DshTokenService, parseDshTokenLine };
