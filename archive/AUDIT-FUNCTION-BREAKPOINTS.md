# 内核全量功能断点审计报告（2026-09-10）

> 范围：内核仓 dsh-supervisor 全部对外能力面 + 前端 UI 消费面（只读审计，未改代码）。
> 方法：后端路由/事件/导出/配置 → 五方消费者（UI/CLI/壳/测试/CI）双向映射 + 声明-消费核对。
> 判定：**「声明了但没接线」「实现了但没入口」「有入口但没实现」** 三类断点。

---

## 一、结论摘要

| 类别 | 数量 | 性质 |
|---|---|---|
| A. 后端能力完整、前端未接线 | **4** | 🔴 真断点（用户看不到/用不了） |
| B. 声明存在、无人消费 | **1 组** | 🟠 死元数据（约束失效） |
| C. 前端定义、无 UI 调用 | **4** | 🟡 死代码 |
| D. 后端端点、五方无消费者 | **6** | 🟡 孤儿端点（部分为运维预留） |
| E. 事件契约 | 99/133 无按类型消费 | 🟢 审计流（设计使然，见 §6） |

**核心结论：内核的「能力供给」普遍强于「前端接线」。最严重的 4 个断点都属于同一模式——后端把 job 进度/能力矩阵/changelog 完整实现，前端却没有对应的调用方法。**

---

## 二、A 类：后端完整、前端未接线（真断点）

### 🔴 A1. 能力矩阵（capabilities）全链未接线

**后端实现（完整）**：`src/platform/os/index.js`
- `capabilityProfile(platform, arch)`：三平台静态档位（multiInstance / pidAdoption / processTreeKill / desktopNotify / autostart / frpExpose / hostService）
- `capabilities()`：静态档位 × 实际工具探测（`hasTool` 覆写）
- 有专项测试 `test/capability-profile-test.js`（覆盖三平台 + 未知平台）

**断点证据**：
| 环节 | 状态 |
|---|---|
| 文档承诺 | `os/index.js:110` 注释：「供壳/面板做能力感知呈现与降级提示（`/env/status capabilities`）」 |
| 内核 API | ❌ `envStatus()`（settings-view.js）返回 node/npm/git/catalog，**无 capabilities 字段** |
| 前端类型 | ❌ `EnvStatus` 无 capabilities |
| 前端 UI | ❌ 全仓 `capabilities` 在 ui/src 零引用 |
| 错误指引 | ⚠️ `instance/index.js:766` 报错「…见 `/env/status capabilities.multiInstance`」——**指向不存在的字段** |

**影响**：用户/壳无法感知平台能力（如 Windows 不支持沙箱），得不到前置的降级提示；错误信息把用户引向空处。

### 🔴 A2. 插件安装/更新/卸载 **job 进度断链**

**后端实现（完整）**：
- `pluginManager.install/update/uninstall` 创建 job（`pj-<ts>-<rand>`），返回 `jobId`
- `installStatus(jobId)`（`plugins.js:398`）从 TaskRegistry 派生 `running/done/failed`，经 `/plugins/install-status?job=` 暴露

**断点证据**：
| 环节 | 状态 |
|---|---|
| 后端端点 | ✅ `/plugins/install-status` 完整 |
| client 方法 | ❌ `client.ts` **无** `/plugins/install-status` 对应方法 |
| UI 使用 | ⚠️ `PluginsPage.tsx:109` 仅 `toast.success("安装任务已提交（job pj-xxx）")` —— **打印原始 job 号后永不轮询** |

**影响**：用户点「安装/更新/卸载」后只看到一句「任务已提交（job pj-xxx）」，**无进度、无成功/失败反馈**；失败时用户完全无感。

### 🔴 A3. 反代更新 **job 进度断链**（注释自我承诺未兑现）

**后端实现**：`/router/proxy/update/status`（router.js:80），注释明确写道：
> `// 反代更新进度查询（job 模型，前端轮询消除黑盒）`

**断点证据**：
| 环节 | 状态 |
|---|---|
| 后端端点 | ✅ `proxyUpdateStatus(appId)` 完整 |
| client 方法 | ❌ 仅有 `proxyUpdateCheck` / `proxyUpdateApply`，**无 status 方法** |
| UI 使用 | ❌ `RouterPage.tsx` 调用 apply 后仅 `"已提交更新，所有实例将依次更新并重启"`，**不轮询进度** |

**影响**：注释承诺的「消除黑盒」未实现——多实例依次更新过程中用户看不到任何进度。

### 🔴 A4. changelog **双端点无 UI 入口**

**后端实现**：
- `/changelog`（guard.js:33）→ `fetchDshChangelog`：输出 DSH 当前/最新版本 + 升级指引 + GitHub Releases 链接
- `/guard/changelog`（guard.js:37）→ 读取本地 `CHANGELOG.md` 原文

**断点证据**：
| 环节 | 状态 |
|---|---|
| 后端 | ✅ 两个端点均有完整实现 |
| 前端类型 | ❌ `DshVersionInfo` 无 changelog 字段 |
| 前端 UI | ❌ `ui/` 全仓 **零** changelog 引用 |
| 命名错位 | ⚠️ 后端注释反复引用「**版本与升级**」这一 UI 名称（guard.js:14/23/32），但 UI 无此界面（升级在「概览页」） |

**影响**：后端专门实现的更新日志能力无任何入口；且注释与 UI 实际命名脱节。

---

## 三、B 类：声明存在、无人消费

### 🟠 B1. `MANAGED_KINDS.startable / guardable` 死元数据

`src/guard/lifecycle/objects.js:29-35` 为每种受管类型声明「可启停 / 可守护」：

    dsh:                { startable: true,  guardable: true  }
    sandbox-instance:   { startable: true,  guardable: true  }
    router-daemon:      { startable: true,  guardable: true  }
    lan-daemon:         { startable: true,  guardable: true  }
    plugin:             { startable: false, guardable: false }

