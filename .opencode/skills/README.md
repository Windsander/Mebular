# `.opencode/skills/` — 开发期技能素材

本目录存放 OpenCode/agent 会话使用的 **skill**（纯文本 `SKILL.md` 指令，**非运行时**，
不进 npm 包——根包 `files` 白名单不含 `.opencode`；`check:cleanliness` 已跳过本目录）。

## 优先级（冲突时以此为准）

**自建契约（各自领域内的单一契约；外部建议与之冲突一律否决）**

1. `mebular-console-design` — 控制台（`packages/console`）视觉与交互契约
2. `mebular-assistant-integration` — 「连接 AI 助手」接入契约
3. `mebular-site-design` — 官网（`site` 分支）设计契约

**顾问文本（外部，仅参考）**

4. `frontend-design`（审美裁判）
5. `web-design-guidelines`（质量清单：a11y/对比度/性能/UX）
6. `writing-guidelines`（文案规范：语气/结构/排版）
7. `webapp-testing`（工具型：浏览器自动化验收）

全部技能均为顾问文本（不自动执行命令）：**不得引入运行时依赖 / 外部字体 / 第二套设计系统**
（零运行时依赖红线，见各自建契约）。

## Provenance

| 名称 | 来源 | 版本 / commit | 许可 | 用途 | 状态 |
|---|---|---|---|---|---|
| `mebular-console-design` | 本仓库自建 | 随仓库演进 | MIT（同仓库） | 控制台 UI 设计契约：token 与双皮肤边界、星图/防光污染/性能护栏、a11y、新页面 checklist | ✅ 已入库 |
| `mebular-assistant-integration` | 本仓库自建 | 随仓库演进 | MIT（同仓库） | 助手接入契约：descriptor 注册表、三态诚实判定、验证闭环、写入备份/回滚红线 | ✅ 已入库 |
| `mebular-site-design` | 本仓库自建 | 随仓库演进（site v1.3 起） | MIT（同仓库） | 官网设计契约：零依赖/性能护栏/星图语言/术语表/双语与版本规则 | ✅ 已入库 |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) `skills/frontend-design` | commit [`41bbe19`](https://github.com/anthropics/skills/commit/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f)（2026-09-03） | Apache-2.0（`LICENSE.txt` 已随附） | 新页面/改版的审美方向与反模板化自查 | ✅ 已 vendor |
| `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills) `skills/webapp-testing` | commit [`dbd4588`](https://github.com/anthropics/skills/commit/dbd4588f9e1033efb41dad4bef2f7947c8993d44)（2026-10-09） | Apache-2.0（`LICENSE.txt` 已随附） | 浏览器自动化验收（Playwright：截图/交互/console 日志） | ✅ 已 vendor |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/web-design-guidelines` | commit [`063bee9`](https://github.com/vercel-labs/agent-skills/commit/063bee94c3f4df8453406c830b0a7df0f2860278)（2026-08-28） | MIT（README 声明；仓库根无独立 LICENSE 文件） | 提交前质量清单（a11y/对比度/性能/UX；规则实时拉取） | ✅ 已 vendor |
| `writing-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/writing-guidelines` | commit [`063bee9`](https://github.com/vercel-labs/agent-skills/commit/063bee94c3f4df8453406c830b0a7df0f2860278)（2026-08-28） | MIT（README 声明；仓库根无独立 LICENSE 文件） | 文案规范审计（语气/结构/排版；规则实时拉取） | ✅ 已 vendor |

### 评估未收录（记录，避免重复筛选）

| 名称 | 来源 | 未收录原因 |
|---|---|---|
| `brand-guidelines` | anthropics/skills | Anthropic 自家品牌规范，不适用 |
| `theme-factory` | anthropics/skills | 预设主题 = 第二套色板/字型，与自建契约冲突 |
| `web-artifacts-builder` / `react-*` / `vercel-*` | 两家 | 引入 React/Tailwind/构建步骤，违背零依赖红线；站点非 Vercel 部署 |
| `canvas-design`、`skill-creator` | anthropics/skills | 本轮未选：面向 PNG/PDF 美术物料与技能创作工具，需要时再评估 |

## 安装/更新方式

- 不使用 `npx skills add`；统一手工拷贝进本目录，随 git 版本管理。
- 更新第三方 skill：核对上游 commit → 更新本表 → 连同 LICENSE 一并替换。
- 同一 PR 内同步登记 [`THIRD-PARTY.md`](../../THIRD-PARTY.md)「开发期技能素材」表。
