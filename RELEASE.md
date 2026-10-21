# Mebular 发布 SOP

面向 `@mebular/*` 的 npm 发布操作手册。发布流水线对齐 ADI-Stable-Diffusion 的
`auto-publish.yml` 模式：**分支名即版本号（SSOT）**、**幂等发布**、**按 ref 串行**。

## 0. 发布对象

| 包 | 目录 | 说明 |
| --- | --- | --- |
| `@mebular/core` | `.`（仓库根） | 核心库；tarball 内含 `packages/fleet/dist` 以提供 `fleet` bin |
| `@mebular/service` | `packages/service` | 常驻服务化（launchd/systemd/Task Scheduler） |
| `@mebular/skill` | `packages/skill` | 行为层：`SKILL.md` / `MEMORY_POLICY.md` / MCP 接入片段 |
| `@mebular/fleet` | `packages/fleet` | 跨设备多 Agent 协作 |
| `@mebular/mcp` | `packages/mcp` | MCP server（stdio + Streamable HTTP） |

- **版本策略**：lockstep，5 个包永远同版本号。
- **触发方式**：push 到 `release/v*` 分支（例如 `release/v0.2.0`），**不使用 tag 触发**。
- **发布分支即真相**：`release/vX.Y.Z` 的 `X.Y.Z` 必须等于 5 个 `package.json` 的版本，
  且等于 `CHANGELOG.md` 中 `## [vX.Y.Z]` 章节。

## 1. 手动前置清单（首次发布前一次性完成）

- [ ] **npm org/scope**：在 npmjs.com 创建组织 `mebular`（scope `@mebular`）。
      5 个包 `publishConfig.access = "public"`，scoped 包会以 public 发布。
- [ ] **NPM_TOKEN**：生成 npm **Automation** token（Organization → Access Tokens；绕过 2FA
      交互，适合 CI），并给 `@mebular` scope 授予 **Read and write** 权限。
- [ ] **GitHub Secret**：仓库 Settings → Secrets and variables → Actions 新增
      `NPM_TOKEN`（值即上一步 token）。发布 job 通过 `NODE_AUTH_TOKEN` 使用它。
- [ ] **GitHub Actions 权限**：仓库 Settings → Actions → General，Workflow permissions 至少
      勾选 **Read and write permissions**（`release` job 需要 `contents: write` 创建 Release / tag）。
- [ ] **账号配置**：确认 npm 账号已 `npm login`（本地首次 `npm publish` 用），并开启
      `npm org ls mebular` 可见。
- [ ] **首次发布注意**：`@mebular/core` 虽为仓库根包，仍以普通包发布；其 tarball 携带
      `packages/fleet/dist`（`files` 已声明）以支撑 `fleet` bin。首次发布会占用 5 个包名，
      之后版本仅需递增。
- [ ] **分支保护**：`main` 保持受保护；发布只走 `release/v*` 分支，勿直接向 `main` 提交版本号。

### 1.1 首次发布后回滚指南

发布是不可逆的，仅在版本号尚未被下游依赖时使用「删除」，否则一律「标记废弃」：

- **npm unpublish（72 小时窗口）**：仅能删除**发布后 72 小时内**、且**无人依赖**的版本；
  超时或被依赖一律 400。按包执行，lockstep 需 5 个包各跑一次：
  ```bash
  npm unpublish @mebular/core@0.2.0     # 重复 core → service → skill → mcp → fleet
  ```
  同一版本被删除后**不可再以相同版本号重新发布**，后续必须升号（重新 `bump_version.sh`）。
- **npm deprecate（常规手段）**：标记问题版本，安装时会打印警告但不阻断：
  ```bash
  npm deprecate @mebular/mcp@0.2.0 "broken: use 0.2.1"
  ```
  lockstep 建议 5 个包同一条消息一并废弃，再发布更高修复版本走第 2 节流程。
- **回退 GitHub Release**：
  ```bash
  gh release delete v0.2.0 --yes            # 仅删 Release
  git push origin :refs/tags/v0.2.0         # 删除 tag（gh release delete 加 --cleanup-tag 可一并删）
  ```
  或网页端 Releases → 该版本 → Delete release；若只想隐藏，标为 **pre-release** 即可。
  删除后重推同一 `release/v0.2.0` 分支，流水线会因 tag 缺失而重建 Release。

## 2. 发布流程（每次）

### 2.1 本地准备

```bash
git fetch origin
git switch -c release/v0.2.0 origin/main      # 分支名即版本号
bash scripts/bump_version.sh v0.2.0           # 同步 5 个版本号 + 生成 CHANGELOG 章节占位
```

`bump_version.sh` 会：

1. 将 5 个 `package.json` 的 `version` 改为 `0.2.0`；
2. 同步任何“已是版本号区间”的内部 `@mebular/*` 依赖为 `^0.2.0`
   （开发期源码用 `file:` 本地链接，pack 期由脚本统一改写，故 `file:` 保持不动）；
3. 在 `CHANGELOG.md` 顶部插入 `## [v0.2.0] - <date>` 章节（已存在则跳过，幂等）。

