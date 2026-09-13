# DSH 两仓审计与修复 —— 交接文档

> 本文是「跨设备/跨对话继续执行」的唯一入口。
> 新对话开始时，先读本文，再读本文末尾的「剩余任务」。

---

## 1. 两仓定位

| | 内核（runtime） | 壳（installer / desktop） |
|---|---|---|
| 路径 | `/home/bowen/develop/plus` | `/home/bowen/develop/dsh-supervisor-launcher` |
| 语言 | JS / CommonJS | Rust (Tauri 2) + 前端 TS |
| 远端 | `advgyxqamf/dsh-supervisor-core`（**私有**） | `wasi7mglns/dsh-supervisor-launcher`（**公开**） |
| 分支 | `master` | `main` |
| 角色 | 运行时服务 + 面板后端 | 安装器（无头 provisioning）+ 桌面壳 |

**工作区根目录 = `/home/bowen/develop/plus`**（内核）。壳仓在**同级目录**。

**职责边界（重要，决定了「缺陷该在哪边修」）**：

```
壳 = installer + desktop shell + 镜像探测 + 契约导出
内核 = runtime service + panel backend
```

两者**不能共享代码**（Rust ↔ JS）。共享只能通过：
  · **移动职责**（谁最合适谁做）；
  · **消费产物**（内核读壳写的文件）；
  · **共享规格 + 测试向量**（`shared/version-vectors.json`，两侧 sha256 必须一致）。

关键契约文件：
  · `~/.dsh/supervisor/registry.json` —— **壳写、内核读**（镜像源选择，v2 含 schema/writtenBy/catalog/probe/selected）
  · `~/.dsh/shell/identity.json` —— **壳写**（phase/version/pid/exe）
  · `~/.dsh/shell/update-guard.json` —— 壳自更新护栏账本

---

## 2. 硬约束（不可违反）

1. **没有明确许可，不做任何版本构建 / tag / 发布**；
2. **不要抬高版本号**；
3. **保留 Tauri 原生壳**（不要改成别的形态）；
4. **不得破坏内核更新机制**；
5. **审批提示已禁用** —— 绝不设置 `sandbox_permissions`（一律自动拒绝）；
6. 文件策略为 `danger-full-access`。

### 绝不可杀掉的进程

  · 系统 `Xvfb :99`（父进程为 init，早于本任务启动）；
  · 机器级 guard 进程。

（旧记录的 pid：896 / 1483 / 3483429 —— **pid 会变**，按**命令行特征**辨认，不要照抄 pid。）

---

## 3. 验证标准（非可协商）

> **每一处修复都必须做「注入 → 失败 → 还原 → 通过」。**
> **不能证伪的门禁不是门禁。**

具体流程：

```
① 写好门禁/测试
② 注入缺陷（还原成修复前的样子）
③ 跑测试，确认**确实 FAIL**
④ 还原修复
⑤ 跑测试，确认 PASS
```

**注入必须保持可编译/可解析** —— 否则「测试通过」只是「测试没跑」。
（本仓已踩过：把 `?` 塞回 `match` 表达式导致 Rust 类型错误，测试根本没执行。）

还原脚本**本身也要验证**：曾因还原时漏删一行造成重复声明语法错误。

---

## 4. 当前状态（**第十三轮后**，2026-09-13）

```
内核 plus：  HEAD 702c6ce（master），工作树干净，未推送 63
壳 launcher：HEAD 97e8edb（main），  工作树干净，未推送 50
```