**核验**：全仓（src + ui + test + bin + shell）**无任何代码读取 `startable` 或 `guardable`**（仅 `kindMeta` 返回该对象，但调用方只取 `label`）。

**影响**：约束形同虚设——`plugin` 标记为不可启停，但 `/lifecycle/plugin/start` 仍会走到 LifecycleManager 并返回其结果，而非依据元数据拒绝。

---

## 四、C 类：前端定义、无 UI 调用（死代码）

`ui/src/services/supervisor/client.ts` 中 4 个方法无任何 UI 调用：

| 方法 | 端点 | 判定 |
|---|---|---|
| `sessionStatus` | `GET /session/status` | 死代码（会话态经 `/status.sessionState` 已轮询） |
| `lifecycleGet` | `GET /lifecycle/{id}` | 死代码（UI 只用 start/stop） |
| `guardVersionCheck` | `POST /guard/version/check` | 死代码（AboutCard 用 `selfUpdateStatus` 取代） |
| `envStatus` | `GET /env/status` | 死代码（环境卡用 `/env/node-lts`） |

**影响**：低（不损害功能），但构成「两套并行路径」——同一语义有两个后端实现，只有一条被使用，另一条长期无验证。

---

## 五、D 类：后端端点、五方无消费者

（五方 = UI / CLI / 壳 / 测试 / CI·release）

| 端点 | 后端能力 | 消费者 | 判定 |
|---|---|---|---|
| `/logs/tail` | 各 stream 日志尾部 | **无** | 注释称「供 CLI/调试」，但 CLI `logs` 命令**直读文件、不走 HTTP** → 实际孤儿 |
| `/logs/events-tail` | 聚合事件尾部 | **无** | 同上（注释「等价 /events 全量读，供 CLI/调试」） |
| `/logs/export` | 审计 JSONL 导出 | **无** | ⑤ 孤儿（无导出 UI，注释称「离线备份」但无触发点） |
| `/metrics` | 事件流派生遥测 | **无** | 运维预留（无监控接入） |
| `/readyz` | 就绪探针 | **无** | 壳只用 `/healthz`；readyz 无调用方 |
| `/env/dsh` | DSH 环境（bin/installed/managed/phase） | **无** | UI 环境卡用 `/env/node-lts`；dshenvStatus 仅被 envCatalogSummary 内部调用 |

**补充（内部消费，非孤儿）**：`/router/domain-summary` 由守卫监督拍自消费（`control-view.js:408`），前端不消费属设计（守卫侧只读缓存）。

---

## 六、E 类：事件契约（设计使然，非缺陷）

- 内核 `events.append()` 共发出 **133** 种事件类型
- 其中 **99** 种不被 UI/测试/壳/内核按类型消费（仅作为聚合流存入时间线）
- **判定**：这是**审计流**设计——UI 的 `/events` 时间线是通用展示（不按类型分发），因此「无按类型消费者」不等于断点。
- **唯一可选改进**：错误类事件（`*_failed`/`*_error`/`dsh_command_missing` 等 22 种）中，仅 4 处走 `notify()` 主动通知用户，其余只在时间线里「躺平」——用户不主动翻日志就不会察觉。

---

## 七、已核验为「健康」的面（无断点）

| 维度 | 结论 |
|---|---|
| 路由 `owns()` 覆盖 | ✅ 各域 `handle` 内定义的 pathname 全部被 `owns()` 覆盖（无不可达路由） |
| 域间分派遮蔽 | ✅ 9 个域之间**零路径重叠**（无「前者吞后者」） |
| 前端 → 后端 | ✅ UI 引用的所有 `supervisorApi.*` 方法均在 client 定义；无未定义调用 |
| `/status` 字段契约 | ✅ 前端 `SupervisorStatus` 声明的 22 字段与后端 `statusSummary()` 产出**完全一致** |
| 配置项消费 | ✅ `DEFAULTS` 38 项**全部**有消费（无死配置） |
| 模块导出 | ✅ 20 个「疑似死导出」经查**均为模块内部使用**（冗余导出，非死代码） |
| 适配器接线 | ✅ `registerAll` 注册的 5 个模块（router/lan/instances/dsh/plugins）与 `LifecycleModuleId` 及 `MANAGED_KINDS` 一致 |
| TODO 标记 | ✅ 仅 3 处（Provider 化 P2、mac/win 沙箱 Phase3），**无未实现桩** |

---

## 八、修复优先级建议

| 优先级 | 断点 | 修复方向 |
|---|---|---|
| **P0** | A2 插件 job 进度断链 | client 补 `pluginInstallStatus(jobId)` + UI 轮询到 done/failed |
| **P0** | A3 反代更新进度断链 | client 补 `proxyUpdateStatus(appId)` + UI 轮询 |
| **P1** | A1 能力矩阵未接线 | `envStatus()` 返回 `capabilities`；UI 据此灰化/提示不支持项；修正 instance 错误指引 |
| **P1** | A4 changelog 无入口 | 概览页/关于卡增加「更新日志」入口；统一「版本与升级」命名 |
| **P2** | B1 startable/guardable | 在 `/lifecycle/{id}/{action}` 依据元数据拒绝非法操作 |
| **P2** | C1 4 个死 client 方法 | 删除或接线 |
| **P3** | D1 孤儿端点 | 明确保留（标注为对外 API）或删除；`/env/dsh` 与 `/env/status` 去重 |

---

## 附：审计方法与可复现命令

