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
| `@mebular/dsh-plugin` | `packages/dsh-plugin` | DeepSeek Harness 插件；**独立版本线**，不参与 lockstep |

- **版本策略**：5 个 lockstep 包（`core` / `service` / `skill` / `mcp` / `fleet`）永远同版本号。
- **独立版本包**：`@mebular/dsh-plugin` 与 v0.1.0 同一 release train 首发（自身版本 `0.1.0`），
  但版本号只取自 `packages/dsh-plugin/package.json`；`bump_version.sh` 不改它，verify 的
  5 包 SSOT 校验也不包含它。
- **安装入口**：`npm install -g @mebular/core` 是根包，同时提供 `mebular` + `fleet` 两个 bin；
  `@mebular/mcp` 单独安装只有 `mebular`，**不能**当作双 bin 安装入口。
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
      之后版本仅需递增。`@mebular/dsh-plugin` 独立发布，首发同时占用该包名。
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

`bump_version.sh` 只处理 5 个 lockstep 包；`@mebular/dsh-plugin` 的版本单独在
`packages/dsh-plugin/package.json` 维护，不随 `bump_version.sh` 变化。

然后**手工填写** `CHANGELOG.md` 中该章节的 Added / Changed / Fixed（Release notes 取自此章节）。

### 2.2 本地预检（可选但推荐）

```bash
npm ci
npm run build
npm run lint
npm run test:coverage        # 覆盖率门槛在 package.json#jest.coverageThreshold
npm run verify:mcp:publish   # 5 包 npm pack + tarball 干净安装冒烟
npm run verify:dsh-plugin    # 插件契约：package.json / patch / 无 @mebular import / tarball
npm run check:docs           # 文档一致性 7/7
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
3. **publish-dsh**（`needs: publish`，独立版本）：
   - 从 `packages/dsh-plugin/package.json` 读取版本，先 `npm view @mebular/dsh-plugin@<version>`：
     已存在则 **skip**，否则 `(cd packages/dsh-plugin && npm publish --access public)`。
   - 不进入 5 包 SSOT 校验，也不由 `bump_version.sh` 改写版本。
4. **release**（`needs: [publish, publish-dsh]`）：从 `CHANGELOG.md` 抽取 `## [v0.2.0]` 章节生成
   Release notes，创建 GitHub Release 并回打 tag `v0.2.0`（已存在则 skip）。

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
  - `publish-dsh` 同样先查 `npm view`，插件版本已发布则 skip；
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
| DSH 里看不到 `mcp__mebular__*` 工具 | App/daemon 未运行或端口不一致。先 `curl http://127.0.0.1:7331/healthz`，再核对 profile patch 的 `url` 与 `mcp.http.port`。 |
| DSH 工具调用报 `MCP_STORAGE_LOCKED` | 条目被改成 stdio，另起了第二个 Mebular 进程。改回 `streamable-http`；stdio 会与 App 抢 storage lock。 |
| DSH 工具调用报 `NOT_INITIALIZED` | 尚未建新 / 加入忆云。在锁定控制台完成初始化，同一 MCP 会话自动恢复，无需重启。 |
| release 报 `contents: write` 被拒 | 仓库 Actions 权限未开读写；见第 1 节。 |
| 本地 pack 后残留 `package.json.packbak` | 某次 pack 异常中断；删除该文件并检查 prepack/postpack 是否成对。 |

## 6. 回滚

