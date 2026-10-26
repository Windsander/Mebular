# DSH 真实 E2E 与 CI 门禁

面向 `@mebular/dsh-plugin` 的回归说明：在**真 daemon + 真 `@deepseek-ai/dsh` + 真
Chrome/CDP + 真 MCP 工具调用**上跑 P0 失败/恢复与 P1 managed/Agent 场景，并把它作为
nightly 信号、相关路径 PR 检查和发布门禁。另有测试专用的 negative control，证明坏插件
会让门禁变红。

> 原则：前置条件缺失直接失败，不允许静默 SKIP；不 mock DSH，不硬编码工具总数；
> managed 只回收自己启动的 child，外部 daemon 永不停止。

相关文件：

| 文件 | 作用 |
| --- | --- |
| `scripts/verify-dsh-e2e.mjs` | 总编排（daemon / DSH / Chrome / 断言 / artifacts） |
| `scripts/lib/dsh-e2e-world.mjs` | 单场景隔离世界（home、profile、端口、进程、artifacts） |
| `tests/dsh/e2e/versions.json` | 最低 / 当前 DSH 版本 |
| `tests/dsh/e2e/fixtures/probe-plugin` | 仅测试用的 DSH probe 插件 |
| `tests/dsh/e2e/negative-control.mjs` | 故障注入（test-of-test）：坏插件必须让 E2E 判红 |
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

# 故障注入：故意破坏插件的 panel 注册，E2E 必须变红
npm run verify:dsh:e2e:negative

