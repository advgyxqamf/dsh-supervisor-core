# 对抗审查：`/instances/add` 的 commandShapeError（N11 入口闸）

> 只读审查，未运行任何测试/门禁，未改任何源码；仅新建本报告。
> 审查对象：`src/api/domains/instances.js` 的 `commandShapeError`（96-126）与调用点（180）。
> 报告内路径一律为通用占位，不含操作者绝对路径。

## 0. 闸的实际语义（逐行）

| 行 | 判据 |
|---|---|
| 97 | `undefined/null` → 放行（走默认） |
| 98 | 非数组 → 400 |
| 99 | `[]` → 放行（走默认） |
| 100 | 长度 > 64 → 400 |
| 101-106 | 每项必须是「非空字符串 / ≤4096 / 不含 NUL·CR·LF」 |
| 113 | `baseOf(p) = String(p).split(/[\\/]/).pop().toLowerCase()` |
| 114 | `isConfiguredDshBin(p)`：`typeof dshBin==='string' && dshBin!=='' && p===dshBin`（严格相等） |
| 108/110/112 | `NODE_HEAD={node,node.exe}`；`DSH_HEAD={dsh,dsh.exe,dsh.js,dsh-supervisor,dsh-supervisor.js}`；`DSH_ENTRY={dsh,dsh.js,dsh-supervisor,dsh-supervisor.js}` |
| 116-122 | 形态 A：`baseOf(command[0]) ∈ NODE_HEAD` → 要求 `command[1]` 的 basename ∈ DSH_ENTRY 或严格等于 dshBin，否则 400 |
| 124-125 | 形态 B：`baseOf(command[0]) ∈ DSH_HEAD` 或严格等于 dshBin → 放行；否则 400 |

**关键结构事实：白名单只比较 `basename`，不比较 realpath、前缀、存在性**（instance.js 注释亦自述「路径存在性不作为放行依据」，instances.js:89）。

---

## 1. 绕过（node 族 + 非 DSH 仍可执行任意代码）

### B1【高】白名单只比 basename → 任意可执行/脚本改个名就过

- 形态 A 头：`['/tmp/evil/node', 'dsh.js']` → `baseOf(command[0])='node'` ∈ NODE_HEAD、`baseOf(command[1])='dsh.js'` ∈ DSH_ENTRY → **放行** → systemd-run 执行 `/tmp/evil/node`（attacker 二进制），**不需要任何 DSH 文件**。证据：instances.js:116、117、113。
- 形态 A 脚本：`['node', '/tmp/evil/dsh.js']` → basename `dsh.js` ∈ DSH_ENTRY → **放行** → 任意 JS 执行。这正是注释 instances.js:93 声称要挡住的形态（`["node","/tmp/evil.js"]`），但改名成 `dsh.js` 即绕过。
- 形态 B：`['/tmp/evil/dsh', 'x']`、`['/tmp/evil/dsh-supervisor']`、`['/tmp/evil/dsh.js']` 全部放行（instances.js:124）→ 任意二进制/脚本。
- 结论：闸把攻击面从「任意路径」降到「路径末段名为 node/node.exe/dsh/dsh.js/dsh-supervisor* 的任意路径」，**并未实现注释所称的「任意脚本不由本端点承担」**。要真正收口需 realpath/前缀校验（见 §5）。

### B2【中】形态 A 的相对入口按 cwd 解析到**可写目录**

- `['node', 'dsh.js']`、`['node', 'dsh']`、`['node', './dsh.js']`、`['node', 'some-dir/../dsh.js']` 全部通过 basename 检查（instances.js:117）。
- 单元的 WorkingDirectory = 沙箱 data 目录且可写：`workingDir = data`（sandbox.js:54、63）。
- node 对**脚本参数**始终按 cwd 解析（不经 PATH），故 `['node','dsh.js']` 实际执行 `<dataDir>/dsh.js` —— 沙箱内进程可写入该目录 → 「沙箱内写文件、守卫重启时执行」的二级面。仅当操作者显式配置了相对入口时成立。
- 反向对照（非漏洞）：形态 B 的裸名 `['dsh', ...]` 由 systemd 自身路径搜索解析，**不**用单元的 `Environment=PATH`（sandbox.js:57 的 `install/bin` 不参与 ExecStart 解析）→ 该形态可能 203/EXEC 起不来（fail-closed），不是绕过。

### B3【中】`isConfiguredDshBin` 逃逸的退化

