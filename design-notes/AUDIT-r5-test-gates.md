# AUDIT-r5-test-gates — 第五轮测试与门禁质量审计（J 组）

范围：test/ 与 package.json#scripts（只读 src/，只报告）。
方法：仅静态检查 —— node --check、grep、wc、git status、只读脚本统计；
本机未执行任何测试、未启动任何 daemon、未产生发布产物（符合 ACCEPTANCE-STANDARD §0/§5）。
其他组已改的 src/ 文件与 test/layering-and-dependency-gate-test.js、
test/shell-safety-net-test.js 不在本报告改动范围（git status 可见），本组未触碰。

---

## 1. scripts.test 与 test/ 文件一致性

### 1.1 机械核对（静态，脚本统计）

- scripts.test 条目数：126；长度 7711 字符（N-e 上限 8000，余量约 289）。
- test/ 下匹配 isTestFile 的测试文件：127（125 个 *-test.js + smoke.js + ports-verify.js）。
- 链中不存在重复条目（按路径与 basename 均无重复）。
- 链中每个条目都对应真实文件（本组新增 N-f 后由门禁固化，见 §7）。
- 唯一未入链测试：test/native-test.js，已在 test-chain-completeness-test.js 的
  EXCLUDED 表显式排除并写明理由；排除表引用的文件真实存在。

结论：N-a/N-b/N-c/N-d/N-e 当前均成立。

### 1.2 高优先级：同一批测试的「排除」与「入链」互相矛盾（登记冲突）

三处独立声明这两个测试**不得**进入 npm test 自动链：

- package.json 第 21 行 `_uninstallTests`（项目政策，2026-08-31）：
  「api-contract-test.js（含 POST /native/uninstall 契约断言）、
   plugin-change-restart-test.js（含插件卸载场景）禁止进入自动测试链（npm test）」。
- test/api-contract-test.js 第 4-6 行文件头：“已从 npm test 自动测试链排除，
  仅允许作为独立脚本显式单独调用”。
- test/plugin-change-restart-test.js 第 4-6 行文件头：同样声明“已从 npm test 自动测试链排除”。

但现状相反：两者都在 scripts.test 链中（位于 test-chain-completeness-test.js 之后、
package-root-test.js 之前），且各有独立 npm script（test:api-contract /
test:plugin-change-restart）本可承载按需调用。CI 的 test job 跑 xvfb-run npm test
= 每次 CI 都会执行这两个被政策排除的卸载类测试。

这是「scripts.test 与 test/ 一致性」与「重复登记」的直接冲突：同一事实被登记到
两个互斥的集合里。两个可能的收敛方向，各有代价，属政策裁决，本组不擅自改：

- 方向 A（遵守政策）：从 scripts.test 移除二者，并加入 test-chain-completeness-test.js
  的 EXCLUDED（带理由）。N-a 仍绿，政策与文件头一致；代价是 CI 覆盖面回落。
- 方向 B（政策失效）：删除 `_uninstallTests` 与两个文件头的排除声明，明确二者
  已是回归测试。代价是废弃一项用户确认过的卸载安全政策。

注：这两个测试当前均以桩实现（api-contract 用最小 stub Supervisor；
plugin-change 用 stub CLI + 真实临时目录），静态看无真实卸载副作用；
但政策文本是显式的，不能由本组以「看起来安全」为由推翻。

### 1.3 N-a..N-e 盲区（本组已补 N-f）

- N-a：只保证「测试文件有归属」，不保证「链指向真实文件」。链若要到运行到该条才炸，
  属可提前发现的门禁缺口。已新增 N-f（§7）。
- N-c：把「非 *-test.js 且非 _ 前缀」一律当助手。若有人把回归测试误命名为
  test/foo.js（无 -test 后缀），既不会入链（N-a 不管它）、N-c 还会把它当合法助手
  ——永不执行且门禁全绿。建议后续把「疑似测试的助手」也纳入报告（本组仅报告）。
- N-a/N-b 只扫 test/ 顶层目录；test/ 子目录（如 test/fixtures/）不参与判断。
  当前 fixtures 只有 mock 进程脚本，无测试文件，暂无实害。