> 任务起点：内核 800b308 / 壳 3448e75。**第十三轮新增 11 个内核 commit + 4 个壳 commit**
> （约 34 项修复，全部经「注入→失败→还原→通过」验证）。
> 第十二轮已合入 D-3 第一步 / A 节四项 / D-2。
>
> 第十三轮重点（详见各 commit message 与壳 docs/DESIGN-COMPLETE.md）：
>   · **P0** exec.run「成功也返回 null」→ hasTool/isUnitActive 恒假（沙箱功能对所有 Linux
>     用户不可用、删数据保护失效）
>   · **P1** 心跳是唯一周期驱动，任一 adapter 卡死即永久停摆（无超时/无兜底/无观测）
>   · **P1** sanityCheck 丢弃返回值（损坏包会被翻转到 current）、router.js 多处无 catch
>     （ctl 拒绝时请求永久挂起）
>   · **P1** 壳投放的镜像契约只读一次（运行中重写永不生效）、frpc 下载零完整性校验
>   · **P1** 壳仓 macOS 构建断裂（macos.rs 用 SVC_QUICK 却未导入 → E0425）
>   · **P1/P2** frp 令牌闸只在一条路径、relay 门卫令牌无热换、删除路径不 force 停实例、
>     插件补丁层队列被异常永久毒化、删除实例与在飞升级无互斥
>   · **P2** TaskRegistry 跨进程双写者丢更新、registry.json 的 selected 恒 null、
>     Node 安装零进度反馈、nodeprobe 孤儿线程堆积、镜像「测试」按钮被页面 CSP 拦截、
>     `ports.release(port, ownerId)` 对未登记端口抛 TypeError
>   · **P3** 令牌恢复文件权限不收口、providers.json 损坏即静默清零、平台事实误报等

**版本（未改动，勿动）**：

```
已安装产品 dsh（/usr/local/bin/dsh、~/.npm-global/bin/dsh）= 0.1.2-rc.1
内核 package.json version = 0.1.5-BETA.1
壳 Cargo.toml version     = 1.0.8
```

> ⚠ 注意：`dsh --version` 若走**当前 harness 实例**的 bin，会显示 `0.1.5-alpha.2` ——
> 那是**运行本会话的 DSH harness**，不是被测产品。核对产品版本请用 `/usr/local/bin/dsh`。

### 测试基线（全部 0 失败）

```
内核  npm test      90 文件 / 1659 断言 / 0 失败  （任务起点 1098；第十三轮 78→90 文件，1460→1659 断言）
壳    cargo test    129 项 / 0 失败                （任务起点 77；第十三轮 114 → 129）
壳    cargo check   0 警告
前端  npm run verify  tsc 0 / eslint 0 / vitest 15 / build 成功（任务起点：从未运行过）
```

---

## 5. 已完成（十轮，87 项修复）

| 轮次 | 范围 | 修复数 |
|---|---|---|
| 一~八 | 平台/进程/生命周期/分布式/插件/壳引导等 | 68 |
| 九 | native 管理器 + 实例域 + 壳看护 + 插件市场 | 13 |
| 十 | 壳仓深部（update/mirror/node/platform/main）+ 内核 lifecycle | 6 |
| 十一 | **评估 D-1 取舍时发现并修复自己引入的市场回归** | 1 |

### 第十轮明细（最近，最有参考价值）

| 级别 | 位置 | 缺陷 |
|---|---|---|
| **P0** | 壳 `update.rs` | `pinned` 抑制在**更新成功后**变永久自锁 → 永久收不到更新（含安全修复）|
| **P1** | 壳 `node.rs` | SHASUMS 下载失败 `?` 提前返回 → 单一镜像抽风中断整条回退链（**两处**）|
| **P1** | 壳 `mirror.rs` | 跨仓 `probe` 超时：壳实测 8s、告诉内核 6000ms → 选源分叉 |
| **P1** | 壳 `platform/unsupported.rs` | 11 个 `Platform` 方法写进了 `impl ServiceControl` → 该模块**从未被编译** |
| **P1** | 内核 `guard/lifecycle/managed.js` | `restart()` 回退路径丢弃 stop/start 失败 → 报假成功 |
| **P2** | 壳 `main.rs` | 关窗 `exit` 路径在 **UI 线程**跑 ~70s 退出握手 → 窗口假死被强杀 |

### 第十一轮明细（D-1 取舍评估的副产物）

| 级别 | 位置 | 缺陷 |
|---|---|---|
| **P2** | 内核 `pluginmarket.js` | **我加的构建预算引入的回归**：截断源（部分结果）会**替换掉**完整的旧缓存 ——
既有保护判据是「本次**整源失败**」，而截断源**仍在结果里**，故不触发保护。已修（保护 A：截断源并集）。|

### 第九轮明细