然后**手工填写** `CHANGELOG.md` 中该章节（本项目用 `### Highlights (EN)` / `### 亮点（中文）`
能力清单，也可沿用 Added / Changed / Fixed；Release notes 取自此章节）。

> 章节标题必须带 `v` 前缀（`## [vX.Y.Z]`）：`publish.yml` 与 `bump_version.sh` 都按
> `## [<tag>]` 逐字匹配，tag 形如 `v0.1.0`。

### 2.2 本地预检（可选但推荐）

```bash
npm ci
npm run build
npm run lint
npm run test:coverage        # 覆盖率门槛在 package.json#jest.coverageThreshold
npm run verify:mcp:publish   # 5 包 npm pack + tarball 干净安装冒烟
```

### 2.3 提交并触发

```bash
git add -A
git commit -m "release: v0.2.0"
git push -u origin release/v0.2.0
```

push 后 GitHub Actions `Publish` 流水线自动执行：

1. **verify**（`packages/fleet`/`mcp`/`service`/`skill` + root，共 5 个）：
   - checkout → `npm ci` → **版本 SSOT 校验**（分支名 == 5×package.json == CHANGELOG 章节）
   - `npm run build` → `npm run lint` → `npm run test:coverage`（覆盖率门槛）
   - `npm run verify:mcp:publish`（5 包 pack + tarball 安装冒烟）
2. **publish**（依赖序，token 用 `secrets.NPM_TOKEN`）：
   - `@mebular/core` → `@mebular/service` → `@mebular/skill` → `@mebular/mcp` → `@mebular/fleet`
   - 每个包先 `npm view <name>@<version>`：已存在则 **skip**（幂等），否则 `npm publish`
3. **release**：从 `CHANGELOG.md` 抽取 `## [v0.2.0]` 章节生成 Release notes，
   创建 GitHub Release 并回打 tag `v0.2.0`（已存在则 skip）。

> 串行保证：`concurrency.group = publish-${{ github.ref }}`，`cancel-in-progress: false`，
> 同一 release 分支重复 push 不会并行发布。

## 3. 内部依赖如何处理

- 开发期：`packages/fleet`、`packages/mcp` 内部依赖写 `file:../..`、`file:../service`、
  `file:../fleet`，由 npm workspaces 本地链接，`npm ci` / 本地调试零网络依赖。
- 发布期：各包 `prepack` 调用 `scripts/publish-manifest.mjs set`，把所有 `@mebular/*`
  依赖统一改写为 `^<当前版本>`；`postpack` 调 `restore` 还原 `file:`。
- 因此 tarball 内**不含任何 `file:` / `workspace:` 泄漏**，安装方可从 registry 正常解析。
- 版本升级只会改变包版本号；pack 期区间按当前版本动态计算，无需手改依赖字符串。

## 4. 幂等与重跑

- 重跑流水线（删除分支重建、或重推同名分支）安全：
  - 版本 SSOT 校验只读；
  - `publish` 已发布版本自动 skip；
  - `release` 已存在则跳过创建。
- 若某包发布失败：修复后重新 push 同一 `release/v*` 分支即可，已成功的包会 skip。

## 5. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| verify 报 `version=... != ...` | 分支名与 package.json 不一致。在分支上跑 `bash scripts/bump_version.sh vX.Y.Z` 并提交。 |
| verify 报 `CHANGELOG.md 缺少 [vX.Y.Z]` | 未生成/未提交 CHANGELOG 章节；跑 `bump_version.sh` 后补内容并提交。 |
| publish 报 `EOTP` / 需要一次性密码 | `NPM_TOKEN` 不是 Automation token 或缺 bypass-2FA 权限，重新生成。 |
| publish 报 `E403` / scope 无权 | token 缺少 `@mebular` scope 的 read/write 权限，或 npm org 不存在。 |
| publish 报 `EPUBLISHCONFLICT` | 该版本已存在（幂等应已 skip）；确认版本号是否递增正确。 |
| 安装 tarball 报找不到 `@mebular/*` | 检查 `scripts/publish-manifest.mjs` 是否在 prepack 生效、发布顺序是否完整。 |
| release 报 `contents: write` 被拒 | 仓库 Actions 权限未开读写；见第 1 节。 |
| 本地 pack 后残留 `package.json.packbak` | 某次 pack 异常中断；删除该文件并检查 prepack/postpack 是否成对。 |

## 6. 回滚