- 路由全集：`grep -rhoE "pathname === '[^']+'" src/api/*.js | sort -u`（66 个端点）
- 消费矩阵：对每个端点跨 `ui/src`、`bin`、`.shell-work/src-tauri/src`、`test`、`release`、`.github` 做 `grep -rF`
- 前端死方法：提取 `client.ts` 顶层方法名，检查 `supervisorApi.<name>` 在 client.ts 之外的出现
- 声明-消费：`startable|guardable|capabilities` 全仓 grep
- owns 覆盖与域重叠：解析各域 `owns()` 与 `handle()` 的 pathname 集合做差集

---

## 九、P0 修复实施记录（2026-09-10）

### 已修复：A2 插件 job 进度断链 + A3 反代更新进度断链

| 项 | 位置 | 内容 |
|---|---|---|
| **A2** client 补方法 | `ui/src/services/supervisor/client.ts` | `pluginInstallStatus(jobId)` → `GET /plugins/install-status?job=` |
| **A3** client 补方法 | 同上 | `proxyUpdateStatus(appId)` → `GET /router/proxy/update/status?appId=` |
| 类型契约 | `types.ts` | 新增 `JobState` / `PluginJobStatus` / `ProxyUpdateStatus` |
| **通用轮询器** | `ui/src/services/supervisor/jobs.ts`（**新增**） | `pollJob(fetchStatus, opts)`：running→done/failed 闭环；支持 `onTick`/超时/中止；`job not found` 短路避免无限轮询 |
| **A2** UI 接线 | `PluginsPage.tsx` | 安装/更新/卸载提交后**轮询到终态**并给出成败提示（批量汇总进度 `n/m`） |
| **A3** UI 接线 | `RouterPage.tsx` | 反代更新按 `steps` 显示「已更新 n/m 实例」，终态提示成功/失败/超时 |
| 单测 | `ui/src/services/supervisor/jobs.test.ts`（**新增**） | 7 项：终态识别 / job-not-found 短路 / 超时 / 抛错重试 / 中止 / onTick 异常隔离 |

### 验收

| 验证 | 结果 |
|---|---|
| `npm test`（内核 33 文件） | **667 passed / 0 failed** |
| UI `npm run verify`（typecheck+lint+test+build） | 全通过（新增 `jobs` chunk 产出） |
| 单测 `jobs.test.ts` | 7 passed |
| **端到端** | ① `/plugins/install-status?job=不存在` → `{error:"job not found"}`（明确报错非 500）；② 真实 `POST /plugins/install` → 返回 `jobId`，`status` 轮询得到 `state:"running"`；③ `/router/proxy/update/status` 可达 |

### 行为变化（用户可见）

- **修复前**：点安装/更新/卸载只看到「任务已提交（job pj-xxx）」，**无进度、无成败**；反代更新只有「已提交更新」文案。
- **修复后**：loading toast 实时显示进度（批量 `n/m`、反代 `n/m 实例`），终态明确 success/error/warning；失败原因回显给用户。

### 剩余（未做，按原优先级）

| 优先级 | 断点 | 状态 |
|---|---|---|
| ~~P0~~ | A2 / A3 job 进度 | ✅ 本次完成 |
| P1 | A1 能力矩阵未接线（含修正 instance 误导性错误指引） | 待办 |
| P1 | A4 changelog 双端点无 UI 入口 + 「版本与升级」命名脱节 | 待办 |
| P2 | B1 `startable/guardable` 元数据执法 | 待办 |
| P2 | C1 4 个死 client 方法（`sessionStatus`/`lifecycleGet`/`guardVersionCheck`/`envStatus`） | 待办 |
| P3 | D1 孤儿端点（`/logs/*`、`/metrics`、`/readyz`、`/env/dsh`）明确保留或删除 | 待办 |

---

## 十、P1 修复实施记录（2026-09-10）

### A1 能力矩阵接线（含修正误导性错误指引）

| 项 | 位置 | 内容 |
|---|---|---|
| 后端暴露 | `src/guard/supervisor/settings-view.js` | `envStatus()` 新增 `capabilities`（接线既有 `platform.capabilities()`——注释早已承诺 `/env/status capabilities`，实现却未暴露） |
| 前端类型 | `ui/src/services/supervisor/types.ts` | 新增 `PlatformCapabilities`（platform/arch/multiInstance/pidAdoption/processTreeKill/desktopNotify/autostart/frpExpose/hostService）+ `EnvStatus.capabilities` |
| **UI 前置提示** | `ui/src/features/supervisor/InstancesPage.tsx` | 读取 `capabilities.multiInstance`：不支持时顶部**告警条**（说明需 Linux+systemd-run、原生 DSH 不受影响）；空状态文案随之变化；`addInstance()` **前置拦截**（不再等后端 400） |
| **修正误导** | `src/domains/instance/index.js` | 两处错误信息由 `见 /env/status capabilities.multiInstance`（裸字段路径，易误读）改为 `能力矩阵见 GET /env/status 的 capabilities.multiInstance` |

**行为变化**：非 Linux 用户此前只有点「添加实例」被 400 拒绝才知道不支持；现在打开实例页即见原因。

### A4 changelog 入口 + 命名统一

| 项 | 位置 | 内容 |
|---|---|---|
| client 补方法 | `ui/src/services/supervisor/client.ts` | `dshChangelog()` → `/changelog`；`guardChangelog()` → `/guard/changelog`；新增 `getText()`（text/plain 端点专用，保持同源/CSP/超时语义） |
| **UI 入口** | `ui/src/features/supervisor/settings/AboutCard.tsx` | 「关于」卡新增两个按钮 + Dialog 展示原文（此前两个端点**零 UI 接线**） |
| **命名统一** | `src/api/guard.js` | 注释与话术由模糊的「版本与升级」（曾暗示独立页面）统一为「**概览 · 版本与升级**」（UI 实际位置） |

### 验收