| 级别 | 位置 | 缺陷 |
|---|---|---|
| P1 | 内核 `guard/native/manager.js` | 安装/升级/卸载三入口锁**不对称** → 升级中可卸载（不可恢复）|
| P1 | 内核 `domains/instance/index.js` | 升级失败**两条路径都无回滚** |
| P1 | 同上 | 删数据目录前**未确认单元已停** → 不可逆数据丢失 |
| P1 | 同上 | `ports.release()` 不带 ownerId → 误删他人端口登记 |
| P1 | 同上 | `_updCache` 只写不删 + 定时器未 unref |
| P2 | 内核 `domains/shell/` | 「谁是壳」两份实现分叉 → 误杀运维自检进程 |
| P2 | 内核 `domains/instance/` | systemd 模板无条件删除 → 改「改名让位」 |
| P2 | 内核 `pluginmarket.js` | 无整体构建 deadline（最坏数十分钟）|
| P2 | 内核 `watchdog.js` | 陈旧 phase 让宽限永久走 5min |
| P3 | 内核 `instance/index.js` | 新增实例不探测端口真实占用 |
| P2 | 内核 `settings-view.js` | `watchdog.status()` 零消费 → 接进 `/env/status` |
| P2 | 内核 `instance/index.js` | 我上轮留下的 setter 与注释自相矛盾 |

---

## 6. 门禁清单（都已证明可失败）

### 壳仓

| 门禁 | 锁定 |
|---|---|
| G1/G1′ | 平台分支只能出现在 `platform/`（递归扫描全部 Rust 源）|
| G2 | `commands/` 内不得 `Command::new` |
| G3 | `main.rs` ≤ 550 行、零 `#[tauri::command]` |
| G5 | 每个 JS 语法检查 |
| G6-a..e | 自更新护栏不得永久自锁 + 显式恢复入口 + 用户可见 |
| **G6-f/g/h** | pinned 在更新成功后被解除；抑制语义保留；一处实现 |
| **G6-i** | 跨仓 probe 超时单一事实源 |
| **G6-j** | SHASUMS 失败不中断镜像回退 |
| **G6-k** | 退出握手必须离开 UI 线程（两条路径）|
| **U-a..d** | 未知平台实现的 trait 方法归属（该模块三大平台都不编译）|
| B32 | 禁裸 `.output()/.status()` |
| B43/B45/B46/B56..B63 | 引导/服务/转义等 |

### 内核仓

| 门禁 | 锁定 |
|---|---|
| G9 | 只有 `platform/exec.js` 可调 `execFileSync`（也扫 `bin/`）|
| G10 / C-a..d / E-a..i / F-a..d / K3-a..e / J-a..j | 分层/契约/词表/命名等 |
| **K-a..d** | native 三入口互斥锁对称（含**行为级**）|
| **L-a..g** | 实例域安全（回滚/数据保护/端口归属/缓存清理/setter/模板让位/端口探测）|
| **M-a..e** | 插件市场整体预算（含**行为级** deadline 生命周期）|
| **N-a..f** | 陈旧 phase 时效（含**行为级**，注入时钟）|
| **P-a..e** | restart 回退必须尊重 stop/start 失败 |

测试文件：内核 **77 个**（链在 `package.json` 的 `scripts.test`），壳 **6 个 test target**。

> ⚠ **新增内核测试必须加进 `package.json` 的 `scripts.test` 链**，否则永不运行。
> （踩过一次：断言总数没变才发现。）

---

## 7. 反复出现的失效模式（找 bug 时按这个清单扫）

| # | 模式 | 实例 |
|---|---|---|
| a | 注释/声明声称某纪律，代码里没有 | `unsupported.rs` 全模块 |
| b | 同一事实两处实现且已分叉 | 「谁是壳」6 flag vs 3 flag；probe 8s vs 6000ms |
| c | 声明了能力/字段但零调用点 | `watchdog.status()`；`isUnitActive` |
| d | 门禁/测试锁定了错误行为（含恒真断言）| `p2p-api-test` 曾断言假成功 |
| e | 计数/阈值/闸门因时序恒真或不可达 | `pidlookup` Windows 分支不可达 |
| f | 只写不读的字段 | `_updCache`；`lastProbeOk`；`guiSupported` |
| g | 纪律在多条路径中**只在一处**执行 | restart vs start/stop；关窗 exit vs 托盘 quit；删数据路径 |
| h | 异步未 await / 被提前截断 | `shutdown()` 不 await；`?` 提前 return |
| i | 跨仓契约两侧不一致 | probe timeout；`update-journal.json` 无接收方 |

