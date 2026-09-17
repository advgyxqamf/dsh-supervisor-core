# P3-C 报告：src/api 收口（N11 加码 + 两项 P1 + identity 头注）

> 工作流 P3-C，独占 `src/api/**`。全程未跑任何测试/门禁（仅 `node --check` / `grep` / `read` / 只读 git），
> 未做任何 git 写，未改 `test/`，未加依赖。工作区改动待主控提交。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 【P1】非回环鉴权 fail-closed | **已修** `src/api/transport/server.js`（可观测行为变更·安全方向） |
| 【P1】`/lan/frp/expose` 恒回 200 | **已修** `src/api/domains/relay.js`（改按 ok 映射 400） |
| N11 加码（安装根包含性） | **未按字面实现**：add 时拿不到该实例安装根（证据见 §1.1）；改为落地可静态判定的加码 + 修真实误伤 |
| `src/api/identity.js` | **保留 shim**（两条硬阻断）；仅更正过时头注 |

改动 4 文件：`instances.js`、`relay.js`、`transport/server.js`、`identity.js`。`node --check` 全过。

## 1. N11 加码

### 1.1 为什么「位于沙箱安装根之下」不能按字面落地（grep 证据）

```
domains/instance/sandbox.js:16   installDir(rootDir, inst) = path.join(root(rootDir,inst), 'install')
domains/instance/sandbox.js:12   root(rootDir, inst)       = path.join(rootDir, inst.id)
domains/instance/ops.js:34       const id = 'inst-' + Date.now() + '-' + <rand>   ← id 在此才生成
api/domains/instances.js:180     commandShapeError(...)                            ← 闸在 add 之前
```
⇒ **add 时不存在 inst.id，因而不存在该实例的安装根**。`sup.instances.instancesRoot` 虽可达，
但要求用户预知未来 id，且会拒掉 UI 当前合法形态 `['node','/usr/local/bin/dsh','web']`
（`ui/src/features/supervisor/InstancesPage.tsx:234` 的三行占位符）。
按主控 fallback「不能干净取得就保留现状 + 诚实登记」，**未写假的包含性检查**。

### 1.2 实际落地（可静态判定 + 修真实误伤）

