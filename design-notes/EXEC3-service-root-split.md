# EXEC3 · platform/service 根部拆解（ports / log / token）

> 第三轮「下拉到最根部」。负责范围（R3-C 独占）：src/platform/service/** 全部。
> 本文件记录实际改动、与原目标结构的偏差、遗留。

## 1 结果概览（行数 / 文件）

### ports/（原 index.js 592 行）
| 文件 | 行数 | 职责 |
|---|---|---|
| index.js | 20 | 门面：组合 core + pool，只导出 |
| pool.js | 193 | PortRegistry（状态 + 登记/查询/容量） |
| alloc.js | 152 | 分配与槽位仲裁（claimSlot/allocate 编排） |
| core.js | 121 | 纯算法：池/段/锚点/容量/快照 |
| store.js | 58 | 持久化读/原子写/只读聚合 |
| probe.js | 45 | TCP 探测 / bind / pid / cmdline 回收 |
| migrate.js | 38 | owner 前缀迁移（IO） |

### log/（原 hub.js 492 行）
| 文件 | 行数 | 职责 |
|---|---|---|
| hub.js | 245 | EventHub 类 + 兼容再导出 |
| sources.js | 91 | 源注册 / 内部簿记 / 人性化（注入接口） |
| core.js | 78 | 窗口派生读（纯）+ EventReader |
| tail.js | 46 | ctlCall + 尾读（IO） |
| watermark.js | 25 | 水位读写（IO） |

### token/（原 pool.js 372 行）
| 文件 | 行数 | 职责 |
|---|---|---|
| pool.js | 282 | TokenPool（登记/捕获/广播/调度） |
| infer.js | 49 | 源形态 → kind 推断（纯） |
| snapshot.js | 46 | 池快照 IO（原子写/加载过滤） |

### tasks.js（顺手，原 345 行）
| 文件 | 行数 | 职责 |
|---|---|---|
| tasks.js | 290 | TaskRegistry 状态机 |
| task-store.js | 62 | 任务持久化 + 跨进程合并（IO） |

## 2 冻结接口保持（签名逐字不变）

- ports module.exports 仍为 { PortRegistry, shared, BASE_POOLS, DEFAULT_POOLS, SEGMENT_POOL, registerPools, registerSegment }；
  shared 方法 claimSlot / allocate / allocateMark / release / readAll / registerSegment / migrateByOwnerPrefix / capacity / available / isFull / snapshotAll 全在。
- log/hub 仍逐字导出 registerSource / registerSources / setSources / getSources / registerInternalType / setInternalTypes / isInternalEvent / ctlCall / tailFile / EventHub / EventReader（从 sources/core/tail 再导出）。
- token/pool 仍导出 TokenPool / CAPTURE_RETRY_MS / BACKFILL_THROTTLE_MS / MAX_PENDING_LINES / configureKindInference / kindInference（configureKindInference/kindInference 由 infer.js 再导出，app/settings/token-kinds 无需改）。
- tasks 仍只导出 { TaskRegistry }。

## 3 DF-1..DF-9 证据

- DF-1 门面：ports/index.js = 20 行（≤150）。
- DF-2 单文件：src/platform/service/** 全部 ≤300（最大 token/pool.js 282）。
- DF-3 纯/IO 不混：core.js（纯，无 fs/net）与 store/probe/migrate/tail/watermark/snapshot（IO）分离；pool.js 只编排。
- DF-4 零 this 跨文件：PortRegistry 的方法全在 pool.js；分配经 PortAllocator(registry) 构造注入（显式组合，非同一 this）；hub 的读派生为 core 具名函数。
- DF-5 DAG：pool -> {core,store,probe,migrate,alloc}；alloc -> {core,probe}；hub -> {sources,core,tail,watermark}；无环，无 Object.assign(X.prototype,...)。
- DF-6 可独立 require：core/store/probe/migrate/alloc、sources/watermark/tail、infer/snapshot/task-store 均可单独 require。
- DF-7 依赖单向：index -> pool -> core/store/probe/migrate/alloc，无反向。
- DF-8 顶层 require：对 32 个 service 文件做「剥注释+字符串 + 花括号深度」正则扫描，内联 require = 0。
- DF-9 嵌套深度：同上扫描，最大花括号深度 ≤6（0 处超限）。

## 4 与原目标结构的偏差（如实）

- 目标建议 ports/{index,pool,store,migrate}；实际多出 core.js（纯算法）与 probe.js（探测 IO）、alloc.js（分配编排）。
  理由：DF-3 要求纯/IO 不混；若把分配与探测都塞进 pool.js，pool.js 超 300 且纯算法与 IO 混杂。
  命名遵循职责（core/probe/alloc），未使用 *-view/*-mixin 之类「从哪切出来」的名字。
- 目标建议 log/{core,hub,sources,watermark,tail}；与该结构一致（core 另含 EventReader）。
- 目标建议 token/{index,pool,persist,infer}；persist 原本已存在，另拆 snapshot.js（池快照 IO）与 infer.js。
- tasks.js 目标 301-400「可顺手处理」，本轮一并下沉 task-store.js。

## 5 迁移纪律：同步改测试（仅指向，行为断言不动）

- test/round13-ports-release-test.js:87（R-c 跳过定义处）与 :122（R-d 读源码）由 ports/index.js → ports/pool.js。
- test/probe-gate-and-ownership-test.js:72（E-c release 签名）由 ports/index.js → ports/pool.js。
- platform-audit-fixes-test H-a 仍断言 log/hub.js：本轮刻意把 _log 定义与 4 处 this._log 调用保留在 hub.js，测试零改动通过。

## 6 验证结果（本轮实跑）

ports-claim 17/0、ports-capacity 20/0、ports-migrate 5/0、ports-verify 14/0、round13-ports-release 9/0、
loghub 19/0、token-contract-gate 38/0、token-boundary 12/0、adopt-token-reclaim 27/0、
round13-discipline-gaps 24/0、platform-audit-fixes 20/0、platform-capability-audit 67/0、
directory-structure-gate 16/0(hard)、layering-and-dependency-gate 10/0、all-platforms 34/0（T6-a 零运行时依赖 PASS）、
test-chain-completeness 10/0、probe-gate 33/0、task-registry（见批 4 日志）。

## 7 遗留 / 需协调

1. domain-structure-gate 的唯一硬 FAIL 是门禁自身的「非空转」自检：
   test/domain-structure-gate-test.js:519 要求「真实存在 ≥1 个 >400 行文件」。
   本轮把最后两个 >400 文件清零后 count=0 → 该断言失败。该门禁归 R3-J，
   修法应改用合成样本（同 DG-1 的反向自检），不应要求真实违规存在。本代理未越界改。
2. tasks.js 期间被另一进程在 04:19:54 重写（task-store.js 一度被删、回退为内联），
   本代理在 mtime 稳定后按 R3-C 归属重拆为 task-store.js；若另有代理仍在写该文件需让路。