**模式 g 出现频率最高，且最隐蔽** —— 看到「这条纪律写得很清楚」时，
立刻去问：**有几条路径会走到这里？都执行了吗？**

---

## 8. 剩余任务（可直接执行）

> **第十三轮已把 A 节全部项与 B 节全部区域处理完毕**（见下表「结论」列）。
> A 节两项经独立复核判定为**已文档化/非缺陷**（见 9.7）；其余均已修并有门禁。

### A. 壳仓 —— 已处理

| 级别 | 位置 | 问题 | 结论 |
|---|---|---|---|
| P2 | `mirror.rs` | 声称「缓存（TTL）」但 `checked_at` 无过期判定；`selected_node` 只写不读 | **证伪**：TTL 判定在**内核**（`dist/index.js` 消费 `contract.selected.checkedAt`，30min TTL），层是对的；`selected_node` 有消费（`mirror_status`）。但发现并修复了**真缺陷**：`selected_npm` 从不落盘 → registry.json 的 `selected` 恒 null |
| P2 | `update.rs` | `reset_guard()`/`mark_pending()` 不回写 `identity.json` | 已修（D-3 第一步：单一写入 helper，+5 注入验证）|
| P2 | `linux.rs` | 提权通道探测与 `install_node` 分叉 | 已修（共用 `find_privilege_command`）|
| P3 | `env.rs` | `api_port()` 回退 3100 vs `api_base_url` 36360 | 已修（单一常量 `DEFAULT_API_PORT`）|
| P3 | `bounded.rs` | 失败路径遗留 temp 日志 | 已修（两条路径都 cleanup）|
| P3 | `domain/windowing.rs` | 无宿主的文档注释 | 已修（改为指向性说明）|
| P3 | `update.rs` | `pinned` 只增不剪 | 已修（`pruned_pinned()` 单一裁剪，文件与投影同源）|
| 跨仓 | 内核 `domains/shell/index.js` | `pinnedVersions` 壳仓零消费 | 已修（如实标注「无接收方」+ **说明为何不能贸然接线**：会重新引入永久拉黑；含跨仓扫描门禁 R10）|

### B. 内核仓 —— 已处理

| 位置 | 结论 |
|---|---|
| `src/guard/lifecycle/managed.js` 深部 | 已审；修 `stop()` 失败硬编码回 running（把已知失败显示成运行中）；`objects.js` 修复：心跳逐对象超时、`_nextTickAt` 复位、节流按实际执行时刻前推；`ports.release` 空值顺序 + 三处调用方补 ownerId |
| `heartbeat` / `adapter` 调度节流 | 已修 **P1**：心跳是唯一周期驱动，任一 adapter 卡死即永久停摆（加逐对象超时 + 兜底释放 + 可观测字段）|
| managed-objects 与实例相位一致性 | 已核：实例相位词表（STOPPED/INSTALLING/STARTING/RUNNING/BACKOFF/FAILED）与 registry 映射**完整对应**，无缺口 |
| `registry.json` 在内核其余消费点 | 已核并修 **P1**：契约只在构造期读一次 → 加 60s TTL 重载（主进程与 router-daemon 共用同一实现）|
| 前端其余 JS | 已核并修 3 项：node-lts 死字段/死分支、镜像「测试」按钮被 CSP 拦截（改同源后端探活）、`core_plan.error` 零消费导致谎报「内核已是最新」|

### C. 已核实**无问题**（不要重复怀疑，除非有新证据）

