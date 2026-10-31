# DSH 真实 E2E（P0 失败/恢复 + P1 managed/Agent 矩阵）

一条命令在“真 daemon + 真 DSH + 真浏览器 + 真工具调用”上跑完首发 P0 与本阶段 P1：

```bash
npm run verify:dsh:e2e                 # versions.json 的 minimum
npm run verify:dsh:e2e:min             # 最低支持版本
npm run verify:dsh:e2e:latest          # npm latest
npm run verify:dsh:e2e -- --scenario daemon-down-recovery
npm run verify:dsh:e2e -- --scenario managed-lifecycle --keep
npm run verify:dsh:e2e -- --scenario panel-false --keep
npm run verify:dsh:e2e:negative        # 故障注入：坏插件必须判红
npm run verify:dsh:e2e -- --list        # 列出场景名
node scripts/verify-dsh-e2e.mjs --dsh-version minimum
node scripts/verify-dsh-e2e.mjs --dsh-version latest --root "$TMPDIR/dsh-e2e/latest"
node scripts/verify-dsh-e2e.mjs --scenario happy-path --plugin-tarball ./bad.tgz
```

`--keep` 在成功时也保留临时目录和 artifacts。失败时无论是否加 `--keep` 都会保留现场。
`--root`（或 `MEBULAR_DSH_E2E_ROOT`）把现场固定到指定目录，CI 用它上传稳定路径；
目录必须不存在、为空，或带 harness 标记，且不能与仓库/主目录重叠。`--plugin-tarball`
只用于显式测试覆盖（negative control）；不传时仍从 `packages/dsh-plugin` 打包。

CI 触发、矩阵、artifacts 与 release gate 见
[`docs/operations/DSH_E2E.md`](../../../docs/operations/DSH_E2E.md)。

## Memory Runtime E2E（fake Runtime，无外部模型）

```bash
npm run verify:dsh:memory-runtime                 # enabled + disabled
npm run verify:dsh:memory-runtime -- --scenario enabled
npm run verify:dsh:memory-runtime -- --scenario disabled --keep
```

复用 `scripts/lib/dsh-e2e-world.mjs` 的真实 DSH Web profile，但把 Memory Runtime
sidecar 换成本地 `tests/dsh/e2e/fake-runtime-server.mjs`：不启动模型、不读写用户
home。覆盖 pre-step `/context` 注入/anchor 去重、工具遮蔽与 `tools/change` 重放、
compaction checkpoint、ingest 重试/幂等、bearer 认证，以及 `memoryRuntime` 关闭时零
`/memory-runtime/v1` 请求。前置仍是构建产物、Mebular CLI、pnpm 和可安装的
`@deepseek-ai/dsh`；不需要 Chrome。CI 中它是 `.github/workflows/dsh-e2e.yml` 的独立
`memory-runtime` job，不影响真实 DSH 矩阵的时长。

## Negative control（test-of-test）

```bash
npm run verify:dsh:e2e:negative
npm run verify:dsh:e2e:negative -- --dsh-version latest
npm run verify:dsh:e2e:negative -- --keep
```

`tests/dsh/e2e/negative-control.mjs` 复制生产插件到临时目录，把副本
`cordis.patch.yml` 的 `panel: true` 改成 `panel: false`，`npm pack` 后用
`--plugin-tarball` 跑 `happy-path`。期望：

- harness 退出码非 0；
- 输出包含 `✗ 侧边栏存在唯一的 Mebular 入口` 与 `✗ Mebular 面板 iframe 已挂载`；
- `probe`、关键工具与 `DSH Web 页面已加载` 仍为 `✓`，证明失败是 UI 注册回归，而不是
  preflight 短路或 DSH 没有启动；
- 失败现场写出 artifacts，脚本退出 0 表示“坏插件被正确判红”。

它不改生产插件、不新增依赖，也不放进 nightly / release（会让 E2E 成本翻倍）。发布前或
修改 E2E 断言时手动跑一次；正式发布门禁仍是完整 9 场景。

## 前置

