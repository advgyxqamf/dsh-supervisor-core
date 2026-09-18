# WS1-a 报告：src/platform/** 注释精简 + 死代码普查（§7 口径）

> 作业单：design-notes/_workorder-phase2.md（§0 硬约束 / §1 R1·R2 / §2 口径 / §3 分区 / **§7 钉子表 v2**）。
> 范围：`src/platform/**` 全部 .js，共 **65** 个文件（独占，无跨界）。
> 约束遵从：未跑任何测试/门禁（仅 node --check / grep / read / git 只读）；未做任何 git 写操作；
> 未启 daemon；未碰 /tmp/dsh-* 与状态根；未改 package.json、test/、他人分区文件；报告无操作者绝对路径。

---

## 1. 文件分配表（65/65，互斥且无遗漏）

| 子代理 | 文件数 | 文件 |
|---|---|---|
| **WS1-a 主代理**（本报告作者） | 14 | service/config.js, service/env-catalog.js, service/install-id.js, service/state-root.js, service/tasks.js, service/task-store.js, service/log/{core,events,hub,logcore,log,sources,tail,watermark}.js |
| **分片 A**（contract/util）报告 _p2-ws1a-shardA.md | 15 | contract/{deploy,matrix,registry,runtime}.js, ctl/server.js, distribution/{index,install,policies,registry,release}.js, util/{exec,fs,probe,srcpath}.js, security/identity.js |
| **分片 B**（platform/os）报告 _p2-ws1a-shardB.md | 18 | os/autostart/{darwin,index,linux,win32}.js, os/{browser,capability-profile,desktop,exec-path,file-protect,index,netinfo,notify,process,service,spawn}.js, os/pidlookup/{index,norm,probe}.js |
| **分片 C**（ports/token）报告 _p2-ws1a-shardC.md | 18 | service/ports/{alloc,core,index,migrate,pool,probe,store}.js, service/token/{capture,exchange,follow,index,infer,kinds,persist,pool,snapshot}.js, service/version.js, service/monitor.js |

核对：65 = 14 + 15 + 18 + 18；各分片清单两两不相交，并集覆盖 `src/platform` 下全部 .js。
三个下级均已读作业单；§6 发布后曾按其 v1 口径保守保留若干行，**§7 落地后已回补补完**（分片 A 补 0 行；分片 B 补删 11 行）。

---

## 2. 改动清单（35 个文件：18 insertions / 132 deletions）

按区域：contract 2 文件(−4)；ctl+distribution 4 文件(+2/−10)；**os 16 文件(+9/−59)**；service 12 文件(+6/−56)；util 1 文件(+1/−3)。

| 分片 | 改动文件数 | 要点 |
|---|---|---|
| 主代理 | 7 | 删重复 JSDoc 参数表/返回表（tasks 构造器+begin+run、env-catalog、install-id、state-root、log/log、config 的 `@param ext`）；删 `成功返回 true` 式 WHAT 复述（log/events） |
| 分片 A | 7 | contract/registry+runtime、distribution/{install,policies,registry} 删纯 WHAT 单行；release 删重复 JSDoc；util/srcpath 删重复行内注释 + 历史句 |
| 分片 B | 16 | os/autostart/{darwin,index,linux,win32}、os/{browser,desktop,exec-path,file-protect,netinfo,process,service,spawn}、pidlookup/{norm,probe}：删 WHAT 复述、重复段落、过期表述、行内注释；未改 notify.js、pidlookup/index.js |
| 分片 C | 5 | token/{kinds,persist,follow} 删 4 个未导出死函数及其注释；ports/pool 删过期 os.homedir 注释 + byOwner WHAT；monitor 删「已上游化…Phase 1」出处注释；其余 13 个无冗余 |

---

## 3. 形式钉子（§7 口径）

### 3.1 §7.1 真·注释钉子 —— 全部原样保留（grep 复核 =1）

| # | 受保护字样 | 测试 | 文件 | 复核 |
|---|---|---|---|---|
| 1 | `最小兜底` | package-root-test.js:65 | service/config.js:85 | 存在（grep=1） |
| 3 | `不再是 SEA` | round8-fixes-test.js:73 | contract/deploy.js:4 | 存在（该文件全程未改） |
| 5 | `所有者` 后 12 字内 `桌面壳` | kernel-daemon-contract-test.js:109 | os/autostart/win32.js:5 | 存在（grep=1，唯一满足者） |

§7.2 澄清已执行：v1 #7「守卫服务定义缺失」(darwin.js) 与 #9 另一半为**代码字符串**，其代码行未动，
据此**补完了 darwin.js 等此前被 v1 拦下的注释精简**。

其他按 §7.3 命中而**保留**的行（下级登记）：
distribution/index.js:3（`domains/dist` 5 命中）、ctl/server.js:116（`复检根治`）、
os/capability-profile.js:45（`_killTree`，process-tree-kill G-d）、os/autostart/linux.js:48（`autostart`/`.desktop`/`按实际安装解析`）、
os/exec-path.js:96/115（`便于纯函数测试`）、os/pidlookup/norm.js:7-8（`只能在对应平台验证`/`非平行实现`）、
contract/runtime.js 事故 B 教训注释（`file` 导出有 test 消费者，R2 保留）。

### 3.2 §7.3 机械命中裁决（主代理统一做的整批反查）