```
TaskRegistry 持久化：tmp+rename 原子、崩溃窗口安全、unshift+slice(0,MAX) 保留最新
UI 消费：installLog（OverviewPage）与 updateJob（InstancesPage）都真实消费
版本向量：两侧 sha256 一致
分层：壳 commands/domain 无 Command::new；cfg 分支只在 platform/ 与白名单 bounded.rs
原子写：identity/update-guard/mirrors/registry/runtime 均 tmp+rename
服务定义自愈：三平台均内容比对重写
既有引号/转义修复确在：schtasks /TR、cmd 双引号、systemd ExecStart、plist XML、架构白名单
```

### D. 设计取舍 —— **已给出建议方案**（动手前先与用户确认）

#### D-1 插件市场：批大小 / 预算取值

**实测参数**：单条 `safeFetchLatest` 超时 8s；社区候选约 2468 个；批次 8。

```
理想网络（~200ms/条）：2468/8 × 0.2s ≈ 62s      → 4 分钟预算绰绰有余
最坏情况（每条都超时）：308 批 × 8s ≈ 41 分钟  → 4 分钟只够约 240 条（~10%）
```

**建议**：保留 8 并发 / 4 分钟，**但已补上截断源合并**（见下）。

> ⚠ **重要**：加预算这件事本身引入了回归 —— 既有的「坏构建保护」判据是
> 「本次**整源失败**」（`!freshSources.has(source)`），而被截断的源**仍在结果里**，
> 于是它**不会**保留旧条目 → 只跑到 200/2400 的 community 会**替换掉**完整的旧列表。
> **已修复**（新增「保护 A」：截断源与旧缓存取并集，不受 50% 比例约束），
> 并有 M-f/M-g 正反向回归测试。

**若想进一步优化**：可考虑按「已耗时比例」动态收窄批次、或对社区源做增量缓存
（只重测上次未命中的名字）。但这属于性能优化，不是缺陷。

#### D-2 `_prepareSystemd` 是否该彻底不再触碰用户 systemd 目录

**先确认前提**：删除/让位是**有正当理由的** —— `service.js:57` 注释与实现表明
实例用 `systemd-run --user --unit=dsh-web@<id>`（`service.js:70`），
而 `~/.config/systemd/user/dsh-web@.service` 模板会与同名瞬态单元**冲突**，
导致 `systemd-run` 拒绝重建。所以「不能放着不管」。

**建议**：**保留「改名让位」**（当前实现），理由：
  · 阻断效果与删除**完全相同**；
  · 内容完整保留、可人工恢复；
  · 记事件 `systemd_template_moved_aside` 可追溯。

**可再改进一步（低风险）**：把让位目标名从固定 `.disabled-by-dsh`
改为**带时间戳**（如 `.disabled-by-dsh-<epoch>`）——
当前实现会先 `rmSync(aside)` 再 rename，若用户恰好有个同名文件会被静默删掉；
时间戳后缀可彻底消除这个（极低概率但不可逆的）碰撞。

**不建议**改成「不触碰 + 让 systemd-run 报错」：那会把一次可自愈的冲突
变成用户看不懂的实例启动失败。

#### D-3 `identity.json` 第二状态源（**最需要定夺的一项**）

**现状**：

```
update.rs::init_identity()  → 把 attempt / pinned / pendingVersion **抄进** identity.json
update-guard.json          → Guard 的真正存储（attempt/pendingVersion/pinned/lastAttemptAt）
reset_guard() / mark_pending() → **只写 update-guard.json，不回写 identity.json**
```

消费方：
```
内核 domains/shell/index.js:119-121  用 id.attempt 作为「失败次数」权威来源（决定回滚）
壳   commands/mod.rs:416            shell_identity 快照（引导页展示 attempt/pinned）
```

**根因**：identity.json 的**定位**是「壳此刻是什么状态」（version/pid/exe/phase），
而更新护栏账本是**另一个关注点**、有**自己的文件**。把后者抄进前者
= 制造第二真源 —— 且已被证明会陈旧（`reset_guard` 后 identity 仍显示旧 attempt）。

**建议（分两步，先低风险后彻底）**：

