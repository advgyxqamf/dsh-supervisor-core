# WS1-c 分片 B 报告（app/main、native、self、session、settings、state）

> 作业单：design-notes/_workorder-phase2.md。独占文件集 = 下列 6 个目录的全部 .js（38 个）。
> 未触碰 src/app/assembly/** 与 src/app/{control,ctl,daemons,facade,domain-actions,audit}/**（分片 A）。
> 未运行任何测试；未做任何 git 写操作；未改 test/ 与 package.json。

## 0. 总览

- 独占文件 38 个；本轮改动 36 个（decide.js、signals.js 的注释全部为 WHY/契约，判定保留，未动）。
- 净变化 +72 / -138 行；装饰符号新增 0；node --check 38/38 通过。
- 唯一的代码（非注释）改动是 §3 的 2 处死代码删除；其余改动全部只在注释内，且逐行核对过
  「代码前缀字节一致」（§4 证据）。

## 1. 改动文件清单（每个一行理由）

### app/state（10）
- src/app/state/phase.js — 删两处复述函数体的 WHAT 注释；保留 OBSERVED 合成语义。
- src/app/state/field-tables.js — 头部去掉文件名词缀，保留「fields.js re-export 以稳定 helper 形态」契约。
- src/app/state/intents.js — 删复述语义段与 5 处 WHAT JSDoc；保留「一次性/无时间窗」「非恢复依据」。
- src/app/state/collaborator.js — deps 逐项枚举与代码重复，压缩为「惰性取值函数」一句。
- src/app/state/desired.js — 删文件名词缀与「公开：」式 WHAT JSDoc；保留观测转正与旧键删除语义。
- src/app/state/main-record.js — 删「写入后落盘」类 WHAT 注释；保留 fallback 与 write 语义。
- src/app/state/main-store.js — 删文件名词缀与 trivial JSDoc；保留 live 缓存原地修改约束。
- src/app/state/store.js — 删「内容未变不写盘」等 WHAT；保留状态单源/升级 hold/boot 相位不继承。
- src/app/state/upgrade-hold.js — 压缩头部；保留 hold 标志位落宿主瞬态字段的跨模块约定。
- src/app/state/fields.js — 删 toEntry/toLegacy 与 procField 的复述注释；**头部含 _mPhase 的句子原样保留（钉子）**。
- src/app/state/field-tables.js 已含于上。
  （state 共 10 个文件：collaborator/desired/field-tables/fields/intents/main-record/main-store/phase/store/upgrade-hold）

### app/settings（8）
- src/app/settings/access.js — 删文件名词缀与状态 WHAT；保留「不回显明文」「原子持久化」；导出形态短语保留（钉子）。
- src/app/settings/autostart.js — 删「调用方零改动」历史句；保留平台能力声明与门禁绑定契约。
- src/app/settings/domain-config.js — 「反转前…逐字未改」改为约束表述；删别名行的重复说明。
- src/app/settings/env.js — 删小节标题与「仅本块使用」；保留能力矩阵/壳看护暴露理由。
- src/app/settings/lan-panel.js — 删方法 WHAT；平台化历史改写为「经 netinfo」；保留安全语义与 N3 的 code 区分。
- src/app/settings/node-lts.js — 压缩 JSDoc 首行；保留「不做远端查询/绝不抛异常」；导出形态短语保留（钉子）。
- src/app/settings/token-kinds.js — 两处「逐字未改」改为约束表述；保留 kind 语义与注入时机契约。
- src/app/settings/versions.js — **删除重复的 /** 头行（清理残留，含 ** 装饰）**；删日期叙事与「A3：」过程标记。

### app/main（7）
- src/app/main/controller.js — 删重复的「systemd 已废弃」句与「收敛窗口关闭」WHAT；保留契约/INV-S1/单向依赖。
- src/app/main/decide.js — 未改动（注释全为 WHY/契约/否决位建模）。
- src/app/main/health-gate.js — 删 @returns 参数表；保留 failStreak 语义与反向边约束；导出形态短语保留（钉子）。
- src/app/main/port-rederive.js — 删「消除双份」历史；保留 ownerId 陷阱与成员名契约；「切面装配」短语保留（钉子）。
- src/app/main/process.js — 删 6 处「影子 actual 记账」WHAT 与重复的拆分说明；保留脱敏/进程组/守护 gate 语义。
- src/app/main/shadow.js — 删「已记账」WHAT 与日期；保留窗口语义与排除集理由。
- src/app/main/signals.js — 未改动（注释为跨平台与孤儿教训）。

### app/native（8）
- src/app/native/command.js — 删职责罗列；保留 rejectParentOptions 陷阱与端口注入语义。
- src/app/native/installer.js — 删职责罗列（与 require 列表重复）；保留构造期注入与互斥检查时序。
- src/app/native/manifest.js — 删依赖清单与 @param 表；保留「首装认领不因升级丢失」。
- src/app/native/npm.js — 删依赖清单/环境检查 WHAT；保留解构值绑定陷阱与「唯一入口」契约。
- src/app/native/ops.js — 删依赖清单与重复的并发锁注释；**两处钉子原样保留**（见 §2）。
- src/app/native/policies.js — 删依赖清单与 3 处复述表达式的 WHAT JSDoc。
- src/app/native/probe.js — 删依赖清单与 3 处 WHAT JSDoc；保留「唯一入口」与恒 null 语义（钉子）。
- src/app/native/upgrade.js — 删依赖清单与 2 处 WHAT JSDoc；**删除死导出 PKG_DEFAULT（见 §3）**。

### app/session（2）
- src/app/session/machine.js — 压缩 deps 枚举；保留契约 §3/§6 与 INV-S1。
- src/app/session/shutdown.js — 删小节标题/兜底括号/「V5 修复」；**删除死导入 registerAll（见 §3）**。

### app/self（3）
- src/app/self/health.js — 删 2 处复述方法体的探针 JSDoc；保留端点语义。
- src/app/self/lifecycle.js — 仅收起 1 处 WHAT JSDoc 尾句；保留「监事」不变量。
- src/app/self/notify.js — 头部去文件名词缀；保留静默停用理由。

## 2. 形式钉子保留项（R1：被 test/ 匹配，原样未动）

| 文件 | 保留文本 | 匹配它的测试 |
|---|---|---|
| src/app/native/ops.js | `可重试` | test/uninstall-timeout-test.js:61（region=锁置位→module.exports） |
| src/app/native/ops.js | `保留 manifest` | test/defects-batch-f-test.js:134、test/uninstall-timeout-test.js 反向（seg=idx±900/400） |
| src/app/native/ops.js | `if (exitCode === 0) {\n  rm(host.manifestFile)` 结构 | 同上（硬正则，未触碰该 4 行） |
| src/app/native/ops.js | `platform/os/process`（require 行） | test/uninstall-timeout-test.js（SRC 全文） |
| src/app/native/probe.js | `恒为 null` | 1 个测试命中该短语 |
| src/app/settings/access.js、node-lts.js | `导出形态 { methods }` | 2 个测试命中该短语 |
| src/app/{main/health-gate,main/decide,main/shadow,main/controller,main/process,main/signals}.js | `导出形态 { methods }` | 同上（短语全数保留，仅裁掉其前后冗余） |
| src/app/main/port-rederive.js | `切面装配` | 1 个测试命中 |
| src/app/main/controller.js | `接管既有实例` | 1 个测试命中 |
| src/app/main/decide.js、src/app/session/shutdown.js | `抑制一切自动拉起` | 1 个测试命中 |
| src/app/session/machine.js | `INV-S1`、`契约 §6` | 各 1 个测试命中 |
| src/app/state/fields.js | 头部含 `_mPhase` 的整句 | test/token-contract-gate-test.js、test/adopt-token-reclaim-test.js 引用该标识符 → 整句保留 |

## 3. 死代码删除（附全仓核验证据）

1. **src/app/native/upgrade.js：删除 `const PKG_DEFAULT` 与其导出**（module.exports 由 `{ upgrade, PKG_DEFAULT }` 改为 `{ upgrade }`）。
   - R2 全仓 grep `PKG_DEFAULT`（src/ test/ bin/ release/ ui/ design-notes/ *.md .github/ app/，排除 node_modules/.git）：
     命中仅 `src/app/native/ops.js`（其**自有**同名局部常量，3 处使用）与
     `design-notes/_r5-app-api-P3.md:50`（称「ops.js 使用」——经核验**该说法不成立**，ops.js 用的是自身常量）。
   - 该文件在 upgrade.js 内零引用（仅定义 + 导出）；test/ 与 bin/ 无消费者 → 按 R2 可删。
2. **src/app/session/shutdown.js：删除未使用的导入 `const { registerAll } = require('../../app/control/adapters')`**。
   - 该绑定在本文件仅出现 1 次（即导入行本身），无任何调用。
   - `control/adapters` 另由 `src/app/assembly/bootstrap.js:11` 与 `src/app/assembly/compose/observers.js:8` require，
     且 adapters.js 无顶层副作用（只 require ./entry、./registry）→ 删除不减模块加载。

其余 36 个改动文件中未发现：被注释掉的代码块（0 命中）、恒真/恒假分支、重复实现。
逐文件的 require 绑定重新扫描：全部 38 个文件已无「仅出现 1 次」的导入绑定。

## 4. 「代码零变化」自证

对 6 个目录做 `git diff -U0`，把所有 +/- 行按「去掉前缀与缩进后是否以 // 、/* 、* 开头」过滤，
输出的非注释行**只有两类**：
- 行内尾注释被删/缩短的 11 行 —— 每对 -/+ 在 `//` 之前**字节完全一致**（已逐对核对）；
- §3 的 2 处死代码删除。
未新增任何装饰符号（emoji/框线/箭头/带圈数字）：新增行命中数 = 0。

## 5. node --check

38 / 38 全部通过（0 失败）。命令：对 6 个目录逐个 `node --check <file>`。

## 6. CI 风险点（供主控裁决）

1. **R1 残余风险（低）**：我只 grep 了候选注释的特征串。若某测试用**别种子串**断言了我裁剪的文本，
   仍可能红。重点观察对象（都读我这些文件）：
   test/upgrade-test.js、test/native-test.js、test/native-op-mutex-test.js、test/uninstall-timeout-test.js、
   test/defects-batch-f-test.js、test/app-ctor-injection-test.js、test/adopt-token-reclaim-test.js、
   test/graceful-shutdown-test.js、test/shadow-decision-test.js、test/token-contract-gate-test.js。
2. **§3 的两处删除是本批唯一的非注释改动**，若主控偏好保守，可回退其中之一：
   - upgrade.js 导出面缩小（先例 f410a3a 正是「删导出→CI 红」）；
   - shutdown.js 去掉一次 require（已证 adapters 由装配期加载）。
3. **X-2 门禁**：本报告只用相对路径，未出现任何操作者 home 绝对路径（POSIX 或 Windows 形式皆无）。
4. 本批未触碰 test/、package.json、scripts.test，故不涉及 N-e 命令行长度判据。

## 7. 交付边界

未提交、未推送（作业单禁止 git 写操作）。改动留在工作区，由主控统一提交与跑 CI。
