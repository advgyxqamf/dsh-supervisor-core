# P6-C 报告：instance `command` 运行时执行边界复校 + 历史 `state.version` 键清理

> 对应作业单 `_workorder-phase6.md` §5/§6（提交 `7b78324`）。本报告由主控按工作树实测补写
> （原 P6-C 执行者未交付终稿）。未跑测试/门禁、未 require 产品模块；只 `node --check`/grep/read/wc/只读 git。
> 全部路径为仓库相对路径。

## 0. 结论

- §5：`inst.command` 的**运行时执行边界复校**已落地（`EXECUTION-CONTRACT.md` §8.6 由「待决」改为
  **已复校**）。api 写时闸与启动期复校**共用同一纯函数** `exec-path.commandEntryViolation()`（单一事实源）。
- §6：历史遗留 `inst.state.version` 键在 `store.js` 加载期做**内存归一去键**（不写盘、幂等）。
- 两处均有明确的行为变更声明与 CI 风险论证（见 §3/§4）。

## 1. §5 instance `command` 运行时执行边界

### 1.1 单一事实源（`src/platform/os/exec-path.js`）

新增（`+97` 行，**纯函数**，无新增 IO 依赖）：

| 导出 | 语义 |
|---|---|
| `commandEntryViolation(cmdArr, opts)` | **入口归属**判定；返回 null=通过 / 可读违规原因。判据见下。 |
| `knownDshEntries({dshBin, npmRoot, platform, env})` | 复用 `resolveDsh()`/`dshJsIn()` 产出**内核已知的 DSH 入口**候选绝对路径（可能有不存在者，调用方 realpath）。 |
| `dshJsIn(prefix)` / `resolveDsh(opts)` | 既有；作为包内入口的 SSOT。 |

`commandEntryViolation` 判据（**保守即拒绝**，代价不对称：误放行=执行任意代码，误拒绝=一次可读错误）：

1. 形态：`[node, <entry>, ...]` 取 entry=cmdArr[1]；否则 entry=cmdArr[0]。
2. **裸名**（不含分隔符，如 `dsh`）→ 放行（交 exec 的 PATH 解析；内核默认命令 `[node, 裸 dshBin]` 即此形态）。
   - 仅当调用方置 `requireAbsoluteEntry: true`（api 写时闸）时，node 打头的裸/相对 entry 一律拒绝。
3. **相对路径**（含分隔符但不绝对）→ 拒绝（会按 workingDir 解析；沙箱 workingDir 沙箱内可写）。
4. **绝对路径** → ① 调用方 `allowEntry` 策略放行 ② realpath 后精确等于 `files` 之一，或位于 `roots` 之下
   （root/file 两侧都过 realpath，防「安装根内软链指向 /tmp」）③ 否则拒绝。
5. **ENOENT / realpath 失败 → 拒绝（fail-closed）**：否则「先提交、后由外部创建」可绕过。

### 1.2 api 写时闸改为复用（`src/api/domains/instances.js`，`commandShapeError`）

- 结构校验（数组/长度/字符串/NUL 换行）保持原样；**白名单语义不削弱**：`requireAbsoluteEntry: true`（P4 形态 A 硬要求）、
  `allowEntry` 保留 basename（`DSH_ENTRY`）与 `isConfiguredDshBin`（严格相等且不认 node）与 `isDshPackageEntry`。
- `isDshPackageEntry` 不再硬编码子串 `/node_modules/@deepseek-ai/dsh/`，改为**先取规范尾形前缀再用
  execPath.dshJsIn(prefix) 重新拼出并归一比对**（消除「api 与内核解析器各写一份」的漂移；较原实现略严：
  非规范尾形不再放行）。
- `files: execPath.knownDshEntries({dshBin})` 追加「内核自己解析出的已知入口」，与启动期复校同规。

### 1.3 启动期复校（`src/domains/instance/lifecycle.js`）

在 `_systemdStart` 中、`sandbox.effectiveCommand(...)` 之后、`service.startTransient(...)` 之前插入：

`@js
const boundary = inst.domain === 'sandbox'
  ? execPath.commandEntryViolation(cmdArr, {
      roots: [sandbox.installDir(instancesRoot, inst)],
      files: execPath.knownDshEntries({ dshBin: deps.dshBin }),
    })
  : null;
if (boundary) { inst.state.lastError = msg; store.save();
  events.append('inst_start_refused', { id, name, error: msg }); logger.warn(...); return { ok:false, error: msg }; }
`@

- **适用范围仅 sandbox**（§8.6 定案）：native/main 的命令来自**操作者配置文件** `cfg.command`（如
  `['node', <mock 绝对路径>, port]`），不是 API 供给；对它做执行边界复校既不必要、也会误拒合法入口。
