# dsh-supervisor

DeepSeek Harness 生命周期监管工具：独立于 Harness 运行的系统级守卫进程，负责 **启动、存活监测、故障自动重启** 被监管目标（默认 `dsh web`），并支持主动停止/恢复（期望状态语义）。

完整设计见 [ARCHITECTURE-PLAN-session-lifecycle.md](ARCHITECTURE-PLAN-session-lifecycle.md) 与
[ARCHITECTURE-CONTRACT-phase0.md](ARCHITECTURE-CONTRACT-phase0.md)。

## 文档索引

| 文档 | 性质 | 说明 |
|---|---|---|
| [ARCHITECTURE-CONTRACT-phase0.md](ARCHITECTURE-CONTRACT-phase0.md) | **规范（权威）** | 阶段 0 契约：会话生命周期 · 所有权矩阵 · 状态机 · 时序 |
| [ARCHITECTURE-PLAN-session-lifecycle.md](ARCHITECTURE-PLAN-session-lifecycle.md) | 计划 | 会话生命周期与所有权重构的根因级计划 |
| [PLATFORM-CAPABILITY-MATRIX.md](PLATFORM-CAPABILITY-MATRIX.md) | **规范（权威）** | 跨平台能力矩阵（14 项 × 3 平台）+ 证据 + 缺口；配套 `test/platform-capability-audit-test.js` |
| [AUDIT-CROSS-PLATFORM.md](AUDIT-CROSS-PLATFORM.md) | 审计 | 跨平台规范审计；§五.a 含 2026-09-11 复核更正 |
| [RELEASE-AND-UPDATE-MECHANISM.md](RELEASE-AND-UPDATE-MECHANISM.md) | 规范 | 发布与更新机制总纲 |
| [CROSS-PLATFORM-BUILD-AND-UPDATE.md](CROSS-PLATFORM-BUILD-AND-UPDATE.md) | 规范 | 跨平台构建与自更新完整方案 |
| [CHANGELOG.md](CHANGELOG.md) | 记录 | 版本变更 |
| [archive/](archive/) | 归档 | 已完成/被取代的历史文档（见 [archive/README.md](archive/README.md)） |

> **文档可信度不变量**（2026-09-11 确立）：能力声明必须由**可执行断言**支撑；
> 本仓的文字（注释/审计/文档）**不构成证据**。新增能力请同步 `test/platform-capability-audit-test.js`。

## 桌面面板（原生 Linux 应用）

守卫内置一个运维面板（`http://127.0.0.1:3100/`，浏览器可直接打开），并用 **Tauri** 打包成原生桌面应用（~10MB，无 Electron 大壳）：

- 实时状态：阶段 / 期望状态 / DSH 与守卫进程 / 最近探测 / 重启次数 / 最近故障
- **版本信息**：顶栏徽标显示守卫版本，「更新日志」一键查看每次版本变更内容
- **一键安装**：未检测到 DeepSeek Harness 时，版本卡直接提供在线安装按钮
- 控制开关：启动 DSH、停止 DSH、重启一次
- 设置中心：顶栏「⚙ 设置」聚合全部配置项
- 事件时间线：自动刷新，标注每次重启的原因
- 服务位置：守卫服务、配置文件、状态文件、日志路径一览

**托盘常驻**：关闭窗口 = 隐藏到托盘；托盘菜单可直接 启动/停止/重启 DSH，「退出托盘」才真正退出。

**桌面通知**：崩溃进入退避、升级完成/失败等关键事件自动弹系统通知（`notifyEnabled` 可关，依赖 `notify-send`）。

**设置中心**（顶栏 ⚙ 按钮）：

- **开机自动启动服务**：登录后自动启动守卫与 DeepSeek Harness，并打开监管面板（整条服务链一键开关）
- **局域网访问 DeepSeek Web**：开启后局域网设备通过 `http://<本机IP>:3088` 直接使用 DSH Web，与桌面端完全同步
  （含设置/Agent 预设/模型/插件等全部功能面）。实现为守卫内置反向代理（0.0.0.0:3088 → 127.0.0.1:3080），
  并对 `/api` 与 WebSocket 握手做**回环呈现**（Origin/Referer 改写为回环权威），
  使 DSH 的浏览器信任围栏将其视为本机流量——该语义与官方生态插件一致，但执行在反代层，
  **不改动 DSH 的任何源码、配置文件，也不安装任何插件**。可选 `lanToken` 访问令牌
  （配置文件设置；首次凭 `?token=` 进入自动种 HttpOnly Cookie），令牌永远只存在于反代层。

