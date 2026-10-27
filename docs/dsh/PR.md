# feat(dsh): integrate Mebular as a shared-console DSH plugin

> **Historical v0.1 PR material**: the current v0.2.0 guide is
> [`docs/integrations/DSH.md`](../integrations/DSH.md) /
> [`DSH_CN.md`](../integrations/DSH_CN.md). This file is kept for traceability.

> PR 描述草稿。目标分支 `main`，来源分支 `feat/dsh-shared-console`，基线
> `origin/main@7c03798`。
>
> 当前**未 push、未开 PR**；本文档只作为提交与评审材料。npm 未发布，也未进入任何
> 官方插件列表。

## 摘要

把 Mebular 接入 DeepSeek Harness（DSH），但不复制 Console：

- DSH 侧边栏的 **Mebular** 面板用 iframe 打开同一个 Mebular Console
  （`/console/?embed=dsh`）；
- Mebular daemon 的记忆与任务工具通过 DSH 官方 `@deepseek-ai/dsh-mcp-client` 注册给
  DSH；
- 插件默认 `attach`，只探测已有 daemon；可选 `managed` 启动并只托管自己启动的
  `mebular serve` 子进程；
- daemon origin 由 `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331` 统一解析，
  面板、状态路由与 MCP 桥共用同一结果；
- Console 只有一套实现，Electron App、浏览器与 DSH 插件是不同壳。

一句话：**一套 Console，多个壳。**

## 背景与目标

Mebular 已经有一套完整的本地 Console（星图、共享、记忆、审计、设置）和一个 MCP
`/mcp` 服务。DSH 是另一个宿主：它有自己的 sidebar、slot、tool registry 和 MCP client。

目标不是把 Console 重写成 DSH 组件，而是：

- 让 DSH 用户在自己的 sidebar 里看到同一套 Console；
- 让 DSH 的 Agent 通过官方 MCP client 使用 Mebular 记忆与任务图；
- 保持 Mebular 的 store / identity / trust / 配置完全独立；
- 插件可独立安装、卸载，不干扰桌面 App、服务托管或手动 `mebular serve`。

## 架构

```text
                 ┌──────────────────────────────────┐
                 │          Mebular daemon          │
                 │ identity / store / sync / P2P    │
                 │ /healthz  /app/embed/info        │
                 │ /mcp      /console（唯一 Console）│
                 └───────────────┬──────────────────┘
                                 │ HTTP（唯一边界）
              ┌──────────────────┴───────────────────┐
              │                                      │
  ┌───────────▼───────────┐            ┌─────────────▼─────────────┐
  │ Mebular Desktop App   │            │ @mebular/dsh-plugin       │
  │ Electron 壳            │            │ host：发现 / 生命周期      │
  │ ?shell=desktop        │            │ client：sidebar iframe    │
  └───────────────────────┘            │ ?embed=dsh                │
                                       └─────────────┬─────────────┘
                                                     │ 官方 peer
                                       ┌─────────────▼─────────────┐
                                       │ @deepseek-ai/dsh-mcp-client│
                                       │ 连接 / 重连 / 工具注册      │
                                       └───────────────────────────┘
```

包与版本：

- 目录：`packages/dsh-plugin`
- 包名：`@mebular/dsh-plugin`
- 版本：`0.1.0`（独立版本线，不参与五包 lockstep）
- Node：`>=22.19`
- DSH：`>=0.2.1-rc.2 <0.3.0`
- MCP peer：`@deepseek-ai/dsh-mcp-client`
  `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`

## 主要改动

### P7.1 · Console host adapter、embed 与 runtime 发现

- `packages/console/host.js`：`desktop` / `dsh` / `browser` 三种 host，按 capabilities
  决定动作，避免死按钮；DSH 桥精确校验父 origin。
- `packages/console/console.js`、`console.css`、`deep-link.js`、`shell-boot.js`：
  `?embed=dsh` 在首帧前设置 `data-embed='dsh'`，隐藏顶层 topbar，保留侧栏设置入口；
  `?view=` 深链与 `?shell=desktop` 行为不变。
