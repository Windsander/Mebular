# DSH 真实 E2E 与 CI 门禁

面向 `@mebular/dsh-plugin` 的回归说明：在**真 daemon + 真 `@deepseek-ai/dsh` + 真
Chrome/CDP + 真 MCP 工具调用**上跑 P0 场景，并把它作为 nightly 信号、相关路径 PR
检查和发布门禁。

> 原则：前置条件缺失直接失败，不允许静默 SKIP；不 mock DSH，不硬编码工具总数。

相关文件：

| 文件 | 作用 |
| --- | --- |
| `scripts/verify-dsh-e2e.mjs` | 总编排（daemon / DSH / Chrome / 断言 / artifacts） |
| `scripts/lib/dsh-e2e-world.mjs` | 单场景隔离世界（home、profile、端口、进程、artifacts） |
| `tests/dsh/e2e/versions.json` | 最低 / 当前 DSH 版本 |
| `tests/dsh/e2e/fixtures/probe-plugin` | 仅测试用的 DSH probe 插件 |
| `.github/workflows/dsh-e2e.yml` | nightly / PR / push main / reusable workflow |
| `.github/workflows/publish.yml` | 发布门禁：`publish` / `release` 依赖 DSH E2E |

## 1. 本地运行

### 1.1 前置

- 已安装依赖并构建：`npm ci`（`prepare` 会构建），或手动 `npm run build`；
  `dist/index.js` 必须存在。
- 系统有 Chrome/Chromium；也可用 `CHROME_PATH` 指定。已缓存的 Playwright /
  Chrome for Testing 二进制会被自动发现。
- `pnpm` 在 PATH 上（`dsh plugin add` 会把参数转发给 pnpm；CI 固定 `12.15.0`）。
- 网络可访问 npm registry（首次需要下载 `@deepseek-ai/dsh`，之后走 npm 缓存）。
- 不需要 DeepSeek API key；本项目不启动真实模型对话。

缺少任一前置时命令以退出码 1 结束，不会“跳过并通过”。

### 1.2 命令

```bash
# 默认：tests/dsh/e2e/versions.json 的 minimum
npm run verify:dsh:e2e

# 显式最低版 / npm latest
npm run verify:dsh:e2e:min
npm run verify:dsh:e2e:latest

# 单场景 + 保留成功现场
npm run verify:dsh:e2e -- --scenario daemon-down-recovery --keep

# 列出场景
npm run verify:dsh:e2e -- --list
```

`--dsh-version` 接受 semver、`minimum`、`current` 或 `latest`：

```bash
node scripts/verify-dsh-e2e.mjs --dsh-version 0.2.1-rc.2
node scripts/verify-dsh-e2e.mjs --dsh-version minimum
node scripts/verify-dsh-e2e.mjs --dsh-version latest
```

### 1.3 固定 artifacts 根目录（CI 使用）

默认使用系统临时目录下的随机 `mebular-dsh-e2e-*`，成功清理、失败保留。CI 需要稳定
上传路径，因此支持显式根目录：

```bash
node scripts/verify-dsh-e2e.mjs \
  --dsh-version latest \
  --root "$RUNNER_TEMP/dsh-e2e/latest"

# 等价
MEBULAR_DSH_E2E_ROOT="$RUNNER_TEMP/dsh-e2e/latest" \
  npm run verify:dsh:e2e -- --dsh-version latest
```

安全语义：

- `--root` 必须是**不存在、空目录，或带 harness 标记的上一次失败现场**；
  非空且没有 `.mebular-dsh-e2e-root.json` 时直接拒绝。
- 拒绝文件系统根目录、用户主目录，以及与仓库目录重叠的路径（防止误删）。
- `--root` 本身是符号链接时直接拒绝；已存在路径及其最近存在的祖先都会用 `realpath`
  复核，避免通过 symlink 绕过仓库/主目录/根目录重叠检查。
- 成功时：harness 自己创建的根目录整体删除；用户预先创建的空目录只删除 harness
  拥有的条目（`scenario-*` / `pack` / `dsh-install` / 标记文件），目录本身保留。
- 失败时：无论是否 `--keep` 都保留现场；`--keep` 额外让成功场景也保留。