**第一步（低风险，建议现在就做）**：**单一写入路径**。
把 identity.json 的所有写入收敛到一个 `write_identity(&Guard, runtime_fields)` helper，
`init_identity` / `set_phase` / `reset_guard` / `mark_pending` **全部经它**。
守卫字段永远是 Guard 的**投影**，不可能分叉。**不动任何消费方，无跨仓风险。**

**第二步（彻底，需协调发布）**：从 identity.json **移除** `attempt`/`pinned`/`pendingVersion`，
让两个消费方改读 `update-guard.json`（内核本就在读同目录的 identity.json，
读另一个同目录文件不引入新依赖类别）。这样契约只剩**一个**真源。

**为什么不建议「回写 identity.json」这条捷径**：那只是让两份拷贝保持同步，
仍是两个真源 —— 下一个新增的 Guard 变更点会再次忘记回写，问题只是被推迟。

**风险提示**：第二步是**跨仓契约变更**（壳与内核分别发版），
必须两侧都改完才能上线，否则内核读不到 attempt 会把失败计数当 0 →
**回滚判定失效**。若决定做，需要：新版内核**先**允许从 update-guard.json 读、
在 identity.json 缺失该字段时降级，再在下一版壳里移除字段。

---

## 9. 陷阱与教训（血泪清单）

### 9.1 子代理误判 **6 次**（全部拦下）

共同形状：**看起来像死代码/漏接线，实际是活的**。

| 子代理说 | 实际 |
|---|---|
| `self-update.js` 是死代码 | 活的，测试要求 |
| 内核 CI 从不跑 `npm test` | `ci-core.sh [2/5]` 在跑 |
| `fs-utils.extractTarGz` 是死 export | **被 `self-update.js:87` 调用** —— 照删会破坏守卫自更新 |
| `env` 注入是死变量 | `manager.js` 无此参数，5 个调用点都不传 |
| 「谁是壳」两份实现 | 属实（这条是真的）|
| ... | ... |

**纪律**：子代理的每条结论都必须**独立复核**（grep 调用点 + 读实现 + 行为验证）。

### 9.2 我自己造出的**假门禁 / 假测试 7 次**

| 类型 | 实例 |
|---|---|
| 假通过 | 用例共用实例 → 注掉 `busy()` 检查仍 PASS |
| 恒真断言 | `typeof x === 'boolean' \|\| x === undefined` |
| 匹配错位置 | `indexOf('if (!dead)')` 命中了上面那行 warn |
| 命中自己的注释 | 断言命中说明文字里的字符串（**两次**：`_writeIdentity`、`impl ServiceControl for Impl`）|
| 断言命中自己的新代码 | `!includes('let rbOk = false')` —— 新助手里也有同名变量 |
| 设计错误 | 用文件 mtime 判 phase 时效（被既有 W3-e 拦下，因其注入 identity 桩）|
| 门禁被注释欺骗 | `find("impl X for Impl")` 命中自己刚写的说明注释 |

**纪律**：
  · 断言前**剥离注释**；
  · 用**特征调用**（如 `version: oldVersion`）而非易撞名的局部变量；
  · 顺序断言要**限定在目标函数体内**（`addInstance` 的 `registerUser` 曾被文件前面的同名调用干扰）。

### 9.3 注入/还原的操作事故

| 事故 | 后果 | 教训 |
|---|---|---|
| 注入破坏类型 | 编译失败，测试**根本没跑** | 注入必须保持可编译 |
| 还原漏删一行 | 重复声明语法错误 | **还原脚本也要验证** |
| `git checkout` 还原 | 该文件本就未提交 → 还原成**原始缺陷版** | 歪打正着：反而成了「门禁对原始代码确实 FAIL」的铁证 |

### 9.4 临时文件纪律

  · 一律写到 `/home/bowen/develop/` 下，文件名避开 `.dsh-*`（会被清理脚本误删）；
  · **不要用 `/tmp`** —— 曾与清理脚本竞争导致 `file no longer exists`；
  · 每轮结束必须确认仓外无残留。

### 9.5 绝不盲写已存在的文件

曾用 `tools.write` 把一个 1713 行的测试文件截成 91 行（`bootstrap_flow.rs`）。
**先读，再用 `edit` 做定点修改。**

