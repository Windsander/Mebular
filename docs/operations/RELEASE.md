# Mebular 发布 SOP

面向 `@mebular/*` npm 包与三平台桌面安装包的发布操作手册。核心约束：**分支名即版本号
（SSOT）**、**先构建安装包再发 npm**、**幂等发布**、**按 ref 串行**。

当前发布线 v0.1.2：

- 6 个 npm 包统一为 `0.1.2`（单版本 umbrella：`core` / `service` / `skill` / `mcp` / `fleet` / `dsh-plugin`）；
- macOS Universal DMG、Windows NSIS x64、Linux AppImage + deb x64（unsigned）；
- `SHA256SUMS.txt`（仅 GitHub Release 资产生成）。

从下一版本起，`@mebular/dsh-plugin` 仍由独立 npm job 发布，但版本号随统一 release train bump，
六个 npm 包同版本，并由发布 gate 校验；不存在只发布 DSH 插件的批次。

## 0. 发布对象

| 包 | 目录 | 说明 |
| --- | --- | --- |
| `@mebular/core` | `.`（仓库根） | 核心库；tarball 内含 `packages/fleet/dist` 以提供 `fleet` bin |
| `@mebular/service` | `packages/service` | 常驻服务化（launchd/systemd/Task Scheduler） |
| `@mebular/skill` | `packages/skill` | 行为层：`SKILL.md` / `MEMORY_POLICY.md` / MCP 接入片段 |
| `@mebular/fleet` | `packages/fleet` | 跨设备多 Agent 协作 |
| `@mebular/mcp` | `packages/mcp` | MCP server（stdio + Streamable HTTP） |
| `@mebular/dsh-plugin` | `packages/dsh-plugin` | DeepSeek Harness 插件；独立适配器，独立 npm job 发布，版本随统一 release train |

- **版本策略**：6 个可发布包（`core` / `service` / `skill` / `mcp` / `fleet` / `dsh-plugin`）
  共用同一发布版本；`scripts/bump_version.sh` 一次同步全部 manifest 与版本源。
- **MCP 版本源**：`packages/mcp/src/version.mjs` 是唯一真源；`serve.mjs` / `server.mjs` /
  `client.mjs` 从它导入，`packages/mcp/scripts/publish-manifest.mjs` 从自己的
  `package.json` 取版本。禁止再手写 `0.x.y`。
- **安装入口**：`npm install -g @mebular/core` 是根包，同时提供 `mebular` + `fleet` 两个 bin；
  `@mebular/mcp` 单独安装只有 `mebular`，**不能**当作双 bin 安装入口。
- **桌面版本**：`apps/desktop/package.json`、`apps/desktop/package-lock.json` 与
  `apps/desktop/src/main/daemon.mjs` 的 `APP_VERSION` 必须等于发布版本。
- **触发方式**：push 到 `release/v*` 分支（例如 `release/v0.2.0`），**不使用 tag 触发**。
  手动 `workflow_dispatch` 是 packaging dry-run。
- **发布分支即真相**：`release/vX.Y.Z` 的 `X.Y.Z` 必须等于 6 个 `package.json` 的版本、
  根 `package-lock.json` 的 workspace 条目、桌面三处版本、MCP 版本源，以及
  `CHANGELOG.md` 中 `## [vX.Y.Z]` 章节。`npm run verify:release-version` 一次校验全部。

### 0.1 发布产物

| 产物 | 来源 | 说明 |
| --- | --- | --- |
| 6 个 `.tgz` | verify 的 `release-pack` | 六个同版本包：`core` / `service` / `skill` / `mcp` / `fleet` / `dsh-plugin` |
| `Mebular-<version>-universal.dmg` | `desktop-macos` | macOS Universal（arm64 + x64），unsigned |
| `Mebular-Setup-<version>.exe` | `desktop-windows` | Windows NSIS x64，unsigned |
| `Mebular-<version>-x86_64.AppImage` | `desktop-linux` | Linux x64，unsigned |
| `Mebular-<version>-amd64.deb` | `desktop-linux` | Debian/Ubuntu x64，unsigned |
| `SHA256SUMS.txt` | `release` job | 只覆盖 4 个安装包，按文件名排序 |

## 1. 一次性前置清单

- [ ] **npm org/scope**：在 npmjs.com 创建组织 `mebular`（scope `@mebular`）。6 个包
      `publishConfig.access = "public"`，scoped 包会以 public 发布。
