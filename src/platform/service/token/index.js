'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 令牌组件门面（DSH-TOKEN-CONTRACT §3/§4）—— 全系统唯一的令牌节点。
//
// 对外入口保持 `require('<...>/platform/service/token')`，目录化后解析到本文件；
// 分层门禁 unitOf 取前 3 段 → 单元名仍为 `src/platform/service/token`，门禁透明。
//
// ## 架构定位（为什么收敛到"一个节点"）
//   "DSH 的访问令牌怎么获得"只属于系统中的一个节点（本组件）。其余任何模块
//   （守卫生命周期 / 实例管理 / 远程控制 relay / API 呈现）只做两件事：
//     1) 通过统一接口把「该从哪里拿令牌」登记给本服务（attach + 源描述）；
//     2) 订阅 onChange 消费令牌（relay 热换 cookie、API 生成直连 URL）。
//   原生 DSH 与沙箱实例**没有**两套获取逻辑 —— 全部经同一方法（attach 登记源 →
//   capture 统一捕获 → 任源命中即持久化恢复文件），区别只在「源的形态」：
//     · spawn 托管的主实例：stdout 管道逐行推送（feedLine，实时、最新）；
//     · systemd 托管（沙箱实例）：journald 拉取（按单元、取最新行）；
//     · 恢复文件（所有 DSH 统一，0600 私有）：任源首次拿到令牌即回写原文行，
//       守卫重启后从文件尾恢复——main 免重建、沙箱在 journal 清空后仍可恢复（2026-09）。
//   捕获策略（退避重试、周期回填、轮换收敛）在组件内统一实现，调用方不再复制任何逻辑。
//
// ## 关键语义
//   · 令牌随 DSH 重启轮换：每一次捕获都以「最新一条 URL 行」为权威（journald 倒序 /
//     stdout 最近行优先），任何历史行都不会覆盖新令牌；
//   · 守卫重启后内存令牌清空 → 对已运行目标由 capture 统一回填（stdout → 恢复文件
//     → journald；恢复文件为任源命中的持久化缓存，0600），并由池快照加速恢复；
//   · 令牌为本组件私有：绝不写入 instances.json 等用户配置文件；恢复文件/池文件
//     仅为守卫私有状态目录下的运行时缓存（0600，不进任何用户配置）。
//
// ## 本次目录化落实的铁律
//   TK-1 令牌恒存在（捕捉链路可修，不驱动进程生命周期）；TK-4 单一存储（本池即 SSOT，
//   消费方按需 get，不得缓存）；TK-5 单一落盘点（persist.js）；TK-6 超限轮转而非清空；
//   TK-8 变更与失效/清空都广播（含 value=null）。
//
// ## 兼容性（§4）
//   get/onChange/attach/detach/capture/feedLine/scheduleCapture/ensureCaptured/clear
//   的名字与返回语义保持不变；onChange 回调**新增第 3 参 record**（向后兼容）。
//   解析函数 parseDshTokenLine 为全仓唯一实现，本文件原样再导出（语义未改）。
// ═══════════════════════════════════════════════════════════════════════════

const { TokenPool } = require('./pool');
const { parseDshTokenLine } = require('./capture');

/**
 * 令牌服务：令牌池 + 捕捉 + 跟随广播（§4 冻结 API 的门面）。
 * 实现按职责分层在 pool/capture/persist/follow/kinds，本类只做**转发与兼容**，
 * 保证既有消费方（supervisor/instance/relay/api）无需改动即可继续工作。
 */
class DshTokenService {
  /**
   * @param {object} opts { logger, events, poolFile }
   *   - poolFile: 池快照路径（可选；不传则不落盘池快照，只保留恢复文件持久化）
   */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.pool = new TokenPool({ logger: this.logger, events: this.events, poolFile: o.poolFile || null });
  }

  /* ═══════ 来源登记 ═══════ */
  /** 登记源。kind 必填（§1）；兼容期缺省时按源形态强推断（见 pool.inferKind）。 */
  attach(id, src) { return this.pool.attach(id, src); }
  /** 注销源 + 清令牌（**广播 null**，TK-8）。 */
  detach(id) { return this.pool.detach(id); }

  /* ═══════ 捕捉 ═══════ */
  /** 主动捕捉一次（journal 源）。返回当前令牌或 null。 */
  capture(id) { return this.pool.capture(id); }
  /** DSH stdout 行事件（同步命中即入池并广播）。 */
  feedLine(id, line) { return this.pool.feedLine(id, line); }
  /** 进入 RUNNING 后窗口内退避重试。 */
  scheduleCapture(id) { return this.pool.scheduleCapture(id); }
  /** 周期兜底（节流）。 */
  ensureCaptured(id) { return this.pool.ensureCaptured(id); }

  /* ═══════ 变更 ═══════ */
  /** 清令牌（**广播 null**，TK-8）。 */
  clear(id) { return this.pool.clear(id); }
  /** 订阅令牌变化：fn(id, value|null, record)。返回取消订阅函数。 */
  onChange(fn) { return this.pool.onChange(fn); }

  /* ═══════ 读取（消费方按需读，禁止缓存——TK-4）═══════ */
  /** 当前令牌值（空串表示未捕获到）。 */
  get(id) { return this.pool.get(id); }
  /** 当前令牌记录（含"代"）{ value, gen, source, at } | null。 */
  getRecord(id) { return this.pool.getRecord(id); }
  /** 展示用列表（**不含**用户配置类，TK-7）。 */
  list() { return this.pool.list(); }
}

// §4 冻结导出面：只导出 DshTokenService 与 parseDshTokenLine。
// 为什么不多导出 KINDS/工具：SSOT §3 要求端口（路径不变式）保持"用户入口 = 服务"，把
// 内部分类表做成顶层导出会诱使消费方绕开服务直接读写分类——分类的消费方是 pool/capture/
// persist 自己（它们 require kinds.js），不是外部。需要按 kind 分派的外部模块从
// `platform/service/token/kinds` 显式 require，使依赖关系在 import 处可见。
module.exports = {
  DshTokenService,
  parseDshTokenLine, // 唯一解析实现（由 capture.js 提供，语义与旧 token.js 一致）
};