启动方式（二选一）：

```bash
dsh-supervisor-gui          # 桌面窗口（GNOME 应用菜单里也有「dsh-supervisor」）
xdg-open http://127.0.0.1:3100/   # 或浏览器直接开面板
```

桌面应用源码在 `src-tauri/`（Rust + WebKitGTK），重新编译：`cd src-tauri && cargo build --release`。

## 内核发布：Node launcher 统一形态（2026-09 定案：全平台弃 SEA）

按产品方向（私有 GitHub 存源码 + 公开 npm 发布**内核构建物**热更新 + 壳开源引流），内核统一以 **Node launcher 包**发布。

> **弃 SEA 原因（铁证）**：Node SEA 单文件二进制在 macOS 上注入后 `self-check` 即段错误——即使最小 hello-world SEA 亦崩（CI 双 arch 验证，与 useCodeCache/codesign/Node 版本均无关，为 Node SEA 的 macOS 上游缺陷）。为彻底消除平台差异、保证 macOS/Windows（产品主力）可用，全平台改发 Node launcher。

- **构建**：`npm run build:launcher`（`release/scripts/build-launcher.sh`）→ esbuild CJS bundle（`--define:__DSH_VERSION__` 注入版本）→ 组装 `bin/dsh-supervisor`（node 启动脚本）+ `core.cjs` + `ui-react/` → 自带冒烟（self-check + fresh-HOME daemon + UI 服务断言）。
- **产物**：`dist/launcher/dsh-supervisor-<ver>-<platform>-<arch>/`（bin + core.cjs + ui-react + version.txt），整包发布可辨识。
- **运行时依赖**：Node.js ≥18（launcher 需目标机 node；SEA 免运行时优势已弃，换取三端可运行可发布）。
- **版本自包含**：esbuild 编译期注入 `__DSH_VERSION__`，launcher 任意 cwd 自报正确版本；提升走 `release/scripts/bump.sh --core`（单源 = `package.json.version`）。
- **平台命名**：npm 内核子包按平台分（`@scope/dsh-core-linux-x64` / `darwin-arm64` / `darwin-x64` / `win-x64`；`process.platform` 的 `win32` 需映射 `win`）。各平台在对应平台机器上各自构建（无交叉编译）。
- **平台生产分工（2026-09 定案，GitHub 额度优化）**：**linux-x64 本地生产**——Linux 机器执行 `npm run release:core:publish` 走完整门禁后直推 npm；**win-x64 / darwin-arm64 / darwin-x64 由 GitHub CI** 在 tag 触发后生产。故 CI 矩阵不含 ubuntu，本地真发布有平台闸（非 Linux 直接拒绝，防与 CI 二次发布）。
- **许可**：内核 **UNLICENSED**（闭源构建物，主 `package.json`/`LICENSE` 声明）；壳 **MIT**（`src-tauri/LICENSE`）。
- **双仓库（壳开源引流）**：壳源码位于公开仓库 `wasi7mglns/dsh-supervisor-launcher`（MIT 许可）；
  本仓库为内核（私有，`advgyxqamf/dsh-supervisor-core`）。两仓**完全独立**——
  本仓不持有任何壳资产（无 `src-tauri/`、无片面的壳打包工具/设计文档），
  壳相关工具与文档均在壳仓自身。
- **跨仓协作方式**：内核侧仅保留**对接代码**（`src/domains/shell/`、`src/api/shell.js` ——
  内核需展示桌面版本并观测壳健康，属内核职责）；壳的构建、签名、发布、测试全部由壳仓自持。
- **发布工程单源**：全部发布/构建自动化收拢于 `release/`（`release/scripts/` 发布脚本集 + `release/scripts/ci-core.sh` 产线核心 + `release/scripts/release-core.sh` 一键编排 + `release/runbooks/` 操作手册 + `release/README.md` SOP）。一键发布见 `npm run release:core`（dry-run）/ `npm run release:core:publish`（真发，仅 Linux）。

## 架构

```
systemd user unit → dsh-supervisor（自研守护进程）→ dsh web（0.0.0.0:3080）
```

- **systemd**：只负责守卫进程自身的保活与登录开机自启（`enable-linger`）。
- **守卫**：`spawn` 目标 → 周期探测（进程存活 + `GET /` 200）→ 按期望状态调和（controller 模式）。
- 守卫死亡**不会**连带杀掉 DSH；守卫重启后读持久化期望状态，幂等收敛，绝不叠加双实例。

