# GitHub 维护说明

本仓库的 GitHub 侧配置以仓库内文件为准，便于评审与回放。

## Ruleset

- 定义文件：`.github/rulesets/main.json`（`main`）、`.github/rulesets/site.json`（`site` / `site-*`）。
- 应用方式：`npm run rulesets:apply`（实际调用 `node scripts/apply-rulesets.mjs --apply`，需要 `GH_TOKEN` / `GITHUB_TOKEN` 且具备 repo admin 权限）。不带 `--apply` 时只做 dry-run，打印将要应用的 ruleset。
- 脚本按 ruleset `name` 幂等创建或更新，因此改完 JSON 后重新执行即可。

`main` 的当前策略：

- 必须通过 PR 合入，`required_approving_review_count` 为 **1**：至少一个 reviewer 批准。
- 单人维护时，维护者自己的 PR 通过管理员 bypass（RepositoryRole 5，`bypass_mode: always`）合入；bypass 仅用于本人 PR 或紧急兜底，不是常规审批替代。
- 保留 required status checks、review thread resolution、禁止删除分支与 non-fast-forward，合入前 CI 仍必须通过。
- 不引入 signed commit、code owner review 等额外门槛。

## CI 触发与去重

`.github/workflows/ci.yml`：

- `push` 监听 `main` 与 `release/v*`：main 合入与 release 分支发布前都跑完整 CI；feature branch 的验证只由 `pull_request` 产生，同一 commit 不会出现两套 run。
- `pull_request`、`merge_group`、`workflow_dispatch` 保留。
- `concurrency` 以 PR 号（无 PR 时用 `github.ref`）分组；仅 `pull_request` 事件 `cancel-in-progress`，PR 更新会取消旧 run，而 main / release push 不会被后续合入取消。
- job 名称即 required status checks 的 context，修改 job `name` 时必须同步更新 `.github/rulesets/main.json`。

## 仓库设置：合入后不自动删除分支

项目决定**保持「合并后自动删除分支」关闭**（`delete_branch_on_merge` = `false`）：合入 PR 后保留
head 分支，便于本地回看与后续跟进。请不要开启该设置。

以下旧命令**已废弃，不要执行**（它会把该开关重新打开）：

```bash
# 不要执行：gh api -X PATCH repos/Windsander/Mebular -f delete_branch_on_merge=true
```

未开启自动合并（auto-merge）。

已合并分支的清理只走 dry-run 清单，确认后再删：

```bash
npm run branches:merged                  # 只列已合并进 origin/main 的候选
npm run branches:merged -- --apply --yes # 明确确认后才删除
```

脚本保护 `main` / `release/*` / `release-prep/*` / `site*`、当前分支、worktree 分支和
open PR head；细节见 [`docs/operations/RELEASE.md`](../docs/operations/RELEASE.md#81-已合并远端分支清理)。

## Dependabot

- minor/patch 分组自动提 PR；`electron` 与 `electron-builder` 的 **major 一律人工处理**（`version-update:semver-major` ignore），避免打包/签名链路被自动跨大版本。

## Community Roadmap

公开 Roadmap 分为三层，各自承担不同职责，不复制任务状态：

- **公共叙事**：根目录 [`ROADMAP.md`](../ROADMAP.md) / [`ROADMAP_CN.md`](../ROADMAP_CN.md) 是正式来源；`assets/roadmap-{en,cn}{,-light}.svg` 只呈现同样的主题摘要。图中不写百分比、逐任务状态或具体发布日期。
- **讨论入口**：在 Discussions 的 **Announcements** 分类发布题为 `✦ Mebular Roadmap — Now / Next / Exploring` 的置顶帖。正文直接复制 `ROADMAP.md`；其中的图片和文档 URL 已使用 `main` 分支绝对地址，无需改写。编辑原帖以保留评论，不重新开帖；中文全文由帖首链接进入。
- **实时规划**：建立公开的 `Mebular Roadmap` Project 并关联本仓库。Issue / PR 是任务状态来源，Project 是实时视图，Roadmap 文档不另维护一份任务清单。

Project 只保留下列字段与视图：

| 配置 | 约定 |
|------|------|
| `Horizon`（Single select） | `Now` / `Next` / `Exploring`；已发布能力通过 Releases 查看，不堆积在 Project 中 |
| `Area`（Single select） | `Runtime` / `Desktop` / `Console` / `DSH` / `Sync` / `Docs` / `Community`，按需增补 |
| `Start date` / `Target date`（Date） | 仅用于实际排期；留空表示尚未承诺日期 |
| `Status` | 使用 Project 原生任务状态，不与 `Horizon` 混用 |
| `Roadmap` 视图 | 使用 Start / Target date 的 timeline；无日期任务留在 Board / Table，不伪造排期 |
| `Board` 视图 | 按 `Horizon` 分组，依次展示 Now / Next / Exploring |
| `Table` 视图 | 展示 Area、Status、Horizon、Start date、Target date 与关联 Issue / PR |

发布与更新顺序：

1. 通过 PR 更新 Roadmap 文案与四套 SVG，确认 `Next` 不被写成版本承诺、`Exploring` 不写成确定设计。
2. 合入 `main` 后，将新的 `ROADMAP.md` 正文更新到原置顶 Discussion；确认 dark / light 图片均可加载。
3. 更新公开 Project 的条目与链接，再从主 README、文档索引和 Discussion 检查入口一致。
4. 在仓库维护记录中保存最终 Discussion / Project URL；之前可以使用仓库的 Discussions / Projects 标签页作为稳定入口。
