# `.opencode/skills/` — 开发期技能素材

本目录存放 OpenCode/agent 会话使用的 **skill**（纯文本 `SKILL.md` 指令，**非运行时**，
不进 npm 包——根包 `files` 白名单不含 `.opencode`；`check:cleanliness` 已跳过本目录）。

## 优先级（冲突时以此为准）

1. **`mebular-console-design`**（自建契约）— 最高，任何外部建议与之冲突一律否决
2. **`readme-authoring`**（自建契约）— README 专用：图 > 表 > 文字、首屏、双语结构与审阅清单
3. `frontend-design`（审美裁判，顾问文本）
4. `web-design-guidelines`（质量清单，**未入库**，仅本机参考）

以上均为顾问文本：**不得引入运行时依赖 / 外部字体 / 第二套设计系统**
（零运行时依赖红线，见自建契约第一节）。

## Provenance

| 名称 | 来源 | 版本 / commit | 许可 | 用途 | 状态 |
|---|---|---|---|---|---|
| `mebular-console-design` | 本仓库自建 | 随仓库演进 | MIT（同仓库） | 控制台 UI 设计契约：token 与双皮肤边界、星图/防光污染/性能护栏、a11y、新页面 checklist | ✅ 已入库 |
| `readme-authoring` | 本仓库自建 | 随仓库演进 | MIT（同仓库） | README 产品首页：首屏、图/表/文优先级、版式、双语校验、审阅清单 | ✅ 已入库 |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) `skills/frontend-design` | commit [`41bbe19`](https://github.com/anthropics/skills/commit/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f)（2026-09-03） | Apache-2.0（`LICENSE.txt` 已随附） | 新页面/改版的审美方向与反模板化自查 | ✅ 已 vendor |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/web-design-guidelines` | commit [`ba46938`](https://github.com/vercel-labs/agent-skills/commit/ba46938889d4e58635362fb8f618e1178ac3ec46)（2026-01-16） | ⚠️ **仓库根无 LICENSE，许可不明** | 提交前质量清单（a11y/对比度/性能）参考 | ❌ **未 vendor**——许可不明不入库；需要时仅本机参考 |

## 安装/更新方式

- 不使用 `npx skills add`；统一手工拷贝进本目录，随 git 版本管理。
- 更新第三方 skill：核对上游 commit → 更新本表 → 连同 LICENSE 一并替换。
