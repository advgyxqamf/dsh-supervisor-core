# 原生 DSH 接管契约（N1–N5）

> 本文是「原生 DSH 接管」的**冻结契约**。它先于代码：任何对原生 DSH 的**检测 / 绑定 / 接管 /
> 安装 / 插件管理**的改动都必须符合本文，并由 `test/native-dsh-binding-test.js` 等门禁强制。

## 0. 角色（产品定位，不可偏离）

**dsh-supervisor 是「管家」，不是「容器 / 运行时环境」。**

- 管家的职责是**接管原生系统上的 DSH 业务**：接管它的进程生命周期，并管理它的版本与插件。
- 原生 DSH 的安装目录 / 数据目录 `~/.dsh` **就是管家要管的对象**——插件启停、卸载、升级是其**核心价值**，
  不是「越界」。
- 沙箱实例是**另一条独立业务线**（隔离数据/依赖），与原生**共享实现抽象**，但**不互相转化**；
  绝不能把原生逻辑改造成沙箱逻辑，也不能把原生「只读化」。

## 1. 根因（2026-09-16 真机取证）

原生 DSH 的「是否存在 / 在哪」此前**只来自静态配置** `config.command[1]`，而出厂默认是**裸逻辑名**
`'dsh'`（`bin/dsh-supervisor` 的 `DEFAULT_CONFIG`）：

- `NativeManager.binPath()` = `'dsh'` → `fs.existsSync('dsh')` **恒 false** → `installedVersion()` null
  → `status().installed` **false**；
- 于是**系统原生已装 DSH，守卫却判「未安装」** → 接管分支（adopt/spawn）永不走，面板按「未安装」
  走安装分支（`npm i -g @deepseek-ai/dsh`）→ **二次安装 / 顶替原生 DSH**；
- 全仓（含壳）**没有任何一处**把 `dsh` 解析为真实可执行入口：内核已有 `platform/os/exec-path.js`
  却只用于 `npm`/`npx`/`dsh-supervisor`；`node dsh` 不做 PATH 解析，Windows 裸名亦无扩展名。

同一事实（有没有 DSH）得到**两个相反结论** —— 这就是「两套对立的逻辑」。

## 2. 铁律（冻结）

| # | 铁律 |
|---|---|
| **N1** | 原生 DSH 的存在与位置必须由**检测**得出，绝不静态写死裸名。 |
| **N2** | 检测 → 绑定 → 接管是**同一条管线**：已装则绑定并接管；未装则安装，装后**再检测绑定**。安装与接管不是两套逻辑。 |
| **N3** | 绑定结果必须是**可执行入口**：优先包内 JS（`node <abs lib/bin.js>`）；仅垫片时由 shell 承载；命令一律**绝对路径**。 |
| **N4** | 原生域与沙箱域**独立**，共享实现抽象（target 描述符 + 安装/版本/插件/生命周期能力），不互相转化。原生 `home=~/.dsh` 由管家管理。 |
| **N5** | 检测/绑定失败必须**如实报「未安装」**，绝不伪造路径或猜测；由用户显式安装或引导安装。 |

## 3. 单管线（N2 的落地语义）

    [守卫启动]
       │
       ▼
    检测：resolveDsh()  —— DSH_BIN → PATH/PATHEXT → 标准落点 → <npmRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js
       │
       ├─ 命中 → 绑定 config.command = [node, <abs lib/bin.js>, ...rest]（用户显式且存在的路径原样尊重）
       │           │
       │           ├─ 已有健康实例 → adopt（接管既有进程，不另起、不误杀）
       │           └─ 无 → spawn 并纳管
       │
       └─ 未命中 → status().installed=false → （用户/面板）安装 → 装后重新检测绑定 → 接管

`_bindNativeDshCommand()` 必须在**任何消费者之前**执行（`InstanceManager` / `PluginManager` / spawn）。

## 4. 域与抽象（N4）

| 域 | home | bin | 谁管 | 生命周期 | 版本/插件 |
|---|---|---|---|---|---|
| 原生 native | `~/.dsh` | 检测到的真实 `dsh` | 管家 | ✅ | ✅（启停/卸载/升级） |
| 沙箱 sandbox | `<dataDir>/.dsh` | `<installDir>/.../lib/bin.js` | 管家 | ✅ | ✅ |

两者**共享**实现（`platform/distribution` 安装执行、`exec-path` 解析、插件 CLI 的 `runtime` 承载、生命周期监督），
差异只在**target 描述符**（bin、home、profileDir、env 四项）。

## 5. 门禁（可执行断言）

| 门禁 | 断言 |
|---|---|
| `test/native-dsh-binding-test.js` | 假 npm 前缀：`resolveDsh` 命中包内 JS；已绑定→installed+版本；裸名且无可解析安装→**如实 false**；注入真实安装→true；绑定先于 `InstanceManager`；插件 CLI 经 `runtime` 承载。 |
| `test/cross-platform-test.js` | `resolveExecutable` 跨平台（既有）。 |

## 6. 反例（禁止回归）

- ❌ 把 `config.command[1]` 保持为裸 `'dsh'` 并据此判定 installed；
- ❌ 直接 `spawn(target.bin)` 而不经 `runtime`（包内 JS / Windows 垫片必失败）；
- ❌ 用「静态默认 command」与「真实安装」两套判据得出相反结论；
- ❌ 把原生 target 当作沙箱 target（或反之）来「隔离」。