形态 A（`command[0]` ∈ node/node.exe）现在三重校验：
1. `command[1]` 必须存在且是**绝对路径**（POSIX `/`、盘符 `X:\`、UNC）—— 相对入口会按沙箱
   `workingDir`（data 目录，沙箱内可写）解析，构成「沙箱写文件 → 守卫重启执行」的二级面（审查 B2）；
2. 且必须是 DSH 入口之一：官方包内入口 `<前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js`
   （`baseOf==='bin.js'` 且规范化路径含该包段）、`dsh` 族 basename、或配置的 `dshBin`；
3. `dshBin` 为 `node/node.exe` 时不再作为逃逸（堵 `['node','node']`，审查 B3）。

**为什么要放行 `bin.js`**：内核自己的 `platform/os/exec-path.js:134-135` `dshJsIn(prefix)` 产出
`<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`，`resolveDsh()` 亦返回该形态；加码前闸的
白名单比内核自己的入口解析**更窄**，会把内核规范入口判 400（对抗审查 M1【高】、M2）。
形态 B 另补 Windows 垫片 `dsh.cmd/.ps1`（审查 M3）。

### 1.3 残留（如实登记，未修）

- `['node','/tmp/evil/dsh.js']` 与形态 B `['/tmp/evil/dsh']` **仍放行**——把脚本命名为
  `dsh*.js` / `dsh` 即可。本闸本质仍是 basename/路径形态判定，不是 realpath 收口。
- `['node','/tmp/node_modules/@deepseek-ai/dsh/lib/bin.js']` 可伪造成包内入口（需匹配包段名）。
- **结构解**：见 §8「结构解设计（不实现）」——含精确挂点、realpath 判据、与既有 `command`
  覆盖契约的冲突证据与替代方案。**属 domains/instance 范围，主控已裁定本批不实施**。
- 审查 B6：闸只在写时校验，启动时直接消费持久化 `inst.command`。已核实**不是旁路**
  （`/instances/update` 不认 command；`createRecord` 只有 `ops.js:44` 一个调用点），仅登记。

## 2. 【P1】非回环鉴权 fail-closed

`src/api/transport/server.js`：

```js
// 旧：accessKey && !identity.loopback && ...        ← accessKey 为 null 时整层跳过
// 新：!identity.loopback && method!=='OPTIONS' && (!accessKey || !requestHasAccessKey(req, accessKey))
```
**可观测行为变更（安全方向修正）**：`apiHost='0.0.0.0'` 且未配置 `apiAccessKey` 时，
非回环请求由「零认证放行」改为 **401**；未配置 key 的错误文案改为
「非回环请求一律拒绝。请先设置访问密钥，或将 apiHost 收回 127.0.0.1」。
回环豁免与 OPTIONS 预检语义不变；已配置 key 的行为完全不变。

### ⚠ 必须先改 test/ 才能提交（否则必红）

`test/api-contract-test.js:51` 的主 `sup` 配置**没有 apiAccessKey**，:98 却 `listen 0.0.0.0`，
:133 用 `LAN_IP` 发**真实非回环**请求：
```js
instR = LAN_IP ? await req('GET','/instances',null,LAN_IP+':'+API_PORT,null,'lan') : { body:{} };
const instLan = instR.body && instR.body.native;
check('F1 LAN（真实非回环 socket）/instances 不下发 token', !LAN_IP || (!!instLan && instLan.authUrl.indexOf('token=') < 0 && instLan.tokenPresent === false), ...);
```
旧行为下该请求 200、断言通过；fail-closed 后返回 401 → `instLan` 为 undefined → **该 check 必红**。
`LAN_IP`（:72-79，取首个非 internal IPv4）在 CI 必为真：同文件 F2 的「LAN 无 key → 401」一直是绿的，
那只有 LAN_IP 真、socket 真非回环才可能。
**建议改法**（在 `test/`，超出 P3-C 授权，未动）：
`check('F1 LAN 未配置密钥 → 401（fail-closed）', !LAN_IP || instR.code === 401, ...)`
—— F1 的「token 不出本机」属性改由 401 保证，而非靠 200 体里没有 token。

## 3. 【P1】`/lan/frp/expose` 状态码

`src/api/domains/relay.js:26`：`send(200, r)` → `send(r && r.ok !== false ? 200 : 400, r)`，
与同文件 :21（settings/install/toggle）同规。空令牌被 FIX-1 暴露闸拒时不再回 200（否则 UI 显示「已开启」）。
已核 `test/` 无 `expose`/`lan/frp` 状态码钉子。

## 4. `src/api/identity.js`：保留 shim，仅更正头注

**不删**，两条独立硬阻断：
1. **R2**：`test/relay-source-gate-test.js:87` 与 `test/lan-access-boundary-test.js:39` **按路径 require** 本文件
   → 删除即 `MODULE_NOT_FOUND`（`f410a3a` 同形态）。
2. **断言形态**：`test/lan-access-boundary-test.js:88-90` 硬匹配 `security.js` 里
   `const {…isPrivateIpv4…} = require('./identity')` → 改指 `shared/ip` 即失配。

**已改**（R1 先查：无测试钉住该头注文本）：
- 删除过时声明「消费者（api/index.js、…）」——实测 `src/api/index.js` **零引用**；
- 补真实消费者清单（生产：`security.js`/`transport/server.js`；测试：上述两文件）；
- 移除条件补第 3 条（E-g 的形态断言须先放宽）。

## 5. 对抗审查（下级只读，产物 `design-notes/_p3-c-review.md`）

已挡住：`node -e/--eval/-p/-r/--require/--import/--loader/-`、`['node']`、目录、尾斜杠、
`dsh.js/../evil.js`。仍可绕过：B1（basename 改名）、B2（相对入口 → data 目录，**本轮已堵**）、
B3（`dshBin='node'`，**本轮已堵**）。误伤：M1/M2（包内 `bin.js`，**本轮已修**）、M3（`.cmd`，**已补形态 B**）、
M4（单行写法本就被拒，UI 三行形态放行）、M5（合法放行正确）。审查确认：**默认命令确实不经本闸**
（闸仅在 add；缺省存 `command:[]`；启动时 `effectiveCommand` 生成）。

## 6. 纪律自证

- `node --check`：4 个改动文件全过。
- 未改 `test/`、未改 `package.json`、未改 `src/api/**` 之外任何文件；未做 git 写。
- R1：新增文案特征串（`fail-closed`、`整层跳过`、`需要访问密钥`、`伴随安装根`、`实际消费者` 等）
  已 grep `test/`；命中的仅有 check 名称/注释，无源码断言。identity 头注改前已单独 R1（`移除条件`/`shim` 命中均为无关测试）。
- X-2：本报告与全部改动无操作者绝对路径。
- 未跑任何测试/门禁，未启 daemon，未碰 `/tmp/dsh-*` 与状态根。

## 7. CI 风险点

1. **确定会红**：`test/api-contract-test.js:135`（§2）——须先由 test/ 所有者改断言。
2. 其余低：`instances.js` 的 `/instances/add` 在 `test/` 内**零命中**；`relay.js` expose 无钉子。
3. `instances.js` 现消费 `sup.instances.dshBin`（本就消费，非新增）；若未来改用 `instancesRoot` 会新增
   DG-10 软违例（DG-10 当前 report-only，`DG_STRICT` 未在 CI 设置），需同步补 `instance/contract.js#PUBLIC_API`。

## 8. 结构解设计（不实现，按主控要求）

### 8.1 精确挂点

`src/domains/instance/lifecycle.js:53`（`_systemdStart(inst)` 内）：
```js
const cmdArr = sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst);   // :53
if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
```
此时 `inst.id` 存在、`instancesRoot` 在作用域内 ⇒ `sandbox.installDir(instancesRoot, inst)` 可精确求出
**该实例的**安装根。这是**唯一**同时握有「实例身份」与「安装根」的消费点：
add 时 id 尚未生成（`ops.js:34` 晚于 `instances.js:180` 的闸），`effectiveCommand` 是纯函数、无根可依。
建议在 :53 之后、`unitProps` 之前插入 `_assertCommandAllowed(cmdArr, inst)`，并把 api 层白名单抽为
`shared`/`platform` 级纯函数二者共用，避免出现第二份实现。

### 8.2 realpath 包含性判据（草案）

```js
const root = fs.realpathSync.native(path.dirname(path.dirname(sandbox.installDir(instancesRoot, inst))));
//   installDir = <instancesRoot>/<id>/install  ⇒  dirname×2 = <instancesRoot>/<id>
const bin  = fs.realpathSync.native(cmdArr[1]);            // 解析软链，防安装根内软链指向 /tmp
const ok   = bin === root || bin.startsWith(root + path.sep);
```
形态 B（`cmdArr[0]` 自身即 DSH 入口）需对 `cmdArr[0]` 做同类判定，或只接受裸名（交给 PATH 解析）。
**必须 fail-closed**：`realpath` 抛 ENOENT 时一律拒绝 —— 否则「先提交、后创建文件」可绕过。

### 8.3 是否会破坏既有 `command` 覆盖契约 —— **会**（证据）

1. **UI 字段就是自由文本 argv，且示例指向沙箱安装根之外**——`ui/src/features/supervisor/InstancesPage.tsx`：
   - :231 标签「启动命令（每项一参数，可留空用默认）」；
   - :234 `placeholder={"node\n/usr/local/bin/dsh\nweb"}`；
   - :62 `fCmd.split(/\n/).map((x) => x.trim()).filter(Boolean)` → :64 `instanceAdd({ …, command })`。
2. **落库不做任何规范化**——`src/domains/instance/model.js:41`：
   `command: Array.isArray(payload.command) ? payload.command : []`。
3. **唯一消费者原样执行**——`sandbox.js:31-34` `effectiveCommand` 三分支：沙箱且空 → `sandboxCommand`；
   有 command → **原样返回**；否则 `defaultCommand`。
4. **规范文档里根本没有 instance `command` 的定义**——`DOMAIN-STRUCTURE-DESIGN.md` 与
   `EXECUTION-CONTRACT.md` 中 `command` 的全部命中都是 router 的 `providers/command.js#buildCommand`
   （**另一件事**；见 `EXECUTION-CONTRACT.md:74`/`:77`）。
   ⇒ 该字段**没有 SSOT 契约**，事实契约只存在于 UI + model + effectiveCommand。
   因此「安装根包含性」是**收紧事实契约**，与 :234 的示例直接冲突 ⇒ 属契约变更，需 UI 协调，
   不宜塞进安全小批（**主控已同意**）。

### 8.4 建议的契约替代方案（三选一，风险由低到高）

- **A（推荐，破坏最小）**：把包含性从「沙箱安装根」放宽为「**已知 DSH 安装位置集合**」：
  { 该实例 `installDir` } ∪ { `exec-path.resolveDsh()` 解析出的系统/包内入口 }，realpath 后比对。
  既保住 :234 的 `/usr/local/bin/dsh`（若那里确为 DSH），又拒掉 `/tmp/evil/dsh.js`；
  且**复用 `exec-path.resolveDsh()/dshJsIn()` 作单一事实源**（二者已在 `exec-path.js` 的
  `module.exports` 中），顺带消除我在 api 层硬编码的包路径形态（审查建议 ②/⑥）。
- **B（契约变更，最干净）**：公开 API 不再接受自由 `command`，只接受「附加参数」；入口一律由
  `exec-path.resolveDsh()` 决定。需 UI 把文本框改为「附加参数」，覆盖面 100%。
- **C（显式降级）**：保留自由 `command`，但要求独立操作者确认位（如 `allowUnsafeCommand: true`）
  并写事件账本留痕；安全性最弱、改动最小。

### 8.5 当前残留的实际风险边界（授权操作者信任域内）

- 该域**本就具备任意代码执行能力**：`/plugins/install` → `api/domains/plugins.js:53`
  `pluginManager.install(spec, { target })` → `platform/distribution/install.js:136` 跑 npm install，
  插件代码随后由 DSH 进程加载执行。与之相比，`command` 残留**不新增能力**，只是「换个入口跑代码」。
- 真正**跨信任边界**的方向是「低权限 → 高权限」：沙箱内可写文件被守卫执行（审查 B2：相对入口按
  沙箱可写的 data 目录解析）。**该方向本轮已堵**（形态 A 强制绝对路径）。
- 故 §1.3 残留（按 `dsh*.js` 改名、伪造包内路径）的**边际风险 = 同域内换执行入口**，
  属纵深防御问题而非权限边界问题：优先级低于 §8.4-A 的落地，**不应阻塞本批**。

## 9. 风险登记（含对抗审查未处理的高危项，不静默）

| 编号 | 项 | 现状 | 去向 |
|---|---|---|---|
| B1 | basename 改名绕过：`['node','/tmp/evil/dsh.js']`、形态 B `['/tmp/evil/dsh']` | **未修**（本轮已堵其相对入口变体：形态 A 强制绝对路径） | §8.4-A |
| NEW-1 | 我为修 M1 而放宽，引入**伪包内路径**：`['node','/tmp/node_modules/@deepseek-ai/dsh/lib/bin.js']` 可放行 | **未修**（已如实登记） | 与 B1 同批由 §8.4-A realpath + 已知位置集合收口 |
| SSOT-1 | api 层硬编码 DSH 包路径形态，未复用 `exec-path.resolveDsh()/dshJsIn()`（审查建议 ②/⑥） | **未修**（漂移风险：包名/布局变更时两处不一致） | §8.4-A 顺带消除 |
| B6 | 闸仅在写时校验；启动期直接消费持久化 `inst.command` | **已核实不是旁路**（`/instances/update` 不认 command；`createRecord` 唯一调用点 `ops.js:44`） | §8.1 挂点可顺带覆盖 |
| M1/M2 | 官方包内入口 `lib/bin.js` 被误拒（闸比内核解析器窄） | **已修** | — |
| M3 | Windows npm 垫片 `dsh.cmd` | 形态 B 已补 `dsh.cmd/.ps1` | — |
| B2 | 相对入口按沙箱可写 data 目录解析执行 | **已修** | — |
| B3 | `dshBin='node'` 时 `['node','node']` 逃逸 | **已修** | — |
| M4/M5 | 单行写法拒绝（UI 三行形态放行）；Windows/大小写/尾径判决正确 | 非缺陷，已记录 | — |
## 10. 新增 SSOT：`EXECUTION-CONTRACT.md` §8（instance `command` 契约）

### 10.1 落了什么

`EXECUTION-CONTRACT.md` **新增 §8**（**72 行插入 / 0 行删除**，其余内容一字未动）：

- **§8.1 字段形状**：字符串数组；非数组落 `[]`（`model.js:41`）；**缺失 ≡ 空数组 = 用默认命令**；
  前端按「每行一参数」切分（`InstancesPage.tsx` :62/:231/:234）。
- **§8.2 写入者**：`/instances/add` → `ops.js#addInstance` → `store.save()`；落盘
  `instances.json`（原子写 + `0o600` + 内容未变不写盘）；`/instances/update` **不接收**该字段。
- **§8.3 消费点**：`lifecycle.js:53` → `sandbox.js:31-34`（非空**原样返回**）→ `lifecycle.js:60`
  `service.startTransient` → `platform/os/service.js` 拼 `systemd-run`。
- **§8.4 守卫当前保证**：结构闸 + 入口白名单 + **绝对路径**要求（`api/domains/instances.js`）；
  写路径另受 `api/transport/server.js` 的 fail-closed 鉴权保护。
- **§8.5 已知未保证**：basename 改名绕过、伪包内路径 —— 属**纵深防御**；该域本有
  `/plugins/install` 代码执行面，故**不新增能力**，只是换执行入口。
- **§8.6 待决**：运行时执行边界是否复校（精确挂点 + 前置证据/缺口），指向本报告 §8。

只写**有代码证据**的条款；未保证项与待决项单列，不发明更强承诺。

### 10.2 门禁自检输出（对应主控三条约束）

**约束 1 —— U-3 词表（新增节内不得出现「唯一事实源/唯一规范/唯一权威/定版 SSOT」）**

```
whole file: 0
first 80 lines (U-3 scan window): 0
```

**约束 2 —— DR-1（节内每个 src/ 路径必须真实存在）**

```
=== DR-1 simulation on EXECUTION-CONTRACT.md ===
OK   src/api/domains/instances.js
OK   src/api/transport/server.js
OK   src/app/assembly/compose.js
OK   src/app/ctl/facades.js
OK   src/app/domain-actions
OK   src/domains/instance/lifecycle.js
OK   src/domains/instance/model.js
OK   src/domains/instance/ops.js
OK   src/domains/instance/sandbox.js
OK   src/domains/instance/store.js
OK   src/platform/os/service.js
OK   src/supervisor.js
=== end（零 MISS）===

whole-repo root .md DR-1（tracked，排除 HISTORICAL）：零 MISS
```

**约束 3 —— 只新增、不改已有内容**

```
git diff --numstat EXECUTION-CONTRACT.md   ->  72	0
git diff -U0 | grep -c '^-[^-]'            ->  0
```

**自检中发现并规避的一个额外陷阱**：DR-1 的 `SRC_REF` 正则会从 `ui/src/features/...` 中**截出**
`src/features/supervisor/InstancesPage.tsx`，并因该路径不存在而判违规 ——
即**在根级 .md 里写 `ui/src/...` 会直接让 docs-reference 转红**。
故 §8 一律把前端文件写作 `InstancesPage.tsx`（前端）+ 行号，**不出现 `ui/src` 子串**（已 grep 验证 = 0）。
（现存两处 `ui/src/...` 位于 DR-1 的 HISTORICAL 排除集：`CHANGELOG.md` 与 `ARCHITECTURE-PLAN-session-lifecycle.md`。）

### 10.3 §8.4-A 的前置条件：**部分具备，仍有缺口**

**已具备**

1. **契约已成文** —— A 从此有**可评估的基线**（此前只能对着隐式事实改）。
2. **挂点可用**：`src/domains/instance/lifecycle.js:53`，此时 `inst.id` 与
   `sandbox.installDir(instancesRoot, inst)` 均可得。
3. **「尚未安装」的 ENOENT 顾虑基本解除**（本轮新查得的关键证据）：
   `src/domains/instance/lifecycle.js:92-97` 在进入 `_systemdStart` **之前**就 `fs.existsSync(dshEntry)`，
   不存在则先安装并 `return { ok:true, installing:true }`（本次不启动）。⇒ 挂点处**默认命令**的安装根
   必然已存在，realpath 判定不会把「首次启动」误判为越界。

**仍缺（须产品/契约决策，我不单方定）**

1. 用户**显式** `command` 指向**尚不存在**路径时的语义 —— fail-closed 会拒「先提交、后由外部创建」的用法；
2. **非 sandbox 域**（native/main）不经过上述 `existsSync` 前置，须单独定义判据；
3. §8.1 记作「通用示例」的 `/usr/local/bin/dsh` 是否**必须继续支持** —— 直接决定 A 的
   「已知 DSH 安装位置集合」边界大小。

⇒ **一句话**：A 已从「无据可依」转为「可评估」，但落地前仍需上述三项决策；本轮按裁定**不实施**，
已在 `EXECUTION-CONTRACT.md` §8.6 登记为待决项并指向本报告 §8。