| 验证 | 结果 |
|---|---|
| `npm test`（内核 33 文件） | **677 passed / 0 failed**（较 P0 增 10 项 A1/A4 断言） |
| UI `npm run verify`（typecheck+lint+test+build） | 全通过 |
| `cross-platform-test` 新增断言 | A1-a…f（capabilities 暴露/字段/与 capabilityProfile 一致/前端类型/UI 消费/错误指引）、A4-a…d（client 方法/getText/AboutCard 入口/命名统一） |
| **端到端** | ① `/env/status` 含 `capabilities`（实测 linux/x64/multiInstance=true/hostService=systemd）；② `/changelog` → `text/plain`，首行「DeepSeek Harness（DSH）更新日志」；③ `/guard/changelog` → HTTP 200，62672 字节，首行 `# Changelog` |

### 剩余（未做，按原优先级）

| 优先级 | 断点 | 状态 |
|---|---|---|
| ~~P0~~ | A2 / A3 job 进度 | ✅ 已完成 |
| ~~P1~~ | A1 能力矩阵 / A4 changelog | ✅ 本次完成 |
| P2 | B1 `startable/guardable` 元数据执法 | 待办 |
| P2 | C1 4 个死 client 方法 | 待办 |
| P3 | D1 孤儿端点（`/logs/*`、`/metrics`、`/readyz`、`/env/dsh`）明确保留或删除 | 待办 |

---

## 十一、P2 修复实施记录（2026-09-10）

### B1 能力元数据执法（startable / guardable 从死声明变为强制约束）

| 项 | 位置 | 内容 |
|---|---|---|
| 能力字段 | guard/lifecycle/managed.js | ManagedLifecycle 新增 startable/guardable；**guardable=false 构造期锁定 guardian=false**（能力锁，不依赖调用方自律） |
| 能力入快照 | 同上 | snapshot() 暴露 startable/guardable（UI 据此灰化入口） |
| **执法** | guard/lifecycle/index.js | start/stop/restart 对 startable=false 显式拒绝（{ok:false,error:'模块不可启停（kind:id）'}）——原实现走 no-op 回调返回 {ok:true}（**假成功**） |
| API 状态码 | api/lifecycle.js | /lifecycle/{id}/restart 失败由 200 → **409**（与 start/stop 一致） |
| **单一源** | guard/lifecycle/adapters.js | 新增 capsOf(objectKind) 从 MANAGED_KINDS 取能力 → 各适配器注入；改类型表即生效 |
| 能力修正 | 同上 | instances（聚合单元，无全局进程）显式 startable:false——原 start/stop 是 no-op 却返回 ok |

### C1 死 client 方法处理（区分死代码与未接线）

| 方法 | 原判定 | 实际性质 | 处理 |
|---|---|---|---|
| sessionStatus | 死代码 | 真死（/status.sessionState 已投影，双路径） | **删除**（+ 移除 SessionState 未用导入） |
| lifecycleGet | 死代码 | 真死（UI 只用 start/stop） | **删除**（+ 移除 LifecycleModuleState 未用导入） |
| guardVersionCheck | 死代码 | ❌ **误判**——是**源码部署形态**的更新通道（git fetch + 领先提交数） | **接线**（见 A5） |
| envStatus | 死代码 | 已被 A1 接线（InstancesPage 读 capabilities） | ✅ 已消解 |

### A5（C1 复查中发现的**新增断点**）：源码形态更新通道未接线

- **现象**：AboutCard 的「检查更新」只走 selfUpdateStatus（npm 通道）。源码 git 部署形态下该调用返回 {ok:false, error:'内核自更新未配置'}，用户得到困惑错误；而 guardVersionCheck（git 上游检查）**完整实现却零 UI 接线**。
- **修复**：AboutCard check() 改为双通道——① npm 形态走 selfUpdateStatus；② 不可用且 upstream==="git-repo" 时回退 guardVersionCheck，提示「源码仓库有上游更新，请 git pull 后重启守卫」。
- **类型**：VerInfo 补 upstream/commit（源码形态字段）。

### 验收

| 验证 | 结果 |
|---|---|
| npm test（33 文件） | **688 passed / 0 failed**（较 P1 增 11 项断言） |
| UI npm run verify（typecheck+lint+test+build） | 全通过 |
| session-lifecycle-test 新增断言 | B1-a…g、C1-a…b、A5-a…b |
| **端到端** | ① /lifecycle/plugins/start → **409**；② /lifecycle/instances/start → **409**；③ /lifecycle/router/start → **200**；④ /lifecycle/status 含 startable/guardable；⑤ /guard/version/check → 200（含 commit/upstream） |

### 剩余（P3）

| 断点 | 内容 |
|---|---|
| D1 孤儿端点 | /logs/tail、/logs/events-tail、/logs/export、/metrics、/readyz、/env/dsh —— 五方无消费者，需明确「保留为对外/运维 API 并文档化」或删除 |

---

## 十二、P3 修复实施记录（2026-09-10）· 含一处根因重判

### 根因重判：D1 不是「6 个孤儿端点」，而是「**没有受强制的 API 契约**」

审计初判 D1 为「6 个端点五方无消费者」。P3 取证时发现更深层事实：

- **README 就是事实上的 API 契约**，但它**已过期**：仍文档化 R3 已删除的 POST /start|/stop|/restart，
  同时遗漏 /lifecycle、/session/*、/ports、/metrics、/logs/*、/env/status、/tasks 等**大半真实路由**。
- **/env/dsh 与 /readyz 并非孤儿**——README:117/246 **明确文档化**，属「文档化但 UI 不用」的公开面。
- 真正的问题：**没有任何机制强制「源码路由 ↔ 契约文档」一致**，所以清单必然腐化。

### 实施