- N-d 反向样本硬编码 test/__nonexistent-gate-test.js 等，属有效反向，但只验证
  「未入链被识别」，不验证「链中死引用被识别」；N-f 补上后二者互补。

## 2. 空转判据（恒真 / 无信息断言）

### 2.1 已确认为空转并已修（§7 有逐条依据）

1. test/switch-policies-test.js:86 `assert.ok(true);` —— 无条件恒真，
   且是文件内 assert 的唯一用法。已删除，并删除随之失去引用的
   `const assert = require('node:assert')`。
2. test/freeze-recovery-test.js:100
   `check('B1 冻结后 300ms 定时补探测已排定（等 800ms）', true);` —— 无条件恒真。
   其声称的行为由后续 B2（billingHits 增长）与 B3（quota 刷新）真实断言。已删除该行，
   保留 800ms 等待与 B2/B3。
3. test/token-boundary-test.js:104,106 —— 两条弱断言：
   - 「重复相同令牌不重复广播（轮换收敛）」只重读了上一条已断言过的 pushed.tok，
     并未真正重喂同值，等于没测去重；
   - 「取消订阅生效」直接写 true（注释自承“内部无查询接口，语义性断言”）。
   已改为行为断言：置空后重喂同值要求回调不触发；unsub 后喂新值要求回调不触发。
   依据：pool.js:220 同值早退（不广播）；follow.js:33-36 on() 返回移除函数；
   follow.js:49-57 emit 同步遍历 listener。

### 2.2 已确认但未改（需环境或跨仓裁决，仅报告）

- test/release-channel-gate-test.js:226,228：壳仓 core.rs 交叉断言在
  `!fs.existsSync(shellCore)` 时 `check(..., true, '跳过')`。本仓按设计
  不检出壳仓工作树（no-cross-repo-test.js X-4），故这两条在本仓 CI **恒为假通过**。
  这与 ACCEPTANCE-STANDARD §1.4「静默 SKIP = 该断言在 CI 永不检查」是同一失效模式。
  建议：跨仓断言应报告为 SKIP 且不计入 PASS，或彻底移出本仓门禁。
- test/p2p-api-test.js:128,179 与 test/p2p-router-test.js:201,227：在
  “无 ready 账号 / 无账号”分支 `check(..., true, '跳过')`。是否触发取决于
  上游桩账号是否就绪；一旦某次环境变化使其恒为 false，这两组断言即静默失去覆盖，
  且日志仍显示 PASS。建议改为显式 SKIP 计数，或把前置条件变成该测试的硬前置断言。
- test/lifecycle-mirror-test.js:46：`if (!lc) check(..., true)` 的兜底分支。
  同文件 M0 已断言 lifecycleManager 注册含 router，故该分支实际不可达（死跳过分支）。
  可删以消除误导。

## 3. 失效断言（钉在源码形态/字面量）

- 上一轮 design-notes/EXEC-test-assert-sync.md 已把已知的「单文件形态断言」
  改为整域读取或行为判据。本组静态复核了其中高风险项，当前自洽：
  - test/kernel-update-single-writer-test.js:75 断言
    `src/platform/distribution/self-update.js` **不存在**，是删除后的
    反向存在性断言，不是死引用（扫描器易误报，已核实）。
  - test/round13-router-relay-gaps-test.js:52-66 读取面已指向
    `src/app/domain-actions/main.js`；实测该文件含 patchDshMain（第19行）
    与 `validateFrpExposure`（第15/43行），`relay/core.js` 含
    `function validateFrpExposure`（164）与两条错误文案（170/172），
    闸在 writeMainMeta（53）之前，判据当前成立（即 design-notes 记录的
    遗留 FAIL ① 已被后续改动收敛，不再是红门禁）。
  - test/layering-and-dependency-gate-test.js 的 root 出边与
    `src/supervisor.js` 实测 require 一致（仅 app/settings、
    app/assembly/compose）；domain-actions 由 app/assembly/facets.js 以
    app→app 同层引入，不构成 root→app 未登记跨层边。
