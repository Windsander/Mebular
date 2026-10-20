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
- `docs/`、`docs.design/`、`design-notes/`：本地设计文档，**不进入远端**（已被 gitignore 排除，请勿提交）；对外法律文件 `docs/DCO.md` 除外，随仓库发布

## 项目状态与质量门禁

Mebular 仍在早期：功能可用，API 未稳定，未发 npm 包；生产使用请自行评估。记忆层契约见 [`SEALING.md`](SEALING.md)。

| 门禁 | 说明 |
|------|------|
| 单元/集成测试 | `npm test`（CI 跑 `npm run test:coverage`，覆盖率门槛不降） |
| fleet 验收 | `npm run verify:fleet:all`（含 local/remote/agents/onboard/tasks/service/handoff/collab） |
| 守护验收 | `npm run verify:daemon` / `verify:daemon:cluster` |
| WAN | `npm run verify:wan:l2`（+ `:docker`） |
| 配对即连 | `npm run verify:connect`（配对 hints 自动连通 / relay 降级与恢复） |
| LAN 发现 | `npm run verify:lan`（LAN 自动拨号 / 陌生设备不拨号 / LAN↔WAN 切换） |
| 依赖政策 | `npm run check:deps`（THIRD-PARTY 登记 + 精确 pin + 无幽灵依赖） |
| 打洞 | `npm run verify:nat`（AutoNAT/DCUtR 装配与软降级 / 直连升级 / 失败保留 relay） |
| 表面一致性 | `npm run check:surface-parity`（MCP 工具 ↔ CLI 逐字同名、无孤儿） |
| 整洁性 | `npm run check:cleanliness`（孤儿模块 / 失效引用 / 裸 throw） |
| 文档一致性 | `npm run check:docs`（EN/CN 结构对齐、链接存在、工具名一致、无手写数字） |
| 类型/Lint | `tsc`（strict + `noUncheckedIndexedAccess`）与 ESLint 零告警 |
| CI | 四 job：build/test/lint · WAN NAT（docker）· Windows · 真实语义（live badge 见 README） |

实时数字不写进文档：README 用 CI 状态 badge（由 GitHub 计算），`check:docs` 禁止手写测试/覆盖率数字。

## 分支保护（rulesets）

`main` 与 `site` / `site-*` 由仓库 rulesets 保护，定义在 `.github/rulesets/*.json`（以仓库为准，可评审、可回放）：

- `main`：禁止删除/强推；必须经 PR（1 个批准、需解决全部评论线程）；必须通过四个必需检查（build/test/lint · Windows · WAN NAT · 真实语义）
- `site` / `site-*`：禁止删除/强推（站点分支允许直接推送）
- 管理员保留 bypass，避免误锁维护者

应用/更新：`npm run rulesets:apply`（dry-run 直接运行 `node scripts/apply-rulesets.mjs`；需要 `GH_TOKEN`，权限 repo admin）。

## 知识产权与商标 / Intellectual Property & Trademark

### 版权归属 / Copyright ownership

本项目（含原始代码、文档与设计素材）的版权归发起人 Sobert Li（李述博）个人所有，依 MIT 协议发布，许可全文见 [LICENSE](LICENSE)。本项目不设立、也不代表任何公司或其他法律实体。

「Windsander」是指自然人 Sobert Li（李述博）的 GitHub 账号与品牌名，二者为同一主体；本章节所称「发起人」均指该自然人。

Copyright in this project — including its original code, documentation, and design assets — is held by the founder, Sobert Li (李述博), and is released under the MIT License; the full license text is in [LICENSE](LICENSE). The project does not establish, and does not represent, any company or other legal entity.

"Windsander" refers to the GitHub account and brand name of the natural person Sobert Li (李述博); the two denote the same natural person. "The founder" in this section means that natural person.

### 贡献许可 / Contribution licensing

贡献者保留其贡献的版权。贡献一经合并，即视为贡献者以 MIT 协议向本项目及所有下游使用者授予全球范围、永久、免费、非排他、不可撤回的许可，允许使用、复制、修改、合并、发布、分发、再许可及销售该贡献，条件与 MIT 协议一致。

提交贡献须按 Developer Certificate of Origin 1.1 使用 `git commit -s` 签署；DCO 全文与中文导读见 [docs/DCO.md](docs/DCO.md)。DCO 是对贡献来源的声明，不转移版权，也不改变本项目以 MIT 发布的许可条款。

Contributors retain copyright in their contributions. Once a contribution is merged, the contributor is deemed to grant this project and all downstream recipients a worldwide, perpetual, royalty-free, non-exclusive, and irrevocable license under the MIT License to use, copy, modify, merge, publish, distribute, sublicense, and sell that contribution, on the terms of the MIT License.

Contributions must be signed off with `git commit -s` under the Developer Certificate of Origin 1.1; the full text and a Chinese guide are in [docs/DCO.md](docs/DCO.md). The DCO is a certification of the contribution's origin; it does not transfer copyright and does not change the MIT terms under which this project is released.

### 商标 / Trademarks

MIT 协议仅授予版权许可，不包含商标、商号或标识许可。「Mebular」名称与 ✦ 标识由发起人保留全部相关权利（无论是否注册），并为未来可能设立的实体预留。未经书面许可，不得以「Mebular」名义推广衍生产品，或暗示官方背书、赞助或关联；为如实指代本项目而进行的合理使用（例如说明某产品「基于 Mebular 构建」）除外。

The MIT License grants copyright permissions only; it grants no trademark, trade name, or logo license. The founder reserves all rights in the "Mebular" name and the ✦ mark, whether or not registered, including for any entity that may be established in the future. Without written permission, you may not promote a derivative product under the "Mebular" name or suggest official endorsement, sponsorship, or affiliation; reasonable, truthful references to this project (for example, stating that a product is "built on Mebular") remain permitted.

### 效力语言 / Governing language

本章节中英文并列，英文为参考译文。两者表述不一致时，以中文为准；本章节未尽事宜，依 [LICENSE](LICENSE)。

This section is presented in Chinese and English side by side; the English text is a reference translation. If the two versions differ, the Chinese version governs. For matters not addressed in this section, [LICENSE](LICENSE) governs.