### 9.6 其他

  · `| tail` 会吞退出码 → 用 `set -o pipefail`；
  · bin crate 上 `--lib` 会报 `no library targets found` → 用 `--bins`；
  · `const { x } = require(...)` 是**值绑定**，patch 模块导出对已解构的引用无效（曾导致测试真跑了 `npm uninstall -g`，已核实无损害）。

---

### 9.7 第十三轮新增的教训（**注释自匹配累计 13 次**）

本轮又 4 次被自己的**说明文字**骗过（判据命中了注释里的旧代码/字段名/调用形态）：
  1. R10-a 的 surface 断言命中了我自己写的「本条 note 原写…」注释；
  2. A-2/A-3 用 `include_str!` 读自身源码，针脚字符串就在测试源码里；
  3. R-c 只剥 `//` 行，而**块注释续行**（`*` 开头）里写着
     「PortRegistry.release() 现已支持 ownerId」→ 被当成一次无参调用（假红）；
  4. UI node-lts 门禁命中了类型注释里列举的旧字段名。
  **铁律：断言前必须同时剥离 `//`、`*`、`/*` 三类行；针脚尽量在运行时拼接。**

另有 3 次**门禁太松/空转**：
  · frpc 信任根用无锚点子串匹配 → 「镜像前缀 + 官方 URL」仍命中（假绿）；
  · `defined_locally` 把「使用」误判为「本地定义」→ 反向断言失效；
  · M-a 用全文件 find 命中了 `load()` 里的读取赋值（位置在 warmup 之前）。
  **铁律：结构性判据要么按行定界，要么限定在目标函数体内；每条门禁都要有反向断言。**

### 9.8 我自己的改动造成过回归（门禁及时拦下）
  · 心跳兜底改写时把 `const iv` 落在 setInterval 回调内部、却在 `}, iv)` 处引用 →
    ReferenceError → 定时器根本没建起来 → **smoke S1 全红**（基线 34/34 通过、改后立刻失败）。
  · `main.rs` 端口释放的 owner 我写成 `'dsh-main'`，而 `ports.register` 写的是
    `'system:dsh-main'` → 释放变 no-op → 旧端口残留，被既有
    `test/main-port-rederive-test.js` **当场捕获**。
  **教训：改「唯一周期驱动」与「按 owner 释放」这类关键路径时，先跑既有的行为级门禁。**

---

## 10. 命令速查

```bash
# 内核全量测试
cd /home/bowen/develop/plus && npm test

# 内核单个测试
cd /home/bowen/develop/plus && node test/<name>.js

# 壳构建与测试
cd /home/bowen/develop/dsh-supervisor-launcher/src-tauri
export CARGO_HOME=/home/bowen/.cargo RUSTUP_HOME=/home/bowen/.rustup
export PATH="/home/bowen/.cargo/bin:$PATH"
cargo test
cargo check --all-targets

# 前端
cd /home/bowen/develop/plus/ui
export PATH="/home/bowen/.nvm/versions/node/v26.7.0/bin:$PATH"
npm run verify

# 汇总断言数（内核）
cd /home/bowen/develop/plus
npm test 2>&1 | grep -oE '^结果: [0-9]+' | grep -oE '[0-9]+' | paste -sd+ | bc
```

### 提单规范（本任务一直沿用）

  · 每条修复**独立 commit**，message 含：缺陷 → 为什么是缺陷 → 后果 → 修法 → **注入验证结果** → 测试计数变化；
  · 中文 message，`git -c user.name=dsh-agent -c user.email=agent@local.dsh commit`；
  · 壳 `docs/DESIGN-COMPLETE.md` 追加该轮记录。

---

## 11. 完成判据

在「继续」类指令下，**每一轮必须留下**：

```
① 至少一处**经注入验证**的真实修复（或一条**有证据的证伪**）
② 两仓工作树干净
③ 内核 npm test / 壳 cargo test / 前端 verify 全绿
④ 仓外无临时文件残留
⑤ 该轮记录进 commit message（+ 壳 DESIGN-COMPLETE.md）
```

**宁可只交 1 条确凿的，也不要 10 条猜测。**
每条都要能回答：**注入什么会让它失败？**