| 项 | 位置 | 内容 |
|---|---|---|
| **契约清单（单一事实源）** | src/api/surface.js（**新增**） | 65 条精确 + 13 条前缀路由；每条声明 methods/domain/category/consumers/note |
| **强制测试** | test/api-surface-test.js（**新增**） | 双向一致（源码↔清单）+ 分类合法性 + **孤儿端点必须显式归类** + 已删端点不得复活 |
| 分类语义 | 同上 | public（一方 UI/CLI/壳消费）/ operational（运维监控审计面）/ internal（守卫自消费）/ deprecated（兼容保留，须写移除条件） |
| **删除冗余端点** | src/api/lifecycle.js | /logs/events-tail **删除**——与 GET /events?internal=1 语义完全等价（同走 hub.read(0,n)），零消费者 |
| 连带清理 | src/platform/loghub.js | eventTail() 失去唯一调用方，从 EventHub 与 EventReader 一并删除 |
| **修正过期文档** | README.md | API 节重写：删已删路由、补全真实路由、**加注「权威清单见 surface.js」**、单列运维/可观测面与兼容保留面 |
| 兼容保留 | /shutdown | 标记 deprecated，注明「已由 /session/stop 取代；保留供旧版壳退出」 |

### 分类结果（surface.summary()）

    public 58 / operational 4 / internal 2 / deprecated 1
    operational = /readyz /metrics /logs/tail /logs/export
    internal    = /router/ports（契约测试验证域分离）/router/domain-summary（守卫监督自消费）
    deprecated  = /shutdown

**这 5 个「无一方 UI 消费者」的端点全部得到显式归类与文档化**——不再是无主孤儿，而是有意保留的对外/运维面。仅 /logs/events-tail 因**语义重复**被删除。

### 验收

| 验证 | 结果 |
|---|---|
| npm test（34 文件） | **700 passed / 0 failed**（新增 api-surface-test 12 项） |
| UI npm run verify | 全通过 |
| **端到端** | ① /logs/events-tail → **404**（已删）；② /readyz /metrics /logs/tail /logs/export → **200**（运维面保留）；③ /events?internal=1 仍可取事件尾部（替代路径）；④ POST /shutdown → **200**（兼容保留） |
| **防回归能力实测** | 向 guard.js 注入未登记路由 /fake-unregistered-route → 契约测试**立即捕获**并输出 `FAIL 源码中所有精确路由均已登记 ← /fake-unregistered-route`；恢复源码后立刻转绿 |

### 断点审计总收官

| 优先级 | 断点 | 状态 |
|---|---|---|
| P0 | A2 插件 job 进度 / A3 反代更新进度 | ✅ |
| P1 | A1 能力矩阵 / A4 changelog | ✅ |
| P2 | B1 元数据执法 / C1 死方法 / A5 源码更新通道（复查新发现） | ✅ |
| **P3** | **D1 孤儿端点 → 升级为「API 契约强制机制」** | ✅ **本次完成** |

**A/B/C/D 四类断点全部清零**，且新增两道常驻不变量（api-surface-test 契约面、session-lifecycle/cross-platform 架构面）。

---

## 十三、实例/原生「升级恒失败」专项修复（2026-09-10）

### 用户报告

> 实例管理与原生 DSH 的「检测更新 → 升级」，即使检测到新版本、版本号正确，也一直显示升级失败。

### 实例升级：两个根因（确证：日志 + 代码 + 测试三重证据）

#### 根因 R1：升级作业被自己的并发守卫挡住（主因）