- `packages/mcp/src/serve.mjs`：
  - 匿名只读 `GET /app/embed/info`；
  - `consoleSecurityHeaders()`：普通 `/console` 继续 `X-Frame-Options: DENY` +
    `frame-ancestors 'none'`；只有 `?embed=dsh` 且 loopback 才移除 XFO，并把
    `frame-ancestors` 限制为 `http://127.0.0.1:* http://localhost:*`；
  - listener 绑定成功后写 runtime 发现文件。
- `packages/mcp/src/runtime-file.mjs`：`<home>/runtime.json` 原子写、`0600`、按 pid
  守卫清理。
- 测试：`tests/console/host.test.mjs`、`tests/console/deep-link.test.mjs`、
  `tests/mcp/console-embed.test.mjs`、`tests/mcp/runtime-file.test.mjs`、
  `tests/mcp/shutdown.test.mjs`。

### P7.2 · 零构建 DSH bundle + 官方 MCP peer

- 新增 `packages/dsh-plugin`：
  - `package.json` 声明 `dsh.bundle` / `dsh.client` / `engines` / peer；
  - `cordis.patch.yml` 只插入一条 `mebular` host row；
  - `index.js` 纯 ESM host；
  - `client.js` 手写 `window.__ModuleLoader__.load({ id, factory })`，只
    `require('react')`；
  - `locale/en.json`、`locale/zh.json`、`icon.svg`、`screenshots.json`、`assets/*`。
- `client.js` 注册 `sidebar.panellist`（`id: mebular`，order 10）与根级 `main`
  （`key: mebular`）。
- `index.js` 在 `apply` 时动态 import 官方 `@deepseek-ai/dsh-mcp-client`，用解析后的
  同一 origin 挂载：`serverName: mebular`、`transport: streamable-http`、
  `failOnStartupError: false`。
- `GET /mebular/embed-info` 状态契约：`status` / `mode` / `managed` / `panel` /
  `version` / `embedProtocol` / `consoleUrl` / `embedUrl` / `mcpUrl` / `loopback` /
  `reason`。
- `attach` 默认只探测；`managed` 复用健康 daemon，必要时启动 `mebular serve --port`，
  dispose 只停止自己的 child（`SIGTERM` → 2s → `SIGKILL`）。
- `panel:false` 通过 `webServer.tapIndex` 注入 `window.__MEBULAR_DSH__={"panel":false}`，
  client 跳过两个槽位；MCP 挂载不受影响。
- managed child 日志脱敏：token/secret/password/api_key、`Authorization`、CLI 路径、
  home；单行 500 字符。
- `scripts/verify-dsh-plugin.mjs`：128 项契约检查，含真实 `npm pack --dry-run`；
  `tests/dsh/*` 覆盖 host/client/manifest。
- 删除旧 `client/index.cjs` 与静态 MCP row；MCP 桥不再由 patch 表达式拼 URL。

### P7.3 · 真实 E2E、截图与上架材料

- 临时 `MEBULAR_HOME` / `DSH_HOME`、非默认端口完成 DSH Web E2E；
- Chrome/CDP 验证 sidebar、iframe、`dataset.embed='dsh'`、星图、设置弹层；
- 临时 probe 插件读取 `ctx.tools.schemas()`，确认 29 个 `mcp__mebular__*` 工具；
- 覆盖 `panel:false`、daemon down、卸载隔离、普通 `/console` 安全头；
- 重拍 `packages/dsh-plugin/assets/dsh-panel.jpg`（2880×1800，真实 DSH Web + Console）；
- 更新 `docs/design/dsh-plugin-v1.md`、插件 README、根 README/README_CN、awesome
  条目与本文档。

## 隔离边界

- **一套 Console**：`packages/dsh-plugin` 不打包、不复制 Console 资源；只 iframe 打开
  daemon 提供的 `/console/?embed=dsh`。
- **两个壳**：Electron App 与 DSH 插件互不依赖；插件卸载后桌面 App 与 Console 不受影响。
- **零 Mebular import**：插件不 import `@mebular/core`、`@mebular/console`、
  `@mebular/desktop`，也不 import `packages/console/*`。