npm 不允许覆盖已发布版本。具体步骤见 [1.1 首次发布后回滚指南](#11-首次发布后回滚指南)：
`npm unpublish` 仅限 72 小时窗口，常规走 `npm deprecate` + 发布更高修复版本。

## 7. v0.1.0 首版发布清单（物料已备齐，待主控执行）

> 本节只列**待执行**动作；发布分支切割、push 与 tag 由主控在合并后完成。
> 版本号已是 `0.1.0`、`CHANGELOG.md` 已含 `## [v0.1.0]` 章节，因此**不需要**再跑
> `bump_version.sh`（脚本幂等：版本号相同、章节已存在会直接跳过）。

### 7.1 执行前确认

- [ ] 本分支的文档物料已合并进 `main`，且 `main` 工作树干净。
- [ ] 第 1 节的一次性前置已完成：npm org `mebular`、`NPM_TOKEN`（Automation）、
      Actions `Read and write permissions`。
- [ ] 五个 `package.json` 版本均为 `0.1.0`，`CHANGELOG.md` 含 `## [v0.1.0]` 章节。
- [ ] `packages/dsh-plugin/package.json` 版本为 `0.1.0`，`npm run verify:dsh-plugin` 通过
      （57 项：manifest / HTTP patch / host entry / 无 `@mebular/*` import / tarball）。
- [ ] 插件发布前确认 `@mebular/dsh-plugin` 包名可用；同版本重跑会被 `publish-dsh` 的
      `npm view` 检查跳过。
- [ ] 当前 `main` 的发布门禁记录已核对（见第 8 节）；release 分支 push 后由 Publish verify
      重跑 `build` / `lint` / `test:coverage` / `verify:mcp:publish`。
- [ ] `npm run verify:star-map:multinode` 通过；六台真实守护、远端 `task_submit`、`fleet` SSE
      和 hover 航道均有记录。
- [ ] `npm run check:i18n`、`npm run check:deps`、`npm run check:docs` 均通过。
- [ ] 发布说明按 7.5 的口径撰写，不写旧流程（自动重启 / 去写入初始设置）。

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
3. **publish-dsh**：读取 `packages/dsh-plugin/package.json` 的版本，`@mebular/dsh-plugin`
   已存在则 skip，否则单独发布（不参与 5 包 lockstep / SSOT）。
4. **release**：`needs: [publish, publish-dsh]`；从 `CHANGELOG.md` 抽取 `## [v0.1.0]` 章节生成
   notes，创建 tag `v0.1.0` 与 GitHub Release。

### 7.4 发布后核验

```bash
for p in core service skill mcp fleet; do npm view "@mebular/$p@0.1.0" version; done
npm view @mebular/dsh-plugin@0.1.0 version
gh release view v0.1.0

# 根包双 bin：mebular + fleet
npm install -g @mebular/core@0.1.0
command -v mebular && command -v fleet
mebular tools >/dev/null && fleet --version
```

> 不要用 `npm install -g @mebular/mcp@0.1.0` 冒充双 bin 安装：`@mebular/mcp` 只提供
> `mebular`，`fleet` 必须来自根包（或单独安装 `@mebular/fleet`）。

插件独立验证（先让 App / 守护运行）：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.0
dsh web --dump-config | grep -A3 mebular    # transport: streamable-http，url .../mcp
# DSH 会话中确认 mcp__mebular__* 可调用；App 与控制台仍在运行
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

### 7.5 发布说明口径（Release notes / CHANGELOG）

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
   fleet 事件；蓝 / 金是任务域可达性，不是设备互连。README 截图只做展示，不能替代六台真实守护
   的 E2E 证据。
7. **DSH 不改变控制面**：App 仍是控制面，继续独立运行并持有存储、身份与控制台；DSH 是 agent
   面，只通过 HTTP MCP（`http://127.0.0.1:7331/mcp`）接入，不使用 stdio，也不替换 App。
   控制台入口从 DSH 面板在新标签页打开，不做 iframe。`@mebular/dsh-plugin` 独立版本 `0.1.0`，
   不进入五包 lockstep。

不要把「自动重启」「去写入初始设置」写回发布说明，也不要把 `@mebular/mcp` 说成自带 `fleet`。

## 8. 发布前验证记录

验证对象：**当前 `main`**，执行日期 2026-10-23。基线包含 onboarding v2、星图 / fleet
网络、`#227` 四张 README 截图、`#228` 主题化配图和 `#229` 脉冲边缘渐隐。以下记录以本轮
真实门禁为准，不复用旧 `m0/release-v010` 基线数字。

| 命令 | 结果 | 关键输出 |
| --- | --- | --- |
| `npm run build` | ✅ 当前 main | core / service / fleet 构建完成 |
| `npm test -- --runInBand` | ✅ 当前 main | **177 suites / 1616 tests** 全过 |
| `npm run verify:console:ui` | ✅ 当前 main | **388/388** checks（headless Chromium；1440 / 1024 / 390，含 i18n、安全流程、星图图例） |
| `npm run verify:star-map:multinode` | ✅ 当前 main | **37/37**；6 台真实 daemon，`baseEdgeCount=15`、`solid=10`、`dashed=5`；hover B 9 条 / hover F 5 条；真实 MCP `task_submit` 与 `fleet` SSE |
| `npm run check:i18n` | ✅ 当前 main | **32 checks / 0 failed**；console / desktop / errors 三套 locale pack |
| `npm run check:deps` | ✅ 当前 main | **4/4**；16 项运行时依赖均在 `THIRD-PARTY.md` |
| `npm run lint` | ✅ 当前 main | eslint 通过 |
| `npm audit --omit=dev` | ✅ 当前 main | **0 vulnerabilities** |
| `npm run check:docs` | ✅ 当前 main | **7/7**；README EN/CN 结构、互链、无手写测试数字、CI badge、工具名、本地链接 |
| README 视觉走查 | ✅ 当前 main | 四张星图均 1600×1000、6 颗星；baseline 灰虚线 / 压暗实线 / 声波脉冲；lanes 旧版弧线航道；亮色 banner + 三组示意图使用 `<picture>` 切换 |
| `npm run verify:mcp:publish` | ⏳ 待 release 流水线 | 发布前必须在 `release/v0.1.0` 由 Publish verify 重跑 |
| `npm run verify:dsh-plugin` | ✅ 当前 main | **57 checks**：bundle / HTTP patch / host entry / no core imports / tarball |
| 真实 DSH `0.2.1-rc.2` | ✅ 当前 main | `dsh plugin add link:`；host + MCP client 运行；Settings 出现 Mebular 面板；29 个 `mcp__mebular__*` 工具；console 独立可开；App/daemon 不受影响 |

> 第 8 节记录的是当前 `main` 已完成的发布门禁；它**不替代**发布分支上的
> `build` / `lint` / `test:coverage` / `verify:mcp:publish` / `verify:dsh-plugin` 门禁。
> `desktop:smoke` / `verify:onboarding` 的上一轮集成结果仍保留在历史记录中；本轮星图变更
> 未改动守护、引导和 Electron 主进程，因此不重复计入本轮数字。

### 8.1 已知问题（不阻塞 0.1.0）

- **桌面 App 在 v0.1.0 仍是源码运行（M1 壳）**，不附带签名 / 公证安装包；README 的桌面
  路径从源码启动，浏览器 / CLI 是当前的一键安装路径。安装包分发与自动更新留待后续版本。
- `mebular init` 的“下一步”提示仍使用仓库相对路径（`node packages/.../mebular.mjs`），对
  `npm install -g` 用户不适用；当前 README / QUICKSTART 的首次运行已改为 `mebular serve` +
  锁定控制台，不再依赖该提示。
- 部分源码注释仍写“记忆 11 项 / 共 27 工具”，实际注册表已是 13 记忆 + 16 任务 = 29
  （`check-surface-parity` 断言 29）。文档按代码实测的 29 编写；注释清理留待后续版本。