CI 固定到 `$RUNNER_TEMP/dsh-e2e/<matrix.dsh>`（`0.2.1-rc.2` / `latest`）。

## 2. CI 触发与矩阵

`.github/workflows/dsh-e2e.yml`：

| 触发 | 范围 | 说明 |
| --- | --- | --- |
| `schedule` | 每天 `0 3 * * *` UTC（北京时间 11:00） | nightly 先发现 DSH 新版本破坏 |
| `workflow_dispatch` | 手动 | 复现失败 / 版本升级验证 |
| `workflow_call` | 由 `publish.yml` 调用 | 发布门禁 |
| `pull_request` | 相关路径 | `packages/dsh-plugin/**`、`packages/mcp/**`、`packages/console/**`、`tests/dsh/**`、`scripts/verify-dsh-e2e.mjs`、`scripts/lib/**`、workflow 自身，以及 daemon/Console 依赖的 `src/**`、`packages/service/**`、`packages/fleet/**`、`package.json`、`package-lock.json` |
| `push` `main` | 同一路径过滤 | 保证主干有基线 |

矩阵：

| label | DSH 版本 | Node | 说明 |
| --- | --- | --- | --- |
| `minimum` | `0.2.1-rc.2` | 24 | 与 `tests/dsh/e2e/versions.json` 的 `minimum` 对齐（workflow 内有 SSOT 校验） |
| `latest` | `latest` | 24 | 夜间 / 发布前发现新版破坏 |

- `fail-fast: false`：两档都跑完再汇总。
- 单 job `timeout-minutes: 45`。
- 每个 job 准备 pnpm（`dsh plugin add` 需要；CI 固定精确版本 `12.15.0`）和 Chrome/Chromium。
  Chrome 直接探测 `ubuntu-latest` 预装的 `google-chrome` / `google-chrome-stable` /
  `chromium` / `chromium-browser`，不引入第三方 action；缺少时显式 `::error::` 并退出，
  不会静默 SKIP。
- npm 缓存由 `actions/setup-node` 提供；pnpm store 单独缓存。
- PR 更新会取消同一 PR 的旧 run；`main` push / nightly 不取消。

## 3. Artifacts

失败时每个矩阵 job 上传：

- `<root>/scenario-*/artifacts/`：`scenario.json`、`seed.json`、`dsh-log.txt`、
  `daemon-log.txt`、`dsh-dump-config.yml`、`runtime.json`、`profiles.json`、
  `healthz.json`、`embed-info.json`、`dsh-embed-info.json`、`probe.json`、
  `browser-errors.json`、`browser-dom.html`、`headers.json`（安全头场景）、
  `redaction-audit.json`、`screenshot.png`（能采集时）；
- harness 控制台日志 `dsh-e2e-<version>-harness.log`。

所有文本在落盘前经过 `scripts/lib/redact.mjs`；`redaction-audit.json` 有泄漏时场景
直接判失败。artifact 保留 14 天，名称为 `dsh-e2e-<label>-<run_attempt>`。

成功时 harness 清理根目录，CI 再兜底删除固定路径，避免残留。

本地下载：

```bash
gh run download <run-id> -n dsh-e2e-minimum-1 -D dsh-e2e-minimum
```

## 4. Release gate

`publish.yml` 中的 `dsh-e2e` job 直接复用本 workflow：

```text
verify
  ├─ dsh-e2e（reusable：minimum + latest）
  ├─ preflight（push only）
  └─ desktop-macos / desktop-windows / desktop-linux
        │
        ▼
     publish（needs 含 dsh-e2e；E2E 失败则不启动）
        │
        ▼
     publish-dsh → visibility → release（needs 含 dsh-e2e）
```

效果：

- DSH E2E 任一阵列失败，`publish` 不运行，六个 npm 包都不会发布；
  `publish-dsh` / `visibility` / `release` 因依赖链同样不运行，GitHub Release 不会创建。
- `workflow_dispatch` packaging dry-run **也跑** E2E，但不发布 npm / Release；这样
  `release-prep` 的 dry-run 与正式发布覆盖同一道门。
- `release` 的 `if` 也显式要求 `needs.dsh-e2e.result == 'success'`，避免以后调整
  `publish` 依赖时把门禁漏掉。

