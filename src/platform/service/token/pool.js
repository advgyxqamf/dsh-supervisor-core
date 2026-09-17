'use strict';

// 令牌池（DSH-TOKEN-CONTRACT 契约3/4，TK-1/TK-4/TK-8）。
// 本池是唯一事实源（TK-4）：id 到 { value, gen, source, at, kind }；消费方一律按需 get()，不得自行缓存；gen 为代号，每次值变化加一。
// TK-8：值变化广播 (id, value, record)，清空或注销广播 (id, null, null)，clear/detach 必广播，没有静默删除路径。
// TK-7：用户配置类权威在配置存储，list() 排除，attach 只登记。
// 落盘（TK-5/TK-6）：恢复文件经 persist.appendByRotation（原子备份、截断、0600、脱敏）；池快照需显式 opts.poolFile，缺省不落盘以免测试互相污染。
// 源形态到 kind 推断在 infer.js，池快照 IO 在 snapshot.js，本文件不直连 fs。

const path = require('node:path');
const persist = require('./persist');
const kinds = require('./kinds');
const capture = require('./capture');
const { FollowBus } = require('./follow');
const snapshot = require('./snapshot');
const { configureKindInference, kindInference, inferKind } = require('./infer');

/** 进入 RUNNING 后的捕获退避时间（ms），覆盖端口先起、URL 后打印的典型窗口。 */
const CAPTURE_RETRY_MS = [0, 1500, 4000, 8000, 15000, 30000];
/** 空令牌周期回填的节流（ms）。 */
const BACKFILL_THROTTLE_MS = 30000;
/** stdout 行缓冲上限，只保留最近的 URL 候选。 */
const MAX_PENDING_LINES = 20;

