# DSH 综合管理平台 产品结构与系统结构定稿（2026-09-05 讨论定案）

---
## 0. 文档定位

从产品认知出发，把"系统该长什么样"定稿：三层结构（守卫/功能域/公共机制）、目标目录、搬迁清单、执行顺序。
目的：先立结构认知，再论代码迁移。API 出口保持单一文件，不在此轮拆。

---
## 1. 产品认知（定稿）

### 1.1 产品本质
DSH 综合管理平台 = 【生命周期守卫】 + 【多功能域】 + 【公共机制】。
本质是一个生命周期管理工具：守卫把一系列功能串成一个完整产品，并监管它们的生命周期。

### 1.2 核心原则
- 域 = 功能（模块）。有的功能有完整独立生命周期（router/relay/instance，底层配服务），
  有的只是配合功能实现的简单功能（pluginmarket 无服务也属于域）。
- 每个功能域的底层都配有自己的服务（daemon/进程），域生命周期独立——守卫重启不影响它们，
  它们保持健康地继续运行。
- 守卫的职责：① 串联各功能形成完整产品；② 监管各域生命周期状态；③ 按配置策略分发——
  生命周期不健康 → 若配置了自动恢复则拉起/重启进程；若配置了还原则还原。除此无其他。
- 各功能域业务自治：router 的切换/账号管理/反代、relay 的隧道/frp，全在各自域内完成，
  绝不上溯为全局公共逻辑。域内可抽自己的子公共，但那是域内的事。
- 守卫只收各域的【生命周期状态面】，不碰域内业务。

