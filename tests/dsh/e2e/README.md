# DSH 真实 E2E（Phase 2：P0 失败/恢复矩阵）

一条命令在“真 daemon + 真 DSH + 真浏览器 + 真工具调用”上跑完首发 P0：

```bash
npm run verify:dsh:e2e                 # 全部 P0 场景
npm run verify:dsh:e2e -- --scenario daemon-down-recovery
npm run verify:dsh:e2e -- --scenario panel-false --keep
npm run verify:dsh:e2e -- --list       # 列出场景名
node scripts/verify-dsh-e2e.mjs --dsh-version 0.2.1-rc.2
```

`--keep` 在成功时也保留临时目录和 artifacts。失败时无论是否加 `--keep` 都会保留现场。

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
| `security-headers` | 直接请求 daemon Console 与发现文档 | 普通 `/console/`：`X-Frame-Options: DENY` + `frame-ancestors 'none'`；`?embed=dsh`：无 XFO，`frame-ancestors` 只放开 loopback；`/mebular/embed-info` 字段白名单且不含 token/密钥/home/CLI 路径 |

`daemon-down-recovery` 用一个保留但未监听的随机端口作为 `MEBULAR_HTTP_PORT`，因此不会碰到真实用户
在 7331 上的 daemon。`custom-port` 故意把 `runtime.json` 写成冲突值，用来证明 env 优先于 runtime
文件，而不是碰巧连上同一个端口。

## 隔离

每个场景独立创建：

- 临时 `MEBULAR_HOME`（真实身份、一个忆云、一条带随机关联 token 的记忆）；
- 独立 `DSH_HOME` 与 `profiles/web`；
- 随机端口与独立 `runtime.json`；
- 独立 probe 输出与 artifacts 目录。

DSH 安装包和两个 npm tarball 在场景之间复用，避免每个场景重复安装；profile、home、进程和端口
仍完全隔离。所有场景都只读写临时目录，不碰 `~/.mebular` / `~/.dsh`。

## Probe

`tests/dsh/e2e/fixtures/probe-plugin` 只存在于测试 fixture，不会进入 `@mebular/dsh-plugin` 的 npm
包。它通过 DSH 自己的 registry 工作：

- `PROBE_EXPECT=up`：读 `ctx.tools.schemas()`，确认关键工具存在，再用 `ctx.tools.execute()`
  调一个只读 Mebular 工具，断言返回临时 home 的 seed token 与 memory id。
- `PROBE_EXPECT=recover`：记录 `down → up → down → up` 的状态转换，最后完成真实调用。
- `PROBE_EXPECT=down`：观察三轮，记录 Mebular 工具是否确实为空。

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

## 边界与已知缺口

- 不引入 Playwright；直接使用 Chrome/CDP。
- 不改生产插件；`panel:false` 只通过 DSH 的 profile `cordis.patch.yml` 覆盖。
- 非 loopback 的 `X-Frame-Options` / `frame-ancestors` 需要 daemon 以 TLS + 非 none auth 启动，
  本 E2E 只覆盖 loopback；非 loopback 分支由 `tests/mcp/console-embed.test.mjs` 单测覆盖。
- DSH Desktop 的 origin/HTTPS/自定义 scheme 仍不在 P0（Phase 3+ 记录）。
- managed 生命周期、Agent 状态文本、版本矩阵与 CI/release gate 属于 Phase 3/4，本阶段不测。
- 不验证真实 DeepSeek 模型对话；probe 走 DSH tool registry，不发模型请求。
