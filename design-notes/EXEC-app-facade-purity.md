# EXEC-app-facade-purity —— app facade 纯化 + 写动作下沉（R7/R8）

> 批次：迁移步骤 8（facade 纯化 + 写动作归位）。日期：2026-09-17。
> 归属：`src/app/facade/**`、新建 `src/app/domain-actions/**`、`src/api/deps.js`；
> 经主代理 D-2 越界授权：`src/supervisor.js` APP_MODULES 块、`src/app/ctl/facades.js`、
> `test/round13-router-relay-gaps-test.js`、`test/probe-gate-and-ownership-test.js:135`、
> `test/layering-and-dependency-gate-test.js` 的 `root -> app` 登记。
> **未启动任何守卫/daemon 进程；未触碰 /tmp/dsh-*、产品状态根、~/.dsh；未 commit。**

## 1 目标与判据

R7：`app/facade/**` **只读**；写动作下沉 `app/domain-actions/`（R8：建为 app 子目录）。
实测 5 个写动作全部归位，公共调用面（`sup.*`）逐字不变。

## 2 实际改动

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/app/facade/router.js` | 改 | 移出 `setRouterRunning`；保留 5 只读视图；**上移 `routerApi`**（SCC④，见 §2.5） |
| `src/app/facade/lan.js` | 改 | 移出 `setLanFrp/lanFrpc/syncFrpc`；只留 `listLan/frpStatus` |
| `src/app/facade/main.js` | 改 | 移出 `patchDshMain`；保留 `dshMainView`；新增只读 `exposurePeers()`（注入投影） |
| `src/app/domain-actions/router.js` | 新建 | `setRouterRunning`（逐字搬迁） |
| `src/app/domain-actions/lan.js` | 新建 | `setLanFrp/lanFrpc/syncFrpc`；本地写经 lifecycle `lan` 登记项（消除旁路） |
| `src/app/domain-actions/main.js` | 新建 | `patchDshMain`；安全闸收敛 relay/core；实例冲突经注入投影 |
| `src/app/ctl/facades.js` | 改 | 删除 `routerApi`（上移 facade/router），只留 ctl Proxy 通用构造 |
| `src/supervisor.js` | 改 | APP_MODULES 新增 3 条 domain-actions require（仅数组内） |
| `src/api/deps.js` | 改 | 写动作指向标注为 domain-actions（R9：仍只声明不强制） |
| `test/round13-router-relay-gaps-test.js` | 改 | ① 指向 domain-actions/main + `validateFrpExposure` 单一事实源 + 注入 `exposurePeers` |
| `test/probe-gate-and-ownership-test.js` | 改 | E-h 读取路径 → `app/domain-actions/router.js` |
| `test/layering-and-dependency-gate-test.js` | 改 | `root -> app` 新增 `src/app/domain-actions` 登记 |

### 2.1 公共导出面（不变）

`sup.setRouterRunning` / `sup.patchDshMain` / `sup.setLanFrp` / `sup.lanFrpc` / `sup.syncFrpc` /
`sup.routerApi` 全部仍在 `Supervisor.prototype` 上（方法名/签名逐字不变）。
消费方 `api/domains/{router,native,relay}.js`、`app/control/adapters.js:49,54` 无需改动。

### 2.2 安全闸单一事实源（任务项 3）

`domain-actions/main.js#patchDshMain` 不再内联与 relay 重复的令牌/端口/占用闸，改调用
`domains/relay/core.validateFrpExposure`（relay 侧 `ops.js#setFrp` 亦调用同一纯函数）。
行为回归（令牌缺失/端口非法/端口占用/关闭 frp）全部保留，且闸仍在落盘之前。

### 2.3 消除旁路（任务项 2）

本地（非 daemon）模式的 lan 写动作不再直接穿透 `this.lan`：经 `lifecycleManager.get('lan')`
（app/control/adapters.js 注册的 ManagedLifecycle 登记项）取模块——写动作只走这一「唯一入口」，
登记项缺失时**显式拒绝**（不静默穿透）；daemon 模式仍走 43108 ctl。

### 2.4 跨域直读消除（任务项 2 后半）

`patchDshMain` 不再直读 `this.instances.instances`；改经宿主注入的只读投影 `this.exposurePeers()`
（实现落在只读层 `app/facade/main.js`，属「视图投影」职责）。

### 2.5 SCC 消解（任务项 4）