- 已安装依赖并构建：`npm ci`（`prepare` 会执行 `npm run build`），或手动 `npm run build`。
- 系统有 Chrome/Chromium；也可用 `CHROME_PATH` 指定。已缓存的
  Playwright/Chrome for Testing 二进制会被自动发现。
- `pnpm` 在 PATH 上（`dsh plugin add` 会把参数转发给 pnpm）。
- 不需要 DeepSeek API key；本阶段不启动真实 Agent 对话。

## 场景（默认全部运行）

| 场景 | 做什么 | 关键断言 |
|---|---|---|
| `happy-path` | 随机端口 daemon + 插件 + DSH Web | 侧边栏、`connected`、iframe `/console/?embed=dsh`、`dataset.embed=dsh`、关键 MCP 工具注册、真实 `memory_query` 返回临时 home 数据 |
| `daemon-down-recovery` | 先不启动 daemon，DSH 起来后启动；再停掉；再同端口重启 | 启动时 `offline`、面板占位、无 `mcp__mebular__*`；启动后 `connected`、工具重挂、iframe 自动出现；掉线后回到 `offline`/无工具/无 iframe；再恢复后真实调用成功；DSH pid 全程不变 |
| `panel-false` | 独立 `DSH_HOME`/profile，profile patch 写 `panel: false` | `window.__MEBULAR_DSH__.panel === false`；无 sidebar、无 iframe；`/mebular/embed-info` 报 `panel:false`；MCP 工具仍注册且可调用 |
| `custom-port` | `runtime.json` 指向一个已存在 pid 的**错误端口**，同时设置 `MEBULAR_HTTP_PORT` | 插件按契约优先 env；iframe、`/mebular/embed-info`、daemon `/app/embed/info`、MCP 调用四处同一 origin；未误用冲突端口 |
| `uninstall` | DSH 运行中 `dsh plugin --profile web remove @mebular/dsh-plugin` | profile bundles 不再包含插件；`dump-config` 无 `mebular` row；daemon `/healthz`、`/console/` 仍 200；daemon 与 DSH 进程都未退出 |
| `security-headers` | 直接请求 daemon Console 与发现文档 | 普通 `/console/`：`X-Frame-Options: DENY` + `frame-ancestors 'none'`；`?embed=dsh`：无 XFO，`frame-ancestors` 放开 loopback 与 DSH Desktop 的 `dsh-app://app`；`/mebular/embed-info` 字段白名单且不含 token/密钥/home/CLI 路径 |
| `managed-lifecycle` | profile 写 `lifecycle: managed` + `cliPath` 指向本仓库 `packages/mcp/bin/mebular.mjs`，启动前没有任何 daemon | 插件自启 child：`connected`、iframe、工具与真实调用可用；`/mebular/embed-info` 报 `mode=managed` / `managed=true`；临时 home `runtime.json` 的 pid 存活且不是 DSH pid；停止 DSH 后该 pid 退出、端口关闭 |
| `managed-reuse` | 先启动真实外部 daemon，再用 managed profile 启动 DSH | `/mebular/embed-info` 报 `mode=managed` / `managed=false`，`consoleUrl` 指向外部 daemon；工具与真实调用可用；停止 DSH 后外部 daemon 仍存活、`/healthz` 与 `/console/` 仍 200、`runtime.json` 未被改动 |
| `managed-cli-missing` | profile 写一个不存在的 `cliPath`，并从 PATH 移除所有能解析到 `mebular` 的目录 | 状态 `down`；`/mebular/embed-info` 的 `reason=download_required`、`state=download_required`、`downloadRequired=true`、`managed=false`；`install` 引导可用；没有 `mcp__mebular__*` 工具；`mebular:status` 文本说明 CLI/runtime 缺失并给出安装/`MEBULAR_CLI`/`cliPath` + 重启 DSH 的恢复动作 |

`daemon-down-recovery` 用一个保留但未监听的随机端口作为 `MEBULAR_HTTP_PORT`，因此不会碰到真实用户
在 7331 上的 daemon。`custom-port` 故意把 `runtime.json` 写成冲突值，用来证明 env 优先于 runtime
文件，而不是碰巧连上同一个端口。`managed-lifecycle` 同样使用随机端口，避免 managed child 与用户
已有的 7331 daemon 冲突。