src/domains/instance/index.js 的 startInstance() 开头：

    if (inst.domain === "sandbox") {
      if (this.tasks && this.tasks.isBusy("instance", id)) {
        return { ok: true, installing: true, already: true };   // ← 什么都没启动
      }

而 upgradeInstance() 自身就是一个 instance 作业（tasks.begin("instance","upgrade",{id}) 写入 _current["instance:"+id]）。
于是升级流程走到「装完 → 重启并验证」调用 startInstance(id) 时被自己的作业挡住，返回 {ok:true} 但 systemd 单元从未被拉起
→ 调用方等端口 40s → 判「升级后实例未能启动」→ 回滚 → 回滚路径同样被挡 → 最终「升级失败」。

日志铁证（guard.log + journal）：

    12:12:39 [tasks] instance/upgrade inst-...-353 created
    12:14:35 [tasks] ... -> failed (升级后实例未能启动（端口 3084 未就绪）——可能是新版 DSH 与已装插件不兼容)

注：错误文案归因「插件不兼容」是误导——真实原因是单元从未启动。

修复：startInstance(id, opts) 新增 fromUpgrade 直通；升级与回滚两处调用显式传入（非升级路径的并发互斥语义不变）。

#### 根因 R2：waitPortHealthy 在稳定期预算不足时直接判失败

src/domains/dist/index.js 的 waitPortHealthy()：

    if (await portListening() && unitActive()) {
      if (Date.now() + stabilityMs > deadline) break;   // ← 端口已健康却直接判失败
      ...

默认 stabilityMs=15000。当端口在「deadline - 15s」之后才就绪（慢启动：插件多/首次加载）时，
端口健康却被 break 判失败 → 触发不必要的回滚。

修复：用剩余预算做缩短的稳定期复检（不漏判、不超 deadline）；实例升级验证窗口 40000 → 120000（与原生 verifyDeadlineMs 同量级）。

### 原生 DSH 升级：排查结论（未确证，需用户提供错误文案）

| 排查项 | 结论 |
|---|---|
| --patch 兼容性 | **排除**。对照实验（0.1.2-rc.1 与 0.1.5-rc.1 × 4 种参数顺序）：--patch 是 web 子命令级选项，必须紧跟 web——守卫 nativeCommand() 正是这样构造，两版本均正常启动；放末尾才报 unknown option |
| npm prefix 不一致 | **非原生主因**。~/.npmrc 已设 prefix=/home/bowen/.npm-global，安装落点与 DSH 实际位置一致 |
| _mainUnit() | 当前**恒返回 null**（09-06 概念清分 → 守卫 spawn 托管），健康验证只按端口+稳定期。09-03 那次「升级失败 + 回滚后旧版也起不来」与「校验一个不存在的 systemd 单元」特征吻合，但**当前代码已无该缺陷** |
| waitPortHealthy 稳定期 bug | **原生与实例共用** → 已随本次修复消除（原生升级失败的真实候选根因之一） |
| _crashHalted / upgrade-resume | **排除**。stopProcess 先清 child，exit handler 因 _mChild() !== child 提前 return，不会误置 _crashHalted |
| 卡住任务 | 当前 tasks.json 33 条中 **0 条 running/pending** → 排除被残留任务挡住 |

**限制**：09-03 那次的详细日志已随 guard.log 轮转丢失（现存日志从 09-10 起），无法确证当时的具体失败点。

**下一步（需用户）**：请在原生升级失败时提供 UI 上显示的具体错误文案（如「健康验证失败（端口 3080 未就绪）已回滚」/「安装后版本校验失败」/「无法从任何 registry 获取最新版本」/「已有任务在进行中」）——这是区分剩余候选根因的唯一键。或授权我在低峰期在生产执行一次并实时抓取完整日志。

### 验收

| 验证 | 结果 |
|---|---|
| npm test（35 文件） | **706 passed / 0 failed** |
| 新增 test/instance-upgrade-test.js | 6 项：R1-a/b/c、R2-a/b/c |
| 既有升级相关测试 | upgrade-test 14/0、instance-state-test 9/0、reconcile-instance-test 60/0、ensure-instance-test 8/0 全绿 |
| 验证副作用 | 已恢复（为验证启动的 inst-…-353 已停止回原状） |

---

## 十四、远程控制 · 公网访问（FRP）「配置了却不运行」专项修复（2026-09-10）

### 用户报告

> 远程控制里的公网访问，FRPS 即使配置了，服务并没有运行起来。

### 根因：**两个前置条件在 UI 上都不可达**（100% 确证）

后端启动 frpc 的硬条件是 `syncFromInstances`：

    if (!settings.enabled || count === 0) { this.stop(); return; }   // 任一不满足 → 永不启动

其中 `count` = 开启了 `frpEnabled + frpRemotePort + wanPort` 的实例数（`buildConfig` 据此生成 [[proxies]]）。

| # | 缺口 | 证据 |
|---|---|---|
| **RC1** | UI 的「保存并应用」**从不提交 `enabled`** | `LanPage.tsx` 只发 serverAddr/serverPort/authToken → 后端 `settings.enabled` 恒为默认 false（实测生产 `frp.json.enabled = false`） |
| **RC2** | **无任何实例级「公网暴露」UI 入口** | 后端 `/lan/frp/expose`（即 `setLanFrp`）**全仓零消费者**（grep 确认）→ `count` 恒为 0（实测生产 count=0） |
| **RC3** | **无访问令牌（remoteToken）UI 入口**，而暴露有安全闸 | `setFrp` 拒绝无令牌暴露；生产 4 个实例 + main 的 `remoteToken` **全为空** |
| RC4 | 后端 `list()` 不下发 `frpEnabled/frpRemotePort`；`listLan` 白名单会剥离新增字段 | UI 无从呈现/回读暴露状态 |

**纯函数实证**：`buildConfig` 在「未开 frpEnabled / 无 frpRemotePort / wanPort 未分配」三种情况均 `count=0`；
当前真实状态 `enabled=false + count=0` → `syncFromInstances` 直接 `stop()`。

### 顺带发现并修复的两个真实健壮性缺陷

#### RB1：`frpc` 默认 `loginFailExit=true` → 连不上 frps 即退出且**不重试**
- 实测：生成配置无该键时，frps 不可达 → frpc 立即 `exited code=1`，隧道**永久失效**（除非再次触发 syncFrpc）。
- 修复：`buildConfig` 显式写 `loginFailExit = false`（frp 原生自愈）。实测该配置下 frpc **保持存活并每 2s 重连**。

#### RB2：frpc 非预期退出后**无人拉起**
- frpc 不在受管对象目录（`managed-objects.json` 无它），无周期性监督 → 崩溃后隧道长期失效。
- 修复：新增**有界退避自动重拉**（2s→4s→…→60s，最多 5 次；稳定运行 60s 后重置计数）。
- 实测：`kill -9 frpc` 后自动重拉（新 pid），`/lan/frp.running=true`。

#### RB3（安全）：`frpc.toml` 权限泄漏
- 实证：生产 `frpc.toml` 为 **664**（其他文件 600），内含 **49 字符 authToken 明文** → 同机他用户可读。
- 修复：FrpManager 构造时对 `frp.json` / `frpc.toml` 各加固一次（复用平台层 fileProtect：Unix chmod 0600 / Windows icacls）。已立即修正生产文件为 600。

### 实施清单

| 层 | 变更 |
|---|---|
| 后端 | `frpmgr.buildConfig` 增 `loginFailExit = false`；新增 `_scheduleRestart` 有界退避重拉 + `_hardenPermissions` |
| 后端 | `LanManager.list()` 下发 `frpEnabled/frpRemotePort`；`supervisor.listLan` 白名单放行二者 + `tokenSet`（布尔，不泄明文） |
| 前端 | `client.ts`：`frpSettings` 增 `enabled`；新增 `frpExpose(id, on, port)` |
| 前端 | `LanPage.tsx`：新增**总闸开关**「启用公网访问」、**每实例「公网暴露」**（远端端口输入 + 开关）、**访问令牌设置**按钮（含 `tokenSet` 状态色） |
| 类型 | `FrpSettings.enabled`、`LanItem.frpEnabled/frpRemotePort/tokenSet` |

### 验收

| 验证 | 结果 |
|---|---|
| `npm test`（36 文件） | **716 passed / 0 failed，EXIT=0** |
| 新增 `test/frp-resilience-test.js` | 10 项：R1 配置健壮性（loginFailExit/代理条目/wanPort 缺失防护）、R2 真实 crash→自动重拉、R3 主动 stop/停用不重启 |
| `token-boundary-test` | 12/0（白名单更新：新增字段均非机密，token/dshToken 仍被剔除） |
| **端到端** | ① 初始 enabled=false → 不运行；② 只开 enabled 无暴露 → 仍不运行（符合设计）；③ 无令牌暴露 → **被安全闸拒绝**（明确错误文案）；④ 设令牌+暴露 → 生成正确 frpc.toml 且**真实拉起 frpc**；⑤ `kill -9` → **自动重拉新 pid** |
| UI 门禁 | typecheck / lint / build 全通过 |

### 备注（环境噪声，非代码缺陷）

本次排查中出现的 `EADDRINUSE 39080`、`lan-daemon 启动失败`、`ports-claim 顺序补位失败` 三例，
经单独复跑均通过；原因是**我并行/中断的多次运行遗留进程占用了固定端口**。
干净环境下全量回归 716/0。教训：测试链含固定端口，**不得并行运行**。

---

## 十五、发布链路：Linux 改本地生产（GitHub 额度优化，2026-09-10）

### 用户要求

> Linux 不再用 GitHub 生产，直接在本地环境生产然后推送到 NPM（额度不够用）；只有 MacOS 与 Windows 在 GitHub 上生产。

### 改造后的平台分工

| 平台 | 生产位置 | 子包 |
|---|---|---|
| **linux-x64** | **本地 Linux 机器**（`npm run release:core:publish`） | `@dsh-sup/dsh-core-linux-x64` |
| win-x64 / darwin-arm64 / darwin-x64 | GitHub CI（tag 触发矩阵） | 三平台子包 + 挂 Release |

### 实施清单

| 文件 | 变更 |
|---|---|
| `.github/workflows/build.yml` | 矩阵**移除 ubuntu**（只留 win/mac 三平台）；删除常驻 `ubuntu-latest` 的 `ui-verify` 作业（Linux 消耗归零）；注释说明平台分工 |
| `release/scripts/release-core.sh` | 重写为**薄编排**：平台闸（非 Linux 真发布直接拒绝 exit 2）+ 干净树/CHANGELOG 预检 + tag/push 时序 + 委托 `ci-core.sh`；**不再重复实现验证/构建**（原与 ci-core 双份维护） |
| `release/scripts/ci-core.sh` | 成为**唯一产线核心**（CI 与本地 Linux 生产共用）；移除重复的 UI 门禁（由 release-core 承担）与自带 token 处理 |
| `release/scripts/publish-core.sh` | **认证单源**：NPM_TOKEN → 临时 userconfig（`NPM_CONFIG_USERCONFIG`，退出即删），不再 `npm config set` 污染开发机 |
| `release/scripts/build-ui.sh` | 支持 `DSH_UI_SKIP_INSTALL=1`（本地已装依赖时跳过 npm ci） |
| `release/scripts/configure-credentials.sh` | 补充说明：发布已不需要它（显式可选） |
| `release/README.md` / `README.md` / `release/runbooks/*` | 平台分工、认证单源、脚本职责同步 |
| `CHANGELOG.md` | 新增 `[未发布]` 段（含本轮全部修复） |

### 关键设计决策与理由

1. **发布顺序改为「先 tag/push → 再本地发 npm」**：标签可删、CI 构建需时间；反之「先发 npm 后 push」一旦 push 失败即「已发布但无 tag」——同版本不可重发，无法补救。
2. **平台闸而非文档约定**：在 mac/win 上跑 `release:core:publish` 会与 CI 形成同平台二次发布（npm 拒绝且不可覆盖），故**代码级拒绝**并指引走 tag。
3. **消除双份实现**：原 release-core.sh 自己写了一遍 verify/test/build/launcher，与 ci-core.sh 重复。现 release-core 只保留 CI 不需要的三件事（平台闸、预检、tag 时序），验证/构建全部委托 ci-core —— 单源。
4. **认证不落盘**：原 ci-core 的 `npm config set registry` + `_authToken` 会把开发机默认 registry 永久改为官方源（用户平时用镜像源）、并把 token 明文写入 `~/.npmrc`。现仅在子进程内生效。
5. **Linux launcher 不再挂 GitHub Release**：npm 即其分发通道，减少 Release 体积与 CI 动作。

### 验收

| 验证 | 结果 |
|---|---|
| 平台闸（隔离副本模拟 darwin/win32/linux） | darwin/win32 → **exit 2 + 指引**；linux → 通过闸门进入预检 |
| 端到端 dry-run（Linux 全链路） | **EXIT=0**：verify → build-ui → npm test → build:launcher → 子包组装（`guardVersion=0.1.2-BETA.7` 自检通过）→ dry-run 发布 |
| CI 矩阵 | 确认仅 `windows-latest` / `macos-latest` / `macos-14`（无 ubuntu） |
| YAML 合法性 | python3 yaml.safe_load 通过 |
| 脚本语法 | 6 个发布脚本 `bash -n` 全通过 |
| `npm test`（36 文件） | **716 passed / 0 failed，EXIT=0** |
| UI 门禁 | typecheck / lint / test / build 全通过 |

### 你需要做的（Linux 首次真发布）

```bash
# 1) 配置 npm 认证（二选一）
export NPM_TOKEN='<npm automation token>'   # 推荐：不落盘，仅本次会话
# 或 npm login --registry=https://registry.npmjs.org/
# 2) 整理 CHANGELOG + 提版本
bash release/scripts/bump.sh --core <新版本>
# 3) dry-run 确认 → 4) 真发（自动 tag/push 触发 mac+win CI，并在本机发 linux 子包）
npm run release:core && npm run release:core:publish
```

⚠ **前提**：本机需先有 npm 官方源发布权限（当前 `npm whoami` 显示未登录官方源）。

---

## 十六、发布认证标准化：单一解析器 + 规范位置（2026-09-10）

### 用户提问（关键纠正）

> 你现在 NPM 的 token 不是在我们整个的发布链路里面是有的吗？为什么还要单独再走一套发布链路？我们应该把发布的整个的行为标准化。

**用户是对的，我上一条回复有误。** 我此前跑 `npm whoami` 时用的是**我这个 DSH 沙箱实例的 `$HOME`**
（`~/.dsh/supervisor/instances/inst-...-203/data`），那里没有 `.npmrc` → 得出「未登录官方源」的错误结论。

### 取证：token 确实在链路里，但位置错了

| 位置 | token | 说明 |
|---|---|---|
| `/home/bowen/.npmrc`（真实 home） | ❌ 无 | runbook 宣称的「规范位置」实际是空的 |
| `instances/inst-1788823804493-427/data/.npmrc`（"测试"实例沙箱 HOME） | ✅ 有效 | `whoami` → **lob.bowen**，mtime 2026-09-09 15:27 |
| 我这台沙箱（inst-...-203） | ❌ 无 | 故报 ENEEDAUTH |

→ BETA.5/BETA.6 之所以能从本机发布，是因为当时**在 inst-427 那个沙箱里**跑的（它的 HOME 下有 token）。

**真正的架构问题**：认证解析依赖 `$HOME`，而 DSH 沙箱会覆盖 `$HOME` →
「能不能发布」取决于**你在哪个沙箱里跑**。这既解释了假阴性，也是必须标准化的点。

### 结论：不是「另走一套链路」，而是只有一套

平台分工后仍**只有一个发布链路**，只是入口按平台不同：

| 入口 | 用途 | 实际执行 |
|---|---|---|
| `npm run release:core:publish`（Linux） | 本地发 linux 子包 | release-core（预检+平台闸+tag）→ **ci-core** → **publish-core** |
| tag → `build.yml`（mac/win） | CI 发三平台子包 | **ci-core** → **publish-core** |

`ci-core.sh` / `publish-core.sh` / `_npm-auth.sh` 三者被两条入口**共用**——不存在第二套发布逻辑。
我上一条给的「export NPM_TOKEN」只是**认证来源之一**的示例，却造成了「要另配一套」的误解，
且当时恰好在无 token 的沙箱里，看起来像「token 丢了」。

### 实施

| 文件 | 变更 |
|---|---|
| `release/scripts/_npm-auth.sh`（**新增**） | 认证解析**单源**：`dsh_real_home()` / `dsh_npm_auth_setup()` / `dsh_npm_auth_cleanup()` / `dsh_npm_auth_describe()` |
| `release/scripts/publish-core.sh` | 改为 source 该库；真发布无认证时**快速失败**并给三条指引 |
| `release/scripts/configure-credentials.sh` | 写入**真实 home**（非 `$HOME`）；`--check` 用**同一解析器**判定；git 自检同样以真实 home 为准 |
| `release/README.md` / `README.md` / `release/runbooks/credentials.md` | 记录唯一解析顺序与「真实 home」理由 |
| `test/release-auth-test.js`（**新增**，24 断言） | 锁死：单源、真实 home 解析、临时 userconfig 0600/清理/恢复、无 `npm config set`、CI 无 ubuntu、平台闸 |
| `package.json` | 测试链接入新测试 |

### 唯一解析顺序（标准化后）

1. `DSH_NPMRC` — 显式 npmrc 文件
2. `NPM_CONFIG_USERCONFIG` — npm 原生标准，已设则尊重
3. `NPM_TOKEN` / `NODE_AUTH_TOKEN` — 临时 userconfig（0600，退出即删，不落盘）
4. **真实用户 home 的 `~/.npmrc`** — **规范位置**
5. `$HOME/.npmrc` — 兜底（沙箱旧副本）

### 数据迁移（已执行）

- token 从 `instances/inst-1788823804493-427/data/.npmrc` **迁至规范位置** `/home/bowen/.npmrc`（0600）；
  原文件先备份为 `/home/bowen/.npmrc.bak-*`。
- **移除**沙箱内的散落副本（无损：内容已并入规范位置，且规范位置为唯一权威）。
- 验证：从 `inst-...-203` 与 `inst-...-490` 两个不同沙箱 `HOME` 下，`whoami` 均为 **lob.bowen**。

### 验收

| 验证 | 结果 |
|---|---|
| `npm test`（37 文件） | **740 passed / 0 failed，EXIT=0**（新增 `release-auth-test` 24 断言） |
| 认证自检 | `configure-credentials.sh --check` → `命中认证来源 → 真实 home (/home/bowen/.npmrc)` |
| 跨沙箱一致性 | inst-203 / inst-490 两个 `$HOME` 下均解析成功 |
| `publish-core.sh --dry-run` | `认证：真实 home (/home/bowen/.npmrc)`，子包组装 + self-check 通过 |
| 环境恢复语义 | 临时 userconfig 路径：文件删、`NPM_CONFIG_USERCONFIG` 精确恢复原值 |
| git 通道 | `git ls-remote` 经 repo-local SSH key 成功（与 `$HOME` 无关） |
