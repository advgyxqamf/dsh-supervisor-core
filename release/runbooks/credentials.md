# 凭据与令牌管理（GitHub / NPM）

> 核心原则：**令牌的值永不进入仓库目录、永不进 git 历史、永不进对话记录**。
> 仓库内只保存"引用 + 配置脚本"；值存在操作系统级安全存储（CI Secrets / 本机凭据助手 / 0600 配置文件）。

## 本项目的实际发布形态（最小权限的依据）

- 私有内核仓：`lobbowen/dsh-supervisor`（闭源 UNLICENSED，本仓库）。
- npm 发布 scope：`@dsh-sup`，四平台子包 `dsh-core-<os>-<arch>`：
  `dsh-core-linux-x64` · `dsh-core-darwin-arm64` · `dsh-core-darwin-x64` · `dsh-core-win-x64`
  （scope 已单源声明于 `package.json → npmPublish.scope = "@dsh-sup"`，`publish-core.sh` 优先读它）。
- 发布通道（2026-09-10 分工定案）：**linux-x64 由本机一键发布**（`release:core:publish`，Linux 机器，认证见下方「本机侧」）；
  **darwin-arm64 / darwin-x64 / win-x64 由私有仓 CI 矩阵**（tag 触发）发布。
- 热更新：npm 平台子包经 self-update 执行器安装——发布令牌即上表 npm 子包发布权限。

## 令牌总览与最小权限（收紧到上述形态）

| 令牌 | 用途 | 最小权限（只给这些） | 存放位置（值） |
|---|---|---|---|
| GitHub PAT（fine-grained） | 本机 `git push` 私有内核仓 | **仅** `lobbowen/dsh-supervisor` 一个仓库；`Contents: Read/Write`；无 admin/org/其它仓 | 本机 git credential helper / gh（**不内嵌 remote URL**） |
| GitHub Actions `GITHUB_TOKEN` | CI 挂 GitHub Release 附件 | 自动注入，仅当前仓 | 不需配置 |
| NPM token（automation） | 真发 `@dsh-sup/dsh-core-*` 子包（CI 发 mac/win，本机发 linux） | `Automation` 粒度；**仅`@dsh-sup` scope 的 `dsh-core-*` 子包**发包 | CI：仓库 Secrets `NPM_TOKEN`；本机：环境变量 `NPM_TOKEN`（经临时 userconfig 注入，不写入 `~/.npmrc`）或 `npm login` 官方源 |

> 曾发现：git remote URL 内嵌过明文 fine-grained PAT（`github_pat_…`）——**已从 remote 脱敏**。
> 该 token 已暴露，**必须在 GitHub 上撤销并重新签发**；新 token 改用 credential helper 保存，禁止再写进 remote URL。

## CI 侧（多平台自动发布 / 热更新真正走的通道）

GitHub 仓库 `lobbowen/dsh-supervisor` → **Settings → Secrets and variables → Actions**：

- `NPM_TOKEN` ← npmjs automation token（CI 真发 mac/win 三子包必需，scope `@dsh-sup`）
- `GITHUB_TOKEN` 无需配置（Actions 自动注入，`softprops/action-gh-release` 用它挂 Release）

接线点（已就位，值都在 Secrets 里）：
- `.github/workflows/build.yml`：tag `v<内核>` 触发 → **mac/win 三平台矩阵**各自 `ci-core.sh`（linux 已改本地生产，不在矩阵内）；
  **仅当 `NPM_TOKEN` 存在时** `--publish` 真发 npm 子包 + 挂 GitHub Release。
- 配置方法：GitHub 网页 Secrets 中新增 `NPM_TOKEN`（不由仓库内脚本管理）。
- npm 侧若需校验发包权限：`npm token list --registry=https://registry.npmjs.org/`（应只见 automation token）。

## 本机侧（开发机 / 一键发布）

### NPM（**认证单源**，2026-09-10 标准化）
```bash
# 规范配置：写入「真实用户 home」下的 .npmrc（0600）——任何沙箱/shell 都能被发布脚本读到
export NPM_TOKEN='<automation token>'
bash release/scripts/configure-credentials.sh --npm
# 自检（只读、不含值，且与发布脚本用同一解析器判定）
bash release/scripts/configure-credentials.sh --check
# 临时方案（不落盘）：仅本次会话有效
export NPM_TOKEN='<automation token>' && npm run release:core:publish
```
> **为什么要「真实 home」**：DSH 沙箱把 `$HOME` 指向实例数据目录。若认证只看 `$HOME`，
> 同一台机器上会「A 沙箱能发版、B 沙箱报 ENEEDAUTH」——这正是此前的真实故障
> （token 曾散落在某个实例的 home 下，只有在那一个沙箱里发布才成功）。
>
> 解析顺序（`release/scripts/_npm-auth.sh` **单源实现**）：
> `DSH_NPMRC` → `NPM_CONFIG_USERCONFIG` → `NPM_TOKEN`(临时 userconfig) → **真实 home/.npmrc** → `$HOME/.npmrc`。
>
> 2026-09-10 起发布脚本**不再**执行 `npm config set`（不改开发机全局 registry、不把 token 写入 `~/.npmrc`）。

### GitHub git push
```bash
# 推荐：gh CLI（凭据存系统 keyring / 凭据助手）
gh auth login --hostname github.com --git-protocol https
# 或凭据助手（token 仅作口令录入，不落 remote URL）
git config --global credential.helper store
git push   # 首次会提示输入用户名 + PAT（PAT 仅作为密码）
```
> 绝不再用 `git remote set-url origin https://x-access-token:<PAT>@github.com/...`。

### 一键编排如何消费
- `npm run release:core`（dry-run）：**不需要任何令牌**（构建/打包/检查都在本机）。
- `npm run release:core:publish`：需要 ① git 认证（credential helper 或 gh）② npm 认证（`NPM_TOKEN` 环境变量或 `~/.npmrc` 登录态）。缺任一即失败于对应步骤。**仅限 Linux 机器**（非 Linux 直接拒绝，见 release/README.md 平台分工）。

## 最小权限自查清单（发布前）
- [ ] GitHub PAT 只绑定 `lobbowen/dsh-supervisor`、仅 `Contents: Read/Write`，未出现在 `git remote -v`。
- [ ] npm automation token 只对 `@dsh-sup` scope 的 `dsh-core-*` 子包有写权限，无账号/组织写权限。
- [ ] CI Secrets 只存 `NPM_TOKEN`；`GITHUB_TOKEN` 走自动注入。
- [ ] 本机 `~/.npmrc` 与 `~/.git-credentials` 权限均为 `600`。

## 验证命令（不含值）
```bash
npm whoami                            # 应返回 npm 用户名
bash release/scripts/configure-credentials.sh --check
gh auth status                         # gh 已登录则显示账号
git ls-remote --heads origin | head    # 能列出分支 = git 认证通
```

## 轮换 / 泄露响应
- 任何 token 疑似泄露（进过 remote URL / 日志 / 对话）：立即到对应平台**撤销**并重新签发，然后更新 Secrets / 本机配置。
- 签发时永远选**最小权限 + 尽量短有效期**；fine-grained PAT 只给需要的那一个私有仓。
