'use strict';

// 配置地基：默认值 + 归一化。守卫配置从 config.json 读取，经 normalize 校验并铺平。
// config.js 保持纯函数、无副作用，便于单元测试与跨领域复用。

const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 产品状态根（独立于 DSH 的 ~/.dsh）——单一事实源 = platform/service/state-root.js。
// 进程内固定：避免运行中环境变化导致状态目录半途切换。
const SUP = require('./state-root').supervisorDir();

// ── 业务域配置键 = **注入点**（DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」）──
//
// 平台本体只承担**通用**配置（状态根/日志/端口池/更新通道/API 地址…）。任何**业务**配置键
// （控制通道端口、启用意图…）**不得**在平台源码出现字面量 —— 否则平台就"知道"了上层业务，
// 结构门禁 DS-G4 判违规。业务键的**默认值与换名别名**由上层在入口/装配期注入，声明位于
// `app/settings/domain-config.js`（app 合法拥有域知识）。
//
// 注入声明形态：
//   { defaults: [ { at: '<语义位置标签>', values: { key: value, … } }, … ],
//     aliases:  [ ['旧键', '新键'], … ] }
//
// ⚠ 为何不是 `platform → app` 的静态 require：
//   那会构成 `platform 依赖上层`（契约 DS-1 / 门禁 DS-G2、L-1、L-2 三重违规），
//   且 config.js ← app ← … 成环。
// ⚠ 为何也不是"平台内置域默认字面量 + 空注入兜底"：
//   字面量本身就是 DS-G4 的命中项 —— 反转的意义正在于**平台源码零业务键**。
//   但每个真实入口都显式注入（守卫 compose / router-daemon / relay-daemon / launcher 模板），
//   故生产行为与反转前**逐字一致**；未注入时 §normalize 输出不含业务键，
//   而全部消费点本就带兜底常量（`Number(cfg.x) || 43107`、`=== true`），故不会因此崩溃或误判。
const NO_EXTENSION = Object.freeze({ defaults: [], aliases: [] });

/** 规范化外部注入声明；非法/缺省 ⇒ 空注入（不追加任何业务键）。 */
function normalizeExtension(ext) {
  if (!ext || typeof ext !== 'object') return NO_EXTENSION;
  return {
    defaults: Array.isArray(ext.defaults) ? ext.defaults : [],
    aliases: Array.isArray(ext.aliases) ? ext.aliases : [],
  };
}