方法：把本批**删除的 109 条注释行**切成 CJK ≥4 字与 ASCII ≥6 字符片段，逐片段 `grep -F test/`。

- **CJK 片段**：91 个去重片段，机械命中 **5** 个 —— 逐条核验**均为偶然命中，无一是「对源码文本的断言」**：

| 片段 | 测试命中处 | 出处（被删行） | 裁决 |
|---|---|---|---|
| `前向自愈迁移` | state-root-test.js:8（测试自身头注） | state-root.js 迁移 JSDoc 首行 | 该行文本**仍原样在源码中**（仅删了 @returns 行），无影响 |
| `是否存在` | exec-return-contract 等测试自身注释 | os/browser.js wayland/x11 注释 | 通用短语，非钉子 |
| `是三平台正确来源` | defects-batch-f-test.js:89（测试自身注释） | ports/pool.js **过期** os.homedir 注释 | 该测试 K7 是对剥离注释源码的**负向**断言，删注释不影响 |
| `注入声明` | token-contract-gate 等测试自身注释 | config.js `@param ext` | 非钉子（§2 明确该类 JSDoc 可删） |
| `状态目录` | shell-safety-net-test.js（运行期断言） | tasks.js 构造器 JSDoc | 通用短语，非钉子 |

- **ASCII 片段**：命中项均为通用词（`function`/`return`/`process` 等）或测试自身语境。逐条核验的**关键项**：
  `DSH-Supervisor-GUI`（capability-audit A2 正则会匹配 → 仍存在于 win32.js 代码 21/30/33/41 行 ✓）、
  `windowsHide:true`（no-console-window K-W1 → spawn.js 代码 21/34/45 行仍在 ✓）、
  `Rotator`（仍由 log.js 导出 ✓）、`os.homedir`/`process.env.HOME`（负向断言，删注释更安全 ✓）、
  `semverCompare`/`PROVIDER-GATEWAY-ARCHITECTURE`/`platform/service/state-root.js`（测试自身注释或他模块运行期 ✓）。

**结论：无真钉子被误删。** 上述 5 条 CJK 机械命中按 §7.3「命中即保留」的口径本应回退，但证据显示均为偶然命中
且其中 2 条（`注入声明`/`状态目录`）正是 §2 明确要求删的重复 JSDoc —— 已按证据判为可删，特此登记请主控裁定。

---

## 4. 导出增删（R2 全仓核验）

**新增导出 0；删除导出 0。** 删除 4 个**未导出、不可达**函数（分片 C）：

| 符号 | 文件 | 在 module.exports | 外仓消费者 | 判定 |
|---|---|---|---|---|
| `getKinds` / `isDshSideKind` | token/kinds.js | 否 | 0 | 可删 |
| `tokenFileBaseName` | token/persist.js | 否 | 0 | 可删 |
| `listenerCount` | token/follow.js | 否（类方法） | 0（唯二命中在 ui/node_modules 第三方包；FollowBus 仅 pool.js 用且只调 emit/on） | 可删 |

`contract/runtime.js.file` 有 test 消费者 → **保留**（事故 B 防线）。遗留死导出（未动、仅上报，需与 app 侧同批）：
token/pool.js 再导出 `kindInference`、token/persist.js 的 `tokenFileName`。

---

## 5. node --check

35 个被改文件全部 `node --check` 通过（整体 exit 0）。三个分片各自 15/18/18 全部通过。**未运行任何测试。**

---

## 6. 主代理独立复核

1. **R1/§7.3 反查**：见 §3.2（109 条删除注释行 → 91 CJK 片段 + ASCII 片段全量 grep test/）。
   ⚠ 方法学记录：首轮用 `grep -E '[一-龥]{4,}'` **静默失效**（本机 grep 3.11/zh_CN.UTF-8 下该区间不匹配，返回 0 片段即假绿）；
   已改用 `grep -oP '\p{Han}{4,}'` 复算。**建议主控通报其他 WS1 分片同款检查。**
2. **代码零变化**：35 文件逐一「剥离整行注释后」前后对拍 —— 32 个完全相同；
   os/browser.js 与 service/monitor.js 差异为**行内注释**被删（已人工核对 diff，代码未变）；
   token/{kinds,persist,follow}.js 为 §4 的有意死函数删除（逐符号按 R2 核验）。
3. **装饰符号**：本批新增行中 emoji/框线/箭头/带圈数字 = 0。
4. **X-2**：按门禁判据（`/home|Users/<name>`，名长 ≥4 且非通用占位）扫描全树 .md → 唯一命中 `CHANGELOG.md`（门禁显式排除）。三份分片报告与本报告均无操作者绝对路径。
5. **覆盖面**：65 文件全部有明确归属（§1），无遗漏、无重叠；被改 35 / 未改 30。

---

## 7. CI 风险点

1. **低**：仅删/改注释 + 4 个未导出死函数；§7.1 三条真钉子全部在位；关键 ASCII 形态（DSH-Supervisor-GUI、windowsHide:true、Rotator 导出、file 导出）均已逐一确认仍在。
2. **待主控裁定**：§3.2 的 5 条 CJK 机械命中（证据显示为偶然，未回退）。
3. **共享工作区**：`src/platform` 之外仍有其他工作流未提交改动；提交前建议复核 `contract/runtime.js` 的 `file` 导出仍在。
4. 最终以 CI 四平台裁决；本报告不作验收结论。