## Managed 与 Agent 状态的语义

- **managed 只回收自己启动的 child。** 插件启动前先探测目标 `daemonUrl`；已有健康 daemon 时直接
  复用（`managed=false`），不会 spawn，也不会在 DSH 退出时停止它。只有本次由插件 spawn 的 child
  会在 DSH dispose 时收到 SIGTERM（必要时 SIGKILL），外部 daemon 永不停止。
- **E2E 证明的是进程事实，不是日志。** `managed-lifecycle` 从临时 home 的 `runtime.json` 读取
  child pid，断言 pid 存活、不是 DSH pid；停止 DSH 后独立等待该 pid 消失并确认端口关闭。
  `managed-reuse` 则断言 DSH 退出后外部 pid、`/healthz`、`/console/` 与 `runtime.json` 都还在。
- **Agent 可见状态来自 systemPrompt registry。** probe 通过
  `ctx.inject(['systemPrompt'])` 取得服务，再调用 `assemble()` 读取名为 `mebular:status` 的
  section 文本；不读 DOM，也不复制插件内部文案。daemon `up` 时 section 文本为空（不增加 prompt
  token）；down 时文本非空并给出恢复动作。`systemPrompt` 不可用或 `assemble()` 失败会记录为
  `supported=null/false` 或 error，场景按失败处理，不会伪装通过。

## 隔离

每个场景独立创建：

- 临时 `MEBULAR_HOME`（真实身份、一个忆云、一条带随机关联 token 的记忆）；
- 独立 `DSH_HOME` 与 `profiles/web`；
- 随机端口与独立 `runtime.json`；
- 独立 probe 输出与 artifacts 目录。

DSH 安装包和两个 npm tarball 在场景之间复用，避免每个场景重复安装；profile、home、进程和端口
仍完全隔离。所有场景都只读写临时目录，不碰 `~/.mebular` / `~/.dsh`。每个场景的目录位于
harness 根目录下（默认随机 tmp，CI 为 `$RUNNER_TEMP/dsh-e2e/<version>`）。

成功时清理根目录；失败时保留。显式 `--root` 只清理 harness 自己创建/标记的条目，
不会删除用户预先创建的空目录本身，也不会使用非空且无标记的目录。

## Probe

`tests/dsh/e2e/fixtures/probe-plugin` 只存在于测试 fixture，不会进入 `@mebular/dsh-plugin` 的 npm
包。它通过 DSH 自己的 registry 工作：

- `PROBE_EXPECT=up`：读 `ctx.tools.schemas()`，确认关键工具存在，再用 `ctx.tools.execute()`
  调一个只读 Mebular 工具，断言返回临时 home 的 seed token 与 memory id；同时等待
  `mebular:status` 文本为空后结束。
- `PROBE_EXPECT=recover`：记录 `down → up → down → up` 的状态转换，在掉线时确认
  `mebular:status` 非空、恢复后重新为空，最后完成真实调用。
- `PROBE_EXPECT=down`：观察三轮，记录 Mebular 工具是否确实为空，并等待
  `mebular:status` 文本出现（用于 `download_required` 的恢复提示断言）。

`probe.json` 中除工具名/调用结果外，还记录：

- `agent.supported`：`true` 表示成功调用 `systemPrompt.assemble()`，`null` 表示服务尚未注入，
  `false` 表示服务不可用；
- `agent.sectionPresent` / `agent.text` / `agent.textLength`：实际 `mebular:status` section；
- `agent.error`：`assemble()` 失败时的稳定错误文本；
- `agentHistory`：按工具数量去重的文本变化，用来在恢复场景中分别断言 down 与 up。

probe 每次状态变化都原子写 `PROBE_OUT`，harness 通过该文件等待状态转换；不硬编码工具总数，
也不 mock DSH。

## Artifacts 已脱敏