- **HTTP only**：插件与 daemon 只通过 `/healthz`、`/app/embed/info`、`/mcp`、
  `/console` 通信；不共享进程/内存/文件锁。
- **配置隔离**：DSH 只持有 `daemonUrl` / `lifecycle` / `panel` / `cliPath`；身份、网络、
  邀请、域、审计、助手设置只在 Mebular Console。
- **数据隔离**：插件不打开 `store.jsonl`、不读密钥/token、不写 `~/.mebular`。
- **生命周期隔离**：默认 attach 不启动/停止；managed 只停止自己启动的 child。
- **MCP 归官方 peer**：插件只按发现结果挂载，不实现连接、重连、工具注册。

## 测试矩阵

| 层级 | 命令 / 方法 | 结果 |
|---|---|---|
| 目标回归 | `npm test -- --runInBand tests/dsh tests/console tests/mcp` | 36 suites / 427 tests 通过 |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build`（单独执行） | exit 0 |
| 插件契约 | `npm run verify:dsh-plugin` | 128 checks 通过 |
| Console 静态验收 | `npm run verify:console` | 通过 |
| Console UI 冒烟 | `npm run verify:console:ui` | 388 项通过 |
| MCP HTTP 工具链 | `npm run verify:mcp:http` | 通过；29 工具；`memory_write` / `memory_query` / 归档 / 删除 / bearer / OAuth / scope / 单实例锁 / 非环回 fail-closed |
| 文档一致性 | `npm run check:docs` | 7/7 通过 |
| 打包 | `npm pack --dry-run`（`packages/dsh-plugin`） | 13 个文件；host/client/patch/locale/README/LICENSE/icon/screenshots/assets 齐全 |

### 真实 DSH Web E2E（P7.3）

环境：macOS；Node `26.7.0`；临时 DSH CLI `@deepseek-ai/dsh@0.2.1-rc.2`；临时
`MEBULAR_HOME` / `DSH_HOME`；daemon `127.0.0.1:7391`；DSH Web `127.0.0.1:7392`
（panel）、`7393`（panel:false）、`7394`（daemon down）。

| 检查 | 结果 |
|---|---|
| daemon + runtime | `SERVE_READY`；`runtime.json` 写入 `pid`、`http.port=7391`、`embedProtocol=1` |
| 安装 | `dsh plugin --profile web add ./packages/dsh-plugin` 成功；bundles 含插件 |
| 组合 | `--dump-config` 只有 `mebular` host row；无静态 MCP row、无写死 URL |
| 状态路由 | `status:up`、`ok:true`、`embedUrl=http://127.0.0.1:7391/console/?embed=dsh`、`loopback:true` |
| sidebar | `button[aria-label="Mebular"]` 存在且 `aria-current="page"` |
| iframe | `src=http://127.0.0.1:7391/console/?embed=dsh`；sandbox 无 top navigation |
| Console | `dataset.embed='dsh'`；星图 canvas 2320×1718；导航 星图/共享/记忆/审计；设置六个 tab 可开 |
| MCP 工具 | probe 读到 33 个工具，其中 29 个 `mcp__mebular__*` |
| panel:false | `window.__MEBULAR_DSH__.panel=false`；无 sidebar、无 iframe；29 个工具仍在 |
| daemon down | `status:down`、`embedUrl:null`、`reason:daemon_unreachable`；占位页，无 iframe |
| 卸载 | bundles 不再含插件；daemon `/healthz` 仍 ok、`/console/` 200 |
| Console 安全 | 普通 `/console/`：`X-Frame-Options: DENY`、`frame-ancestors 'none'`；`?embed=dsh` 才放开 |

未调用真实 DeepSeek 模型或 API key。

### Desktop origin（本轮结论）

`@deepseek-ai/dsh-desktop-host` 不在 npm registry（404），也未出现在公开
`deepseek-ai/deepseek-harness` 仓库可检索的 tree 中，因此无法在本轮静态检查其窗口
origin，也没有安全启动 Desktop。已确认的只有 DSH Web 的 `http://127.0.0.1:7392`
落在当前 `frame-ancestors http://127.0.0.1:* http://localhost:*` 内。

