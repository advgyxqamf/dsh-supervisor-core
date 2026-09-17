'use strict';

// 反向代理应用注册表：每个反代产品=一个独立、完整、第三方的开源「应用」，我们只对接
// （安装 npx/启停/探活/转发/配额感知/自动更新检测），绝不 fork 或二改。新增产品加一条定义即可；
// 产品内不内置测试供应商（仅测试自行注册 mock 应用）。

const PROXY_APPS = {
  commandcode: {
    id: 'commandcode',
    name: 'Command Code Proxy',
    pkg: 'commandcode-api-proxy',
    // 官方运行方式（npx 一键）—— 完整独立发行版
    command: ['npx', '--yes', 'commandcode-api-proxy', '--host', '127.0.0.1', '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health',
    modelPath: '/v1/models',
    upstream: 'https://api.commandcode.ai',
    // 实例环境契约：keyEnv=账号密钥注入的 env 名（只经 env 传递，绝不进 cmdline）；app.env/超时等
    // 一律不注入，commandcode-api-proxy 跑完全默认配置（idle 120s / upstream 600s，作者设计值）——
    // 加 CC_IDLE_TIMEOUT_MS=0 等自我干预曾导致回归，故保持纯净注入。
    keyEnv: 'CC_API_KEY',
    repo: 'thaolaptrinh/commandcode-api-proxy',
    // 自动更新：最新版本从 npm registry 查（同一 package 名）。空则跳过版本检查。
    registry: 'commandcode-api-proxy',
    versionRefreshMs: 6 * 3600 * 1000, // 默认 6h 查一次 npm
    // 每账号配额来源：Command Code 官方 /alpha/billing/credits（Bearer 各账号 key；窗口 5h/weekly +
    // credits 池，无 period 字段），以及 /alpha/billing/subscriptions 的 currentPeriodEnd（月额度随订阅
    // 续期重置的精确时刻；仅 credits-limited 账号按 6h 缓存低频取，防风控）。
    // windowMap: rolling=5h、weekly=周；monthly 由订阅面推导（见 quota-strategies 的 monthlyCapUsd）。
    quota: {
      type: 'commandcode-billing',
      apiBase: 'https://api.commandcode.ai',
      creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      // 月度配额上限（$/月）：Command 订阅含 $10/月总配额池，周窗口从池内扣（weekly.used +
      // monthlyCredits.remaining = 10），解析层据此推导 monthly.percent，前端每月格子显示真实百分比。
      monthlyCapUsd: 10,
    },
    real: true,
  },
};

module.exports = { PROXY_APPS };
