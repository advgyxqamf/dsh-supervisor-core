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

const DEFAULTS = {
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
  stateFile: '~/.dsh/supervisor/state.json',
  // 系统日志框架目录布局（docs/SYSTEM-LOGGING-ARCHITECTURE.md §2/§8）：log/ 与 events/ 分目录；
  // 守卫(guard) 事件在 events/guard.events.log、分级日志在 log/guard.log（daemon 用 router/lan 同构文件）。
  // 显式配置（既有生产 config.json / 测试）仍尊重用户给定路径——不强行改写。
  logFile: '~/.dsh/supervisor/events/guard.events.log',
  eventsMaxBytes: 5 * 1024 * 1024,
  supervisorLogFile: '~/.dsh/supervisor/log/guard.log',
  dshLogFile: '~/.dsh/supervisor/log/dsh.log',
  upgradeLogFile: '~/.dsh/supervisor/log/upgrade.log',
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
  notifyEnabled: true,
  routerAutostart: false, // 智能路由启动开关（旧键 switcherAutoStart 已迁移）
  // 守卫自更新（2026-09 收敛：npm 通道取代 manifest）：corePackageName = 内核自身 npm 子包名
  //（形如 @dsh-sup/dsh-core-linux-x64，按平台/架构发布；null = 不启用自更新）。
  // 旧 manifest 模式键保留仅作兼容（已无默认源）。
  corePackageName: null,
  selfUpdateManifestUrl: null,
  selfUpdateDir: null,
  pluginsProfileName: 'web',
  packageName: '@deepseek-ai/dsh',
  // 默认候选镜像源 = 预设全集（npm官方/国内三大镜像）。自动模式按延迟测速选最快可达，
  // 与 UI 预设保持一致——系统任何 npm 拉包/更新都从这组候选选源。
  registries: [
    'https://registry.npmmirror.com',
    'https://registry.npmjs.org',
    'https://mirrors.cloud.tencent.com/npm',
    'https://repo.huaweicloud.com/repository/npm/',
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

function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
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
  // 配置键迁移（2026-09）：switcherAutoStart（旧）→ routerAutostart（新）；旧键仍被尊重直到文件收敛
  if ((raw || {}).routerAutostart === undefined && (raw || {}).switcherAutoStart !== undefined) cfg.routerAutostart = raw.switcherAutoStart === true; // RC6：判 raw（DEFAULTS 已填 cfg），死分支复活
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

module.exports = { DEFAULTS, normalize, extractPortFromCommand }; // extractPortFromCommand 共享给 supervisor 运行期进程端口再推导（同一解析实现，防重复）