* **SCC③（daemons/runtime ↔ facade/main）**：`patchDshMain`（含 `this._syncLanState()` 调用）
  移出 facade/main → 该文件不再反向调用 daemons/runtime；环消失。
* **SCC④（facade/router ↔ ctl/facades）**：`routerApi()` 由 ctl/facades 上移至 facade/router。
  此后 `ctl/facades` 不再调用 `this.routerDaemonActive`，依赖变为
  `facade/router → ctl/facades` 单向（`_makeRouterFacade`）；环消失。

## 3 与原设计的偏差（如实）

1. **`routerApi` 落在 facade/router.js 而非 ctor 注入**：设计 §E.3 要求「facade/router ctor 注入
   routerApi + ctl/facades 注入谓词」。真正的 ctor 注入需改 `assembly/compose.js`（本批未授权）。
   为在授权范围内打断 SCC④，将 `routerApi` 上移到 facade/router——它是**只读访问器**
   （返回 ctl Proxy 或本地 RouterService），DG-14 判据通过，且 `sup.routerApi()` 行为不变。
2. **lan 登记项 `module` 采用惰性绑定**：设计批 8 表未列 `app/control/adapters.js`，本批未授权。
   故由 domain-actions/lan.js 首次取用时把 `host.lan` 绑到登记项（仍是「经登记项」的唯一入口）。
   若后续授权 adapters，可将绑定移到 `registerAll` 更显式。
3. **`exposurePeers` 仍读 `instances.instances`**：因 compose 未授权，无法把原始实例记录作为
   独立值对象注入；该投影落在只读 facade。DG-11（report-only）仍将 `app/facade/main.js` 计为
   `.instances.instances` 穿透点（改造前同样的穿透点在 `patchDshMain` 内）。要彻底消除需
   InstanceManager 暴露含 frp 字段的公开查询（`list()` 的 viewRow 不含 frp 字段）或 compose 注入。

## 4 遗留 / 需上层裁决

* **`facade/ports.js:36-41` 直读 `ports-lan.json`/`ports-router.json`**（任务项 5）：
  现存 `platform/service/ports` **无 `readAll()`**；新增它属 platform 域，跨层 → **需上层裁决**，本批只报告、未改。
* **`test/probe-gate-and-ownership-test.js` E-g/E-f 红**：13 项失败读的是
  `src/domains/router/router-ops.js`；RT3 已把该文件改为 `createAuxCore(deps)` + `auxMethods` 薄壳，
  门禁的旧正则（`setProviderKeys(id, opts) { ... await Promise.all ... }`）只命中薄壳 → 判据失效。
  属 **RT1/RT3 的 router-ops 改名连锁**（D-3/D-5），非本批改动；需改指向到 `createAuxCore` 内层方法。
* `directory-structure-gate` DS-G3b（report-only）仍命中 `supervisor.js` 的 Object.assign——属批 10。
* `domain-structure-gate` DG-6 全量落定、DG-9/DG-10 待各域 `contract.js`。

## 5 验证（本批实跑）

| 项目 | 结果 |
|---|---|
| `node --check` × 12（全部改动文件） | 通过 |
| `require()` 加载 domain-actions×3 / facade×3 / ctl-facades / deps | 通过（导出面符合预期） |
| 纯函数/假依赖单测：lan 单一入口 + daemon→ctl + 未注册拒绝；main 闸（令牌/端口/占用）+ 注入投影；router 启停 | 全通过 |
| `Supervisor.prototype` 成员核验 | 5 写动作 + routerApi + 只读视图全部在位 |
| round13-router-relay-gaps | 25 passed / 0 failed |
| layering-and-dependency-gate | 10 passed / 0 failed（无退化） |
| directory-structure-gate | 16 passed / 0 hard failed（无退化；report-only 红项为既存） |
| domain-structure-gate DG-14 (facade 只读) | PASS（5 facade 文件；反向自检全 hit） |
| api-surface | 12 passed / 0 failed |
| api-fuzz | 9 passed / 0 failed |
| lan-access-boundary | 20 passed / 0 failed |
| p2p-api | 35 passed / 0 failed |
| api-contract | 14 passed / 0 failed |
| core-test | 37 passed / 2 failed（均为「UI 未构建」环境项，与本批无关） |
| probe-gate-and-ownership | 20 passed / 13 failed（E-g/E-f，RT1/RT3 router-ops 连锁，见 §4） |

> 未启动任何守卫进程；上表全部为 `node --require ./test/_preload.js` 测试与 `require()` + 假依赖调用。