- [ ] **NPM_TOKEN（granular access token）**：npm → Access Tokens → Generate New Token →
      **Granular Access Token**：
  - Packages and scopes：`@mebular` → **Read and write**（覆盖 publish 与 stage）；
  - 勾选 **Bypass 2FA**（CI 无交互，必须；否则 publish 报 `EOTP`）；
  - 设置有效期并按期轮换；token owner 必须是 `mebular` 组织中有发布权限的成员。
- [ ] **GitHub Secret**：仓库 Settings → Secrets and variables → Actions 新增
      `NPM_TOKEN`。`preflight`、`publish`、`publish-dsh` 通过 `NODE_AUTH_TOKEN` 使用它。
- [ ] **GitHub Actions 权限**：仓库 Settings → Actions → General，Workflow permissions 至少
      勾选 **Read and write permissions**；`release` job 另有 job-level `contents: write`。
- [ ] **首次发布注意**：`@mebular/core` 虽为仓库根包，仍以普通包发布；其 tarball 携带
      `packages/fleet/dist`（`files` 已声明）以支撑 `fleet` bin。首次发布会占用六个包名
      （含 `@mebular/dsh-plugin`）。
- [ ] **分支保护**：`main` 保持受保护；发布只走 `release/v*` 分支，勿直接向 `main` 提交版本号。
- [ ] **2027 迁移计划**：npm 已公布自 **2027-01** 起收紧长期 token 的直接发布路径。R6 应切换到
      **trusted publishing（OIDC）**，让 GitHub Actions 以短期身份发布，不再依赖长期
      `NPM_TOKEN`。在切换前，本 SOP 的 granular token + Bypass 2FA 仍是唯一路径。

### 1.1 回滚指南

发布是不可逆的，仅在版本号尚未被下游依赖时使用「删除」，否则一律「标记废弃」：

- **npm unpublish（72 小时窗口）**：仅能删除**发布后 72 小时内**、且**无人依赖**的版本；
  超时或被依赖一律 400。六个包各执行一次（同一版本）：
  ```bash
  npm unpublish @mebular/core@0.2.0     # 重复 core → service → skill → mcp → fleet → dsh-plugin
  ```
  同一版本被删除后**不可再以相同版本号重新发布**，后续必须升号。
- **npm deprecate（常规手段）**：标记问题版本，安装时会打印警告但不阻断：
  ```bash
  npm deprecate @mebular/mcp@0.2.0 "broken: use 0.2.1"
  ```
  建议六个包用同一条消息一并废弃，再发布更高修复版本。
- **回退 GitHub Release**：
  ```bash
  gh release delete v0.2.0 --yes            # 仅删 Release
  git push origin :refs/tags/v0.2.0         # 删除 tag（仅在确认无人依赖时）
  ```
  或网页端 Releases → 该版本 → Delete release；若只想隐藏，标为 **pre-release**。
  注意：删除 Release 不会撤销 npm 发布，npm 仍需按上面的步骤处理。
- **只换安装包**：npm 不受影响。重新构建后对同一 tag 重传资产即可：
  ```bash
  gh release upload v0.2.0 release-assets/* --clobber
  ```
  下载页会立即使用新文件；`SHA256SUMS.txt` 必须与安装包一起重传。

## 2. 发布流水线

`.github/workflows/publish.yml` 的 9 个 job：

```text
verify（SSOT / build / lint / test / 6 tarballs）
  ├─ preflight（push only：npm whoami）
  ├─ desktop-macos  ─┐
  ├─ desktop-windows ├─ 同一批 tarball → runtime → 安装包 → packaged smoke
  └─ desktop-linux  ─┘
        │
        ▼（三平台全部成功 + preflight 成功）
     publish（core/service/skill/mcp/fleet tarball）
        │
        ▼
     publish-dsh（dsh-plugin tarball，同一版本）
        │
        ▼
     visibility（npm view 六包 + dist-tags.latest；失败不创建 Release）
        │
        ▼
     release（4 个安装包 + SHA256SUMS.txt）
```

关键点：

1. **verify** 是唯一一次 pack：6 个 tarball 上传为 artifact `release-tarballs`，后续 npm
   publish 与三平台 runtime 都消费这同一批文件，保证「测什么发什么」。
2. **verify 版本 SSOT** 调用 `node scripts/verify-release-version.mjs`，校验 6 个 manifest、
   根 lock、桌面三处、MCP 版本源与 CHANGELOG；dry-run 与正式发布走同一段代码。