## 5. 升级 / 调整 DSH 版本

1. 先本地确认新版本：

   ```bash
   npm run verify:dsh:e2e:latest
   npm run verify:dsh:e2e:min
   ```

2. 需要提高最低支持版本时，同步修改：
   - `tests/dsh/e2e/versions.json` 的 `minimum` / `current`；
   - `.github/workflows/dsh-e2e.yml` 矩阵 `minimum.dsh`（CI 会校验两者一致）；
   - 本文档与 `tests/dsh/e2e/README.md` 的版本说明；
   - `package.json` 的 `verify:dsh:e2e:min` 使用 `--dsh-version minimum`，无需改硬编码。
3. nightly `latest` 失败但最低版通过时：
   - 先判断是 DSH 上游破坏还是插件回归；
   - 若是上游 breaking change，记录 issue，决定“提高最低版 / 临时排除 latest / 修插件”；
   - 不允许通过把 E2E 改成 SKIP 或删断言来换绿。
4. 发布前至少确认 `minimum` 与 `latest` 两档都通过；dry-run 会实际执行两者。

> `dsh-e2e` 暂不设为 `main` 的 required check：先观察 nightly / PR 稳定性，再按
> `.github/GITHUB_MAINTENANCE.md` 的流程调整 ruleset。

## 6. 失败排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `repo build present` 失败 | 未构建；在仓库根执行 `npm run build`。CI 在 E2E 前已构建。 |
| `pnpm available` 失败 | 安装 `pnpm`；CI 用 `npm install -g pnpm@12.15.0`，并校验版本必须精确匹配。 |
| `Chrome/Chromium available` 失败 | 安装 Chrome 或设置 `CHROME_PATH`；CI 探测 `ubuntu-latest` 预装二进制，找不到即失败。 |
| `npm install @deepseek-ai/dsh@...` 失败 | 版本不存在 / 网络 / registry 故障；先用 `npm view @deepseek-ai/dsh versions` 核对。 |
| `dsh web:` URL 超时 | 看 `dsh-log.txt`；常见为 profile 安装不完整、pnpm 权限、端口被占用。 |
| 侧边栏 / 状态点找不到 | 看 `browser-errors.json`、`browser-dom.html`、`dsh-dump-config.yml`；确认只有一条 `mebular` host row。 |
| `mcp__mebular__*` 为 0 | daemon 未启动或 origin 不一致；看 `probe.json`、`dsh-embed-info.json`、`daemon-log.txt`。 |
| iframe 未出现 / 地址错误 | 看 `embed-info.json` 与 `daemon-log.txt`；确认 `MEBULAR_HTTP_PORT` / runtime.json 解析。 |
| `artifacts 已脱敏` 失败 | 新增日志带出了未覆盖的敏感形状；扩展 `scripts/lib/redact.mjs` 并复跑。 |
| 偶发浏览器 flake | 先单场景复跑：`--scenario happy-path --keep`；仍失败按 artifacts 定位，不要直接重跑到绿。 |
| `--root` 被拒绝 | 目录非空且无 harness 标记，或与仓库/主目录重叠；换空目录或清理旧现场。 |

本地复跑失败场景：

```bash
npm run verify:dsh:e2e -- --scenario happy-path --keep
npm run verify:dsh:e2e -- --scenario daemon-down-recovery
npm run verify:dsh:e2e -- --scenario security-headers --keep
```

## 7. 已知缺口

- 不覆盖 DSH Desktop 的 origin / HTTPS / 自定义 scheme；当前只覆盖 DSH Web（loopback）。
- 非 loopback 的 `X-Frame-Options` / `frame-ancestors` 由单测覆盖，不在本 E2E 里启动
  TLS daemon。
- 不验证真实 DeepSeek 模型对话；probe 走 DSH tool registry，不发模型请求。
- Node 22.19 smoke、managed 生命周期、Agent 状态文本属于后续阶段，当前矩阵只有 Node 24。
- GitHub Actions 的首次真实运行需要在 workflow 进入默认分支后手动 `workflow_dispatch`
  或等 nightly；本文档与本地校验不声称“CI 已绿”。