如果 Desktop 使用 `http://127.0.0.1:<port>`，与当前白名单一致；如果改用 HTTPS 或自定义
scheme，需要扩展 CSP 并重跑 E2E。这是合并前仍待确认的风险，不在本文档中声称已验证。

## 安全与兼容

### 安全

- **仅 loopback 可嵌入**：非 loopback 绑定的 `/app/embed/info` 返回
  `loopback:false` / `embedConsole:false`；host 不返回 `embedUrl`；即使手动带
  `?embed=dsh`，Console 仍保持 `DENY` / `'none'`。
- **普通 Console 不回退**：只有 embed + loopback 才移除 `X-Frame-Options`。
- **状态路由**：`/mebular/embed-info` 只接受 loopback socket，其他来源 `404`；
  `Cache-Control: no-store`；不含 token、密钥、home、CLI 路径。
- **iframe 沙箱**：`allow-scripts allow-same-origin allow-forms`，不允许 top navigation、
  弹窗或下载；加载失败回退占位页。
- **runtime 文件**：只含 version/pid/HTTP 地址/路径/协议，权限 `0600`，原子写入；停止按
  pid 清理。
- **panel 注入**：只注入 `{"panel":boolean}`，`<` 转义为 `\u003c`。
- **managed 日志**：token/secret/password/api_key、Authorization、CLI 路径、home 脱敏。
- **无长期 token 进 URL**：OAuth/凭据协商由官方 MCP client 负责。
- **只停自己的 child**：外部 daemon 永不被 host 停止。

### 兼容性

- Node.js `>=22.19`；DSH `>=0.2.1-rc.2 <0.3.0`。
- MCP peer 范围显式包含预发布分支：
  `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`。
- Console `embedProtocol: 1`；插件运行时校验，不兼容时拒绝嵌入并显示升级提示。
- DSH `dsh.client` / slot API / `webServer.tapIndex` 仍是 developer preview；升级 DSH
  后需重跑真实 E2E。
- 普通浏览器 `/console`、Electron `?shell=desktop` 行为不变。

## 已知限制与风险

1. 默认 `attach` 不托管 daemon；daemon 未运行时面板显示引导，MCP client 等待/重连。
2. 仅 loopback 可嵌入；公网/HTTPS DSH、HTTPS loopback 或非 HTTP 自定义协议不在当前
   CSP 白名单。
3. MCP peer 由 DSH 提供；Jest/普通 Node/缺 peer 的宿主没有 MCP 工具，但面板与状态路由
   仍工作。
4. DSH 与 daemon 的 `MEBULAR_HOME` 不一致时自动发现不命中，需显式 `daemonUrl` 或
   `MEBULAR_HTTP_PORT`。
5. 面板 header 不显示 daemon URL；只有状态、版本、打开 Console、刷新。
6. Console 侧 `mebular:request` 桥保留为 seam；当前面板不发送写请求。
7. `panel:false` 依赖 `webServer.tapIndex`；API 缺失时 client 回退为 `panel:true`。
8. npm 尚未发布；当前只能本地路径或 GitHub 子目录安装，`@mebular/dsh-plugin` 只是预留名。
9. `dsh plugin remove` 后 pnpm 可能保留 `node_modules/@mebular/dsh-plugin` 符号链接；
   不在 bundles 中，不会被加载。
10. MCP 工具数量随 daemon 版本变化；P7.3 在 `0.1.0` 上实测 29 个，不承诺固定数量。
11. Desktop origin 未验证；见上一节。
12. managed 只验证了子进程生命周期；系统服务/桌面 App 的完整停止链路仍需单独验证。
13. 截图使用隔离的临时 daemon，Console 顶部显示“守护 未运行 / 未启用 P2P / 记忆 0”
    是临时实例真值；DSH panel header 同时显示“已连接”。截图不是 mock。

## 发布 / 上架后续

当前**没有**发布 npm，也**没有**进入任何官方插件列表。合并后建议按顺序：

