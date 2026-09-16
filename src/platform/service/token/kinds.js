'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 令牌分类注册表（DSH-TOKEN-CONTRACT §1，唯一事实源）
//
// ## 为什么需要这张表（而不是到处 if 判断）
//   令牌不是一个概念，是**七个**：它们由谁生成、我方该做什么、什么时候变、
//   存在哪里全都不同（SSOT §1 关键分野）。历史上把它们用一套「拿令牌」逻辑
//   套用，才出现「用户配置令牌被当 DSH 令牌去 journal 里捞」「DSH 令牌被写进
//   用户配置」这类互相污染的缺陷（TK-3/TK-7）。
//   把分类**数据化**并在这里登记，才能让 pool/capture/persist 各自按 side/strategy
//   分派，而不是在每个调用点复制判断；新增令牌必须在此登记（门禁 TK-G1）。
//
// ## 字段语义（为什么是这几个）
//   side         生成侧：dsh（进程）/ dsh-derived（由 dsh 换取）/ user（用户填）/
//                self（我方签发）。决定「能不能捕捉」与「谁对这个值负责」：
//                只有 dsh 侧的值才可能从 DSH 输出/journal 里被捕捉到。
//   strategy     我方职责（登记性描述，供人工对照）：capture+persist（捕捉并持久化）
//                | exchange（换取+缓存）| config（仅存储/下发）| issue+verify（签发并校验）。
//                当前分派实际由 captured / persistent / side 驱动。
//   persistent   是否由我方持久化到磁盘。**用户配置类一律 false**：它们的
//                权威存储是配置存储，令牌池只是只读投影（TK-7：绝不写入令牌池文件）。
//   captured     是否可由捕捉链路拿到。用户配置类 false —— 它们不是「拿不到」，
//                而是**本来就不该去捕捉**（TK-1 只适用于 DSH 侧生成的两类）。
//   store        权威存储位置（文档/排查用）：'pool-file'（令牌池文件）|
//                'memory'（进程内存，如 relay 的 dsh-auth 交换结果）|
//                'config'（配置存储）| 'browser'（浏览器 cookie）。
//   unitBacked   源是否以 systemd 单元（journald）形态存在（登记性字段，供人工对照）；
//                capture 实际以 `src.unit` 是否非空决定是否拉 journal。
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ DS-G4：kind 注册接口（platform 去域名词，DIRECTORY-STRUCTURE-DESIGN §4.2 反转法）═══
// 平台**不**硬编码任何业务 kind 名（令牌分类表原含 dsh-* 等域名词）。§1 全部 kind
// （键名 + side/strategy/desc 文本）由 app/ 在装配期经 registerKind/setKinds 注入——
// 声明在 `app/settings/token-kinds.js`，由唯一装配点 `app/assembly/compose.js`
// 在构造令牌服务前 require（**require 即注入**）。
// 未注入时注册表为空：attach 携带未登记 kind 即拒绝（与 TK-3「新增必须登记」同语义）；
// 生产路径（守卫 compose / 经 Supervisor 的测试）始终先注入，故行为与反转前逐字一致。

/** §1 全部 kind 的**运行期注册表**（键序 = 注入顺序，与 SSOT 表格一致，便于人工对照）。 */
const KINDS = {};
/** kind 顺序清单（与 KINDS 同步维护；list() 按登记顺序输出）。 */
const KIND_ORDER = [];

/** 登记/覆盖一个 kind（幂等；新增必须登记——TK-3）。@returns {boolean} 是否登记成功。 */
function registerKind(name, def) {
  if (typeof name !== 'string' || !name) return false;
  if (!Object.prototype.hasOwnProperty.call(KINDS, name)) KIND_ORDER.push(name);
  KINDS[name] = def;
  return true;
}

/** 用给定映射**整体替换**已登记 kind（装配期幂等：重复注入结果一致）。 */
function setKinds(map) {
  for (const k of Object.keys(KINDS)) delete KINDS[k];
  KIND_ORDER.length = 0;
  if (map && typeof map === 'object') {
    for (const k of Object.keys(map)) registerKind(k, map[k]);
  }
}

/** 已登记 kind 快照（副本；供装配自检/测试）。 */
function getKinds() {
  const out = {};
  for (const k of KIND_ORDER) out[k] = KINDS[k];
  return out;
}

/** 幽灵键清单（SSOT §1 末行）：**不存在**这些令牌，src/ 中必须零引用。
 *
 *  为什么在这里**显式写出**废弃键名（而不是删掉就忘）：门禁 TK-G7 以本表为权威
 *  （readGhostKeys 优先 require 本模块的 GHOST_KEYS）——只在唯一分类表里登记一次，
 *  门禁就能自动覆盖全部幽灵键，不会留下"没人守的幽灵键"。门禁 TK-G7 对**全部** src
 *  文件判定（含令牌组件），不设路径豁免；此处键名以字符串字面量登记，被 structOf
 *  归一化后不计为引用。危害在于**消费方**把废弃键当成真令牌用，那正是 G7 要拦的。 */
const GHOST_KEYS = ['lanToken'];

/** kind 是否已登记。pool.attach 据此拒绝未登记的 kind（TK-3：新增必须登记）。 */
function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

/** 取 kind 定义（未登记返回 null，绝不抛——调用方决定是拒绝还是降级）。 */
function kindOf(kind) {
  return isKnownKind(kind) ? KINDS[kind] : null;
}

/** 是否由我方持久化。用户配置类恒 false（TK-7：不得写入令牌池文件）。 */
function isPersistent(kind) {
  const k = kindOf(kind);
  return !!(k && k.persistent);
}

/** 是否可由捕捉链路获得。只有 dsh 侧生成的两类为 true（TK-1/TK-3）。 */
function isCaptured(kind) {
  const k = kindOf(kind);
  return !!(k && k.captured);
}

/** 是否用户配置类（§1 关键分野：不捕捉、不进令牌池 list()、不随 DSH 轮换）。 */
function isUserConfigKind(kind) {
  const k = kindOf(kind);
  return !!(k && k.side === 'user');
}

/** 是否 DSH 侧生成（唯一允许走「捕捉 → 令牌池 → 广播」通道的两类）。 */
function isDshSideKind(kind) {
  const k = kindOf(kind);
  return !!(k && k.side === 'dsh');
}

module.exports = {
  KINDS,
  KIND_ORDER,
  GHOST_KEYS,
  registerKind,
  setKinds,
  getKinds,
  isKnownKind,
  kindOf,
  isPersistent,
  isCaptured,
  isUserConfigKind,
  isDshSideKind,
};
