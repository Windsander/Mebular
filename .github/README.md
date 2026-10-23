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

- `push` 只监听 `main`：feature branch 的验证只由 `pull_request` 产生，同一 commit 不会出现两套 run。
- `pull_request`、`merge_group`、`workflow_dispatch` 保留。
- `concurrency` 以 PR 号（无 PR 时用 `github.ref`）分组并 `cancel-in-progress: true`，PR 更新会取消旧 run，旧失败不会继续挂在 PR 上。
- job 名称即 required status checks 的 context，修改 job `name` 时必须同步更新 `.github/rulesets/main.json`。

## 仓库设置建议

合入本类配置后建议将「合并后自动删除分支」打开：

```bash
gh api -X PATCH repos/Windsander/Mebular -f delete_branch_on_merge=true
```

未开启自动合并（auto-merge），也不修改 Dependabot 配置。