/** 平台**通用**默认值（此对象**不得**含任何业务域键 —— DS-G4）。 */
const BASE_DEFAULTS = {
  probeIntervalMs: 5000,
  // 健康探测（三层）：L0 进程存活 + L1 端口监听 + L2 HTTP GET healthUrl。
  // probeTimeoutMs = 单次 HTTP 探测超时；failThreshold = 连续失败次数 → 判故障（防抖动）；
  // httpProbeEnabled=false 时退化为「端口在线即健康」（自定义非 HTTP 命令时使用）。
  probeTimeoutMs: 3000,
  failThreshold: 2,
  httpProbeEnabled: true,
  startTimeoutMs: 30000,
  stopGraceMs: 10000,
  portReleaseWaitMs: 10000,
  crashWindowMs: 600000,
  crashBurst: 5,
  backoff: [30000, 60000, 120000, 300000, 600000],
  apiHost: '127.0.0.1',
  // API 端口：高位不常用段起始（3100 常用端口易与本机程序冲突）。守卫启动被占则自动顺延并持久化。
  apiPort: 36360,
  // ⚠ 2026-09-16（DS-G4 收敛）：**原此处硬编码** daemon 控制通道端口（43107/43108）。
  //   该二键属业务域知识 → 已反转至 app/settings/domain-config.js 声明、
  //   经 normalize/buildDefaults 的第二参注入。原键名与值**逐字保留**（消费方零改动）。
  // 动态端口池（工业标准：范围是配置项，非编译期常量）。默认避开 OS 动态端口范围
  // （Linux ip_local_port_range=32768-60999），落在 IANA User 段低位供监听池使用。
  // managed = relay/proxyInstance/oauthCallback 共享池（K8s 单一范围思想，杜绝段碎片化）；
  // providerApi = 智能路由供应商独立端点池（按供应商规模调大）。null = 用内置默认池。
  portPools: null,
  stateFile: path.join(SUP, 'state.json'),
  // 系统日志框架目录布局：log/ 与 events/ 分目录；
  // 守卫(guard) 事件在 events/guard.events.log、分级日志在 log/guard.log（daemon 用 router/lan 同构文件）。
  // 显式配置（既有生产 config.json / 测试）仍尊重用户给定路径——不强行改写。
  logFile: path.join(SUP, 'events', 'guard.events.log'),
  eventsMaxBytes: 5 * 1024 * 1024,
  supervisorLogFile: path.join(SUP, 'log', 'guard.log'),
  dshLogFile: path.join(SUP, 'log', 'dsh.log'),
  upgradeLogFile: path.join(SUP, 'log', 'upgrade.log'),
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
  notifyEnabled: true,
  // ⚠ 原此处硬编码 routerAutostart（智能路由启动开关）同属业务域知识 → 同经注入声明提供。
  // 内核更新（单写入者 = 桌面壳）：corePackageName = 内核自身 npm 子包名
  //（形如 @dsh-sup/dsh-core-linux-x64，按平台/架构发布）。守卫**只读**它来查询版本状态；
  //安装/升级由桌面壳执行（见 RELEASE-AND-UPDATE-MECHANISM.md §6）。
  corePackageName: null,
  // ⚠ 2026-09-15：旧 manifest 模式的残留键 `selfUpdateManifestUrl` / `selfUpdateDir` **已删除**
  //   （全仓无赋值点；其唯一消费方曾改为按 corePackageName 判定）。既有用户 config.json 若仍含
  //   这两键，加载时忽略即可（未知键不报错）。新代码**不得**再引入 manifest 更新通道。
  pluginsProfileName: 'web',
  packageName: '@deepseek-ai/dsh',
  // 灰度名单（RELEASE-CHANNEL-CONTRACT §5）：本机配置 canary:true 即视为灰度机。
  // 仅对**我们的**内核包（@dsh-sup/dsh-core-<os>-<arch>）生效 —— dist 据此读 canary tag；
  // 对第三方包（packageName）无效。名单**否定优先**：未置真即非灰度。
  canary: false,
  // **最小兜底**镜像源（2026-09-11 契约化）。
  //
  // ⚠ 完整目录与探测规格**不在这里** —— 它们是**壳**的产物：
  //   用户在装壳那刻机器上没有内核，壳必须先完成镜像选择才能装内核，
  //   故「镜像源管理」的所有权在壳，经 <产品状态根>/supervisor/registry.json 投放（见 state-root.js），
  //   内核由 platform/distribution 的 DistributionManager 读取（见 platform/contract/registry.js）。
  //
  // 此处仅保留 2 条，覆盖「契约不可用时也能跑」这一底线（不变量 C2）：
  //   官方源（能上网）+ npmmirror（中国网络）。
  //
  // 历史：曾在此硬编码与 dist/index.js、壳 mirror.rs **逐字节相同的 6 条**，
  //   任何一处增删都会漂移；且因两侧探测方法不同，实测会**选到不同的源**。
  registries: [
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ],
  updateCheckEnabled: true,
  updateCheckIntervalMs: 3600000,
  initialCheckDelayMs: 20000,
  upgradeTimeoutMs: 600000,
  installCommandTemplate: ['npm', 'install', '-g', '{pkg}@{version}'],
  // apiAccessKey（可选，2026-09 D/F2 拍板）：出回环访问密钥——仅当配置了该键时，
  // 0.0.0.0（局域网）与 FRP 公网通道的 API 请求必须携带 Authorization: Bearer <key>
  // 或 ?access_key=<key>，否则 401；本地回环（127.0.0.1/localhost/::1）豁免。
  // 不配置 = 维持现状（LAN 受 RFC1918 白名单约束，FRP 暴露仍强制 remoteToken）。
  apiAccessKey: null,
  // 关闭窗口时的行为（2026-09 用户定稿，系统级）：'hide' = 隐藏至系统托盘（默认，服务继续常驻）；
  // 'exit' = 退出管家——结束壳并停止全部服务链（守卫 + DSH 主实例 + 沙箱 + 路由/远程 daemon）。
  closeAction: 'hide',
};

/** 合并「注入的业务域默认值」+「平台通用默认值」→ 完整 DEFAULTS。
 *  设计要点：
 *   · 注入组的 `at` = **锚点键**：该组的值落在 BASE_DEFAULTS 中此键**之前** →
 *     完整 DEFAULTS 的键序与反转前**逐字一致**（launcher 落盘的配置模板无字节漂移）。
 *   · 锚点未命中 ⇒ 追加到末尾（容错，绝不丢键）；同名键以**平台侧**为准（显式覆盖）。
 *  @param ext 注入声明（缺省 = 纯平台默认值，零业务键 —— DS-G4）。 */