- `dshBin = config.command[1]`（compose/domains.js:50、90），出厂默认 `command:['node','dsh','web']` → `dshBin='dsh'`（bin/dsh-supervisor:61），`InstanceManager` 再兜底 `|| 'dsh'`（instance/index.js:22）。故：
  - `dshBin=''` **不可达**（两处 `|| 'dsh'`）→ 「空串放宽」不成立；类型守卫（instances.js:114）也使非字符串 dshBin 直接失效 → fail-closed。**这两点是对的。**
  - 但若 `config.command[1]` 是 `node`/`node.exe`（畸形配置，或宿主 command 写成 `['/usr/bin/node','node',...]`），则 `isConfiguredDshBin('node')=true` → 形态 A 的入口判据退化为「`command[1]` 等于 node」：`['node','node','-e','1']` 通过闸，实际执行 cwd 相对的 `./node`（可写目录）→ 回到 B2。
  - 若 `dshBin` 是**任意相对名**（如 `my-dsh`），`['node','my-dsh',...]` 通过，同样 cwd 相对解析。
  - 建议：`isConfiguredDshBin` 增加「dshBin 不得 ∈ {node,node.exe} 且必须是绝对路径」的值校验。

### B4【低】大小写 / UNC / 8.3

- `toLowerCase()`（instances.js:113）使 `DSH.JS`、`Dsh.Js` 放行；在**区分大小写**的 Linux/mac 上它们是不同文件 → 与 B1 同类。
- UNC `\\\\server\\share\\dsh.js` → basename `dsh.js` → 放行（远程脚本，B1 变体）。
- Windows 8.3 短名 `DSHJ~1.JS`、尾点 `dsh.js.`、尾空格 → basename 不等于白名单 → **400（fail-closed，正确）**；Windows 上尾点/尾空格会被文件系统规范化，但此处先拒后放，无绕过。

### B5【低】node 的内建求值形态——**已挡住**

逐一推演（command[0] ∈ NODE_HEAD 时 command[1] 必须像入口）：
`-e` / `--eval` / `-p` / `--print` / `-r` / `--require` / `--import` / `--experimental-loader` / `--loader` / `-`（stdin）→ basename 均 ∉ DSH_ENTRY → 400。
`['node']`（长度 1）→ `command.length > 1` 为假 → 400。
`['node','/tmp/mydir']`（目录）→ basename `mydir` → 400；`['node','dsh.js/']`（尾斜杠）→ basename `''` → 400；`['node','dsh.js/../evil.js']` → basename `evil.js` → 400。
**未被挡的仍只有「入口文件本身」（B1/B2）**：入口之后的参数是给脚本的，node 不再解释（`['node','dsh.js','--require','/tmp/x.js']` 里 `--require` 属于 dsh.js 的 argv）。

### B6【中·范围】闸是「写时」校验，start 不做复校

- 唯一 API 创建路径：`add`（instances.js:180）→ `createRecord`（ops.js:44 → model.js:41 原样存 `payload.command`）→ `instances.json`（store.js:18/27/60）。
- `start` 时不复校：`lifecycle._systemdStart → sandbox.effectiveCommand`（lifecycle.js:53 → sandbox.js:31-35），若 `inst.command` 非空则**直接返回并执行**（sandbox.js:33）。
- 故以下 `command` 不经闸即被执行：① 升级前旧版本写入的实例；② 直接编辑 `instances.json`；③ 任何未来新增的写入路径。
- **不是**旁路（已核实）：`update` 只吃 guardian/remoteEnabled/remoteToken/memoryMax/cpuQuota，**不认 `command`**（ops.js:101-120）→ 无法经 `/instances/update` 注入；`createRecord` 只有 ops.js:44 一个调用点。

---

## 2. Windows 形态判决

| 输入 | 判决 | 评价 |
|---|---|---|
| `['C:\\Program Files\\nodejs\\node.exe', 'dsh.js']` | 放行 | 正确（basename node.exe + 入口） |
| `['node.exe', 'dsh-supervisor']` | 放行 | 正确 |
| `['C:\\x\\dsh.exe', ...]` | 放行（形态 B） | 正确 |
| `['dsh.cmd', ...]` / `['node','dsh.cmd']` | **400** | ⚠ **误伤**：Windows npm 垫片就是 `dsh.cmd`/`dsh.ps1`；内核自己的 `resolveDsh` 也把 .cmd 当合法命中（exec-path.js:158-163） |
| `dsh.js.` / `dsh.js `（尾点/尾空格） | 400 | fail-closed，可接受 |
| `DSHJ~1.JS`（8.3） | 400 | fail-closed，可接受 |
| 反斜杠/正斜杠混用 | 正确处理 | split(/[\\/]/)，instances.js:113 |
| 大小写混写 | 放行 | Windows 正确（但见 B4 的 Linux 面） |

---

## 3. 误伤（合法用法被 400）

### M1【高】内核自己的规范 DSH 入口（`lib/bin.js`）不在白名单

- 内核的规范入口是 `<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`：`dshJsIn()`（exec-path.js:134-135），`resolveDsh()` 命中后返回 `{runtime: process.execPath, bin: <...>/lib/bin.js, isJs: true}`（exec-path.js:147-160）。
- 由此拼出的规范命令是**形态 A + basename `bin.js`**，而 `bin.js` ∉ DSH_ENTRY（instances.js:112）→ `['node','<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js','web']` → **400**，除非该串恰好严格等于 `dshBin`（instances.js:117 的后半）。
- 即：**闸的白名单比内核自己的入口解析更窄**，与 resolveDsh 的形态直接冲突。建议 DSH_ENTRY 增补 `bin.js`（并要求路径含 `@deepseek-ai/dsh` + `lib`），或直接复用 `exec-path.resolveDsh()` 的结果。