3. **preflight** 只在 push 时运行，用 `npm whoami` 验证 token 能认证；失败则后续 job 不启动。
4. **desktop matrix** 在 macOS / Windows / Linux runner 上各自下载 `release-tarballs`，
   执行 `prepare-runtime` → `smoke:runtime` → `dist:*` → packaged runtime smoke，并上传
   `desktop-macos` / `desktop-windows` / `desktop-linux`。
5. **publish** 依赖 `preflight` + `verify` + 三个 desktop job，因此**安装包全部通过后才发 npm**。
6. **publish-dsh** 依赖 `publish`，发布 `packages/dsh-plugin` tarball；版本与六包 SSOT 一致。
7. **visibility** 依赖 `publish` + `publish-dsh`，用
   `scripts/verify-release-visibility.mjs` 有界轮询六个包的 `npm view <pkg>@<version> version`
   与 `dist-tags.latest`。只有六包可见且 latest 指向本次版本，`release` 才会启动。
8. **release** 依赖全部 job，下载三个 `desktop-*` artifact，校验恰好 1 个 `.dmg` / `.exe` /
   `.AppImage` / `.deb`，生成 `SHA256SUMS.txt`，从 CHANGELOG 抽取 notes，创建 Release 并
   `gh release upload --clobber`。

> 串行保证：`concurrency.group = publish-${{ github.ref }}`，`cancel-in-progress: false`；
> 同一 release 分支重复 push 不会并行发布。dry-run（`workflow_dispatch`）不运行
> preflight / publish / publish-dsh / visibility / release。

### 2.1 分支生命周期（固定流程）

发布分支与 dry-run 必须分开，避免「push 即发布」：

```text
origin/main
  └─ release-prep/vX.Y.Z        # bump + 文档 + 本地预检
       ├─ workflow_dispatch     # packaging dry-run（不发布）
       └─ release/vX.Y.Z        # 从 prep 分支创建；push 即正式发布
            └─ PR 回合并 main   # 保留版本提交与 CHANGELOG
                 └─ 删除 release/vX.Y.Z 与 release-prep/vX.Y.Z
```

1. 从最新 `origin/main` 创建 `release-prep/vX.Y.Z`，提交版本与 CHANGELOG。
2. 在 `release-prep/vX.Y.Z` 上跑 `gh workflow run publish.yml --ref release-prep/vX.Y.Z`，
   确认三平台安装包与 6 个 tarball 全绿。**不要**用 push `release/v*` 代替 dry-run。
3. dry-run 通过后，从 prep 分支创建 `release/vX.Y.Z` 并 push；这会触发正式发布。
4. 发布成功后，用 PR 把 `release/vX.Y.Z` 回合并到 `main`（历史 v0.1.1 的 PR #251 即此步骤）。
5. 回合并后删除 `release/vX.Y.Z` 与 `release-prep/vX.Y.Z`；远端已合并分支用第 8.1 节的
   dry-run 清单确认后再清理。

> 不要直接向 `main` push 版本号，也不要长期保留 release 分支；分支名是版本 SSOT，合并后
> 以 tag / CHANGELOG / npm 版本为准。

## 3. 本地准备与预检

### 3.1 本地准备（每次）

```bash
git fetch origin
git switch -c release-prep/v0.2.0 origin/main  # 先 prep，dry-run 后再建 release 分支
bash scripts/bump_version.sh v0.2.0             # 同步 6 包 + 版本源 + CHANGELOG 章节
npm run verify:release-version                  # 只读校验；也可带 --version/--tag
```

`bump_version.sh` 会：

1. 将 6 个 `package.json`（core / fleet / mcp / service / skill / dsh-plugin）改为 `0.2.0`；
2. 同步根 `package-lock.json` 的根版本与 6 个 workspace 条目；
3. 同步桌面 `package.json` / `package-lock.json` / `APP_VERSION`；
4. 同步任何「已是版本号区间」的内部 `@mebular/*` 依赖为 `^0.2.0`；
5. 改写 `packages/mcp/src/version.mjs` 的 `APP_VERSION`（MCP 唯一版本源）；
6. 在 `CHANGELOG.md` 顶部插入 `## [v0.2.0] - <date>` 章节（已存在则跳过，幂等）。

> 若版本号与 CHANGELOG 章节已存在（例如当前 `release-prep/v0.1.2`），**不需要**再跑
> `bump_version.sh`；只有从新版本开始时才执行上面的 bump。

### 3.2 本地预检（推荐）