- 残余风险（仅报告，未逐一改动）：仍有大量门禁以正则/字符串匹配源文件内容
  （如 test/provider-gateway-gate-test.js、test/token-contract-gate-test.js、
  test/round8-fixes-test.js）。文件内重组若恰好保留匹配串，即静默假绿；
  设计上已用「整域聚合 + 剥注释 + 反向样本」缓解，无法完全消除。
  建议新增的形态敏感断言统一采用「整域读取 + 行为判据 + 反向样本」三件套。

## 4. 重复门禁与重复登记

- scripts.test 无重复路径/重复 basename（机械核对）。
- 同名 check 文案（不同文件或同文件重复登记，导致 CI 失败时无法定位是哪一条）：
  经解析后确认真正同文件同名的是：
  - test/destructive-op-safety-test.js:153 与 177（W-3 覆盖前自动备份旧值）；
  - test/provider-gateway-gate-test.js:220 与 256（PG-8 反向：写闸判据能识别未过闸形态）。
  其余如 GD-2(lan/router)、RC-G2-x(if/else)、K-W1/J-b-2 等经带引号展开后
  文案不同，属扫描器截断误报。上述两条已各自针对不同夹具/不同谓词，
  不是重复断言，但同名会降低可诊断性；建议后续为其中一条加 b 后缀区分（本组未改，
  避免与文件所有者冲突）。
- 登记类门禁有 4 道，职责互补、非重复：
  test-chain-completeness N-a（全量测试有无归属）、
  release-spec-consistency P-5（规范列出的门禁在链中）、
  no-cross-repo X-4（链自包含、含自身）、
  state-root SR-7（链经 _preload 注入隔离）。
  四者分别锚定不同失效模式；重复的是「读 package.json 的 scripts.test」这一动作，
  不可合并。

## 5. 无测试覆盖的关键路径（静态近似，非覆盖率工具）

本机不得运行测试，无法取得真实覆盖率。以「测试是否提及源文件路径/stem」做静态
近似，得到 56 个未被直接提及的 src 文件，但该近似**不可靠**：模块常经聚合入口
（如 relay/index）间接 require（例如 token/follow.js、policies/failure.js 实际
已被链中测试间接或动态路径覆盖）。故本组不据此断言「未覆盖」，只提请注意两类
静态上确无直接触点的关键路径，交 CI/覆盖率工具裁决：

