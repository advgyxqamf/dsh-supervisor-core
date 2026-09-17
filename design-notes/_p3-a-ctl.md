# _p3-a-ctl —— P3-A-1：ctl 切面工厂化（createCtl）

> 分片：A-1，独占 `src/app/ctl/**`。未注册（`assembly/**` 归负责人）、未改 `test/`、
> 未跑任何测试/门禁、未做 git 写。只做 `node --check`、require 加载冒烟、grep/read/wc。

## 1. 改动清单（逐行理由）

| 文件 | 动作 | 理由 |
|---|---|---|
| `src/app/ctl/client.js` | 改（25 → 46 行） | 实现抽为具名纯函数 `ctlCall/routerCtlPort/lanCtlPort` + `createCtlClient(deps)`；导出保留 `methods`（facets.js 的安装面不动）。端口/调用不再走跨文件 `this.X()`。 |
| `src/app/ctl/facades.js` | 改（30 → 53 行） | Proxy 构造抽为 `createCtlFacade({port, ctlCall})` / `createRouterCtlFacade({getRouterPort, ctlCall})`；`BANNED` 提为模块常量；导出保留 `methods`。不再用 `self._ctlCall` / `this._makeCtlFacade` / `this.ctl.routerPort()`。 |
| `src/app/ctl/collaborator.js` | 新增（45 行） | 导出 `createCtl(deps)`，公开键与 `THIN_SPEC.ctl` 逐字一致。组合上两者，持有实现；deps 全为惰性 getter。 |

未删任何导出/函数（只新增 `createCtlClient`/`createCtlFacade`/`createRouterCtlFacade`/`createCtl`，
`methods` 及四个 `_ctl*` 方法名全部保留）。

## 2. 公开键逐字对照表（THIN_SPEC.ctl ↔ createCtl）

| THIN_SPEC.ctl 公开键 | host 既有方法（facets 安装，保留） | createCtl 键（逐字） |
|---|---|---|
| `call` | `_ctlCall` | `call` |
| `lanCall` | `_lanCtlCall` | `lanCall` |
| `lanPort` | `_lanCtlPort` | `lanPort` |
| `routerPort` | `_routerCtlPort` | `routerPort` |
| `routerFacade` | `_makeRouterFacade` | `routerFacade` |

另有 host 私有方法 `_makeCtlFacade` 保留（未被 THIN_SPEC 收录，但随 `methods` 安装；`assertCollaboratorTargets` 不检查它，保留以不缩 host 成员集）。

## 3. deps 清单（一律惰性 getter）

`createCtl(deps)`：

| dep | 必填 | 用途 |
|---|---|---|
| `getConfig` | 是 | 派生 `routerCtlPort`/`lanCtlPort`（缺省 43107/43108） |
| `getCtlCall` | 否 | 宿主兼容：公开键实时取用 `host._ctlCall`（**须 `.bind(host)`**，见下） |
| `getLanCtlCall` | 否 | 同上，`host._lanCtlCall`（**保 token-boundary 测试的覆写面**） |
| `getLanCtlPort` | 否 | 同上，`host._lanCtlPort` |
| `getRouterCtlPort` | 否 | 同上，`host._routerCtlPort` |
| `getRouterFacade` | 否 | 同上，`host._makeRouterFacade` |

⚠ **getter 必须返回绑定到 host 的函数**（`.bind(host)`）：host 侧的 `_routerCtlPort`/`_lanCtlPort`/
`_lanCtlCall`/`_makeRouterFacade` 都读 `this.config`，而 `createCtl` 内以 `fn(...args)` 裸调用，
不绑定会丢 `this`（实测：`TypeError: Cannot read properties of undefined (reading 'config')`）。
原 `installThin` 用 `host[src](...args)` 天然绑定；工厂化后此绑定责任上移到注册点。

可选 getter 缺省时用工厂自持实现（可只 `require` + 假 deps 直接断言，DF-6）；提供时
`host.ctl.*` 与 `host._*` 走同一调用路径（行为严格等于原 `installThin` 转发器）。

`createCtlClient(deps)`：`getConfig`（必填）。
`createCtlFacade(deps)`：`port`、`ctlCall`。`createRouterCtlFacade(deps)`：`getRouterPort`、`ctlCall`。

## 4. 内部去 this（DF-4）