```bash
npm ci
npm run build
npm run lint
npm run test:coverage          # 覆盖率门槛在 package.json#jest.coverageThreshold
npm run verify:mcp:publish     # 5 包 npm pack + tarball 干净安装冒烟
npm run verify:dsh-plugin      # 插件契约 + tarball
npm run verify:release-version # 六包 / lock / 桌面 / MCP / CHANGELOG SSOT
npm run check:docs             # 文档一致性 7/7
npm run check:i18n
npm run check:deps
```

发布后可见性 gate 也可以独立预演（对已发布版本只读）：

```bash
npm run verify:release-visibility -- --version 0.2.0 --timeout-seconds 60 --interval-seconds 5
```

桌面链路（与 CI 同路径）：

```bash
npm ci --prefix apps/desktop
bash -c '
  set -euo pipefail
  rm -rf release-pack && mkdir -p release-pack
  ROOT="$PWD"
  npm pack --pack-destination "$ROOT/release-pack"
  for p in packages/fleet packages/service packages/mcp packages/skill packages/dsh-plugin; do
    (cd "$p" && npm pack --pack-destination "$ROOT/release-pack")
  done
'
node apps/desktop/scripts/prepare-runtime.mjs --tarballs release-pack
npm --prefix apps/desktop run smoke:runtime
npm --prefix apps/desktop run dist:dir
# 在对应平台的解包目录上执行（macOS / Windows / Linux 路径见 DESKTOP_RELEASE 第 2.5 节）
node apps/desktop/scripts/smoke-runtime.mjs --runtime "apps/desktop/dist/<unpacked>/resources"
```

> 本机只能可靠构建当前平台。macOS Universal 必须在 macOS 上构建；Windows NSIS 在
> Windows 上构建；Linux AppImage/deb 在 Linux 上构建。三平台由 CI matrix 负责。

## 4. Packaging dry-run

`workflow_dispatch` 只跑 `verify` + 三平台 desktop matrix，上传 artifacts；**不**运行
`preflight`、`publish`、`publish-dsh`、`visibility`、`release`，不发布 npm，也不创建
GitHub Release。TAG 从根 `package.json` 版本生成，因此必须先在 `release-prep` 分支完成
版本 bump。

> `workflow_dispatch` 需要该 workflow 已在默认分支注册。若 `publish.yml` 尚未合入 `main`，
> GitHub 不会提供手动触发入口；此时不要用 `release/v*` 分支 push 代替 dry-run，那会进入
> 正式发布。先完成 workflow 合并，再在 prep 分支上触发。

```bash
# 在 release-prep 分支上触发（workflow 已在 main 注册）
gh workflow run publish.yml --ref release-prep/v0.2.0

# 观察
gh run list --workflow=publish.yml --limit 5
gh run watch <run-id>

# 下载 tarball 与三平台产物
gh run download <run-id> -n release-tarballs -D release-pack
gh run download <run-id> -n desktop-macos -D release-assets
gh run download <run-id> -n desktop-windows -D release-assets
gh run download <run-id> -n desktop-linux -D release-assets
```

dry-run 必须全绿后才创建 `release/vX.Y.Z`；不要在 `release/vX.Y.Z` 上重跑 dry-run，
push 该分支即正式发布。

dry-run 的 artifacts 保留 **7 天**；没有官方 `SHA256SUMS.txt`（它由 `release` job 生成）。
需要在本地核对时，对 `release-assets` 自行计算：

```bash
shasum -a 256 release-assets/*          # macOS
sha256sum release-assets/*              # Linux
```

## 5. 正式发布

### 5.1 触发

dry-run 通过后，从 prep 分支创建正式发布分支并 push：

```bash
git switch release-prep/v0.2.0
git switch -c release/v0.2.0
git push -u origin release/v0.2.0
```

push 后自动执行第 2 节的完整流水线。任一 job 失败即停；安装包未全绿时不会发 npm；
六包未全部可见（visibility gate）时不会创建 GitHub Release。

### 5.2 观察

```bash
gh run list --workflow=publish.yml --branch release/v0.2.0 --limit 5
gh run watch <run-id>
gh run view <run-id> --log-failed       # 失败时

# 单独查看 visibility gate
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name | contains("visibility"))'
```

### 5.3 发布后核验

```bash
# npm 六包：version 与 latest 都必须指向本次版本
for p in core service skill mcp fleet dsh-plugin; do
  npm view "@mebular/$p@0.2.0" version
  npm view "@mebular/$p" dist-tags.latest
done

# 或复用流水线同一个 gate（只读轮询；已可见时立即通过）
npm run verify:release-visibility -- --version 0.2.0 --dsh-version 0.2.0

# GitHub Release
gh release view v0.2.0
gh release view v0.2.0 --json assets --jq '.assets[] | "\(.name)  \(.size) bytes"'

# 根包双 bin
npm install -g @mebular/core@0.2.0
command -v mebular && command -v fleet
mebular tools >/dev/null && fleet --version
```