## 核心行为

| 行为 | 说明 |
|---|---|
| 期望状态 | `desired: running \| stopped` 持久化于状态文件。`stop` 后守卫绝不自动拉起 |
| 健康探测 | 三层：L0 进程存活 → L1 端口监听 → L2 HTTP `GET healthUrl` 2xx（超时 `probeTimeoutMs`）；在线判定以端口为准，健康判定叠加 HTTP 维度 |
| 假死识别 | 进程/端口在但 HTTP 连续 `failThreshold` 次失败（事件循环卡死）→ 判故障重启；非 HTTP 命令可 `httpProbeEnabled=false` 关闭 L2 |
| 重启协议 | 向**进程组**发 SIGTERM → 宽限 10s → 未退 SIGKILL → 复查端口占用 → 重拉 → 端口+HTTP 通过才算 RUNNING |
| 崩溃循环保护 | 10 分钟内 ≥5 次重启 → BACKOFF，指数退避 30s→60s→2m→5m→10m，成功即重置；窗口跨守卫重启持久化 |
| 幂等收敛 | 守卫自身重启后读期望状态调和，不叠加实例；接管既有实例时通过 /proc 识别其 pid，可正常 stop/升级 |
| 观测模式 | 期望停止时发现无主运行实例 → 进入 OBSERVED：如实展示运行状态与 pid，**不强杀不拉起**；点「启动」同一实例无缝转正纳管 |
| 一键升级 | **先停后装**：停 DSH → npm 安装 → 自动拉起 → 健康验证；失败自动回滚旧版本并恢复运行 |

## 安装

```bash
# 1. 生成用户配置（~/.dsh/supervisor/config.json）并写入 systemd unit、启用自启
dsh-supervisor install

# 2. 启动守卫
systemctl --user start dsh-supervisor

# 3. 查看状态
dsh-supervisor status
```

> 前置：Node.js ≥ 18；systemd（user session）+ `loginctl`。
> 安装只做"登记"，不会自动启动守卫，也不会动 DSH 自身。

## 常用操作

```bash
dsh-supervisor status      # 查看状态（phase / desired / dshPid / 最近故障）
dsh-supervisor --version   # 守卫自身版本
dsh-supervisor logs [supervisor|dsh|upgrade|events] [N]  # 查看运行日志
dsh-supervisor stop        # desired=stopped：停 DSH 并保持不拉起（升级/维护时用）
dsh-supervisor start       # desired=running：恢复监管并启动 DSH
dsh-supervisor restart     # 立即重启一次（不改变 desired、不计崩溃次数）
dsh-supervisor events [N]  # 查看最近 N 条事件日志
dsh-supervisor uninstall   # 卸载（守卫退出，DSH 不受影响）
```

**DSH 升级流程**：日常用 `dsh-supervisor upgrade`（内部即"stop → 安装 → start"，失败自动回滚旧版）；手工流程为 `dsh-supervisor stop` → 升级 DSH → `dsh-supervisor start`。

## 本地 API（默认 127.0.0.1:3100）

> **权威清单**：`src/api/surface.js`（机器可校验的单一事实源——每个路由的分类/方法/消费者/用途），
> 由 `test/api-surface-test.js` 强制「源码 ↔ 清单」双向一致：**新增路由不登记即测试失败**。
> 下表为分类速览；完整字段以 surface.js 为准。

