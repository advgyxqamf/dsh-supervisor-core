# 产品认知 → 目标目录结构 定稿（2026-09-05 二轮讨论）

> **执行状态（2026-09-06）**：M1（guard/）→M2a/b（platform/ + platform/os/）→M3（domains/router + domains/relay）→M4（domains/instance/plugin/dist）→M5（API → src/api/ 按域拆文件）已全部落地，26 套件全绿。

## 1. 第一性：域 = 功能

- **域就是一个功能模块**；有的功能有完整独立生命周期（router/relay/instance，底层配服务），
  有的只是配合功能的简单实现（pluginmarket 市场，无服务也属域）。
- 原生 DSH = 实例管理域内的【原生实例】（特殊实例，与沙箱统一生命周期管理逻辑）。
- 对外发布策略（scripts/*.sh 打包/发布/生成 manifest）= 封装期策略，**不是产品内功能**，不参与运行时。
- 镜像源 / 安装执行器（DistributionManager 的 registry + runNpmInstall）= 被全系统共享的**真公共设施**。

## 2. 三层结构（定稿）

| 层 | 内容 | 说明 |
|---|---|---|
| guard 守卫 | supervisor + lifecycle + monitor + guardian | 产品壳：串联各功能 + 监管其生命周期 + 策略分发；守护件归守卫，不进公共 |
| domains 功能域 | router / relay / instance(含原生DSH) / plugin(含pluginmarket) / dist(运行时升级) | 平级；域内业务自治，向守卫暴露生命周期面 |
| platform 公共机制 | registry(镜像源) + install(安装执行) + ports/token/events/tasks/logs/config/version/fs | 真通用设施，被各域与守卫共享 |

## 3. 目标目录

src/
├─ guard/
│  ├─ supervisor.js      # 串联各功能 + 监管生命周期 + 策略分发
│  ├─ lifecycle/        # 生命周期监管
│  ├─ monitor/          # 健康观测
│  └─ guardian/         # 守护策略
├─ domains/
│  ├─ router/           # 智能路由域（daemon/ctl 域内；切换/账号/反代自治）
│  ├─ relay/            # 远程控制域（daemon 域内；隧道/frp 自治）
│  ├─ instance/         # 实例管理域
│  │  ├─ native.js      # 原生 DSH（特殊实例）★统一逻辑
│  │  └─ sandbox.js     # 沙箱实例
│  ├─ plugin/           # 插件域（含 pluginmarket 市场功能）
│  └─ dist/             # 分发/升级域（守卫自更新等运行时升级）
├─ platform/            # 公共机制
│  ├─ registry.js       # 镜像源（由 domain/dist 提取）
│  ├─ installer.js      # 安装执行器 runNpmInstall（由 domain/dist 提取）
│  ├─ ports/ token/ events/ tasks/ logs/ config/ version/ fs/
└─ presentation/        # API 出口
(scripts/*.sh 发布策略 ← 产品外，不属 src)

## 4. 当前 → 目标的搬迁清单（定稿）

| # | 当前实现 | 目标归属 | 动作 |
|---|---|---|---|
| 1 | system-services/router/* + service-daemon/router-daemon.js + router-ctl.js | domains/router/（daemon/ctl 域内） | 移动+重命名 |
| 2 | system-services/relay/* + service-daemon/lan-daemon.js | domains/relay/（daemon 域内） | 移动 |
| 3 | domain/instance + supervisor 对 main 的 tick 独揽 | domains/instance/（原生 DSH 统一进实例生命周期） | 重构 main 进统一 watchdog |
| 4 | domain/lifecycle + domain/monitor + domain/guardian | guard/（监管机制） | 移动 |
| 5 | domain/dist 的 registry + runNpmInstall | platform/registry + platform/installer | 拆出公共设施 |
| 6 | domain/dist 的自更新/发布部分 | domains/dist（运行时升级） | 保留域内 |
| 7 | domain/plugin + pluginmarket | domains/plugin/（含市场功能） | 基本保留 |
| 8 | domain/token + infra/* | platform/（真公共） | 移动 |
| 9 | scripts/*.sh + verify-versions | 产品外封装脚本 | 不动（本就不在 src）|

## 5. 关键认知点（定稿备忘）

1. 域 = 功能；不等于"有服务的进程"。daemon 进程入口是域的服务承载，不单独拉目录。
2. 守卫机制件（lifecycle/monitor/guardian）归守卫类；镜像源/安装器归公共机制；发布策略归产品外。
3. 每个功能域业务自治，向守卫只暴露生命周期状态面；守卫不碰域内业务。
4. 原生 DSH 与沙箱统一生命周期管理逻辑（都是实例域）——这是本次最重要的一致性决策。