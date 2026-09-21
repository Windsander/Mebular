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
- 改动后运行相关验收：`npm run verify:fleet:all` / `npm run verify:wan:l2`（详见 README 与 `packages/fleet/RUNBOOK.md`）；整洁性门禁 `npm run check:cleanliness`

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，使用繁体中文描述：

```
feat(sync): 同步線協議、衝突收斂應用與 SyncManager 重寫
fix(storage): 修復 listNodes 的標籤過濾缺口
test(integration): 圖同步端到端集成測試
chore(scripts): 新增 wan-l2 relay-only 驗證腳本
```

类型：`feat` / `fix` / `test` / `docs` / `chore` / `refactor`；范围取模块名（`core` / `sync` / `p2p` / `memory` / `hermes` …）。

## 测试约定

- 新功能必须配测试；修复 bug 附回归用例
- 集成测试使用 `InMemoryHub` 传输模拟，不依赖真实网络
- Promise 拒绝断言先同步挂 `.rejects` 期望再 `await`（避免未处理拒绝）

## 文档边界

- `README.md` / 本文件 / 代码注释：随仓库发布
- `docs/`、`docs.design/`、`design-notes/`：本地设计文档，**不进入远端**（已被 gitignore 排除，请勿提交）

## 项目状态与质量门禁

Mebular 仍在早期：功能可用，API 未稳定，未发 npm 包；生产使用请自行评估。记忆层契约见 [`SEALING.md`](SEALING.md)。

| 门禁 | 说明 |
|------|------|
| 单元/集成测试 | `npm test`（CI 跑 `npm run test:coverage`，覆盖率门槛不降） |
| fleet 验收 | `npm run verify:fleet:all`（含 local/remote/agents/onboard/quickstart/tasks/grant/service/membership/handoff/rejoin/collab） |
| 守护验收 | `npm run verify:daemon` / `verify:daemon:cluster` |
| WAN | `npm run verify:wan:l2`（+ `:docker`） |
| 配对即连 | `npm run verify:connect`（配对 hints 自动连通 / relay 降级与恢复） |
| LAN 发现 | `npm run verify:lan`（LAN 自动拨号 / 陌生设备不拨号 / LAN↔WAN 切换） |
| 扫码即通 | `npm run verify:invite`（令牌 grant 语义 / 二维码与降级 / 兑换自动授权 / TTL 撤销） |
| 依赖政策 | `npm run check:deps`（THIRD-PARTY 登记 + 精确 pin + 无幽灵依赖） |
| 打洞 | `npm run verify:nat`（AutoNAT/DCUtR 装配与软降级 / 直连升级 / 失败保留 relay） |
| 表面一致性 | `npm run check:surface-parity`（MCP 工具 ↔ CLI 逐字同名、无孤儿） |
| 整洁性 | `npm run check:cleanliness`（孤儿模块 / 失效引用 / 裸 throw） |
| 文档一致性 | `npm run check:docs`（EN/CN 结构对齐、链接存在、工具名一致、无手写数字） |
| 类型/Lint | `tsc`（strict + `noUncheckedIndexedAccess`）与 ESLint 零告警 |
| CI | 四 job：build/test/lint · WAN NAT（docker）· Windows · 真实语义（live badge 见 README） |

实时数字不写进文档：README 用 CI 状态 badge（由 GitHub 计算），`check:docs` 禁止手写测试/覆盖率数字。