发布后核验清单：

- [ ] 六个包的 `version` 与 `dist-tags.latest` 都等于本次发布版本（或直接看 visibility job）；
- [ ] GitHub Release 资产 = 4 个安装包（`.dmg` / `.exe` / `.AppImage` / `.deb`）+
      `SHA256SUMS.txt`，release notes 来自 CHANGELOG 的 `## [vX.Y.Z]` 章节；
- [ ] 下载资产后按第 6 节校验 checksum；`SHA256SUMS.txt` 恰好 4 行；
- [ ] `release/vX.Y.Z` 已通过 PR 回合并 `main`，随后删除 release / prep 分支。

> 不要用 `npm install -g @mebular/mcp@0.2.0` 冒充双 bin 安装：`@mebular/mcp` 只提供
> `mebular`，`fleet` 必须来自根包（或单独安装 `@mebular/fleet`）。

插件独立验证（先让 App / 守护运行）：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.2.0
dsh --profile web --dump-config | grep -A3 mebular   # host row；transport 由官方 MCP client 挂载
# DSH 会话中确认 mcp__mebular__* 可调用；侧边栏面板加载 /console/?embed=dsh
```

> 插件只走 HTTP MCP，不要改成 stdio；stdio 会另起 Mebular 进程并抢占 storage lock。
> 细节见 [`docs/integrations/DSH.md`](../integrations/DSH.md)。

如需首启冒烟，用一次性 home（不要碰真实 `~/.mebular`）：

```bash
MEBULAR_HOME="$(mktemp -d)" mebular serve --port 7399
# 浏览器打开 http://127.0.0.1:7399/console：
# 锁定主控制台 → 新建忆云（忆云名 + 设备名）→ 同页解锁，不重启、不刷新
# 完成后 Ctrl-C，并删除临时目录
```

## 6. 安装包验收

从 Release 下载并校验：

```bash
gh release download v0.2.0 -D release-assets
cd release-assets

# Linux
sha256sum -c SHA256SUMS.txt

# macOS
shasum -a 256 -c SHA256SUMS.txt

