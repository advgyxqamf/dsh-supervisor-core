# P3-A 分片细则（app 切面工厂化）

> 由 P3-A 负责人生成。**下级必读**，并读 `_workorder-phase3.md`（硬约束/R1/R2）与
> `_workorder-phase2.md` §7（形式钉子 v2）与其 §7.3b（grep CJK 陷阱）。

## 0. 侦察结论（主控实测，先读，避免重复劳动）

- `src/app/views/` 与 `src/app/ui/` **目录不存在**：它们只是 `assembly/collaborators.js` 的
  THIN_SPEC 命名空间键（views→facade/state 的 dshMainView/exposurePeers/statusSummary；ui→self/notify 的 notify）。
- 真正有目录的切面：`ctl`(2 文件/3 个 this 调用)、`daemons`(8/43)、`main`(7/141)、`audit`(1/0)；
  另有 `facade`(5/13)、`domain-actions`(3/0) 同为 `{ methods }` 切面。
- 机制：`assembly/facets.js` 把 **33 个模块**的 methods 装到同一个 host 实例；`assembly/collaborators.js`
  的 `installThin()` 把 6 个命名空间做成转发器 `obj[pub] = (...a) => host[src](...a)`。
- 参照模板：`src/app/state/collaborator.js`（`createStateStore(deps)`）与
  `src/app/control/collaborator.js`（`createControlPlane(deps)`）——**惰性 getter 注入**（装配期 host 未就绪，
  故传 `getConfig/getLogger/...` 而非值）。

## 1. 工厂化的**唯一正确形态**（本阶段的行为零变更保障）

1. 在本切面目录下新建 `collaborator.js`，导出 `create<Slice>(deps)`：内部组合本切面已有实现，
   **deps 一律用惰性 getter**，返回的对象键 = 该切面当前的公开面（与 THIN_SPEC 的 pub 名**逐字一致**）。
2. **必须保留 host 上的既有方法安装**（facets.js 的 `{ methods }` 不动）——其他切面仍经 `this.X()` 取用它们。
   本阶段只把 `host.<slice>` 从「转发器」变成「真工厂对象」。
3. 转换内部实现时，把跨文件 `this.X` 改为**经 deps 显式取用**；同文件内的纯局部函数保持 `this` 亦可，
   但优先提出为具名函数以消除隐式 this（DF-4/DF-6）。
4. **不注册**：`assembly/collaborators.js` 由 P3-A 负责人独占，你只在报告里给出**精确注册片段**。
5. 行为零变更：不改任何对外可观测面（状态码/返回/事件名/日志文案/路由/公开键名）。
6. 每步 `node --check`；不改 `test/`；不做 git 写。

## 2. 分片（文件互斥，不得越界）

| 分片 | 独占文件 | 任务 |
|---|---|---|
| A-1 | `src/app/ctl/**` | `createCtl(deps)` + client.js/facades.js 内部去 this |
| A-2 | `src/app/audit/**` | `createOrphanScan(deps)`；另**只读**产出 `daemons/**` 转换计划 |
| A-3 | `src/app/control/manager.js` | restart 分支可达性裁定；另**只读**产出 `main/**`+`facade/**` 转换计划 |
| 负责人 | `src/app/assembly/**` | 注册 + SPEC 别名删除 + 集成 + 复审 + 总报告 |

### A-3 的 manager.restart 特别警告（主控已核实）

`test/lifecycle-restart-failure-test.js` P-a..P-e **正在测试 ManagedLifecycle.restart() 的回退路径**
（stop→start，且必须尊重 {ok:false}）。ManagedLifecycle 定义在 `src/app/control/entry.js`。
所以：
- 若你判定 manager.restart 内联回退分支**不可达**（前提：所有 registration 都是带 restart 的 ManagedLifecycle），
  删除前必须给出**注册来源证据**（`app/control/adapters.js` 的 registerAll 是否恒包 ManagedLifecycle、
  `manager.register` 是否可能收普通对象、`test/` 是否有登记普通对象再调 `mgr.restart` 的用例）。
- **任一证据不足即判「存疑」→ 保留并登记**，宁可保留。删分支不得改变 `mgr.restart` 的返回形状。

## 3. 交付物

- 你的报告：`design-notes/_p3-a-<分片>.md`（改动清单+逐条理由、公开键**逐字对照表**、
  deps 清单、`node --check`、R1/R2 证据、CI 风险点）。
- **不得含操作者绝对路径**（X-2 扫全树 .md）。
- 完成后 `send_message` 给 P3-A 负责人 `session-6e3fcda7-ada8-4b56-9ffe-6eea87dd9fa1`，附自包含结论。