```
# 核心状态与生命周期
GET  /status                状态摘要（含 desired/phase/sessionState）
GET  /events?after=&limit=  增量事件（seq 跨轮转/守卫重启连续）
GET  /healthz               存活探针
GET  /lifecycle[/status]    模块生命周期一览
POST /lifecycle/{id}/{start|stop|restart}  统一启停（唯一入口；不可启停模块返回 409）
# 会话生命周期（壳「退出管家」握手）
GET  /session/status        会话态（starting|running|stopping|stopped）
POST /session/stop          停全部被管对象 + 回执（守卫不自停；由壳/systemd 停止进程）
# 原生 DSH 生命周期（唯一通道）
GET  /native/status          安装状态 + 版本信息 + 升级状态机（含安装/卸载任务进度）
POST /native/check-update    触发一次版本检查
POST /native/install {v?}    异步安装：前置拒绝 400 / 受理 202，进度经 /native/status 轮询
POST /native/uninstall       异步卸载：受理 202，进度经 /native/status.state|lastUninstall 轮询
POST /native/upgrade {v?}    一键升级（先停后装，失败自动回滚；异步 202，进度经 /native/status.upgrade 轮询）
POST /native/settings         main 元数据补丁（guardian/remoteEnabled/frpEnabled）
# 版本与更新日志
GET  /changelog              DSH 更新日志（text/plain）
GET  /guard/changelog        管家自身更新日志（CHANGELOG.md）
GET  /guard/version          管家本地版本（同步安全，无网络 I/O）
POST /guard/version/check    管家完整检查（npm 或 git 上游，按部署形态）
GET  /self-update/status     内核自更新状态
POST /self-update/apply      执行自更新
POST /self-update/restart-guard  守卫退出以生效（systemd Restart=always 重拉）
# 环境与平台能力
GET  /env/status             环境探针 + **平台能力矩阵**（capabilities）
GET  /env/dsh                DSH 本体安装/纳管判定（bin/binOk/managed/phase）
GET  /env/node-lts           Node 当前 vs 官方最新 LTS
# 实例管理（沙箱）
GET  /instances              实例列表（含运行状态/安装进度）
POST /instances/{add|remove|update|start|stop|check-update|open-web|upgrade}
# 插件
GET  /plugins/market|installed|check-updates   市场索引 / 已装 / 更新检测
GET  /plugins/install-status?job=   插件任务进度（前端轮询到终态）
POST /plugins/{install|enable|disable|uninstall|update}
# 智能路由（多供应商 Key 轮换）
GET  /router/status          中转状态 + 用量统计
GET  /router/providers       供应商 + 账号 + 实例视图
POST /router/providers/{add|remove|refresh|activate|deactivate|keys/set|key/use|proxy/*|account/*}
POST /router/proxy/login/{start|wait}   Command Code 一键登录
POST /router/proxy/update/{check|apply}  反代版本检测/应用
GET  /router/proxy/update/status         反代更新进度（前端轮询）
# 局域网/公网访问
GET  /lan-access             远程代理列表（令牌不下发公网）
GET  /lan/frp + POST /lan/frp/{settings|install|toggle|expose}   FRP 公网暴露
# 设置
GET/POST /autostart          整条服务链开机自启
GET/POST /settings/lan       面板局域网访问开关
GET/POST /settings/access-key / settings/close-action
GET/POST /dist/registry(+ /refresh|/set)   全局镜像源配置
GET  /ports                  端口视图（聚合三注册表 + 池容量）
GET  /tasks[/{id}]           统一任务列表
GET  /                       运维面板

# 运维/可观测面（一方 UI 不调用，供监控/编排/审计工具）
GET  /readyz                 就绪探针（守卫已初始化且未停机）
GET  /metrics                监控：事件流派生遥测
GET  /logs/tail?stream=&n=   诊断：各 stream 日志尾部（远程排障）
GET  /logs/export?after=&limit=  审计：聚合流 JSONL 导出

# 兼容保留
POST /shutdown               已由 POST /session/stop 取代（保留供旧版壳退出）
```

**安全模型（无鉴权设计）**：API 只绑回环地址，局域网内其他机器不可达，因此**不做任何登录/令牌**。
针对"用户浏览器里的恶意网页打本机服务"（localhost CSRF / DNS rebinding）做了三层无感防护：
校验 Host 必须指向本机；不返回 CORS 头（面板同源托管，其他网站读不到响应）；
带 `Origin` 的写请求必须来自本机面板来源。CLI/curl/面板使用体验零变化。

