# 归档文档

> 这些文档是**时间点记录**，其事项已完成或已被后续工作取代。
> 保留仅为可追溯，**不再作为现行规范**；现行规范见仓库根目录。

| 文档 | 归档原因 |
|---|---|
| [AUDIT-FUNCTION-BREAKPOINTS.md](AUDIT-FUNCTION-BREAKPOINTS.md) | 自述「A/B/C/D 四类断点**全部清零**」「断点审计**总收官**」—— 审计已完成 |
| [AUDIT-KERNEL-FRONTEND-CONSISTENCY.md](AUDIT-KERNEL-FRONTEND-CONSISTENCY.md) | 自述「内核+前端整体无已知 P0/P1 未决项，**8 项架构债全部清零**」—— 审计已完成 |
| [PROJECT-AUDIT-2026-09-10.md](PROJECT-AUDIT-2026-09-10.md) | 带日期的全量理解+审计报告，已被后续专项审计（跨平台、断点、前端自洽）取代 |
| [CONTINUE-HANDOFF.md](CONTINUE-HANDOFF.md) | 双仓拆分的交接文档，拆分**已完成**；⚠️ 其中仓库归属已过时（写 `wasi7mglns/dsh-supervisor-core`，实际为 `advgyxqamf/dsh-supervisor-core`） |

> ⚠️ 归档文档中的**路径与仓库名可能已过时**，请勿据此定位代码。

## 附：已删除的孤立分支 main（2026-09-11 全仓清理）

删除前状态（留档）：

| 项 | 值 |
|---|---|
| 提交数 | 4（2026-09-09）|
| 与 master 的关系 | **无共同祖先**（独立历史）|
| 文件数 | 236 |
| 与 master 的差集 | 各 168 个文件不同 |

**为何删除**：它是双仓拆分**之前**的单仓快照（含内核 + 壳 + 前端），
与拆分后的 master（内核专用）**没有共同祖先**，挂在远端会让克隆者看到两条互不相关的历史。

**其内容是否已覆盖**：

| main 独有内容 | 现由谁承担 |
|---|---|
| 壳集成冒烟 / 前端 verify / Tauri 依赖安装 | **壳仓** launcher-build.yml（四平台矩阵）|
| 内核子包构建与发布 | 本仓 release/scripts/ci-core.sh（比 main 更完整：含 precheck 省额度闸、build-ui、全平台派生）|
| scripts/*.sh（build-sea / build-shell-frontend / build-ui）| release/scripts/ 下的等价实现 |

**追溯方式**：本地 tag archive/orphan-main-20260909（指向 dac0b3bc16381993f1568d7d69065d46c5b60ce9）。
远端删除后本地仍可 git show archive/orphan-main-20260909:bin/dsh-supervisor 取回。

