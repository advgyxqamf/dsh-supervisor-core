# 桌面壳自更新签名密钥（minisign）管理手册

> **本文档不含私钥内容**（私钥仅存在于本机与离线备份，绝不入库）。
> 密钥生成于 2026-09-11，用于桌面壳（Tauri）自更新产物签名。

## 一、这是什么、为什么必需

Tauri updater 在下载更新包后，**强制用公钥验证 minisign 签名，不可关闭**。

- **没有签名** → 无法产出 `.sig` → **自动更新链路根本无法成立**
- **有签名** → 即使产物经第三方 CDN（unpkg / jsdelivr）分发，仍能保证完整性

> 与 Apple / Windows 代码签名是**两件事**：
> - minisign：自动更新的完整性校验，**免费、必需**
> - Apple Developer ID / Windows 代码签名：消除安装拦截提示，**付费、可选**

## 二、文件与位置

| 用途 | 路径 | 权限 | 是否入库 |
|---|---|---|---|
| 私钥（签名用） | `~/.tauri/dsh-supervisor.key` | `600` | **绝不** |
| 公钥（验签用） | `~/.tauri/dsh-supervisor.key.pub` | `644` | 可（已在 `tauri.conf.json` 公开） |
| 本地备份 | `~/.tauri/backup/dsh-supervisor.key.<时间戳>` | `600` | **绝不** |

**指纹**（用于校验备份一致性；可安全记录）：

| 文件 | sha256（前 16 位） |
|---|---|
| 私钥 | `92e3ae43ed4dea58` |
| 公钥 | `d5ffd60103af390a` |

**公钥**（公开信息，与 `tauri.conf.json` 的 `plugins.updater.pubkey` 一致，152 字符）：

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk2REUzRUYyNkYzODlGNzAKUldSd256aHY4ajdlbGhsQnpRNGo2bldrVG1WYkllTnc1aGlkdHZHSGJybUllZzZ6eXFwS1dJZEcK
```

## 三、CI 配置（壳仓 GitHub Secrets）

| Secret | 值 | 说明 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥**内容**或文件路径 | 构建时签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 密码 | **必须设置**（即使为空也要提供） |

> ⚠ **实测结论**：本密钥为 `rsign encrypted secret key` 格式，**不设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 会签名失败**：
> `failed to decode secret key: incorrect updater private key password`。
> CI 中请显式提供该 secret（空字符串亦可），**不要遗漏**。

`NPM_TOKEN` 亦需配置（发布 `@dsh-sup/shell-*` 与清单包 `@dsh-sup/shell-release`）。

## 四、备份要求（**2026-09-11 用户定案：本机备份即可，不做异地**）

> **私钥一旦丢失，已安装该版本的用户将永久无法再收到自动更新。**
>
> 原因：公钥已固化在用户端的程序内；换新密钥对旧用户无效——他们只能手动重装。

**当前采用的方案（本机）**：

| 位置 | 内容 | 权限 |
|---|---|---|
| `~/.tauri/dsh-supervisor.key` | 在用私钥 | `600` |
| `~/.tauri/backup/dsh-supervisor.key.<时间戳>` | 本机备份副本 | `600` |
| `~/.tauri/backup/README.txt` | 指纹与说明（不含私钥） | `600` |

**已完成的校验**：备份与原件 `cmp` 一致；并做过一次恢复演练（解出后指纹相同）。

**必须遵守**：

1. **备份随开发机一同保护**（勿放在会被清理的临时目录）。
2. **绝不入库**：`.gitignore` 已覆盖 `*.key` / `*.key.pub`；导出脚本亦自检无泄漏。
3. **换机/重装前先拷走 `~/.tauri/`**——否则将永久失去签发更新的能力。

> ⚠ 风险如实说明（不改变上述决定）：本机单点备份意味着**磁盘损坏 / 误删 / 系统重装**都会导致不可逆的更新能力丧失。
> 若后续要加保险，最低成本做法是把 `~/.tauri/backup/` 复制一份到任意离线介质（U 盘即可）。

## 五、验证备份是否可用

```bash
# 1) 指纹比对（应等于 92e3ae43ed4dea58）
sha256sum ~/.tauri/backup/dsh-supervisor.key.<时间戳> | cut -c1-16

# 2) 用备份实际签名一次（真正验证密钥可用）
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/backup/dsh-supervisor.key.<时间戳>
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
cd <壳仓>/src-tauri && npx @tauri-apps/cli@2 build --bundles deb
# 成功即产出 .deb + .deb.sig
```

## 六、轮换（设计上可行，实操代价极高）

minisign **不支持密钥轮换对旧用户生效**。若确需换钥：

- 新版本用新私钥签名 + 新公钥内置 → **该版本必须由用户手动安装一次**
- 此后该用户才能继续自动更新

**结论**：除非私钥确定泄漏，否则不要换钥；泄漏时走「手动安装过渡版」的应急流程。
