# EXEC3 · platform/os 下探到最根部（autostart / pidlookup）

> 第三轮（域结构改造 · 下拉到最根部）。范围：src/platform/os/autostart.js（392 行）、
> src/platform/os/pidlookup.js（305 行）。判据 DF-1..DF-9（DF-2 加严到单文件 ≤300）。

## 1. 目标结构与实际结构

    src/platform/os/
    ├── autostart/
    │   ├── index.js   102 行   门面：分派 + daemonCommand/guiCommand + 所有权矩阵
    │   ├── win32.js    51 行   schtasks DSH-Supervisor-GUI
    │   ├── darwin.js  152 行   launchctl enable/disable + bootstrap/bootout + GUI plist
    │   └── linux.js    84 行   systemd --user + linger + XDG autostart .desktop
    └── pidlookup/
        ├── index.js    42 行   门面：平台分派 findListeningPid + 导出面
        ├── probe.js   186 行   IO：/proc、lsof、netstat(PowerShell CIM)、ss、pgrep
        └── norm.js     99 行   纯：平台输出解析 + cmdline 归一化（零 IO require）

原 autostart.js / pidlookup.js 已删除。Node 目录解析使原有
require('.../os/autostart') / require('.../os/pidlookup')（无扩展名）继续命中 index.js，
故 src/ 内的 20+ 消费点（app/、domains/、platform/service/、bin/）**零改动**。

## 2. 判据逐条

| 判据 | 结果 | 证据 |
|---|---|---|
| DF-1 门面 ≤150 | PASS | autostart/index 102、pidlookup/index 42 |
| DF-2 单文件 ≤300 | PASS | 最大 darwin 152 / probe 186 |
| DF-3 纯/IO 不混 | PASS（见 §4 偏差） | pidlookup/norm.js 零 IO；probe.js 只 IO |
| DF-4 零 this 跨文件 | PASS | 全部具名函数 / ctor 注入（DEPS.guiCommand） |
| DF-5 域内 DAG | PASS | index → win32/darwin/linux；index → probe → norm |
| DF-6 独立 require 可测 | PASS | norm/probe/各平台模块均可单独 require |
| DF-7 依赖单向 | PASS | index → 平台实现 → util/exec、service/state-root |
| DF-8 顶层 require | PASS | 扫描 7 文件函数体内 require = 0（原 autostart.js:111 的内联 require 已上提） |
| DF-9 嵌套深度 ≤6 | PASS | 逐文件花括号净值最大 = 5（darwin），其余 ≤4 |

DF-8/DF-9 用「正则 + 括号计数」离线核验（未引入任何 AST 依赖，未改 package.json）。

## 3. 行为保持

- 公开导出面逐字保持：{ status, setAutostart, setGuiAutostart, daemonCommand, guiCommand }；
  pidlookup 导出 12 个键不变（含 6 个 parse* 纯解析器）。
- 平台分支语义逐条搬移，未改判定：
  - status()：win32/schtasks、darwin/launchagent、linux/systemd、未知平台 none+unit=unsupported；
  - setGuiAutostart()：darwin launchagent、win32 schtasks、未知平台显式 unsupported；
  - 守卫 plist 所有权：内核只做 launchctl enable/disable + bootstrap/bootout，不写/不删。
- 原 autostart.js 的 macGuiPlist 内联 require('../service/state-root') 上提为 darwin.js 顶层
  require('../../service/state-root')（同时消除 DF-8 违规）。

## 4. 偏差与决策（如实记录）

1. **DF-3 的最小口径**：目标结构只给 autostart 四个文件，没有纯叶子位。
   平台字符串渲染器（xmlEscape / macGuiPlist / execQuote）与同平台 IO 同文件 ——
   它们是**平台专属渲染**，与 IO 强耦合（引 shellDir）。pidlookup 则严格拆出纯 norm.js。
2. **setAutostart 未知平台仍落 Linux**：这是原实现既有行为（status/setGuiAutostart 已显式
   拒绝未知平台，setAutostart 没有）。为避免行为变更混入纯结构步，按原样保留并记录；
   如需收敛应作为独立行为变更提交。
3. **平台模块的 deps 注入**：setAutostart/setGuiAutostart 需要 guiCommand()，而 guiCommand
   定义在 index 门面。采用「index 构造 DEPS 并作为第二参注入」，避免
   index ↔ 平台模块 的反向 require（保 DAG）。

## 5. 测试指针同步（合同 §4.5：钉源码的门禁必须改指向）

| 测试 | 改动 |
|---|---|
| platform-parsers-and-commands-test.js | require 路径 pidlookup.js → pidlookup |
| platform-layer-portability-test.js | 3 处子进程 require 去 .js |
| cross-platform-architecture-gate-test.js | CP-3 needFiles 改 autostart/index.js、pidlookup/index.js |
| platform-capability-audit-test.js | 新增 readOsDir 聚合；A2/A5/A6/A8 读目录聚合；A6 macStatus、A8 macBranch 改读 darwin.js |
| autostart-ownership-test.js | 聚合读取；P2 切片改读 darwin.js 的 setAutostart 实现函数体 |
| escape-validation-test.js | 聚合读取 + require 去 .js |
| platform-audit-fixes-test.js | H-b 读 pidlookup 聚合；H-e 改读 autostart/linux.js |
| kernel-daemon-contract-test.js | D-8 读 readDomain('src/platform/os/autostart') |
| round8-fixes-test.js | J-b-2 读 readDomain('src/platform/os/pidlookup') + require 去 .js |

断言语义未放宽：聚合读取 + 定位到具体实现函数体，覆盖面不因切分而缩小。

## 6. 验证结果

- node --check：7 文件全部通过；require 加载与导出键集核对通过。
- 通过：cross-platform-test、platform-capability-audit、platform-layer-portability、
  four-platform-behavior-matrix、platform-parsers-and-commands、autostart-ownership、
  escape-validation、platform-audit-fixes、kernel-daemon-contract、round8-fixes、
  cross-platform-architecture-gate、test-safety-gate、test-chain-completeness、
  lan-daemon、reconcile-instance、watchdog-phase-freshness、shell-watchdog、
  exec-return-contract、all-platforms、platform-matrix-single-source、capability-profile、
  frp-platform、instance-upgrade、api-surface、standards-uniqueness、package-root、no-dev-path。
- 三结构门禁：directory / domain / layering 的 soft-failure **名称集与基线逐条一致**（无退化），
  layering 10/0、directory 16/0(hard)、domain 54/0(hard)。
- **未通过（非本拆分引入，属其它代理在途 app 侧改动）**：
  - daemon-path-test：src/app/daemons/runtime.js:38 改为 this.ctl.routerPort()，而测试 ctx
    仍传 _routerCtlPort —— app/test 两侧契约未同步；
  - probe-gate-and-ownership-test：E-h 读 src/app/domain-actions/router.js 的
    this._disableRouterPersist() 已被该侧改动。
  两者均不 require autostart/pidlookup，失败点不在本范围文件。

## 7. 遗留

- 文档仍写 platform/os/autostart.js、platform/os/pidlookup.js（PLATFORM-CAPABILITY-MATRIX.md、
  CHANGELOG.md、KERNEL-DAEMON-CONTRACT.md、ARCHITECTURE-CONTRACT-phase0.md、
  RELEASE-AND-UPDATE-MECHANISM.md、CROSS-PLATFORM-BUILD-AND-UPDATE.md、bin/dsh-supervisor 注释）——
  属文档同步代理范围，未在本轮改（避免越界）。