- 挂点安全依据：进入 `_systemdStart` 前已 `fs.existsSync(dshEntry)`（不存在则先安装并 return），故安装根**必然已存在**，
  realpath 不会把首次启动误判越界；启动期校验**不使用 child_process**（G9-a），realpath 即可。

### 1.4 契约文档（`EXECUTION-CONTRACT.md` §8.4/§8.5/§8.6）

- §8.4 增补（二）「启动期执行边界复校」，写明包含集合与 fail-closed 语义。
- §8.5 已知未保证项相应**收窄**并保留台账（DNS rebinding 等不在本覆盖内者仍明列，不得据此假设安全）。
- §8.6 三项由「待决」改「定案」：① 运行时边界=**已复校**；② 显式 `command` 指向尚不存在路径=**fail-closed 拒绝**；
  ③ 非 sandbox 域 native/main=**整体排除**。
- DR-1（引用路径须存在）与 U-3（不得出现「唯一事实源」等措辞）自检通过：新增引用均为真实仓库相对路径；
  文档未引入 U-3 禁词。

## 2. §6 历史 `state.version` 键清理（`src/domains/instance/store.js`, `+10`）

### 2.1 判定（逐条证据，详见子报告 `_p6-c1-state-version.md`）

- **零消费者**：内核仓 grep `state.version` 仅 1 命中且是说明注释；`createRecord` 的 state 形状不含 version；
  `viewRow` 的版本取 `resolved.version`（实时读盘）；`test/` 零命中；**壳仓独立复核零命中**。
- **无写入点**：阶段五删两处死赋值后，`src/test/bin` 无任何 `state.version` 赋值（点号与方括号形态都查过）。
- **清理方式安全且幂等**：挂在 `load()` 的归一循环内（`normalizeInstance` 之后），**只在内存删、本方法不写盘**；
  `save()` 全量序列化内存数组，故下一次 save 自然落地；文件已无键时再 load 无键可删。
- **同型先例**：`model.normalizeInstance` 同样在加载期删遗留键 `dshToken`，且 `token-boundary-test` 有断言守护。

### 2.2 实现

`@js
_stripLegacyStateKeys(inst) {
  if (inst.state && Object.prototype.hasOwnProperty.call(inst.state, 'version')) delete inst.state.version;
}
`@

抽成具名私有方法，为**后续遗留键**留落点；`inst.state` 缺失时短路。纯新增、零删除、零导出变更。

## 3. 行为变更声明（必须外显）

1. **启动拒绝**：sandbox 实例若 `command` 越界（相对/裸 entry（node 形态）、绝对 entry 既不在安装根下也不在内核已知入口、
   或不存在/不可解析），启动在 `startTransient` 前被拒：写 `inst.state.lastError`、发新事件 `inst_start_refused`、
   返回 `{ok:false}`，**不执行**。这是安全收口（原行为会执行）。
2. **api 400 文案来源变化**：错误判定改由共享纯函数产出（语义不削弱；包内入口尾形判定较原实现略严）。
3. **持久化形状收敛**：`inst.state.version` 在**下一次 save** 时从 instances.json 消失（不是 load 立即写盘）；
   对外 API/事件/日志无变化（版本显示一直走实时读盘）。

## 4. CI 风险

**中低**。依据：

- 共享纯函数带可注入 `realpath`，便于纯函数测试；`knownDshEntries` 复用既有 `resolveDsh`。
- 启动期复校仅新增「拒绝」分支，不改变放行路径；放行集合 = 安装根 + 内核已知入口 + 裸名（默认命令）。
- 已知形态钉子（子报告 `_p6-c2-pins.md` 预扫描）均未触碰：instances.js 的
  `Promise.resolve(sup.instances.addInstance(j))` 调用形态、路由字面量集合、sandbox.js 纯文件声明、
  exec-path 既有函数签名/返回。
- 唯一的自然风险是 **fail-closed 误拒合法入口**（尤其 Windows 垫片/软链）；已用「realpath 两侧 + 内核
  `resolveDsh` 入口并列」把合法面覆盖到解析器能产出的全部形态，且 CI 四平台（含 Windows）为最终裁决。
- 事实：`7b78324` 之后的轮次四平台全绿。

## 5. 未做 / 残余

- 历史 instances.json 不会在 load 时立即被改写（有意：避免 load 期 IO 与 `_lastBody` 语义纠缠）；
  下一次自然 save 生效。
- §8.5 未保证项（DNS rebinding 等）保持登记，本阶段不扩面。
- 未系统清理其它潜在遗留 state 键（无据不改持久化；`_stripLegacyStateKeys` 已留扩展落点）。