# 列出场景
npm run verify:dsh:e2e -- --list
```

`--dsh-version` 接受 semver、`minimum`、`current` 或 `latest`：

```bash
node scripts/verify-dsh-e2e.mjs --dsh-version 0.2.1-rc.2
node scripts/verify-dsh-e2e.mjs --dsh-version minimum
node scripts/verify-dsh-e2e.mjs --dsh-version latest
```

### 1.3 场景矩阵

| 场景 | 覆盖 | 关键断言 |
| --- | --- | --- |
| `happy-path` | P0 全链路 | sidebar、`connected`、iframe、Console `dataset.embed=dsh`、关键工具注册、真实只读调用 |
| `daemon-down-recovery` | P0 失败/恢复 | 启动 down；运行中启动 daemon 自动恢复；掉线自动注销；同端口重启再恢复；DSH pid 不变 |
| `panel-false` | P0 面板隔离 | `panel:false` 全局、无 sidebar/iframe、工具仍可调用 |
| `custom-port` | P0 发现顺序 | `MEBULAR_HTTP_PORT` 覆盖冲突 runtime；面板/发现文档/MCP 同源 |
| `uninstall` | P0 卸载隔离 | `plugin remove` 后 daemon 与 Console 不受影响 |
| `security-headers` | P0 安全头 | 普通 Console DENY；embed 只放开 loopback；发现文档无敏感字段 |
| `managed-lifecycle` | P1 managed 启动 | 无 daemon 时插件自启 child；`managed=true`；runtime.json pid 存活且非 DSH；停 DSH 后 child 退出、端口关闭 |
| `managed-reuse` | P1 managed 复用 | 外部 daemon 已存在时 `managed=false`；停 DSH 后外部 daemon、`/healthz`、`/console/`、runtime.json 均存活 |
| `managed-cli-missing` | P1 managed 失败 | `down`、`reason=download_required`、`state=download_required`、`downloadRequired=true`、无工具、Agent 文本给出安装/CLI/配置恢复动作 |

Agent 可见状态在 `happy-path`、`panel-false`、`custom-port`、managed 场景中断言 up 时
`mebular:status` 为空；在 `daemon-down-recovery` 断言 down 时非空、恢复后重新为空。文本全部通过
DSH 的 `ctx.inject(['systemPrompt'])` + `assemble()` 读取，不读 DOM。

### 1.4 固定 artifacts 根目录（CI 使用）

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

### 1.5 故障注入 / negative control（test-of-test）

全绿的 E2E 只有在“坏插件会变红”时才可信。negative control 不改生产插件：

1. 把 `packages/dsh-plugin` 复制到临时目录；
2. 把副本 `cordis.patch.yml` 的 `panel: true` 改成 `panel: false`（MCP 仍挂载，但不再注册
   sidebar / 面板）；
3. `npm pack` 出坏插件 tarball；
4. 用测试专用 `--plugin-tarball <bad.tgz>` 跑 `verify-dsh-e2e --scenario happy-path`；
5. 断言 harness 退出码非 0，输出包含 `✗ 侧边栏存在唯一的 Mebular 入口` 与
   `✗ Mebular 面板 iframe 已挂载`；同时 probe 与工具断言仍为 `✓`，证明失败来自 UI 注册，
   而不是 preflight 短路或 DSH 没起来；
6. 清理临时目录（`--keep` 或出现意外结果时保留现场）。

```bash
npm run verify:dsh:e2e:negative
npm run verify:dsh:e2e:negative -- --dsh-version latest
npm run verify:dsh:e2e:negative -- --keep    # 保留坏插件与失败 artifacts
```

`--plugin-tarball` 是显式测试覆盖；不传时仍从 `packages/dsh-plugin` 打包，默认行为不变。
negative control 是 test-of-test，**不放进 nightly / release**（会让 E2E 成本翻倍）；发布前
或修改 E2E 断言时应手动跑一次。它不替代正式 E2E，也不增加发布门禁的运行时。

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

| label | DSH 版本 | Node | 场景 | 说明 |
| --- | --- | --- | --- | --- |
| `minimum` | `0.2.1-rc.2` | 24 | 全部 9 个 | 与 `tests/dsh/e2e/versions.json` 的 `minimum` 对齐（workflow 内有 SSOT 校验） |
| `latest` | `latest` | 24 | 全部 9 个 | 夜间 / 发布前发现新版破坏 |
| `node22-minimum` | `0.2.1-rc.2` | 22.19 | `happy-path` | 仅 `schedule` / `workflow_dispatch`；验证 Node 22.19 兼容性，不增加 PR 成本 |

- `fail-fast: false`：所有已启用档位都跑完再汇总。
- Node 22.19 smoke 在 `pull_request` / `push main` / `workflow_call` 上跳过，只在 nightly
  和手动 dispatch 运行。
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

`probe.json` 额外记录 Agent 可见状态：`agent.supported`（`true` 成功 / `null` 未注入 /
`false` 不可用）、`agent.sectionPresent`、`agent.text`、`agent.textLength`、
`agent.error` 和按工具数量去重的 `agentHistory`。managed 场景成功退出后 `runtime.json`
可能已被 child 清理，artifact 会写成合法的 `null`，而不是空文件。

成功时 harness 清理根目录，CI 再兜底删除固定路径，避免残留。

### 3.1 Managed 生命周期与 Agent 状态证据

- **child 归属**：`managed-lifecycle` 在启动前没有任何 daemon，插件按 profile 的
  `lifecycle: managed` + `cliPath` 自启 child；harness 从临时 home 的 `runtime.json`
  读取 pid，断言 pid 存活、不是 DSH pid、与 `/mebular/embed-info` 同端口。停止 DSH 后
  单独等待该 pid 消失并确认端口关闭。
- **外部 daemon 不受影响**：`managed-reuse` 先启动真实外部 daemon，插件探测健康后直接复用
  （`mode=managed`、`managed=false`）。停止 DSH 后外部 pid、`/healthz`、`/console/` 与
  `runtime.json` 仍存在。插件只在 dispose 时停止自己 spawn 的 child，永不停止外部 daemon。
- **CLI 缺失**：`managed-cli-missing` 让 `cliPath` 指向不存在路径，并从 PATH 移除所有能
  解析到 `mebular` 的目录；期望 `status=down`、`reason=download_required`、
  `state=download_required`、`downloadRequired=true`、无 `mcp__mebular__*` 工具，且 Agent 文本
  包含安装/`MEBULAR_CLI`/`cliPath` 与重启 DSH 的恢复动作。面板显示显式安装引导。
- **Agent 文本**：全部通过 DSH 的 `systemPrompt.assemble()` 读取 `mebular:status` section；
  daemon up 时文本为空（不增加 prompt token），down 时非空且给出恢复动作。`systemPrompt`
  不可用或 `assemble()` 失败会记录为 `supported=null/false` 或 error，场景失败，不会伪造通过。

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

PR 创建后必须等 `dsh-e2e` 在真实 GitHub runner 上跑通，才算本次变更的验收完成；本地全绿
不能替代首次 runner。合并后 nightly 继续回归。本文档只记录本地证据，不预先声称 runner 已绿。

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
| `managed-lifecycle` 的 child pid 立即消失 / 端口未监听 | 看 `dsh-log.txt` 里 `managed daemon ...` 行与 `dsh-dump-config.yml` 的 `cliPath`；确认 CLI 可执行、端口未被占用。 |
| `managed-reuse` 报 `managed=true` | 插件启动前探测到了可复用 daemon 但随后自己 spawn；检查外部 daemon 的 `runtime.json` pid 是否仍存活、`MEBULAR_HTTP_PORT` 是否误指别处。 |
| `managed-cli-missing` 变成 up | PATH 上仍有 `mebular`，或 `cliPath` 指向了存在的文件；看失败输出里的过滤后 PATH，确认 `node` 仍可用但 `mebular` 不可解析。 |
| Agent 文本断言失败 | 看 `probe.json` 的 `agent` / `agentHistory`：`supported=null/false` 表示 `systemPrompt` 服务未注入；有 error 表示 `assemble()` 抛错。不要用 DOM 文案替代。 |
| 偶发浏览器 flake | 先单场景复跑：`--scenario happy-path --keep`；仍失败按 artifacts 定位，不要直接重跑到绿。 |
| `--root` 被拒绝 | 目录非空且无 harness 标记，或与仓库/主目录重叠；换空目录或清理旧现场。 |

本地复跑失败场景：

```bash
npm run verify:dsh:e2e -- --scenario happy-path --keep
npm run verify:dsh:e2e -- --scenario daemon-down-recovery
npm run verify:dsh:e2e -- --scenario managed-lifecycle --keep
npm run verify:dsh:e2e -- --scenario managed-reuse --keep
npm run verify:dsh:e2e -- --scenario managed-cli-missing --keep
npm run verify:dsh:e2e -- --scenario security-headers --keep
```

## 7. 已知缺口

- 不覆盖 DSH Desktop 的 origin / HTTPS / 自定义 scheme；当前只覆盖 DSH Web（loopback）。
- 非 loopback 的 `X-Frame-Options` / `frame-ancestors` 由单测覆盖，不在本 E2E 里启动
  TLS daemon。
- 不验证真实 DeepSeek 模型对话；probe 走 DSH tool registry，不发模型请求。
- managed 生命周期与 Agent 状态文本已覆盖；Node 22.19 的 `happy-path` smoke 已本地通过，
  CI 只在 nightly / manual 运行该档，PR 与 release gate 不含 Node 22.19。首次真实 runner
  结果属于 PR 验收的一部分。
- `managed-cli-missing` 依赖 PATH 上没有可解析的 `mebular`。harness 会过滤包含 `mebular`
  的 PATH 目录并保留 `node`；若宿主把 `node` 与 `mebular` 放在同一目录，场景会明确失败，
  不会静默 SKIP。
- GitHub Actions 的首次真实运行发生在 PR（workflow 进入默认分支后也可手动
  `workflow_dispatch`）；PR runner 结果属于验收的一部分，本文档与本地校验不声称“CI 已绿”。
- negative control 只覆盖“移除 sidebar/panel 注册”这一类破坏；工具注册、managed 生命周期
  等回归仍由正式 9 场景覆盖，不把 negative control 当作全量故障注入矩阵。