失败（或 `--keep`）时 artifacts 在保留前统一经过
[`scripts/lib/redact.mjs`](../../../scripts/lib/redact.mjs)：

- `?token=...` / `token=...` 一次性 DSH URL token；
- `Authorization: Bearer ...`、独立 `Bearer ...` / `Basic ...`；
- `token` / `secret` / `password` / `api_key` / `csrf` 等 key-value；
- 本轮 seed token（即使没有 `token=` 形状）；
- 本轮临时 home、DSH home、scenario 目录、DSH 安装目录与 repo 路径。

写的每个文本文件都会再被 `detectLeaks()` 扫描，结果写入
`artifacts/redaction-audit.json`；有泄漏时场景直接判失败。`dsh-log.txt` 里通常会出现 DSH 启动
URL，保留后应只剩 `?token=<redacted>`。截图是二进制，不含文本日志。

artifacts 包括：`scenario.json`、`seed.json`、`dsh-log.txt`、`daemon-log.txt`、
`dsh-dump-config.yml`、`runtime.json`、`profiles.json`、`healthz.json`、`embed-info.json`、
`dsh-embed-info.json`、`probe.json`、`browser-errors.json`、`browser-dom.html`、
`headers.json`（安全头场景）、`redaction-audit.json`、`screenshot.png`（能采集时）。

## CI 与 release gate

- `.github/workflows/dsh-e2e.yml`：nightly、`workflow_dispatch`、`workflow_call`、相关路径
  PR / `main` push；矩阵为最低版 + `latest`（Node 24，全部场景），nightly / manual 额外跑
  Node 22.19 + 最低版的 `happy-path` smoke；`fail-fast: false`，job 超时 45 分钟。
- Node 22.19 是 **nightly-only** 行为：PR 与 release gate 不跑这一档，避免每次 PR 增加成本。
- 缺 pnpm / Chrome / 构建产物时显式失败，不静默 SKIP。
- 失败上传 `scenario-*/artifacts` 与 harness 日志；成功清理固定根目录。
- `.github/workflows/publish.yml` 的 `publish` / `release` 依赖 DSH E2E；E2E 失败不发六个
  npm 包，也不创建 GitHub Release。dry-run 同样执行 E2E，但保持不发布。
- PR 的首次真实 runner 运行属于验收的一部分；本地全绿不替代它，本文不预先声称 CI 已绿。
- negative control 是手动 test-of-test，不在 CI 矩阵中，也不参与 release gate。
- 操作细节与升级步骤见 [`docs/operations/DSH_E2E.md`](../../../docs/operations/DSH_E2E.md)。

## 边界与已知缺口

- 不引入 Playwright；直接使用 Chrome/CDP。
- 不改生产插件；`panel:false` 只通过 DSH 的 profile `cordis.patch.yml` 覆盖。
- 非 loopback 的 `X-Frame-Options` / `frame-ancestors` 需要 daemon 以 TLS + 非 none auth 启动，
  本 E2E 只覆盖 loopback；非 loopback 分支由 `tests/mcp/console-embed.test.mjs` 单测覆盖。
- DSH Desktop 的 origin/HTTPS/自定义 scheme 仍不在本轮范围。
- managed 生命周期与 Agent 状态文本已覆盖；Node 22.19 的 `happy-path` smoke 已本地通过，
  CI 只在 nightly / manual 运行该档；PR 的首次 GitHub runner 结果属于验收的一部分。
- `managed-cli-missing` 依赖“PATH 上没有可解析的 mebular”：harness 会过滤包含 `mebular`
  的 PATH 目录，但仍保留 `node`；若宿主把 `node` 和 `mebular` 装在同一个目录，场景会显式失败并
  指出无法构造缺失条件，而不是跳过。
- 不验证真实 DeepSeek 模型对话；probe 走 DSH tool registry，不发模型请求。
- negative control 只证明“移除 sidebar/panel 注册”会判红，不是全量故障注入矩阵。
- workflow 已接入；首次 GitHub Actions 真实运行发生在 PR（或默认分支后手动 dispatch /
  nightly），本 README 不声称 CI 已绿。