# Windows PowerShell
Get-Content SHA256SUMS.txt | ForEach-Object {
  $hash, $file = $_ -split '\s+\*?', 2
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $hash.ToLower()) { throw "checksum mismatch: $file" }
}
```

验收标准：

- `SHA256SUMS.txt` 恰好覆盖 4 行：1 个 `.dmg`、1 个 `.exe`、1 个 `.AppImage`、1 个 `.deb`；
- 文件名与第 0.1 节一致；没有额外平台包或调试产物；
- macOS 打开 DMG 后能启动；Windows NSIS 能安装并启动；Linux AppImage 可执行，deb 可安装；
- 首次启动能进入锁定控制台，`/healthz` 正常；
- 全部为 **unsigned** 发布：macOS Gatekeeper 与 Windows SmartScreen 会拦截，按 Release
  notes 的绕过步骤操作。签名、公证与自动更新不在 v0.1.2 范围。

安装包内的 runtime 结构、本地打包与签名后续见
[`DESKTOP_RELEASE.md`](DESKTOP_RELEASE.md)。

## 7. 幂等、失败重跑与回滚

### 7.1 幂等

- 重跑流水线（重推同名分支或 Rerun failed jobs）安全：
  - 版本 SSOT 校验只读；
  - `publish` / `publish-dsh` 先 `npm view`，已发布版本自动 skip；
  - `visibility` 只读轮询，已可见时立即通过；
  - `release` 已存在则跳过创建；资产用 `--clobber` 覆盖。
- 若某包发布失败：修复后重新 push 同一 `release/v*` 分支即可，已成功的包会 skip。
- 若只是 registry 传播慢：重跑 `visibility` job 即可，不会重复发布。

### 7.2 失败重跑

| 失败位置 | 处理 |
| --- | --- |
| verify | 修版本 / CHANGELOG / 测试，重推同一分支。不要跳过 verify。 |
| preflight | 更新 `NPM_TOKEN`（granular + Bypass 2FA），再 Rerun failed jobs。 |
| 单个 desktop job | 先看 packaged runtime smoke 日志；修 runtime / builder 配置后重跑。其余平台成功产物保留。 |
| publish 部分包已发 | 直接重跑；已发布包 skip，未发布包继续。 |
| publish-dsh | 独立 job，重跑即可；不会重复发布同版本。 |
| visibility 超时 | 先看逐包状态：E404 = 版本未可见，latest 不符 = 传播未完成。等待后重跑 visibility；若某包确实没发成功，重跑 publish / publish-dsh。 |
| release | 重跑 `release` job；`gh release upload --clobber` 重传资产与 checksum。 |

### 7.3 回滚

- npm：见 [1.1 回滚指南](#11-回滚指南)。优先 `npm deprecate` + 更高修复版本。
- GitHub Release：只删/重传安装包不影响 npm；若要整体撤回，先处理 npm，再删除 Release 与
  tag（见 1.1）。
- 桌面安装包有问题但 npm 正常：删除或覆盖 Release 资产并重传 `SHA256SUMS.txt`；不需要
  重新发布 npm。
- 安装包已下载到用户机器：无法远程撤回；用 Release notes 和后续版本说明修复，签名后可在
  新版本收紧 Gatekeeper/SmartScreen 路径。

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| verify 报 `version=... != ...` | 分支名、6 个 manifest、lock、桌面版本、MCP 版本源或 CHANGELOG 不一致。先跑 `npm run verify:release-version` 定位。 |
| verify 报 `CHANGELOG.md 缺少 [vX.Y.Z]` | 未生成/未提交 CHANGELOG 章节；补内容并提交。 |
| verify 报 MCP `version.mjs` / 手写版本 | 用 `bash scripts/bump_version.sh` 重跑，或把新增版本使用点改为从 `packages/mcp/src/version.mjs` 导入。 |
| preflight 报 `NPM_TOKEN secret 未配置` | GitHub Secret 缺失或 job 无权限；补 secret。 |
| preflight 报 `E401` / `npm whoami` 失败 | token 过期、被 revoke 或不属于有权限的账号；重新生成 granular token。 |
| publish 报 `EOTP` / 需要一次性密码 | token 未勾选 **Bypass 2FA**，重新生成。 |
| publish 报 `E403` / scope 无权 | token 缺少 `@mebular` 的 Read and write，或 npm org 不存在。 |
| publish 报 `EPUBLISHCONFLICT` | 该版本已存在（幂等应已 skip）；确认版本号是否递增正确。 |
| desktop 报 tarball 版本不一致 | verify 的 tarball 与根版本不匹配；确认下载的是同一 run 的 `release-tarballs`。 |
| desktop 报缺少 `@mebular/core/packages/...` | 根包 `files` 未包含运行时目录；修 `package.json` 后重跑 verify。 |
| packaged smoke 找不到 `Resources` | electron-builder 产物路径变化；按日志检查 `dist/` 实际目录。 |
| Release 资产数不是 1 | 某个 desktop job 上传了额外文件或缺失；检查 artifact 内容后重跑。 |
| checksum 校验失败 | 下载不完整或资产被覆盖；重新下载，必要时重跑 release job。 |
| 安装 tarball 报找不到 `@mebular/*` | 检查 `scripts/publish-manifest.mjs` 是否在 prepack 生效、发布顺序是否完整。 |
| DSH 里看不到 `mcp__mebular__*` 工具 | App/daemon 未运行或端口不一致。先 `curl http://127.0.0.1:7331/healthz`，再核对 host 解析结果。 |
| DSH 工具调用报 `MCP_STORAGE_LOCKED` | 条目被改成 stdio，另起了第二个 Mebular 进程。改回 `streamable-http`。 |
| DSH 工具调用报 `NOT_INITIALIZED` | 尚未建新 / 加入忆云。在锁定控制台完成初始化，同一 MCP 会话自动恢复。 |
| release 报 `contents: write` 被拒 | 仓库 Actions 权限未开读写；见第 1 节。 |
| 本地 pack 后残留 `package.json.packbak` | 某次 pack 异常中断；删除该文件并检查 prepack/postpack 是否成对。 |

### 8.1 已合并远端分支清理

仓库**不开启** GitHub 的「合并后自动删除分支」（见 `.github/GITHUB_MAINTENANCE.md`），因此
清理必须手动、可审计。先 dry-run 列清单，确认后再删除：

```bash
git fetch --prune origin
node scripts/prune-merged-branches.mjs                 # 只列清单（默认）
node scripts/prune-merged-branches.mjs --json          # 机器可读清单
node scripts/prune-merged-branches.mjs --apply --yes   # 确认后删除
```

脚本的保护范围：

- 只列出已合并进 `--base`（默认 `origin/main`）的远端分支；
- 保护 `main` / `master` / `trunk` / `release/*` / `release-prep/*` / `site*` / `gh-pages`；
- 保护当前分支、所有 worktree 已检出的分支、仍有 open PR 的 head 分支；
- `gh` 不可用或未登录时，dry-run 会提示无法排除 open PR，`--apply` 会拒绝执行
  （除非显式 `--skip-open-pr-check`）。

发布分支本身在回合并 main 后，再用同一脚本或显式命令删除：

```bash
git push origin --delete release/v0.2.0 release-prep/v0.2.0
```

> 不要未经确认批量删除；不要删除 `site-*`（Pages 部署源）或仍有 open PR 的分支。

## 9. v0.1.0 首版发布清单（历史记录）

> 以下保留 v0.1.0 当时的操作记录，不再作为当前流程；新版本以第 2 节的
> `release-prep → dry-run → release → back-merge` 为准。
>
> 版本号已是 `0.1.0`、`CHANGELOG.md` 已含 `## [v0.1.0]` 章节，因此**不需要**再跑
> `bump_version.sh`。

### 9.1 执行前确认

- [ ] 本分支的文档物料已合并进 `main`，且 `main` 工作树干净。
- [ ] 第 1 节的一次性前置已完成：npm org `mebular`、granular `NPM_TOKEN`（Bypass 2FA）、
      Actions `Read and write permissions`。
- [ ] 五个 lockstep `package.json` 均为 `0.1.0`；桌面 `package.json` / lock / `APP_VERSION`
      一致；`CHANGELOG.md` 含 `## [v0.1.0]`。
- [ ] `packages/dsh-plugin/package.json` 版本为 `0.1.0`，`npm run verify:dsh-plugin` 通过。
- [ ] 插件包名 `@mebular/dsh-plugin` 可用；同版本重跑会被 `publish-dsh` 的 `npm view` 跳过。
- [ ] `npm run verify:star-map:multinode` 通过；六台真实守护、远端 `task_submit`、`fleet` SSE
      和 hover 航道均有记录。
- [ ] `npm run check:i18n`、`npm run check:deps`、`npm run check:docs` 均通过。
- [ ] 三平台 packaging dry-run 全绿；下载的资产文件名 / 数量 / 大小符合第 0.1 节。
- [ ] 发布说明按 9.3 的口径，不写旧流程（自动重启 / 去写入初始设置）。

### 9.2 精确命令序列

```bash
# 1) 从最新 main 切出版本分支（分支名即版本号，SSOT）
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c release/v0.1.0 origin/main

# 2) 只读核对 SSOT（不改任何文件）
grep -H '"version"' package.json packages/*/package.json apps/desktop/package.json
grep -n '^## \[v0.1.0\]' CHANGELOG.md
git status --short          # 应为空

