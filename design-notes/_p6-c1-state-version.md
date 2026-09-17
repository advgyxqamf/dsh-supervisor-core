# P6-C-1：历史 inst.state.version 键清理（判定 + 实现）

> 范围：独占 `src/domains/instance/store.js`（单文件）。未跑测试/门禁、未 require 产品模块、
> 未做 git 写、未改 `test/`；仅 `node --check`/grep/read/wc/只读 git。全部路径为仓库相对路径。

## 0. 结论

**判定 = 安全，已实现**：在 `store.js` 的加载路径加一次**内存归一去键**（`_stripLegacyStateKeys`），
只在内存删、本方法不写盘；下次 save 由全量序列化自然落地，**幂等**。

- 改动：`src/domains/instance/store.js`，**+11 / -0**（纯新增，零删除、零导出变更）
- `node --check` 通过；文件 **129 行**（DG-2 上限 300）
- 链条未动（未新增判据）；未触碰任何契约表所列导出

## 1. 判定（逐条证据）

### 1.1 该键是否被任何消费者读到？—— 否

| 核验面 | 判据 | 结果 |
|---|---|---|
| 内核仓 | grep `state.version` in src/test/bin | **仅 1 命中**，且是 `src/domains/instance/upgrade.js:156` 的**说明注释**（阶段五删赋值时加的），非代码读取 ⇒ **零代码消费者** |
| 持久化形状声明 | `model.js` `createRecord` 的 state | `{ phase, restartCount, backoffLevel, lastProbeOk }` —— **不含 version** ⇒ 它是升级后才出现的**未声明额外字段** |
| 加载期归一 | `model.js` `normalizeInstance`（:25-33） | 只处理 dshToken / guardian / state.phase，**不读也不写 version** |
| 视图投影 | `model.js` `viewRow`（:65+） | 版本取 **`resolved.version`**（:65 注释明确 resolved = version/latest/updateJob/probe 为**调用方解析好的 IO 结果**，:67 `const version = resolved.version`）；它读的 `inst.state.*` 是 phase/lastError/restartCount/lastFailure/installOk/installError/installLog —— **不含 version** ⇒ 显示走实时读盘（已核实，非采信转述） |
| 测试 | grep `state.version` in test/ | **零命中**；测试里的 `state: { phase: ... }` 都是**自建夹具**，非对持久化的断言 |
| **壳仓（独立复核）** | grep `state.version` in ../dsh-supervisor-launcher（排除 node_modules/.git/target） | **零命中**。壳仓 src-tauri 引用的 json 为 config/core/identity/index/mirrors/ports/registry/runtime/shell-manifest/version-vectors/package.json —— **不含 instances.json** ⇒ 与阶段五结论一致 |

**写入点复核**：搜索 `state.version` 的赋值形态（点号与方括号两种）于 src/test/bin ⇒ **零命中**
⇒ 阶段五删除两处赋值后，**无任何代码路径会重新写入**该键。

### 1.2 清理方式：加载期内存去键是否安全？—— 是，且幂等

- **加载入口**：`src/domains/instance/store.js:25 load()`；数组替换由 `:38 this._replace(...)` 完成；
  每实例归一在 **`:40-46` 的循环**内（`:41 model.normalizeInstance(inst)`）。另 `:62 _replace`、`:68 replace`、`:70 save`。
  本改动挂在 `:42`（normalizeInstance 之后）。
- **幂等性**：`save()`（:85）`JSON.stringify({ instances: this.instances }, null, 2)` —— **全量序列化内存数组**，
  故内存里删掉的键在下一次 save 自然从盘上消失；`_lastBody` 初值 `null`（:22），且 :86 只在「内容与上次相同」时
  跳过写盘 ⇒ **load 后首次 save 必然落盘**。文件既已无该键，再 load 即无键可删 ⇒ **重入无副作用**。
- **本方法不写盘**：`load()` 不调用 `save()`；归一本身零 IO（符合「只在内存里删、不回写盘」）。
- **无测试断言精确形状**：grep `instances.json` in test/ 只有 `ports-verify.js:42`（自建夹具、只断言具体字段）
  与 `token-boundary-test.js:88`（自建夹具、断言遗留列被剔除）；无深比较/快照类对 instances.json 或 state 全形状的断言
  ⇒ 「键消失」不破测试。