## 配置（~/.dsh/supervisor/config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `["node","/home/bowen/.npm-global/bin/dsh","web"]` | 被监管命令（数组） |
| `healthUrl` | `http://127.0.0.1:3080/` | HTTP 探活地址 |
| `probeIntervalMs` | 5000 | 探测周期 |
| `probeTimeoutMs` | 3000 | L2 HTTP 单次探测超时 |
| `failThreshold` | 2 | L2 连续失败次数 → 判故障（防抖动） |
| `httpProbeEnabled` | true | L2 HTTP 探活开关；自定义非 HTTP 命令时设为 false（退化为端口在线即健康） |
| `startTimeoutMs` | 30000 | 启动门：超过视为启动失败 |
| `stopGraceMs` | 10000 | SIGTERM 宽限期 |
| `portReleaseWaitMs` | 10000 | 重启前等端口释放 |
| `crashWindowMs` / `crashBurst` | 600000 / 5 | 崩溃窗口与阈值 |
| `backoff` | 30s…10m | 指数退避序列 |
| `apiHost` / `apiPort` | 127.0.0.1 / 3100 | 本地 API |
| `stateFile` / `logFile` | ~/.dsh/supervisor/… | 状态文件 / 事件日志（有内置默认，缺省也能跑） |
| `eventsMaxBytes` | 5242880 | 事件日志轮转阈值（保留一代 .1 备份） |
| `supervisorLogFile` / `dshLogFile` / `upgradeLogFile` | ~/.dsh/supervisor/… | 守卫运行日志 / DSH 输出 / 升级输出 |
| `logLevel` | info | 守卫日志级别（debug/info/warn/error） |
| `logMaxBytes` | 5242880 | 运行类日志统一轮转阈值 |
| `packageName` | @deepseek-ai/dsh | 被监管的 npm 包 |
| `updateCheckEnabled` | true | 周期版本检查开关（只检查不自动升级） |
| `registries` | npmmirror → npmjs | registry 列表（依次尝试） |
| `updateCheckIntervalMs` / `initialCheckDelayMs` | 3600000 / 20000 | 版本检查周期 / 首查延迟 |
| `upgradeTimeoutMs` | 600000 | npm 安装超时 |
| `installCommandTemplate` | ["npm","install","-g","{pkg}@{version}"] | 安装命令模板 |

## 版本与日志管理

- **版本（双轨独立）**：内核单一版本源为 `package.json`（`bump.sh --core`，tag `v<内核>` 触发私有仓产线）；壳版本独立于内核（`bump.sh --shell`，0.1.0 起，Cargo.toml 与 tauri.conf.json 互锁，公开仓 tag 触发壳 Release）。
  守卫自报版本的三个入口：`dsh-supervisor --version`、`GET /status` 的 `guardVersion`、`guard_started` 事件。
- **日志**：全部自动轮转（保留一代 `.1`），永不无限增长：

| 文件 | 内容 | 用途 |
|---|---|---|
| `events.log` | 结构化事件流（JSONL） | 程序化消费 / 面板时间线 |
| `supervisor.log` | 守卫分级运行日志 | 排查守卫自身问题 |
| `dsh.log` | DSH stdout/stderr 全量 | 排查 DSH 业务问题 |
| `upgrade.log` | npm 安装原始输出 | 升级失败取证 |

  另外守卫日志同步镜像 stderr，systemd 部署下 `journalctl --user -u dsh-supervisor` 亦可查。

## 前端架构（状态中心 + 单向数据流）

- **数据流**：HTTP API（后端）──refresh* 拉取──▶ 前端状态中心 Store（单一数据源）──render* 只读──▶ DOM。
  后端是唯一事实源；前端不持有各自独立的状态副本，各页面（概览/实例/远程控制/智能路由）读到同一份状态快照，
  后端动作（如停止 DSH 联动停止远程代理）随快照自动联动，不存在「某页状态断链」。
- **统一同步**：2s 主循环 unifiedTick 全量同步（状态/实例/远程控制/中转），页面可见时立即同步，写操作后即时全量刷新。
- **联动语义**：远程控制开关 = 实例运行中 ∧ remoteEnabled ∧ relay 实际监听；实例未运行时开关禁用并明示「实例未运行」。

## 故障排查

- 看事件：dsh-supervisor events（restart_triggered 的 reason 说明故障原因：exit:137 被强杀、http_unhealthy 假死、start_timeout 起不来等）。事件日志按 eventsMaxBytes 自动轮转（events.log.1 保留一代）。
- CLI 控制命令尊重 DSH_SUPERVISOR_CONFIG / -c <config> 自定义配置（含 apiPort），与 daemon 使用同一份解析逻辑。
- 端口被不健康进程占用：守卫不会硬抢端口，会记 port_occupied_unhealthy 事件并保持等待。
- 守卫自身被 systemd 拉起后：读状态文件幂等调和，不会叠加 DSH 实例。
- **useSystemdForMain=true 模式**：显式「启动 DSH / 停止 DSH」按钮始终生效（desired 正交轴，不受进程守护开关限制）；
  崩溃后自动拉起需开启「进程守护」开关（面板按钮，默认关）。

## 验证

