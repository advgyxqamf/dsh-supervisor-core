# P6-B B-5/B-6 报告：剩余宿主绑定切面收口 + 可达面澄清

> 承接 `_p6-b1-inplace-dethis.md` / `_p6-b2-main-inplace.md`。未跑测试/门禁；只 node --check / grep / read / 只读 git。
> 全部仓库相对路径。

## 0. 结论

- **宿主绑定切面（facets）已全部去 this**：facade（5）、daemons 切面（identity/runtime/probe/supervise）、
  main（7 文件）、control/scheduler、control/instance-adapter、settings/versions、settings/lan-panel。
- **重要澄清**：AT 棘轮剩余计数**全部**来自**类自身实例方法**与注释，不再是宿主绑定债：

| 文件 | 计数 | 性质 |
|---|---|---|
| `control/entry.js` | 22 | `class ManagedLifecycle` 自身方法（this=实例） |
| `control/registry.js` | 25 | `class ManagedRegistry` 自身方法 |
| `control/manager.js` | 4 | `class LifecycleManager` 自身方法 |
| `daemons/process.js` | 29 | `class DaemonLifecycle` 自身方法 |
| `native/installer.js` | 3 | `class NativeManager` 自身方法 |
| `self/lifecycle.js` | 1 | `class Lifecycle` 自身方法 |
| `settings/autostart.js` | 1 | `class HostService` 自身方法 |
| `assembly/facets.js` | 1 | 头注里的 this.X() 字样（注释，剥注释后为 0） |

- AT 实测：`raw 86 / 剥注释 84`（本轮由 96/94 降）。基线保持上界不改（剩余为类内部调用，下调会让「新增类方法」误红）。

## 1. 本批改动

| 文件 | 改法 |
|---|---|
| `src/app/facade/lan.js` | `this.daemons/ctl/lan` → 惰性 deps；DG-14 与 token-boundary 的 `host._lanCtlCall` 覆写面不变 |
| `src/app/daemons/probe.js` | `this.ctl/config` → deps |
| `src/app/daemons/supervise.js` | `this.*`（11 个对象成员）→ deps |
| `src/app/control/scheduler.js` | `this.*` → deps（含 `_lastOrphanAuditAt` 读/写） |
| `src/app/control/instance-adapter.js` | `this.*` → deps（含兄弟方法 `_syncSandboxRegistryEntry` 转发） |
| `src/app/settings/versions.js` | `this.*` → deps；`_readBinarySelfVersion`/`_vcsRoot` 纯函数体保留 |
| `src/app/settings/lan-panel.js` | `this.*` → deps |

## 2. 同批修正的源码形态钉子

1. `round8-fixes-test.js` 的 `/if \(dep\.updatable\) diskVersion = this\._readBinarySelfVersion\(\);/`
   → `[\w.$]*readBinarySelfVersion\(\)`（形态无关）。
2. `guard-domain-model-gate-test.js` 的 GD-2 分支切分器 `lanBranchOf/routerBranchOf` 原硬编码
   `this\.(?:daemons\.enabled|lanDaemonEnabled)\(\)`，supervise.js 去 this 后 lan 闸变
   `d.daemons().enabled()` ⇒ 改为 `(?:\.enabled\(\)|lanDaemonEnabled\(\))`（两形态都命中，判据本意不变）。

## 3. 未做（并说明为什么它**不应该**按「宿主债」做）

- `control/entry.js` / `control/registry.js` / `control/manager.js` / `daemons/process.js` /
  `native/installer.js` / `self/lifecycle.js` / `settings/autostart.js` 的 `this.X(` 是**类方法互相调用**，
  不是跨文件宿主耦合。对它们套用 depsOf(host) 会**改变 OOP 语义**（类实例不是 host），是错误的。
- `app/assembly/facets.js` 的唯一命中在头注；剥注释后为 0。
- `_workflow.js` 的 `#` 剥离：YAML 域，不共用 JS 词法（见 `_p6-a-strip-lexer.md` §5）。

## 4. CI 风险

**低**。改动是机械等价替换；两处形态钉子同批处理且保留反向自检含义；
DG-14 / token-boundary / four-platform 的 `desc.methods.guardCorePkg` 契约均核对未破。最终由 CI 四平台裁决。