### M2【中】沙箱默认命令形态若被显式提交 → 400

- `sandboxCommand`（sandbox.js:19-23）产出 `[process.execPath, <installDir>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js, 'web', --port, ...]`；同 M1，basename `bin.js` 不在白名单。
- **缓解事实**：该默认命令**不经本闸**（见 §4），所以默认路径本身不受影响；误伤只在操作者显式粘贴此形态时发生。

### M3【中】Windows 垫片 `dsh.cmd`/`dsh.ps1` → 400（同 §2 表）。

### M4【低】「一行写完」的写法

- 若用户把 `node /usr/local/bin/dsh web` 写在**一行**（UI 按行切分，InstancesPage.tsx:62），得到 `['node /usr/local/bin/dsh web']` → `baseOf='web'` → **400**。
- 但 UI 的占位符其实是**三行** `"node\n/usr/local/bin/dsh\nweb"`（InstancesPage.tsx:234）→ `['node','/usr/local/bin/dsh','web']` → basename `dsh` ∈ DSH_ENTRY → **放行 ✓**。即：占位符本身兼容，任务描述里的单串写法才会被拒。

### M5【低】`['node', '<abs>/dsh.js', ...]`、`['node','<abs>/dsh', ...]` → 放行 ✓（题目问的这条合法）

### M6【低】非白名单的真实包装（如 `my-dsh-wrapper`）、带尾空格的绝对路径（直接 API，UI 会 trim）→ 400。属设计取舍。

---

## 4. 与 sandbox.js 的关系：默认命令确实**不经**本闸（属实）

证据链：
1. 闸只出现在 API `add`：`const cmdErr = commandShapeError(j.command, sup.instances && sup.instances.dshBin)`（instances.js:180-181）。
2. 缺省/空数组被放行（instances.js:97、99），记录里存成 `command: []`（model.js:41）。
3. 启动时才生成命令：`_systemdStart → sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst)`（lifecycle.js:53）→ `inst.domain==='sandbox' && !inst.command.length` 走 `sandboxCommand`（sandbox.js:31-32、19-23）。
⇒ 默认命令由域内纯函数生成，**从未经过 API 闸**。instances.js:95 的注释准确。

**但这一「不对称」带来 B6**：`effectiveCommand` 的**另一条**分支（`inst.command` 非空，sandbox.js:33）来自持久化，而持久化值在 start 时**不被复校**。

---

## 5. 建议（只报告，未改码）

1. **入口按 realpath + 前缀收口**（治 B1）：在 `add` 校验「basename ∈ 白名单」，并在 `_systemdStart`（此时 `inst.id`/`installDir` 可得）复校「入口 realpath 落在实例 `installDir`、或配置的 DSH 目录、或 `dshBin` 所在目录内」；否则拒绝并记 warn。
2. **白名单补 `bin.js`**（治 M1/M2）：或直接以 `exec-path.resolveDsh()` 的返回值为唯一事实源，避免闸与内核入口解析两套。
3. **`isConfiguredDshBin` 加值约束**（治 B3）：拒绝 `node`/`node.exe`、要求绝对路径；保留现有类型/空串守卫（它们是对的）。
4. **相对入口禁止或复校**（治 B2）：形态 A 的 `command[1]` 若不含路径分隔符，按「cwd 相对」处理 —— 要求其落在 installDir 内，或在 start 时以绝对路径复校。
5. **Windows 垫片**（治 M3）：DSH_ENTRY 是否纳入 `dsh.cmd`/`dsh.ps1` 取决于契约；若不纳入，至少把 400 文案改成「Windows 请用 node + 包内 lib/bin.js」，避免用户无从下手。
6. `command` 属**写时校验**（B6）：若接受「旧实例/直改 instances.json 的命令也会被执行」，应在 `effectiveCommand` 消费点加同样的白名单（单一事实源函数复用），而不是只在 API 层。

---

## 6. 一句话结论

闸有效挡住了「node 内建求值」与「结构畸形」两类（B5 全部 400），但**其白名单完全建立在 basename 之上**：任何名为 `node`/`dsh`/`dsh.js`/`dsh-supervisor` 的可执行或脚本——含 attacker 自己路径下的——均被放行（B1），并且形态 A 的相对入口按可写 cwd 解析（B2）、`dshBin` 逃逸可退化（B3）、start 不复校持久化命令（B6）。同时它**误伤内核自己的规范入口 `lib/bin.js`**（M1/M2）与 Windows 垫片（M3）。**「任意脚本执行」并未被真正关闭**，只是被改名为「必须叫 dsh*」。