### 1.3 关键归类决策
- 原生 DSH = 实例管理域内的【原生实例】（特殊实例），与沙箱实例统一生命周期管理逻辑（重要一致性）。
- daemon 进程入口（router-daemon/lan-daemon）是域的服务承载，归各自域内，不单独拉目录。
- 守卫机制件（lifecycle/monitor/guardian）归守卫类，不进公共机制。
- 公共机制只放真正的通用设施（镜像源/安装执行器/端口/令牌/事件/任务/日志/配置/版本/fs 等）。
- 对外发布策略（scripts/*.sh 打包/发布/生成 manifest）= 封装期策略，不是产品内功能，不参与运行时。
- API 出口：presentation/api.js 保持单一文件不动，待功能增多后再评估拆分。

---
## 2. 逻辑结构（三层）

| 层 | 职责 | 内含 |
|---|---|---|
| **守卫 guard** | 产品壳：串联各功能 + 监管各域生命周期 + 策略分发 | supervisor（核心）、lifecycle（生命周期监管）、monitor（健康观测）、guardian（守护策略） |
| **功能域 domains** | 平级功能模块，各自业务自治，向守卫暴露生命周期状态面 | router、relay、instance（原生+沙箱）、plugin（含 pluginmarket）、dist（运行时升级） |
| **公共机制 platform** | 真通用设施，被各域与守卫共享 | registry（镜像源）、installer（安装执行器）、token、events、tasks、logs、config、version、fs |
（产品外：scripts/*.sh 发布策略）

---
## 3. 目标目录结构

src/
├─ guard/
│  ├─ supervisor.js      # 串联各功能 + 监管生命周期 + 策略分发
│  ├─ lifecycle/        # 生命周期监管（ManagedLifecycle 收各域状态面 + ports.js 端口观测底座）
│  ├─ monitor/          # 健康观测（探各域底层服务）
│  └─ guardian/         # 守护策略（不健康→拉起/恢复决策）
├─ domains/
│  ├─ router/           # 智能路由域
│  │  ├─ daemon.js      # 服务进程入口（原 service-daemon/router-daemon.js）★域内
│  │  ├─ ctl.js         # 守卫控制通道（原 service-daemon/router-ctl.js）★域内
│  │  └─ business/      # 切换/账号管理/反代/配额（自治；域内可再抽子公共）
│  ├─ relay/            # 远程控制域
│  │  ├─ daemon.js      # 服务进程入口（原 lan-daemon.js）★域内
│  │  └─ business/      # 隧道/frp 管理（自治）
│  ├─ instance/         # 实例管理域
│  │  ├─ native.js      # 原生 DSH（特殊实例，与沙箱统一生命周期逻辑）
│  │  └─ sandbox.js     # 沙箱实例
│  ├─ plugin/           # 插件域（含 pluginmarket 市场功能）
│  └─ dist/             # 分发/升级域（守卫自更新等运行时升级）
├─ platform/            # 公共机制
│  ├─ registry.js       # 镜像源管理
│  ├─ installer.js      # 安装执行器 runNpmInstall
│  ├─ token / events / tasks / logs / config / version / fs
├─ presentation/
│  └─ api.js           # HTTP 出口（保持单一文件，本轮不动）

---
## 4. 当前结构 → 目标 搬迁清单

| # | 当前实现 | 目标归属 | 动作 | 风险 |
|---|---|---|---|---|
| 1 | system-services/router/* + service-daemon/router-daemon.js + router-ctl.js | domains/router/（daemon/ctl 归域内） | 移动+重命名 | 低（纯搬移，改 require 路径） |
| 2 | system-services/relay + service-daemon/lan-daemon.js | domains/relay/（daemon 归域内） | 移动 | 低 |
| 3 | domain/instance + supervisor 对 main 的 tick 独揽 | domains/instance/（原生 DSH 统一进实例生命周期） | 重构 main 进统一 watchdog | 中（涉及守卫 tick 改动） |
| 4 | domain/lifecycle + domain/monitor + domain/guardian | guard/（守卫监管机制） | 移动 | 低 |
| 5 | domain/dist 的 registry + runNpmInstall | platform/registry + platform/installer | 拆出公共设施 | 中（多处引用） |
| 6 | domain/dist 的自更新/运行时升级部分 | domains/dist（保留） | 保留 | 低 |
| 7 | domain/plugin + pluginmarket | domains/plugin/（含市场） | 基本保留 | 低 |
| 8 | domain/token + infra/* | platform/（真公共） | 移动 | 中 |
| 9 | presentation/api.js | 保留单一文件 | 不动 | 低 |
| 10 | scripts/*.sh + verify-versions | 产品外 | 不动 | 低 |

---
## 5. 每个域暴露给守卫的「生命周期状态面」（守卫收什么）

守卫只收各域的生命周期健康面，不做域内业务决策：

| 域 | 底层服务 | 守卫监控的状态面 | 守护策略（可配） |
|---|---|---|---|
| 智能路由 router | router-daemon（43011/ctl） | daemon 进程存活 + ctl 就绪 | 失联 → 拉起/接管 |
| 远程控制 relay | lan-daemon（43108/ctl） | daemon 进程存活 + ctl 就绪 | 失联 → 拉起 |
| 实例 instance(原生) | 主 DSH 进程（spawn/systemd） | 端口 + 进程存活 + 健康 | 挂/卡 → 拉起/重启 |
| 实例 instance(沙箱) | 沙箱 DSH 进程（systemd-run） | watchdog 健康 | 挂 → 退避自愈 |
| 插件 plugin | （无独立服务） | 状态登记 | 无（简单功能） |
| 分发 dist | （守卫自更新通道） | 更新状态 | 无 |

（各域向守卫暴露状态面的方式：原生/沙箱走监控探针喂入；router/relay 走 ctl 就绪 + healthz 自报。）

---
## 6. 执行顺序建议（每步可回滚）

**阶段 A（低风险纯搬移，改 require 路径）**：
  1. domain/lifecycle + monitor + guardian → guard/
  2. system-services/router/* + service-daemon/router-daemon + router-ctl → domains/router/
  3. system-services/relay/* + service-daemon/lan-daemon → domains/relay/
  4. 改全部 require 路径 + 全量测试

**阶段 B（中风险需重构）**：
  5. domain/dist 拆：registry + runNpmInstall → platform/；自更新保留 → domains/dist/
  6. 原生 DSH 统一进实例域生命周期（守卫 tick 改造为实例域统一 watchdog 的 main 分支）
  7. domain/token + infra/*（真公共）→ platform/

---
## 7. 明确不做（防过度）
- 不改任何域内部业务逻辑（router 切换/账号、relay 隧道/frp、实例 watchdog 细节）。
- present/api.js 保持单一文件，不拆。
- 对外发布策略（scripts/*.sh）不进产品运行时。
- 守卫不把域内业务（反代实例/账号）收进统一状态机（黑盒边界）；只收 daemon 级 + 聚合健康。
