'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/settings/domain-config.js —— **业务域配置键声明**（默认值 + 换名别名）
//
// 为什么在此（DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」）：
//   结构门禁 DS-G4 要求 `platform/` 源码（去注释）**不得出现业务域名词**。
//   `platform/service/config.js` 曾硬编码 `routerCtlPort` / `lanCtlPort` /
//   `routerAutostart` 三个业务键 —— 平台因此"知道"了 router/lan 域的存在。
//   反转后：平台只提供**通用配置基建**（状态根/日志/端口池/更新通道），
//   业务键的**默认值与换名别名**在此声明，由各**进程入口/装配期**注入
//   `platform/service/config.normalize(raw, extension)` / `buildDefaults(extension)`。
//
// 本模块的纪律：
//   · 只做**数据声明**（纯对象/数组），零副作用；
//   · **绝不 require `platform/service/config`** —— 否则成环，且会给 platform 造出
//     "依赖上层"的违规边（契约 DS-1 / 门禁 DS-G2、L-1、L-2）。
//   · 注入位置按语义分组（`at` 仅作文档标签，值经 Object.assign 合并）。
// ═══════════════════════════════════════════════════════════════════════════

/** 业务域默认值声明。值 = 反转前 `platform/service/config.js BASE_DEFAULTS` 中的同名字面量，逐字未改。
 *  `at` = 锚点键：本组值插入到 BASE_DEFAULTS 中该键**之前**（保持 DEFAULTS 键序与反转前一致）。 */
const defaults = [
  {
    // 原位置：BASE_DEFAULTS#apiPort 与 #portPools 之间 ⇒ 落在 portPools 之前。
    at: 'portPools',
    // daemon 控制通道端口（router/lan 独立进程 ctl）：集中定义，杜绝散落硬编码（2026-09 端口收敛）。
    // ⚠ 这两个值同时是 `app/ctl/client.js` 与两个 daemon 的兜底端口，不得单独改动
    //   （改动即需同步 8 处 43107/43108 兜底常量）。
    values: {
      routerCtlPort: 43107,
      lanCtlPort: 43108,
    },
  },
  {
    // 原位置：BASE_DEFAULTS#notifyEnabled 与 #corePackageName 之间 ⇒ 落在 corePackageName 之前。
    at: 'corePackageName',
    // 智能路由启动开关（旧键 switcherAutoStart 已迁移）。
    values: {
      routerAutostart: false,
    },
  },
];

/** 换名别名表：`[旧键, 新键]` —— 平台通用迁移机制（config.normalize 逐条应用）。
 *  语义与反转前硬编码分支逐字一致：新键缺省且旧键已给 → 布尔严格归一后写入新键。 */
const aliases = [
  ['switcherAutoStart', 'routerAutostart'], // 2026-09：switcherAutoStart → routerAutostart
];

/** 实例化一个完整注入声明（浅拷贝，防调用方改写本模块的常量）。 */
function extension() {
  return {
    defaults: defaults.map((g) => ({ at: g.at, values: Object.assign({}, g.values) })),
    aliases: aliases.map((a) => a.slice()),
  };
}

module.exports = { extension, defaults, aliases };