function buildDefaults(ext) {
  const pending = normalizeExtension(ext).defaults.slice();
  const out = {};
  for (const key of Object.keys(BASE_DEFAULTS)) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const g = pending[i];
      if (g && g.at === key) {
        if (g.values && typeof g.values === 'object') Object.assign(out, g.values);
        pending.splice(i, 1);
      }
    }
    out[key] = BASE_DEFAULTS[key];
  }
  for (const g of pending) {
    if (g && g.values && typeof g.values === 'object') Object.assign(out, g.values);
  }
  return out;
}

/** 模块级默认值 = **无业务键**的平台默认值。
 *  ⚠ 需要业务键（如 launcher 落盘模板）请用 `buildDefaults(注入声明)`；
 *    直接读本对象是反转前的旧用法，会缺业务键。 */
const DEFAULTS = buildDefaults(null);

function normalize(raw, ext) {
  const extension = normalizeExtension(ext);
  const provided = raw || {};
  const cfg = Object.assign(buildDefaults(extension), provided);
  cfg.stateFile = expandHome(cfg.stateFile);
  cfg.logFile = expandHome(cfg.logFile);
  cfg.supervisorLogFile = expandHome(cfg.supervisorLogFile);
  cfg.dshLogFile = expandHome(cfg.dshLogFile);
  cfg.upgradeLogFile = expandHome(cfg.upgradeLogFile);
  // healthUrl 非法直接 fail-fast（静默降级会让探测永远失败且难排查）
  let u;
  try {
    u = new URL(cfg.healthUrl);
  } catch {
    throw new Error('config.healthUrl 无效: ' + JSON.stringify(cfg.healthUrl));
  }
  cfg.targetHost = u.hostname;
  cfg.targetPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  // 配置键迁移（2026-09）：换名别名由**注入声明**提供（原硬编码分支已随 DS-G4 反转迁出）。
  // 语义逐字保持：别名仅在「新键未给」且「旧键已给」时生效，布尔归一严格 === true。
  // ⚠ 判 **provided（raw）** 而非 cfg：DEFAULTS 已填新键默认值，判 cfg 会让分支恒死
  //   （这就是历史 RC6 缺陷；注释保留以防再踩）。
  for (const [from, to] of extension.aliases) {
    if (provided[to] === undefined && provided[from] !== undefined) cfg[to] = provided[from] === true;
  }
  // 动态端口注册：command 里的 --port/-p 是 DSH 实际启动参数（用户改端口时最真实）——
  // 若 command 指定了端口，以其为准覆盖 healthUrl 端口（用户使用场景各异，绝不硬编码 3080）
  const cmdPort = extractPortFromCommand(cfg.command);
  if (cmdPort !== null) cfg.targetPort = cmdPort;
  // 健康维度参数归一化：非法值回退默认，杜绝 NaN/负数进入探测链路
  cfg.probeTimeoutMs = Number.isFinite(Number(cfg.probeTimeoutMs)) && Number(cfg.probeTimeoutMs) > 0 ? Number(cfg.probeTimeoutMs) : 3000;
  cfg.failThreshold = Number.isInteger(Number(cfg.failThreshold)) && Number(cfg.failThreshold) >= 1 ? Number(cfg.failThreshold) : 2;
  cfg.httpProbeEnabled = cfg.httpProbeEnabled !== false;
  if (!Array.isArray(cfg.command) || cfg.command.length === 0) {
    throw new Error('config.command 缺失：需要一个命令数组');
  }
  return cfg;
}

/** 从启动命令提取端口（--port N / -p N）；无则返回 null。 */
function extractPortFromCommand(command) {
  if (!Array.isArray(command)) return null;
  for (let i = 0; i < command.length; i++) {
    const a = String(command[i]);
    if ((a === '--port' || a === '-p') && i + 1 < command.length) {
      const n = Number(command[i + 1]);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
    const m = /^--port=(\d+)$/.exec(a);
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0 && n <= 65535) return n; }
  }
  return null;
}

// extractPortFromCommand 共享给 supervisor 运行期进程端口再推导（同一解析实现，防重复）。
// BASE_DEFAULTS/buildDefaults 供入口（launcher 模板 / 装配层）取含业务键的完整默认值。
module.exports = { DEFAULTS, BASE_DEFAULTS, buildDefaults, normalize, extractPortFromCommand };