class TokenPool {
  /** @param {object} opts { logger, events, poolFile } */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this._records = new Map();   // id 到 { value, gen, source, at, kind } 的唯一令牌存储
    this._sources = new Map();   // id 到 { kind, unit, file, lines: [] } 的来源登记
    this._bus = new FollowBus({ logger: this.logger });
    this._schedules = new Map(); // id 到 { seq, i, timer } 的退避重试调度状态
    this._seq = 0;               // 调度轮次序号，新轮次使旧轮次作废
    this._backfillAt = new Map(); // id 到最近回填时间，用于节流
    this._poolFile = o.poolFile ? path.resolve(o.poolFile) : null;
    this._loaded = false;         // 池快照是否已尝试载入（只尝试一次）
  }

  /* 来源登记 */
  /** 登记或更新目标的令牌来源，同一目标重复 attach 幂等并保留已推送的 stdout 行。
   *  id 为目标标识（'main' 或实例 id）；src 形如 { kind?, unit?, file? }，kind 缺省时按源形态强推断。
   *  返回是否完成登记；kind 完全无法判定时返回 false。 */
  attach(id, src) {
    if (!id) return false;
    const s = src || {};
    const prev = this._sources.get(id);
    let kind = s.kind || (prev && prev.kind) || null;
    if (kind && !kinds.isKnownKind(kind)) {
      // 契约1：新增令牌必须在 kinds.js 登记，拒绝未登记分类，避免幽灵令牌入池。
      this.logger.warn && this.logger.warn('[token] attach(' + id + ') 拒绝：kind 未登记（§1）：' + String(kind));
      return false;
    }
    if (!kind) kind = inferKind(id, s);
    if (!kind) {
      this.logger.warn && this.logger.warn('[token] attach(' + id + ') 拒绝：缺少 kind 且无法从源形态推断（§1 要求登记分类）');
      return false;
    }
    const unit = s.unit || (prev && prev.unit) || null;
    const file = s.file || (prev && prev.file) || null;
    this._sources.set(id, { kind, unit, file, lines: (prev && prev.lines) || [] });
    const rec = this._records.get(id);
    if (rec) rec.kind = kind; // 记录已存在时补齐 kind（池快照载入的记录也带 kind，这里只兜底）
    return true;
  }

  /** 注销目标的来源与全部令牌状态（实例删除/模式切换永久放弃时调用）。
   *  TK-8：清令牌必须广播 null，否则消费方会继续用已注销目标的旧代令牌。 */
  detach(id) {
    this._cancelSchedule(id);
    this._sources.delete(id);
    this._backfillAt.delete(id);
    this.clear(id);
  }

  /* 统一捕获（源无关） */
  /** 主动捕捉一次（journal 源用）：按源顺序取“最新一条”URL 行的令牌，有变化则入库并广播。 */
  capture(id) {
    const src = this._sources.get(id);
    if (!src) return null;
    const hit = capture.captureOnce({ kind: src.kind, unit: src.unit, file: src.file, lines: src.lines }, { logger: this.logger });
    if (!hit) return null;
    // 任何源拿到令牌后，若有恢复文件则把命中原文行写入（0600、脱敏、轮转）。
    if (src.file) this._persistLine(id, src.file, hit.line);
    return this._commit(id, hit.token, hit.source);
  }

  /** spawn 托管路径：推送一行 DSH stdout（不触发 journalctl，免逐行 I/O）。 */
  feedLine(id, line) {
    if (!id || !line) return null;
    let src = this._sources.get(id);
    if (!src) {
      // 旧调用方可能未 attach 就直接喂行，按形态建一个隐式源。
      src = { kind: inferKind(id, {}), unit: null, file: null, lines: [] };
      this._sources.set(id, src);
    }
    src.lines.push(String(line));
    if (src.lines.length > MAX_PENDING_LINES) src.lines.splice(0, src.lines.length - MAX_PENDING_LINES);
    const t = capture.parseDshTokenLine(line);
    if (t) {
      if (src.file) this._persistLine(id, src.file, line); 
      return this._commit(id, t, 'stdout');
    }
    return null;
  }

  /* 捕获策略（服务内统一） */
  /** 进入 RUNNING 后按退避计划重试捕获直至窗口结束；新轮次（seq 递增）或 detach 使旧轮次作废。 */
  scheduleCapture(id) {
    if (!this._sources.has(id)) return;
    const seq = ++this._seq;
    const st = { seq, i: 0, timer: null };
    this._schedules.set(id, st);
    const tryOnce = () => {
      const cur = this._schedules.get(id);
      if (!cur || cur.seq !== seq) return; // 轮次作废或已 detach
      this.capture(id);
      st.i += 1;
      if (st.i < CAPTURE_RETRY_MS.length) {
        st.timer = setTimeout(tryOnce, CAPTURE_RETRY_MS[st.i]);
      }
    };
    tryOnce();
  }

  /** 周期兜底：令牌仍为空时按节流从来源回填（幂等，可每 tick 调用）。 */
  ensureCaptured(id) {
    const rec = this._records.get(id);
    if (rec && rec.value) return; // 已有令牌无需回填，最新性由轮换时的 scheduleCapture 保证
    // 守卫重启后内存为空，磁盘可能已有上一代令牌，先载入再判定。
    if (!this._loaded) {
      this._loadPoolFile();
      const r2 = this._records.get(id);
      if (r2 && r2.value) return;
    }
    const last = this._backfillAt.get(id) || 0;
    const now = Date.now();
    if (now - last < BACKFILL_THROTTLE_MS) return;
    this._backfillAt.set(id, now);
    this.capture(id);
  }

  /* 生命周期 */
  /** 清空某目标的令牌与调度；TK-8：必须广播 null（消费方据此立刻丢弃旧代令牌）。 */
  clear(id) {
    this._cancelSchedule(id);
    this._backfillAt.delete(id);
    this._records.delete(id);
    this._persistPool();       // 池快照同步移除该 id（原子替换，不整文件删除）
    this._bus.emit(id, null, null);
  }

  /* 查询与订阅 */
  /** 当前令牌（空串表示未捕获到）。 */
  get(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    return rec ? (rec.value || '') : '';
  }

  /** 当前令牌记录（含"代"）；未捕获返回 null。返回副本（TK-4）。 */
  getRecord(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    if (!rec) return null;
    return { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at };
  }

  /** 展示用列表（含代号与来源）；契约4：不得含用户配置类（TK-4/TK-7）。 */
  list() {
    this._loadPoolFile();
    const ids = new Set();
    for (const id of this._sources.keys()) ids.add(id);
    for (const id of this._records.keys()) ids.add(id);
    const out = [];
    for (const id of ids) {
      const src = this._sources.get(id) || null;
      const rec = this._records.get(id) || null;
      const kind = (src && src.kind) || (rec && rec.kind) || null;
      if (kinds.isUserConfigKind(kind)) continue; // 用户配置类不是 DSH 令牌，不进令牌池展示
      out.push({
        id,
        kind,
        value: rec ? (rec.value || '') : '',
        gen: rec ? rec.gen : 0,
        source: rec ? rec.source : null,
        at: rec ? rec.at : null,
      });
    }
    return out;
  }

  /** 订阅令牌变化：fn(id, value|null, record)。返回取消订阅函数。 */
  onChange(fn) {
    return this._bus.on(fn);
  }

  /* 内部 */
  /** 提交一次变化：值相同视为轮换收敛（不递增代、不广播）；值变化则 gen+1 并广播。 */
  _commit(id, value, source) {
    if (!value) return null;
    const prev = this._records.get(id);
    if (prev && prev.value === value) return value;
    const src = this._sources.get(id);
    const rec = {
      value,
      gen: (prev ? prev.gen : 0) + 1, // 每次值变化加一，代号解决无版本问题
      source: source || 'unknown',
      at: Date.now(),
      kind: (src && src.kind) || (prev && prev.kind) || null,
    };
    this._records.set(id, rec);
    this._persistPool();
    if (this.events) { try { this.events.append('dsh_token_captured', { id, source: rec.source, gen: rec.gen }); } catch { /* 事件失败不影响令牌链路 */ } }
    if (this.logger && this.logger.info) this.logger.info('[token] captured for ' + id + ' (source=' + rec.source + ', gen=' + rec.gen + ')');
    this._bus.emit(id, rec.value, { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at });
    return value;
  }

  /** 把命中令牌的原文行持久化到恢复文件（统一经 persist：脱敏 + 0600 + 超限轮转）。 */
  _persistLine(id, file, line) {
    const r = persist.appendByRotation(file, line, { maxBytes: persist.PERSIST_LIMITS.MAX_BYTES });
    if (!r.ok) this.logger.warn && this.logger.warn('[token] persist file(' + id + ') failed: ' + (r.reason || 'unknown'));
    else if (r.rotated) this.logger.info && this.logger.info('[token] persist file(' + id + ') 超限已轮转（备份保留原文，未清空）');
  }

  /** 取消某目标的退避重试，并让在途轮次作废（旧轮次 setTimeout 醒来后自查 seq 退出）。 */
  _cancelSchedule(id) {
    const st = this._schedules.get(id);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch { /* 定时器已触发 */ } }
    this._schedules.delete(id);
  }

  /** 池快照落盘（仅 poolFile 配置时）。仅持久化 TK-7 允许的分类（委托 snapshot 原子写）。 */
  _persistPool() {
    if (!this._poolFile) return;
    const entries = [];
    for (const [id, r] of this._records) {
      if (!r.value) continue;                    // 空值不落盘，没有令牌不是一种持久状态
      if (!kinds.isPersistent(r.kind)) continue; // TK-7：用户配置/派生/自签类绝不写入池文件
      entries.push({ id, value: r.value, gen: r.gen, source: r.source, at: r.at, kind: r.kind });
    }
    const w = snapshot.saveTokens(this._poolFile, entries);
    if (!w.ok) this.logger.warn && this.logger.warn('[token] pool file persist failed: ' + (w.reason || 'unknown'));
  }

  /** 从池快照恢复（只尝试一次；失败静默，恢复只是加速项，真值仍可由捕获重获）。 */
  _loadPoolFile() {
    if (this._loaded) return;
    this._loaded = true; // 先置位，读失败也不重复读盘（幂等由内存优先保证）
    if (!this._poolFile) return;
    for (const e of snapshot.loadTokens(this._poolFile)) {
      if (this._records.has(e.id)) continue; // 内存中更新的代优先
      this._records.set(e.id, { value: e.value, gen: e.gen, source: e.source, at: e.at, kind: e.kind });
    }
  }

// 兼容层已移除：TK-4 要求令牌池是唯一事实源，任何指向内部 Map 的旧访问器都会让消费方绕开 get/getRecord，成为各自缓存令牌的温床。
}

module.exports = {
  TokenPool,
  configureKindInference,
  kindInference,
};
