# 贡献指南

感谢对 Mebular 的关注！请先开 Issue 讨论再提交 PR。

## 开发环境

- Node.js ≥ 20（依赖 Web Crypto API 的 Ed25519/X25519）
- `npm install` → `npm run build` → `npm test`

## 代码约定

- **TypeScript ESM strict + `noUncheckedIndexedAccess`**；模块导入一律带 `.js` 后缀
- 运行时依赖保持极简（当前仅 `bonjour` + `ulid`）；新增依赖需先在 Issue 中说明理由
- 提交前本地三件套必须全绿：
  ```bash
  npm run build && npm test && npm run lint
  ```
- 阶段性改动同步运行对应验证脚本（`node scripts/verify-phaseN.mjs`）

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，使用繁体中文描述：

```
feat(sync): 同步線協議、衝突收斂應用與 SyncManager 重寫
fix(storage): 修復 listNodes 的標籤過濾缺口
test(integration): 圖同步端到端集成測試
chore(scripts): 新增 verify-phase3 驗證腳本
```

类型：`feat` / `fix` / `test` / `docs` / `chore` / `refactor`；范围取模块名（`core` / `sync` / `p2p` / `memory` / `hermes` …）。

## 测试约定

- 新功能必须配测试；修复 bug 附回归用例
- 集成测试使用 `InMemoryHub` 传输模拟，不依赖真实网络
- Promise 拒绝断言先同步挂 `.rejects` 期望再 `await`（避免未处理拒绝）

## 文档边界

- `README.md` / 本文件 / 代码注释：随仓库发布
- `docs/`、`docs.design/`、`design-notes/`：本地设计文档，**不进入远端**（已被 gitignore 排除，请勿提交）