# 3) 三平台 dry-run 在 R4 候选分支上完成；release/v0.1.0 一旦 push 即正式发布
git push -u origin release/v0.1.0
```

### 9.3 发布说明口径（Release notes / CHANGELOG）

发布说明必须写清以下事实，不要回到旧流程：

1. **首次 setup 不需要重启**：桌面「开始部署」启动本机守护并自动接入已装助手，然后进入锁定主
   控制台；首次新建 / 加入忆云由顶栏弹框完成，**不需要重启守护**。
2. **建新 / 加入后立即解锁**：初始化在同一进程、同一页面完成，控制台立即解锁；不刷新页面、
   不重载守护。完成后顶栏恢复「邀请设备 + 加入忆云」。
3. **MCP 未初始化行为**：HTTP `/mcp` 在未初始化时 `initialize` / `tools/list` 成功；
   `tools/call` 返回稳定的 `NOT_INITIALIZED`。建新 / 加入后同一 session 恢复，不需要重写助手
   配置或重启守护。
4. **备份与根密钥丢失处置**：首次 setup 生成主密钥后，第一时间离线备份
   `~/.mebular/user-master-key.json`（以及 `config.json` / 存储文件）；主密钥永不离开本机。
   v0.1.0 未实现主密钥轮换 / 换锚，丢失或被盗没有产品内恢复路径，详见
   [`LIMITATIONS.md`](../limitations/LIMITATIONS.md) 的 Root compromise 一节。
5. **CLI 仍可用**：`fleet quickstart` / `fleet join` 保留给脚本与批量场景；GUI 向导不会替用户
   选择或新建忆云。
6. **星图是主控制台**：主控制台展示忆云内全部设备、共同订阅基础边、hover 任务域航道与真实
   fleet 事件；蓝 / 金是任务域可达性，不是设备互连。
7. **DSH 不改变控制面**：App 仍是控制面，继续独立运行并持有存储、身份与控制台；DSH 是 agent
   面，只通过 HTTP MCP 接入，不使用 stdio，也不替换 App。
   DSH 侧边栏 Mebular 面板以 iframe 嵌入同一套 Console（`?embed=dsh`，仅 loopback），不是
   第二套控制台；daemon 地址由 host 按 `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331`
   在运行时发现，MCP client 也由 host 动态挂载。`@mebular/dsh-plugin` 独立版本 `0.1.0`，
   不进入五包 lockstep。
8. **桌面安装包**：macOS Universal DMG、Windows NSIS x64、Linux AppImage + deb x64；全部
   unsigned，首次打开按 Gatekeeper / SmartScreen 步骤绕过；安装前先核对 `SHA256SUMS.txt`。
   安装包 runtime 来自同一批 verify tarball，自带 Electron，不需要本机 Node.js。

不要把「自动重启」「去写入初始设置」写回发布说明，也不要把 `@mebular/mcp` 说成自带 `fleet`，
或把 unsigned 安装包写成已签名。

## 10. 发布前验证记录

验证对象：**R2 基线 + R3 文档改动**。代码 / 构建门禁来自 R1/R2 的真实记录（2026-10-23 至
2026-10-24）；R3 只改文档，因此文档提交后复跑 `check:docs` / `check:i18n` / `lint`。

| 命令 | 结果 | 关键输出 |
| --- | --- | --- |
| `npm run build` | ✅ | core / service / fleet 构建完成 |
| `npm test -- --runInBand` | ✅ | core 套件沿用 main 历史记录；desktop 229 tests 由 R1/R2 复核 |
| `npm run verify:console:ui` | ✅ | 388/388 checks（headless Chromium；1440 / 1024 / 390） |
| `npm run verify:star-map:multinode` | ✅ | 37/37；6 台真实 daemon |
| `npm run check:i18n` | ✅ | 32 checks / 0 failed |
| `npm run check:deps` | ✅ | 4/4 |
| `npm run lint` | ✅ | eslint 通过 |
| `npm audit --omit=dev` | ✅ | 0 vulnerabilities |
| `npm run check:docs` | ✅ | 7/7 |
| `npm run verify:mcp:publish` | ⏳ | 发布分支上由 Publish verify 重跑 |
| `npm run verify:dsh-plugin` | ✅ | bundle / patch / runtime bridge / client contract / tarball |
| DSH 真实 E2E | ✅ | `@deepseek-ai/dsh@0.2.1-rc.2`：sidebar iframe `?embed=dsh`、29 个 `mcp__mebular__*` |
| 桌面单元 / 契约 | ✅ | desktop 229 tests（R1/R2） |
| `prepare-runtime` + `smoke:runtime` | ✅ | 7 checks：`/healthz`、embed info、Console 安全头 |
| `dist:dir` + packaged runtime smoke | ✅ | 7 checks；从 `<resources>/node_modules` 启动 |
| `publish.yml` 结构 | ✅ | 8 jobs；`workflow_dispatch` dry-run；actionlint 通过 |
| 三平台 packaging dry-run | ⏳ | R4 在 GitHub runner 上执行 |

> 本表不替代发布分支上的 `build` / `lint` / `test:coverage` / `verify:mcp:publish` /
> `verify:dsh-plugin` 门禁；三平台安装包必须在 dry-run 中实际构建并冒烟后才能进入 R5。

### 10.1 已知问题（不阻塞 0.1.0）

- **桌面安装包为 unsigned 首发**：macOS 未签名 / 未公证，Windows 未签名；Gatekeeper 与
  SmartScreen 会提示，按 Release notes 绕过。签名、公证与自动更新留到后续版本。
- `mebular init` 的“下一步”提示仍使用仓库相对路径（`node packages/.../mebular.mjs`），对
  `npm install -g` 用户不适用；当前 README / QUICKSTART 的首次运行已改为 `mebular serve` +
  锁定控制台，不再依赖该提示。
- 部分源码注释仍写“记忆 11 项 / 共 27 工具”，实际注册表已是 13 记忆 + 16 任务 = 29
  （`check-surface-parity` 断言 29）。文档按代码实测的 29 编写；注释清理留待后续版本。
