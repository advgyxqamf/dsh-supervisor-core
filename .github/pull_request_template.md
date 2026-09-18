<!--
  提交前请逐项确认。这些不是形式 —— 每一项都对应一个会失败的门禁。
  流程规范见 DEVELOPMENT-TRACK.md
-->

## 变更类型（勾选，决定你需要补哪些测试）

- [ ] 业务逻辑（`src/domains/**`、`src/app/**`、`src/api/**`）
- [ ] 平台能力（`src/platform/**`）
- [ ] 跨仓契约（`registry.json` / `identity.json` / `update-journal.json`）
- [ ] 发布工程（`release/**`、`.github/workflows/**`）
- [ ] 门禁/测试（`test/**`）
- [ ] 文档

## 自检（**必勾，未勾请不要提交**）

- [ ] **平台知识只在 `src/platform/**`**：本次没有在业务域新增 `process.platform` / os 映射表
- [ ] **新增跨层依赖已登记**：若有新的跨层 import，已在 `test/layering-and-dependency-gate-test.js` 的 `CROSS_LAYER` 加条目**并写明理由**
- [ ] **新增测试已进链**：新测试文件已加入 `package.json#scripts.test`，或已写进排除表并说明理由
- [ ] **注入验证**：新增/修改的门禁我都做了「注入缺陷 -> 确认 FAIL -> 还原（sha256 校验）-> 确认 PASS」
- [ ] **未引入假绿**：判据不依赖默认值兜底 / 不靠夹具顺序巧合 / 不与自己的说明文字匹配（见 DEVELOPMENT-TRACK 第 3 节）
- [ ] **验收状态：待 CI 裁决**（按 ACCEPTANCE-STANDARD，测试一律不在本机执行；不得以本机结果作结论）

## 跨仓影响（若涉及契约）

- [ ] 契约**新增**（向后兼容）—— 可直接发布
- [ ] 契约**删除/语义变更** —— 已确认**内核先行**、保留一个发布周期的跨版本容忍，并已标注消费方

## 说明

### 缺陷 / 动机

### 修法

### 验证证据（注入什么 -> 哪条断言 FAIL -> 还原后 PASS）

### 未做的事 / 已知边界