`npm test` 使用 mock 目标跑通设计文档 §12 的全部用例及安全边界（Host/Origin 校验、控制结果透传、日志轮转、端口占用不硬抢、守卫崩溃幂等、接管实例可停止、升级先停后装与回滚），**不触碰真实 DSH 与真实 npm**。

> **卸载类测试不进入自动链（政策，2026-08-31）**：`test/native-test.js`（原生 DSH 卸载全量清理）、
> `test/api-contract-test.js`（含 `POST /native/uninstall` 契约断言）、`test/plugin-change-restart-test.js`（含插件卸载场景）
> 已从 `npm test` 排除，仅允许作为独立脚本显式单独调用（`node test/<file>` 或
> `npm run test:native-uninstall` / `test:plugin-change-restart` / `test:api-contract`）。除非用户明确指令，不得擅自运行。


## 桌面产品：环境引导 + 守卫自更新（Phase 1/2）

### 安装即用（免预装 Node）
- Tauri 桌面壳（src-tauri）是**引导器 + 面板壳**（Phase 3 一源双出口：完整壳内嵌面板产物，公开壳为 MIT 引导器）；
  - 缺失 → 壳内引导页 → **一键安装官方最新 Node.js LTS**（Windows .msi / macOS .pkg / Linux 官方 tar.xz→/usr/local，均经官方 SHASUMS256 校验 + 一次系统授权）；
  - 就绪 → 壳拉起守卫（daemon）→ 完整壳（embedded-panel feature 默认）导航**壳内面板**（frontend 内嵌 supervisor.html），API 经 Rust `api_proxy` command 转发守卫 3100（绕浏览器 CORS，守卫零 CORS 边界不变）；公开壳（导出仓）导航守卫 3100 托管面板。
- **前端一源双出口**：源码唯一 `ui/`，构建一次 → `ui-react` 镜像（守卫托管/浏览器出口）+ 壳 frontend 内嵌（桌面出口）；统一入口 `release/scripts/build-ui.sh`（release.sh/build-sea.sh/CI 均经它）。
- 守卫保持零第三方依赖（node: 内置即可运行）；shell 提供无头冒烟入口：`dsh-supervisor-gui --node-plan`。

### 守卫自更新（D1 定案：统一走 npm 平台子包；manifest 通道仅底层执行器回归保留）
- **发布通道（D1，2026-09 定案）**：守卫自身更新统一走 npm 平台子包（`DistributionManager.runNpmInstall` + `@dsh-core/<os>-<arch>`）；`release/scripts/release.sh` 不再产出自更新 manifest，仅作源码打包出口。
- 底层执行器：`src/domains/dist/self-update.js`（tar 解包/SHA256 校验/`current` 软链原子翻转/剪枝；guard-update-test 全量覆盖，作回归保留，非发布通道）。
- 接入：配置 `selfUpdateManifestUrl` / `selfUpdateDir`；API `GET /self-update/status`、`POST /self-update/apply`。
- 内核发布：`npm run build:launcher` + `npm run publish:core`（Node launcher + npm 平台子包，见「内核发布」节）；推荐一键：`npm run release:core:all` / `npm run release:core:all:publish`。
- 环境状态：`GET /env/status`（node/npm/git 探针 + 壳写入的 runtime.json）、`GET /env/dsh`（DSH 本体安装/纳管判定）。

### 跨平台打包（**已移至壳仓**）

壳（Tauri 引导器）的打包配置、`Cargo.toml`、`src-tauri/` 全部位于**壳仓**
`wasi7mglns/dsh-supervisor-launcher`（MIT），本仓不再持有任何壳资产。

壳仓产线：四平台矩阵（`ubuntu-22.04` glibc 2.35 基座 / `macos-latest` arm64 /
`macos-15-intel` x64 / `windows-latest`）→ Tauri bundle → GitHub Release + npm 壳包 +
`shell-manifest.json`（Tauri updater 静态清单）。详见壳仓 `README.md`。

桌面实机验收清单：`release/runbooks/verify-desktop.md`（内核侧视角）。

## 边界与非目标（v1）

- 单机单实例，只监管一个目标（默认 `dsh web`）。
- DSH 无优雅关停，SIGTERM/SIGKILL 可能丢失进行中的会话/未持久化工作；升级已采用"先停后装"，中断窗口集中在安装期。
- 已提供本地面板（浏览器/Tauri 桌面壳）。不做：插件级健康、告警通知通道、多机部署、面板公网暴露（如需暴露必须另加认证）。
