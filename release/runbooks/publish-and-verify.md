# 发布与验收：内核/壳双轨操作指南（目标环境执行）

> 产品方向（已拍板）：**私有 GitHub 存开发源码；公开 npm 发布内核构建物（SEA 字节码二进制）做热更新；壳开源引流**。
> 内核=`dsh-supervisor` 二进制（SEA），壳=Tauri 图形引导器（不参与热更新）。所有本地工程/测试/取证已在仓库完成（`npm run verify:shell` 一键全绿）。

## 第 1 步：构建内核构建物（SEA，逐平台）
```bash
# 在对应平台机器执行（无交叉编译；CI 矩阵见 .github/workflows）
npm run build:sea                 # release/scripts/build-sea.sh：bundle→V8 code cache→postject→self-check 冒烟
ls -lh dist/sea/dsh-supervisor-*  # 产物：dsh-supervisor-<ver>-<platform>-<arch>（字节码，无 class 明文）
# 冒烟（脚本已自带）应输出：guardVersion=... node=... platform=... self-check: OK
```

## 第 2 步：npm 发布内核子包（热更新通道）
```bash
# 在对应平台机器（无交叉编译；本机 Linux 已 dry-run 验证通过）：
npm run build:sea                       # 先出 SEA 二进制
npm run publish:core                    # 组装子包 + npm publish --dry-run（推荐先跑）
npm run publish:core -- --publish       # 真发（需 npm 登录且 scope 权限）
# 每个子包：name=@dsh-sup/dsh-core-<os>-<arch>（scope 单源=package.json.npmPublish.scope），version=单源注入裸版本（与内核同号），
#   os/cpu 字段平台过滤，bin 指向 SEA 二进制（win 为 dsh-supervisor.exe），安装即用。
# 发布后：self-update 引擎接 npm 通道（registry latest + integrity → 二进制/平台子包替换）——用户明确「先不急」。
```

## 第 3 步：GitHub 双仓库（私有内核仓 + 公开壳仓引流）
```bash
# 1) 私有内核仓：push 到 <owner>/dsh-supervisor（Private）——存内核/测试/CI（SEA+npm 产线）
# 2) 公开壳仓（引流）：bash release/scripts/export-shell.sh git@github.com:<owner>/dsh-supervisor-launcher.git
#    → dist/export-shell/ 组装（壳源码+产品主页 README+MIT LICENSE+公开仓 CI），commit 后 push；
#    GitHub 拉取后确保仓库设为 Public。公开仓 clone 即 cargo build（已验证）。
# 3) 壳 Release（公开仓）：tag v<壳版本> 触发 launcher-build.yml → 三平台 Tauri bundle 挂 Release；壳版本独立（0.1.0 起，release/scripts/bump.sh --shell）
# 4) 内核 Release（私有仓）：tag v<内核版本> 触发 build.yml → 内核 SEA 挂 Release + npm 子包 --publish（NPM_TOKEN）；壳仅集成冒烟不发布
# 5) 配置守卫自更新源（config.json）：{ selfUpdateManifestUrl, selfUpdateDir }——内核走 npm 后保留为离线备源
```

## 第 4 步：桌面真机验收（桌面会话）
按 `release/runbooks/verify-desktop.md` 清单执行：
- 场景 A：全新环境无 Node → 壳引导页 → 一键装官方最新 LTS → 自动拉起守卫 → 面板 200；
- 场景 B：已有旧版 Node → 引导页「升级到官方最新 LTS」+ 可「跳过并使用现有版本」；
- 场景 C：自更新（npm 内核通道或本地源）→ 状态/应用/重启钳制；
- 托盘/关窗隐藏/设置页「环境与自更新」卡交互。

## 验收退出标准
| 项 | 通过标志 |
|---|---|
| 内核（SEA） | 三平台 `build:sea` 自举 `self-check` OK；npm 子包安装即 `dsh-supervisor self-check` |
| 壳 | 三平台可构建、xvfb/桌面可启动、无 Node 环境引导闭环；版本独立（0.1.0 起） |
| Node | 官方最新 LTS 一键装/升级，SHA256 校验，授权弹窗一次 |
| 自更新 | npm 内核通道状态/应用/回滚/重启钳制全通（Release 源为离线备源） |
| DSH | 检测判定 + 一键装入口（面板） |
| 稳定性 | npm test 全绿、零泄漏、生产端口表不被污染 |

## 状态追踪
- [x] SEA 内核构建物化（Linux x64 验证通过：注入 done、self-check OK、strings 无 class 明文）
- [x] **版本管理规范 v2**（DESIGN §16）：单一事实源 package.json；壳同号跟随内核；bump.sh 一处改三处；verify-versions 三处同号校验；SEA __DSH_VERSION__ 注入自包含（孤立目录实证 0.10.0）
- [x] **publish-core.sh**（4 平台 npm 子包，单源注入裸版本 + os/cpu 过滤 + self-check 错配拒绝；Linux dry-run 验证通过：包 47.5MB/integrity 已生成）
- [x] **双仓库方案 A 落地**：壳解耦（resources 仅 bootstrap/icons；main.rs 定位已安装内核）；export-shell.sh（导出目录独立构建验证通过）；许可（内核 UNLICENSED / 壳 MIT）
- [x] **凭据管理落地（2026-09-09）**：令牌值不入库（CI Secrets `NPM_TOKEN` + 本机 credential helper / 0600）；scope 单源化 `@dsh-sup`（package.json.npmPublish.scope）；remote URL 已脱敏（旧内嵌 PAT 报废）；最小权限规格见 credentials.md
- [x] **本机 git/npm 认证接通（2026-09-09）**：git credential store 0600 + npm login 均验证通过（git ls-remote / npm whoami→lob.bowen）
- [x] **linux-x64 发布成功（2026-09-09）**：`@dsh-sup/dsh-core-linux-x64@0.1.2-BETA.5` 已发布 npm registry（os:['linux'] cpu:['x64'] bin:dsh-supervisor 校验通过）——发布产线端到端真实验证
- [x] **launcher 统一形态发布验证（2026-09-09）**：`@dsh-sup/dsh-core-linux-x64@0.1.2-BETA.6` 与 `@dsh-sup/dsh-core-darwin-arm64@0.1.2-BETA.6` 已发布 npm（全平台弃 SEA 后干净版本，darwin 首次可用）
- [x] **darwin SEA 段错误根因定论（铁证）**：最小 hello-world SEA 在 macOS 注入后即崩（与 codecache/codesign/Node 版本/postject 均无关）→ Node SEA 的 macOS 上游缺陷 → 全平台弃 SEA 改 Node launcher（build-launcher.sh）
- [ ] **darwin-x64/win-x64 待补发**：代码侧已修（darwin-x64 arch_override 在 macos-14 arm64 runner 构建；win pgrepList Windows 实现 + SIGTERM/0600/libuv 测试平台化）；遇 GitHub Actions 瞬时基础设施故障（所有 job 2-10s setup 失败、日志 BlobNotFound、ui-verify 2s 失败证明非本仓代码问题）——待 GH 恢复后重跑 tag 补发
- [ ] **GitHub Secrets `NPM_TOKEN`**：在 lobbowen/dsh-supervisor → Settings → Secrets → Actions 新增（值=`@dsh-sup` scope 的 automation token）——待用户网页配置
- [ ] 公开壳仓 push + 设为 Public（需你的 GitHub 操作）
- [ ] self-update 引擎接 npm 通道（用户：先不急）
- [ ] 私有源码仓库 + 公开壳仓库（需用户账号/凭据）
- [ ] GUI 真机验收（verify-desktop.md 清单）