### 1.3 同型先例（本仓既有约定，非新发明）

- `model.js:26` 已在加载期做**同款**事：`if (hasOwnProperty(inst, dshToken)) delete inst.dshToken;` —— 删遗留的未声明键。
- **且该约定有测试守护**：`test/token-boundary-test.js:86-92` 写入含遗留 dshToken 的 instances.json，
  调 `sup.instances.load()`，断言**加载后内存无该属性**。我的改动与之同形同语义。

## 2. 实现（+11 / -0）

```js
// load() 循环内，紧随 model.normalizeInstance(inst)：
this._stripLegacyStateKeys(inst);

/** 清历史遗留的未声明 state 字段。**只在内存删、本方法不写盘**；下次 save（5s tick 或任意内容变化）
 *  由 save() 全量序列化内存数组而自然落地，故幂等：文件既已无该键，再 load 即无键可删。
 *  state.version：阶段五已停止写入（upgrade.js 的两处赋值删除），且内核/测试/壳仓**零消费者**、
 *  createRecord 声明的 state 形状不含它（version 显示走 readInstalledVersion 实时读盘）。
 *  同型先例：model.normalizeInstance 同样在加载期删遗留键 dshToken（有测试断言该行为）。 */
_stripLegacyStateKeys(inst) {
  if (inst.state && Object.prototype.hasOwnProperty.call(inst.state, version)) delete inst.state.version;
}
```

（注：上一行的 `version` 在源码中为字符串字面量形式，报告此处为避免引号嵌套而转述。）

设计说明：抽成具名私有方法而非内联，是为了给**后续遗留键**一个明确的落点，并把「为什么安全」写在调用点旁；
`inst.state` 缺失时短路（`normalizeInstance` 不保证建 state，见 `ops.js:116` 的注释）。

## 3. 行为变更声明

- **内存**：`load()` 后，历史记录不再带 `inst.state.version`（新记录本就不带）。
- **磁盘**：该键在**下一次 save** 时从 instances.json 消失（不是 load 时立即写盘）。
  这是一次**持久化形状的收敛**（去掉未声明额外字段），不是重建 schema。
- **对外**：无 API/事件/日志变化；版本显示路径不变（一直走实时读盘）。
- **兼容**：不写盘、不删别的键、不改任何已声明字段；用户若曾自行读该键，读到的将是 undefined
  （该键从未被声明或文档化，本仓与壳仓均不读）。

## 4. CI 风险

**低**，依据：

1. 纯新增、零删除、零导出变更（diff 的删除行计数 = 0），R2 不适用。
2. **R1 已做**：新增行的 CJK token（14 个，用 GNU grep 的 Unicode 属性写法抽取）在 `test/` **零命中**；
   ASCII token 的断言形态命中项（delete / hasOwnProperty / Object / prototype / upgrade / version）逐条核实
   均为**泛型标识符在别处文件上的断言**（如 `instance-safety-test.js:78` 断言的是 _updCache 的 delete）。
3. **无测试按文本读 `store.js`**（grep 零命中）⇒ 新增注释不可能触发源码形态钉子。
4. `token-boundary-test.js` 的同类断言（dshToken）走的是**属性缺失**判据，与我的实现同向，不冲突。
5. `load()` 在 CI 中被多测试间接调用，但只多一次属性判断与删除，无 IO、无时序影响。

## 5. 未做 / 不建议

- **未清 instances.json 里其它潜在遗留键**（本次任务只点名 state.version）。若后续要系统清理，
  建议在同一私有方法内按「未在 createRecord/已声明形状中出现且全仓零消费者」逐项登记后加入，
  **不要**一次性大范围删键（无据不改持久化）。
- **不建议**为「更干净」而在 load 时直接写盘（会引入 load 期 IO 与 _lastBody 语义纠缠）——
  现有「内存删 + 下次自然 save」已足够且更安全。