- src/app/state/*（desired/main-record/main-store/upgrade-hold 等状态机核心）
  与 src/app/control/{managed-object,projection,instance-adapter}.js：
  在 test/ 文本中无直接路径引用，行为多经 Supervisor 间接验证。
- src/platform/service/{task-store,monitor,version}.js 与
  src/platform/service/log/{events,logcore,tail,watermark}.js。
- 平台原生 win32 自启动 src/platform/os/autostart/win32.js 属逻辑可测、
  原生行为只能由四平台 CI 裁决（与 ACCEPTANCE-STANDARD §3 边界一致）。

建议：在 CI 增加覆盖率采集（工作流改动，非本组 test/ 范围），再把
「关键路径无覆盖」从静态推测变为机器证据。

## 6. 调试残留与被注释掉的断言

全量 grep（test/ 含 fixtures）结果：

- 被注释掉的断言（// assert / // check / 块注释内断言）：0。
- .only( / .skip(：0（test/task-registry-test.js:51 的 reg.skip 是业务 API，非 Mocha）。
- debugger;：0；console.trace / console.dir / util.inspect：0；
  process.env.*DEBUG：0；eslint-disable：0。
- console.log 均为 PASS/FAIL 输出与分节标题，无内部状态调试打印。

结论：本项无缺陷。唯一等价物是 switch-policies 的 `assert.ok(true)` 残留（已在 §2 删除）。

## 7. 改动清单（本组，均为 test/；package.json 未改）

| 文件 | 改动 | 依据 |
|---|---|---|
| test/switch-policies-test.js | 删除 `assert.ok(true);` 与失去引用的 `require('node:assert')` | 恒真空转；grep 确认 assert 仅此一处使用；node --check 通过 |
| test/token-boundary-test.js | 「重复相同令牌」改为置空后重喂同值断言回调不触发；「取消订阅生效」改为 unsub 后喂新值断言回调不触发 | pool.js:220 同值早退；follow.js:33-36/49-57 同步广播与移除函数 |
| test/freeze-recovery-test.js | 删除恒真的 B1 标记行，保留等待与 B2/B3 行为断言 | 恒真无信息；真实效果由 B2/B3 断言 |
| test/test-chain-completeness-test.js | 新增 N-f「链中每个条目都真实存在」；修正文件头过时计数（94/104→不含魔数） | N-a 只保证测试有归属、不保证链指向真实文件；头部数字已漂移（实际 126/127） |

注释前后统计（本组 4 个文件，含注释行/总行）：

| 文件 | 注释行 before→after | 总行 before→after |
|---|---|---|
| test/switch-policies-test.js | 10 → 10 | 92 → 90 |
| test/token-boundary-test.js | 12 → 14 | 116 → 122 |
| test/freeze-recovery-test.js | 23 → 24 | 138 → 138 |
| test/test-chain-completeness-test.js | 48 → 47 | 133 → 140 |

（注释行在本组只做「删恒真标记、补行为断言理由」，未做符号/表情清除——
任务三的符号清理按分工属 K 组 src/ 范围，且 test/ 全域目前普遍使用
方框线/警示符，单独改少数文件会造成不一致；如需要应作为独立批次统一处理。）

## 8. 四维审计发现

### 8.1 架构设计
- scripts.test 是单条硬编码 && 巨链，跨平台（Windows cmd 8191）与可维护性都靠
  门禁（N-e/N-a）兜底，属可接受的务实形态；但每次新增测试都要手改超长字符串，
  N-f 补齐了「链指向真实文件」这一缺失面。
- 登记类门禁四道互补，职责边界清晰，未见重复门禁。
- 唯一架构级冲突：`_uninstallTests` 政策与链登记互斥（§1.2），应尽快裁决。

### 8.2 业务逻辑
- 空转判据集中在「跳过分支写成 true」与「重读旧值冒充新断言」两类；前者多，
  后者（token-boundary）更隐蔽。已修 token-boundary 的去重与退订两条，
  使两条设计不变量（轮换收敛、退订生效）首次获得真实覆盖。
- freeze B1 的恒真标记掩盖了「计时器是否真的排定」本可由 B2/B3 证明，
  删除后语义更准确。

### 8.3 规范标准
- N-a..N-e 与 ACCEPTANCE-STANDARD §1.5 的 Windows 长度事故闭环良好。
- 但 ACCEPTANCE-STANDARD §1.4「静默 SKIP = 断言在 CI 永不检查」的原则，
  在 release-channel 跨仓断言与 p2p 条件跳过上未被遵守（§2.2），属规范与现实漂移。
- `_uninstallTests` 与两个测试文件头是 2026-08-31 的显式政策，
  scripts.test 的 2026-09-13 改动与之冲突且未同步任一方的文本，属规范标准不一致。

### 8.4 功能设计
- 测试文件采用自实现 check() 汇总 + process.exit(失败数) 的统一形态，
  退出码可靠；无框架依赖，符合「不加 dependencies」约束。
- 建议（未实施，避免越界）：把 scripts.test 由「手写巨链 + 完整性门禁」
  逐步迁移为「目录扫描生成器 + 显式排除清单」，从根上消除 N-a/N-c/N-f 的组合盲区。

## 9. 遗留 / 需裁决（交主代理）

1. [高] `_uninstallTests` 政策 vs scripts.test 登记冲突（§1.2）：请裁决方向 A/B。
2. [中] release-channel 跨仓断言在本仓恒为假通过（§2.2）：建议改 SKIP 计数或移出。
3. [中] p2p 条件跳过（§2.2）：建议前置条件硬化或显式 SKIP。
4. [低] test-chain-completeness N-c 对「无 -test 后缀的真测试」盲区（§1.3）。
5. [低] 同文件同名 check 文案可诊断性问题（§4）。
6. [建议] CI 覆盖率采集（§5），把「无覆盖关键路径」从静态推测变为证据。

## 10. 验证

- `node --check` 全量通过：test/*.js 与 test/fixtures/*.js（0 失败）。
- 未执行任何测试、未启动 daemon、未 commit/push、未改 package.json 版本或依赖。
- 改动仅 4 个 test/ 文件，均位于本组题目范围。