1. **合并本 PR**，确认 `main` 上 `packages/dsh-plugin` 可访问。
2. **发布 npm**：包名 `@mebular/dsh-plugin`；`repository` 指回
   `Windsander/Mebular`，`directory: packages/dsh-plugin`；发布前用
   `npm pack --dry-run` 确认 host/client/patch/locale/README/LICENSE/icon/screenshots/
   assets 都在包里。
3. 或附 **GitHub Release tarball**，用 `tarball:` 指向
   `https://github.com/Windsander/Mebular/releases/...`。
4. 给仓库加 **`dsh-plugin` GitHub topic**（代码里无法完成）。
5. 给 `awesome-dsh-plugin` 提交**一个**条目文件：
   `data/plugins/Windsander__Mebular--packages-dsh-plugin.yml`，内容用
   `docs/dsh/awesome-dsh-plugin-entry.yml` 草稿；不要直接改 README。
6. 提交前确认 `screenshots.json` 与 `assets/icon-180.png` 在 `main` 的 raw URL 可访问；
   awesome 的 `icon:` 只接受 GitHub 托管位图，SVG 不接受。
7. 可选：发布到 dsh-market / 其他市场；awesome-dsh-plugin 已收录（PR #9167），其他市场在确认前不要写“已上架”。
8. 后续验证：DSH Desktop origin、HTTPS loopback、DSH 新 preview 版本的 slot/tapIndex
   兼容性、系统服务停止链路。

## 回滚

插件层：

```sh
dsh plugin --profile web remove @mebular/dsh-plugin
```

- 卸载只移除 DSH profile 里的 bundle；Mebular daemon、Console、store 不受影响。
- 若当前是 `managed` 且 child 由插件启动，DSH dispose 会按 `SIGTERM` → 2s → `SIGKILL`
  停止它；需要继续使用时手动 `mebular serve`。
- pnpm 残留的 `node_modules/@mebular/dsh-plugin` 符号链接可手动删除，不影响运行。

代码层：

- 回滚整组提交到 `7c03798`；P7.1 / P7.2 是增量改动，没有数据迁移。
- Console 的 embed 改动是增量的：普通 `/console` 安全头保持不变。
- `runtime.json` 是新增的非敏感发现文件；回滚后 daemon 不再写它，host 回退到
  `daemonUrl` / 端口 / 7331。
- npm 已发布时不要删除版本；用 `npm deprecate` 指向修复版本。

## Checklist

- [x] 一套 Console，DSH 只 iframe 嵌入，不复制 UI/资源。
- [x] `packages/dsh-plugin` 零 Mebular import，HTTP only。
- [x] 插件可独立安装/卸载，卸载不影响 Mebular。
- [x] 默认 `attach` 不启动/停止任何进程。
- [x] `managed` 只复用外部 daemon，只停止自己启动的 child。
- [x] daemon 发现顺序统一，面板、状态路由与 MCP 桥同源。
- [x] 官方 `@deepseek-ai/dsh-mcp-client` 运行时挂载，peer 缺失可降级。
- [x] `panel:false` 隐藏面板但保留 MCP 工具。
- [x] 普通 `/console` 安全头不回退；embed 仅 loopback。
- [x] `/mebular/embed-info` 仅 loopback、无敏感信息。
- [x] runtime.json 非敏感、0600、原子写、按 pid 清理。
- [x] MCP/SSE 长连接下优雅停止有界。
- [x] 目标测试、lint、build、check:docs、verify:console、verify:console:ui 通过。
- [x] 真实 DSH Web E2E、29 工具、panel:false、daemon down、卸载隔离通过。
- [x] 设计文档、插件 README、根 README/README_CN 入口、列表草稿、PR 草稿。
- [x] 截图与 180px 图标为真实文件，`screenshots.json` 路径有效。
- [x] npm pack dry-run 包含全部声明产物。
- [x] npm 发布 / GitHub Release tarball（已随 v0.1.0 发布）。
- [x] `dsh-plugin` topic 与 awesome-dsh-plugin PR（已合并：[#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)）。
- [ ] DSH Desktop origin / HTTPS loopback / 系统服务停止链路（后续）。