- `ctl/client.js`：`_lanCtlCall` 原 `this._ctlCall(this._lanCtlPort(), ...)` → `ctlCall(lanCtlPort(this.config), ...)`（具名纯函数）。
- `ctl/facades.js`：`_makeRouterFacade` 原 `this._makeCtlFacade(this.ctl.routerPort())` → `createCtlClient({getConfig:()=>this.config})` + `createRouterCtlFacade`；`_makeCtlFacade` 原 `self._ctlCall` → 工厂 `client.ctlCall`。
- `ctl/collaborator.js`：0 处 `this`。跨文件依赖全部经 `deps` 显式注入。
- 仅剩 `this.config`（宿主字段读取，非方法调用）在 `methods` 兼容壳内，属宿主绑定，非跨文件 this 协作。

## 5. app this 棘轮（AT-1）影响

`test/app-this-ratchet-gate-test.js` 基线 `ctl: 3`，判据 `stripped this.X( ≤ 基线`。
实测（`grep -oP 'this\.([A-Za-z_$][\w$]*)[ \t]*\('`，注释内不含该形态）：

| 文件 | 改前 this.X( | 改后 this.X( |
|---|---|---|
| `ctl/client.js` | 2 | 0 |
| `ctl/facades.js` | 1 | 0 |
| `ctl/collaborator.js` | —（新增） | 0 |
| **ctl 合计** | **3** | **0** |

**建议基线下调：`ctl: 3 → 0`**（只降不升，符合门禁头注更新纪律；由主控/P3-B 决定并注明提交信息）。

## 6. 验证

- `node --check src/app/ctl/client.js && node --check src/app/ctl/facades.js && node --check src/app/ctl/collaborator.js` → `ALL_CHECK_OK`。
- require 加载冒烟（假 deps，不触真实 hub/daemon）：
  - `createCtl` 公开键集合 = `{call,lanCall,lanPort,routerPort,routerFacade}`；
  - 端口解析 `5555/6666` 与缺省 `43107/43108` 正确；`getConfig` 惰性（后置改值实时生效）；
  - 提供 `getLanCtlCall` 时 `lanCall` 经宿主 getter（覆写面可用）；
  - `methods._routerCtlPort/_lanCtlPort` 读 `this.config`，缺省正确；
  - Proxy：`BANNED`（then/constructor/…）与 symbol 返回 undefined、`has()=true`、同属性函数缓存、调用经 port 路由；`_makeRouterFacade`/`_makeCtlFacade` 返回 Proxy。
  - 结果：`SMOKE_OK`。
- 集成冒烟（最小宿主 + `installCollaborators` + `client.methods`/`facades.methods`，不启动任何 daemon）：
  - 未注册时 `host.ctl` 仍为 `installThin` 转发器，`host.ctl` 键集 = 公开面 5 键；覆写 `host._lanCtlCall` 后 `host.ctl.lanCall('list')` 走覆写（**证明现状零变更、token-boundary 仍绿**）；
  - 方案 A 注册（`getter` 均 `.bind(host)`）后：`lanCall` 仍走 `host._lanCtlCall`、`routerPort/lanPort/routerFacade` 正确；
  - 反向：未绑定的 getter 会抛 `reading 'config'`，证明注册必须绑定。
  - 结果：`INTEGRATION_SMOKE_OK`。

## 7. R1 / R2 证据

**R1（注释）**：改动/删除的注释行切成 token 后逐条在 `test/` grep：
- `控制通道调用与端口解析` → 0；`module.exports = { methods }` → 0；`反射禁区`/`原型污染`/`Function 元操作`/`宿主字段读取`/`工厂自持`/`宿主 getter`/`覆写面` → 0。
- `导出形态` → 8 命中、`内部使用` → 1、`thenable` → 1，但**逐行核对全部是其它测试自身的注释/代码/check 名称**（针对 `domain-actions/main.js`、`settings/versions.js`、`control/entry.js` 等），**无一读取 `ctl/client.js` 或 `ctl/facades.js` 的源码文本**。
- 决定性命据：`grep -rn 'ctl/client|ctl/facades' test/` = **0**。没有任何测试把断言钉在本切面源码文本上，故无注释钉子，R1 通过。

**R2（死代码）**：未删任何导出/函数。全仓 `src test bin release ui *.md .github app` 核验
`_ctlCall/_routerCtlPort/_lanCtlPort/_lanCtlCall/_makeRouterFacade/_makeCtlFacade` 消费者：
- `_ctlCall`：`src/app/daemons/{runtime,supervise,probe}.js`（经 `this.ctl.call` 或 `_ctlCall` 注释）、`test/round13-robustness-batch-test.js`（源码形态断言读的是 `daemons/supervise.js`，非本文件，未动）。
- `_lanCtlCall`：`test/token-boundary-test.js:81`（覆写）——**保留（见 §8）**。
- `_routerCtlPort/_lanCtlPort`：`test/daemon-path-test.js:46-47`（手工 ctx）——保留。
- `_makeRouterFacade`：`src/app/facade/router.js:85` 经 `this.ctl.routerFacade()`（走 THIN_SPEC/工厂公开键，行为不变）。
- `_makeCtlFacade`：仅本文件 `_makeRouterFacade` 使用；无 test/bin 消费者 → **保留不删**（宁可保留）。
- 新导出 `createCtl/createCtlClient/createCtlFacade/createRouterCtlFacade` 暂无外部消费者，供负责人注册使用。

## 8. 精确注册片段（交负责人）

`assembly/collaborators.js`：新增 `installCtl(host)`，并在 `installCollaborators` 中
`installControl` 之后、`installThin` 之前调用；`installThin` 的循环名集排除 `'ctl'`。

**方案 A（推荐 · 零测试改动 · 行为逐字等价）**：

```js
const { createCtl } = require('../ctl/collaborator');

function installCtl(host) {
  host.ctl = createCtl({
    getConfig: () => host.config,
    // 宿主兼容：host.ctl.* 与 host._* 同一路径（含 test/token-boundary-test.js 对
    // host._lanCtlCall 的覆写面）。省略这 5 个 getter 即纯工厂实现（需同步该测试，见方案 B）。
    // ⚠ 必须 .bind(host)：这些 host 方法读 this.config，createCtl 内为裸调用。
    getCtlCall: () => host._ctlCall.bind(host),
    getLanCtlCall: () => host._lanCtlCall.bind(host),
    getLanCtlPort: () => host._lanCtlPort.bind(host),
    getRouterCtlPort: () => host._routerCtlPort.bind(host),
    getRouterFacade: () => host._makeRouterFacade.bind(host),
  });
}
```

随后可把 `THIN_SPEC` 里的 `ctl` 条目删除（或改 `installThin` 的 `THIN_NAMES` 过滤 `'ctl'`），
并同步 `assertCollaboratorTargets`（它遍历 `THIN_SPEC`；删 `ctl` 后不再校验 ctl 目标，无影响）。

**方案 B（纯工厂终点形态）**：`host.ctl = createCtl({ getConfig: () => host.config });`
需把 `test/token-boundary-test.js:81` 的 `sup._lanCtlCall = ...` 改为覆写 `sup.ctl.lanCall`
（该测试在 `scripts.test` 链中；`test/` 归 P3-B/主控，我未改）。

## 9. CI 风险点

1. **【最高】token-boundary-test 的覆写面**：`test/token-boundary-test.js:81` 覆写 `sup._lanCtlCall`，
   其后 `sup.listLan()` 经 `facade/lan.js:41 this.ctl.lanCall('list')`。若注册用**方案 B**，
   工厂直连 hub 将绕过覆写 → 该测试红（断言 `r.items.length === 1` 会得到空数组）。
   **缓解**：方案 A 的 `getLanCtlCall` 使公开键实时取用 `host._lanCtlCall`，CI 保持绿。
2. **棘轮**：ctl 由 3 降到 0，只会使 AT-1 更宽松；但门禁头注要求「下调需注明」，
   若不下调基线也不红（0 ≤ 3）。
3. **测试树并发写入**：`test/app-this-ratchet-gate-test.js`、`test/comment-pin-gate-test.js`
   当前为未跟踪的新文件且可能仍在被 P3-B 写入；本报告数值基于我读取时的版本（`ctl: 3`），
   若基线被 P3-B 改写，请以门禁最终值为准。
4. **require 边**：`facades.js → client.js` 为 app 内同层边，不新增跨层边（`layering-and-dependency-gate-test`
   只记跨层）；`client.js → platform/service/log/hub` 为既有 `app -> platform` 边，未变。
5. `facets.js` 行数 107、ctl 三文件 ≤53 行，均满足 DG-2（≤300）。

## 10. 未做 / 交回

- 未改 `assembly/**`（注册由负责人执行，见 §8）。
- 未改 `test/**`、未跑测试门禁、未 git 写。
- 未新增 `test/app-ctor-injection-test.js` 对 ctl 的覆盖（test/ 非本分片）；若要闭合 DF-6
  判据，建议 P3-B 补 `createCtl({getConfig})` 的假 deps 直测（本工厂已支持）。
