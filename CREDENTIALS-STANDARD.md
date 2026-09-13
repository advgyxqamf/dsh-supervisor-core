# 凭据管理标准（CREDENTIALS-STANDARD）

> 本文件是**凭据管理的唯一规范**。每一条都对应一个会失败的门禁
> （`test/credential-hygiene-test.js`，18 断言，已注入验证）。
> 工具：仓库 `release/scripts/cred.sh`；库：本机 `/home/bowen/.dsh/credentials/`。

---

## 0. 这份标准要解决的真实事故

**症状**：「下午还能推壳仓、构建壳仓，现在壳仓令牌找不到了。」

**根因**（已查证）：壳仓令牌被存放在**实例附件目录**：

```
/home/bowen/.dsh/supervisor/instances/inst-1788823804493-427/data/.dsh/attachments/.../gh_token.txt
```

那是 **ephemeral** 的 —— 每个会话/实例一个目录，换会话就没了。另有一份副本以 **0664（全局可读）**
散落在 `$HOME` 根目录。

**为什么「下午能推」**：推壳仓走的是 **SSH 部署密钥**（`~/.ssh/id_ed25519_wasi7`，经 repo-local `core.sshCommand`），
**与令牌无关**。令牌只用于 **REST API**（查状态 / 设 secret / 改分支保护）——
两者被混为一谈，才显得「令牌时而有时而没有」。

---

## 1. 三条铁律

| # | 铁律 | 门禁 |
|---|---|---|
| 1 | 凭据**只允许**存放在规范库 `/home/bowen/.dsh/credentials/`（SSH 密钥可留 `~/.ssh`）。**禁止**放在实例子目录或附件目录 | C-3 |
| 2 | 库目录 **0700**、库内文件 **0600**；禁止令牌内嵌进 git remote URL；仓库文件里不得出现令牌值 | C-1 / C-4 / C-6 / C-7 |
| 3 | 令牌**必须有清单条目**（`index.json`），只存引用不存值；缺失要显式标 `missing` | C-2 / C-5 |

### 关键陷阱：`$HOME` 被重定向

```
$HOME = /home/bowen/.dsh/supervisor/instances/<id>/data      # 不是 /home/bowen！
os.homedir() 同值。
```

所以 `~/.dsh` **不等于** `/home/bowen/.dsh`。
**一切凭据路径必须写绝对路径**，禁止用 `~` —— 清单里也写明了（`homeNote`）。

---

## 2. 两类凭据，用途不同（不要再混）

| 类型 | 用途 | 能否改仓库设置 |
|---|---|---|
| **SSH 部署密钥**（`~/.ssh/id_ed25519_*`）| `git push` | 不能：只能读写 git，**无 API 权限** |
| **GitHub PAT**（细粒度）| REST API：查状态 / 建 secret / **改分支保护** | 能：需 `Administration: Read and write` |

> 想设「required status checks」必须用 **PAT 且有 Administration 权限**；
> SSH 密钥再全权限也**做不到** —— 本会话就在壳仓上撞到过 `Resource not accessible`。

---

## 3. 工具：release/scripts/cred.sh

```bash
bash release/scripts/cred.sh list      # 列出全部条目与状态
bash release/scripts/cred.sh doctor    # 卫生检查（权限/缺项/散落副本/值泄漏），有缺项返回 1
bash release/scripts/cred.sh verify    # 实测连通性（API 打点），不打印令牌值
bash release/scripts/cred.sh path 名    # 打印凭据文件路径
bash release/scripts/cred.sh get  名    # 打印令牌值（仅给脚本消费）
echo -n TOKEN | bash release/scripts/cred.sh put 名   # 写入并置 active
```

库根可用 `DSH_CRED_DIR` 覆盖（测试 / 换机）。

---

## 4. 新增一枚凭据的标准步骤

1. 在 `index.json` 的 `entries` 增加条目：
   `name` / `kind` / `account` / `purpose` / `repoScopes` /
   `requiredPermission` / `file`（**必须在库内**）/ `verify`（API 打点）/ `status`；
2. 写入值：`bash release/scripts/cred.sh put 名`（从 stdin 读；自动 0600、自动置 active）；
3. 验证：`bash release/scripts/cred.sh verify 名` 应显示 OK；
4. 跑门禁：`npm test`（`credential-hygiene-test` 必须全过）；
5. 若是**轮换**，在 `history` 记一条（旧令牌尾号 / 失效原因 / 处置）。

### 轮换 / 作废

- 旧值**必须彻底删除**（`shred -u` 或 `rm`），不得留在附件目录、备份、`$HOME` 根；
- 状态由 `put` 自动置 `active`；作废时手动改 `missing` 并写 `history`；
- `doctor` 有缺项时返回 **1** —— 故意的：让「缺令牌」在自动检查里可见，而不是安静地继续。

---

## 5. 现状（cred.sh list）

| 名称 | 类型 | 账号 | 状态 |
|---|---|---|---|
| `kernel` | GitHub PAT | `advgyxqamf` | **active** |
| `shell` | GitHub PAT | `wasi7mglns` | **missing** —— 需重新签发 |
| `push-kernel` | SSH 部署密钥 | `advgyxqamf` | active |
| `push-shell` | SSH 部署密钥 | `wasi7mglns` | active |
| `npm` | npm automation | `lob.bowen` | external（CI 用 repo secret）|

### 壳仓令牌补发（唯一未完成项）

需要账号 `wasi7mglns` 签发一枚 fine-grained PAT：

- Repository access：`wasi7mglns/dsh-supervisor-launcher`
- Permissions：**Administration: Read and write**（分支保护必需）、`Contents: Read`、`Actions: Read`、`Metadata: Read`；
- 签发后：`bash release/scripts/cred.sh put shell`，再 `verify shell` 应 OK。

---

## 6. 门禁（test/credential-hygiene-test.js，18 断言）

| 组 | 内容 |
|---|---|
| C-1 | 规范库存在、0700 |
| C-2 | 清单存在、0600、含 rules / entries、`$HOME` 重定向警告 |
| C-3 | 每个 PAT 条目的 file **必须在库内**（不得指向 ephemeral 位置）|
| C-4 | 库内文件权限均 0600 |
| C-5 / C-6 | 清单内、仓库工作树内**无令牌值** |
| C-7 | git remote URL 未内嵌令牌 |
| C-8 | 旧散落位置：不存在、或指向库内的符号链接 |
| C-9 | 反向判据（能识别 ephemeral 路径 / 权限过宽 / 值泄漏）|

**注入验证**（4 次，全部 FAIL，还原后 18/18）：

| 注入 | 命中 |
|---|---|
| 条目指向 ephemeral 附件路径 | **C-3 FAIL** |
| 库内文件放宽到 0644 | **C-4 FAIL** |
| `$HOME` 根放散落副本 | **C-8 FAIL** |
| 清单内写入令牌值 | **C-5 FAIL** |

---

## 7. 与发布工程的关系

- 仓库内保存**规范 + 工具 + 门禁**，**不含任何值**（值只在本机库或 CI Secrets）；
- `release/runbooks/credentials.md` 是面向人的 runbook（含历史与最小权限说明）；
- 本文件是**标准**（含门禁与步骤）；两者互补，改一处须同步另一处；
- CI 侧凭据走仓库 Secrets（`NPM_TOKEN` / `GITHUB_TOKEN`），不依赖本机库。
