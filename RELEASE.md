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

然后**手工填写** `CHANGELOG.md` 中该章节的 Added / Changed / Fixed（Release notes 取自此章节）。

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
| publish 报 `E403` / scope 无权 | token 未授权 `@mebular` scope 的 read/write，或 npm org 不存在。 |
| publish 报 `EPUBLISHCONFLICT` | 该版本已存在（幂等应已 skip）；确认版本号是否递增正确。 |
| 安装 tarball 报找不到 `@mebular/*` | 检查 `scripts/publish-manifest.mjs` 是否在 prepack 生效、发布顺序是否完整。 |
| release 报 `contents: write` 被拒 | 仓库 Actions 权限未开读写；见第 1 节。 |
| 本地 pack 后残留 `package.json.packbak` | 某次 pack 异常中断；删除该文件并检查 prepack/postpack 是否成对。 |

## 6. 回滚

npm 不允许覆盖已发布版本。具体步骤见 [1.1 首次发布后回滚指南](#11-首次发布后回滚指南)：
`npm unpublish` 仅限 72 小时窗口，常规走 `npm deprecate` + 发布更高修复版本。