npm 不允许覆盖已发布版本。具体步骤见 [1.1 首次发布后回滚指南](#11-首次发布后回滚指南)：
`npm unpublish` 仅限 72 小时窗口，常规走 `npm deprecate` + 发布更高修复版本。

## 7. v0.1.0 首版发布清单（物料已备齐，由主会话执行）

> 本节只列**待执行**动作；发布分支切割、push 与 tag 由主会话在合并后完成。
> 版本号已是 `0.1.0`、CHANGELOG 章节已存在，因此**不需要**再跑 `bump_version.sh`
> （脚本幂等：版本号相同、章节已存在会直接跳过）。

### 7.1 执行前确认

- [ ] 本分支的文档物料已合并进 `main`，且 `main` 工作树干净。
- [ ] 第 1 节的一次性前置已完成：npm org `mebular`、`NPM_TOKEN`（Automation）、
      Actions `Read and write permissions`。
- [ ] 五个 `package.json` 版本均为 `0.1.0`，`CHANGELOG.md` 含 `## [v0.1.0]` 章节。
- [ ] 本机 `npm run lint` / `test:coverage` / `verify:mcp:publish` / `check:docs` 四项全过
      （记录见第 8 节）。

### 7.2 精确命令序列

```bash
# 1) 从最新 main 切出版本分支（分支名即版本号，SSOT）
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c release/v0.1.0 origin/main

# 2) 只读核对 SSOT（不改任何文件）
grep -H '"version"' package.json packages/*/package.json
grep -n '^## \[v0.1.0\]' CHANGELOG.md
git status --short          # 应为空

# 3) push 触发 Publish 流水线
git push -u origin release/v0.1.0
```

### 7.3 观察流水线

```bash
gh run list --workflow=publish.yml --branch release/v0.1.0 --limit 5
gh run watch <run-id>       # 或用网页 Actions 页面
```

预期阶段（任一失败即停，修复后重推同一分支即可，已发布包会 skip）：

1. **verify**：SSOT 校验（分支名 == 5×`package.json` == CHANGELOG 章节）→ `npm run build`
   → `npm run lint` → `npm run test:coverage` → `npm run verify:mcp:publish`。
2. **publish**：`@mebular/core` → `@mebular/service` → `@mebular/skill` → `@mebular/mcp`
   → `@mebular/fleet`（`npm view` 已存在则 skip）。
3. **release**：从 `CHANGELOG.md` 抽取 `## [v0.1.0]` 章节生成 notes，创建 tag `v0.1.0`
   与 GitHub Release。

### 7.4 发布后核验

```bash
for p in core service skill mcp fleet; do npm view "@mebular/$p@0.1.0" version; done
gh release view v0.1.0
npm install -g @mebular/core@0.1.0
mebular --help && fleet --version
mebular init                # 首次运行会提示下一步；路径提示问题见 8.1
```

<details>
<summary>回滚</summary>

见 [1.1 首次发布后回滚指南](#11-首次发布后回滚指南)：`npm unpublish` 仅限 72 小时窗口，
常规走 `npm deprecate` + 发布更高修复版本；GitHub 侧可 `gh release delete v0.1.0 --cleanup-tag`。

</details>

## 8. 发布前验证记录

环境：macOS（darwin）/ Node.js v26.8.1 / npm 11.19.0，依赖由 `npm ci` 从
`package-lock.json` 安装（`prepare` 自动 build）。

验证对象：分支 `m0/release-v010`，基线 `5daf4fe`，执行日期 2026-10-21。

| 命令 | 结果 | 关键输出 |
| --- | --- | --- |
| `npm run lint` | ✅ 通过 | ESLint 覆盖 `src` / `tests` / `tests-semantic` / `scripts` / `packages` / `apps/desktop`，无告警 |
| `npm run test:coverage` | ✅ 通过 | 163 suites / 1436 tests 全过；全局 91.78% stmts、79.13% branches、82.39% funcs、94.29% lines（门槛 85 / 65） |
| `npm run verify:mcp:publish` | ✅ 通过 | 5 包 `npm pack` + tarball 安装冒烟；内部依赖改写为 `^0.1.0` 且无 `file:` 泄漏；安装后 `tools/list=29`（13 记忆 + 16 任务）、`memory_write`/`memory_query` 落图命中、`fleet --version` 正常；根 tarball 全域安装双 bin（`mebular` + `fleet`） |
| `npm run check:docs` | ✅ 通过 | 7/7：README EN/CN 标题结构 `2,2,2,3,3,3,3,2,2` 一致、互链、无手写测试数字、CI badge、工具名在册、本地链接均存在 |
| SSOT 预演（`publish.yml` 同款脚本，`TAG=v0.1.0`） | ✅ 通过 | 5×`package.json` = `0.1.0`；`CHANGELOG.md` 含 `## [v0.1.0]` |

补充验证：另用 `npm install -g --prefix <tmp>` 安装根 tarball `@mebular/core`，
`<prefix>/bin` 同时生成 `mebular` 与 `fleet`，`mebular tools` 返回 29 项——README /
QUICKSTART 中的 npm 全局安装说明与实测一致。只安装 `@mebular/mcp` 时只有 `mebular`
bin；`fleet` 必须来自根包（或单独安装 `@mebular/fleet`）。

### 8.1 已知问题（不阻塞 0.1.0）

- `mebular init` 的“下一步”提示使用仓库相对路径（`node packages/.../mebular.mjs`），
  对 `npm install -g` 用户不适用；README / QUICKSTART 已给出 npm 安装树下的
  `install.mjs` 绝对路径，代码提示留待后续版本修正。
- 部分源码注释仍写“记忆 11 项 / 共 27 工具”，实际注册表已是 13 记忆 + 16 任务 = 29
  （`check-surface-parity` 断言 29）。本次文档按代码实测的 29 编写；注释清理留待后续版本。
