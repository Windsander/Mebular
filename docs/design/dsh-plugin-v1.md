# DSH 插件：共享 Console + 隔离壳

Status: final（P7.1 / P7.2 已实现，P7.3 完成真实 E2E、截图与上架材料）
Branch: `feat/dsh-shared-console`
Base: `origin/main@7c03798`
DSH baseline: `0.2.1-rc.2`
Package: `packages/dsh-plugin`（`@mebular/dsh-plugin@0.1.0`，独立版本线，随 v0.1.0 release train）

## 1. 目标

让 Mebular 以 DSH 插件的形式进入 DeepSeek Harness 生态，同时保持三件事不变：

- Mebular daemon、store、身份与 Console 完全独立；
- Console 只有一套实现，不重写、不 fork、不复制静态资源；
- DSH 插件只是 Mebular daemon 的第二个壳，可独立安装、卸载。

一句话：

> 一套 Console，多个壳。Console 归 Mebular daemon；桌面 App、浏览器和 DSH 插件都只是壳。

## 2. 非目标

- 不把 Console 重写成 DSH React 组件。
- 不在 DSH 里复制 Mebular 的网络、身份、邀请、域、审计、助手接入等设置。
- 不把 Mebular store / identity / trust 状态复制进 DSH。
- 不做同源反向代理，不把 daemon 的 API 搬进 DSH 进程。
- 不实现第二套 MCP 客户端、连接管理、重试或工具发现逻辑。
- 不安装系统服务；`managed` 只是子进程兜底。

## 3. 最终形态

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

### 角色

| 角色 | 职责 |
|---|---|
| Mebular daemon | 身份、存储、P2P、同步、Console、Admin API、MCP `/mcp` |
| Mebular Desktop App | 原生窗口、托盘、守护托管、首次向导 |
| `@mebular/dsh-plugin` host | daemon 发现、attach/managed、官方 MCP client 挂载、状态路由、panel 开关注入 |
| `@mebular/dsh-plugin` client | DSH sidebar 图标、`main` 面板、iframe 容器、占位/错误状态 |
| `@deepseek-ai/dsh-mcp-client` | MCP 连接、重连、工具发现与注册（官方 peer，由 DSH 提供） |
| DSH | sidebar slot、tool registry、插件生命周期、WebServer |

## 4. 代码与构建隔离

`packages/dsh-plugin` 是零构建 DSH bundle：

- host `index.js` 是纯 ESM，只静态 import Node 内置模块；
- 唯一的外部模块是官方 `@deepseek-ai/dsh-mcp-client`，在 `apply` 时**动态 import**；
- client `client.js` 是手写 `window.__ModuleLoader__.load({ id, factory })`，只 `require('react')`；
- 不 import `@mebular/core`、`@mebular/console`、`@mebular/desktop`，也不 import `packages/console/*`；
- 不打包 Console 资源；DSH 插件产物只有 host/client、locale、patch、图标、截图与 README；
- 安装不触发 `prepare` / `allowBuilds`，没有运行时 npm 依赖（MCP peer 由 DSH 提供）。

`tests/dsh/manifest.test.mjs` 与 `scripts/verify-dsh-plugin.mjs` 用静态 import 检查和真实
`npm pack --dry-run` 守住这条线，而不是只靠约定。

## 5. Mebular 侧契约

### 5.1 Console embed

```text
GET /console/?embed=dsh
```

普通 `/console/` 保持：

```http
X-Frame-Options: DENY
Content-Security-Policy: ... frame-ancestors 'none'
```

只有同时满足 `embed=dsh` 且 daemon 绑定 loopback 时才放开：

```http
# 不发送 X-Frame-Options
Content-Security-Policy: ... frame-ancestors http://127.0.0.1:* http://localhost:*
```

页面行为：

- `document.documentElement.dataset.embed = 'dsh'`，在首帧前由 `shell-boot.js` 落位；
- 隐藏 Console 顶层 topbar，保留星图、共享、记忆、审计与侧栏设置入口；
- `?view=` 深链保持有效，`?shell=desktop` 语义不变；
- iframe sandbox 为 `allow-scripts allow-same-origin allow-forms`，不授予 top navigation；
- iframe 加载失败或超时显示占位页，不保留空白框。

实现点：`packages/mcp/src/serve.mjs` 的 `consoleSecurityHeaders()` /
`handleConsole()`，`packages/console/host.js`、`console.js`、`console.css`、
`deep-link.js`、`shell-boot.js`。

### 5.2 发现端点

```http
GET /app/embed/info
```

响应不含 token、身份、home 或 store：

```json
{
  "ok": true,
  "name": "mebular",
  "version": "0.1.0",
  "embedProtocol": 1,
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "capabilities": { "embedConsole": true }
}
```

- 端点在 OAuth / `/app` 鉴权之前，匿名只读；
- 非 loopback 绑定返回 `loopback: false`、`capabilities.embedConsole: false`，host 不嵌入；
- `embedProtocol` 与 `/healthz`、`runtime.json` 共用同一常量，避免多处字面量漂移。

### 5.3 runtime.json

daemon 在 HTTP listen 成功后原子写入 `<home>/runtime.json`（权限 `0600`）：

```json
{
  "version": "0.1.0",
  "pid": 12345,
  "http": { "host": "127.0.0.1", "port": 7331 },
  "consolePath": "/console",
  "mcpPath": "/mcp",
  "embedProtocol": 1
}
```

- 只含非敏感发现字段；
- 通配绑定归一化为 loopback 可访问地址，`localhost` 归一化为 `127.0.0.1`；
- 停止时只删除 `pid` 仍指向当前进程的文件，避免误删新实例；
- host 遇到不存在的 `pid` 视为 stale，继续回退，不会卡死。

实现：`packages/mcp/src/runtime-file.mjs`，接线点在 `packages/mcp/src/serve.mjs`
的 listener 绑定之后与优雅停止的 `finally`。

### 5.4 Console host adapter

`packages/console/host.js` 统一三种壳：

| kind | 来源 | 能力 |
|---|---|---|
| `desktop` | Electron preload `window.mebularDesktop` | 原生窗口、托盘、重启、向导、通知、忆云切换 |
| `dsh` | `?embed=dsh`（优先于 preload） | 全部写能力为 false；保留最小 postMessage 桥 |
| `browser` | 普通浏览器 | 能力全 false，外部链接走 `window.open` |

Console 只按 capabilities 决定按钮是否出现，不出现不可用的死按钮。DSH 面板当前只做
iframe 容器与状态轮询，不发送写请求；`openExternal` / `restartDaemon` / `openWizard` /
`notify` / `cloudSwitch` 桥保留为后续 seam。父页面 origin 由 `ancestorOrigins` 或
`document.referrer` 精确推导，消息同时校验 `source` 与 `origin`。

## 6. DSH host 插件

### 6.1 组合面

`cordis.patch.yml` 只插入一条 host row：

```yaml
- insert:
    - id: mebular
      name: '@mebular/dsh-plugin'
      config:
        lifecycle: attach
        panel: true
```

没有静态 MCP row，没有写死 `daemonUrl`，没有 `command:` / stdio。host 在 `apply` 时
用解析后的同一个 origin 动态挂载官方 MCP client。

### 6.2 daemon 发现

顺序固定为：

1. 显式 `daemonUrl`（只接受 `http:` / `https:`，拒绝含凭据的 URL）；
2. `MEBULAR_HTTP_PORT`（有效端口 1–65535）；
3. `<home>/runtime.json`（`MEBULAR_HOME` 覆盖，缺省 `~/.mebular`；`pid` 必须仍存活）；
4. `http://127.0.0.1:7331`。

host 只读取 runtime 的 `version`、`pid`、`http.host`、`http.port`、`consolePath`、
`mcpPath`、`embedProtocol`；不读 `config.json`、身份、token 或 store。面板、
`/mebular/embed-info` 和 MCP 桥共用这一份解析结果，不会出现“面板连 7332、工具连 7331”。

### 6.3 生命周期

| 模式 | 已有健康 daemon | daemon 不存在 | dispose |
|---|---|---|---|
| `attach`（默认） | 复用，只探测 | 不启动，状态 `down`，面板显示引导 | 不停止任何进程 |
| `managed` | 复用，`managed: false` | 解析 CLI 后启动 `mebular serve --port <port>`，有界等待 `/healthz` | 只对自己启动的 child 发 `SIGTERM`，2s 后 `SIGKILL` |

`managed` 的边界：

- 不 import `@mebular/service`，不安装系统服务，不覆盖 `MEBULAR_HOME`；
- CLI 解析顺序：`cliPath` → `MEBULAR_CLI` → `PATH` 上的 `mebular`；
- 等待 healthz 默认 20s，期间 `starting`；超时、spawn error 或 child 提前退出只清理自己的
  child，状态 `down`、`reason: managed_start_failed`，不无限重试；
- CLI 缺失降级为 `attach`，`reason: managed_cli_missing`；
- 外部 daemon（桌面 App、服务托管、手动 `mebular serve`）永远不会被停止；
- child 的 stdout/stderr 先脱敏再进 DSH 日志：`token` / `secret` / `password` /
  `api_key`、`Authorization`、CLI 路径与 home 都会被替换，单行上限 500 字符。

### 6.4 状态路由

```http
GET /mebular/embed-info
```

只接受 loopback socket；其他来源返回 `404`，不确认路由存在。响应带
`Cache-Control: no-store`，字段固定为：

```json
{
  "ok": true,
  "status": "up",
  "mode": "attach",
  "managed": false,
  "panel": true,
  "version": "0.1.0",
  "embedProtocol": 1,
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

- `status`：`up` / `down` / `starting`；`starting` 时 `embedUrl` 为 `null`；
- `mode`：当前生效生命周期，CLI 缺失时从 `managed` 降级为 `attach`；
- `managed`：仅当 daemon 由本插件启动且 child 仍在运行时为 `true`；
- `ok`：`status: up`、协议 `1`、`capabilities.embedConsole`、两侧 loopback 与合法
  loopback embed URL 全部满足；
- `reason`：稳定诊断码，成功为 `null`，包含 `daemon_unreachable`、`daemon_unhealthy`、
  `embed_info_unavailable`、`embed_not_ok`、`not_loopback`、
  `embed_protocol_unsupported`、`embed_unsupported`、`embed_url_invalid`、
  `managed_cli_missing`、`managed_start_failed`；
- 不返回 token、密钥、home 路径、CLI 路径或进程环境。

### 6.5 panel 开关

`panel: false` 时：

- host 仍挂载官方 MCP client，`mcp__mebular__*` 工具照常注册；
- `/mebular/embed-info` 仍可用，`panel: false` 只是非敏感快照；
- host 通过 DSH `webServer.tapIndex` 向 index.html 注入
  `window.__MEBULAR_DSH__={"panel":false}`；
- client 在 `apply` 时读取，跳过 `sidebar.panellist` 与 `main` 槽位注册。

如果宿主没有 `webServer.tapIndex`（headless/TUI 或未来 DSH 变更），client 回退为
`panel: true`；状态路由仍报告配置值。

### 6.6 MCP 桥

`mountMcp()` 动态 import `@deepseek-ai/dsh-mcp-client`，然后：

```js
ctx.plugin(module, {
  serverName: 'mebular',
  transport: 'streamable-http',
  url: joinUrl(daemonUrl, '/mcp'),
  failOnStartupError: false,
});
```

- 连接、重连、工具发现、工具注册全部归官方 peer；
- peer 缺失或挂载失败只记录 `mcp client mount failed (<code>)`，面板与状态路由继续工作；
- 工具公开名为 `mcp__mebular__<rawName>`，例如 `mcp__mebular__memory_write`；
- 不使用 stdio，不会另起第二个 Mebular 进程抢 storage lock。

### 6.7 Agent 可见状态

host 在 `apply` 时通过 `ctx.inject(['systemPrompt'])` 注入 DSH 可选的 system prompt 服务，
注册唯一 section `mebular:status`（order `3200`，位于 first-party MCP server guidance
`3100` 与 tools SDK `5000` 之间）：

- 文本由 MCP bridge supervisor 已有的 lifecycle snapshot 派生，不新增轮询或状态源；
- `up` 时文本为空，section 在 prompt 渲染时被丢弃，不增加 token；
- `down` 时说明本地 daemon 未运行，提示启动 Mebular App 或运行 `mebular serve`，并禁止
  Agent 声称记忆可用；`starting` 说明工具暂时不可用；`managed_cli_missing` /
  `managed_start_failed` 使用具体 reason 给出对应恢复动作；
- 文本变化时才 `ctx.emit('system-prompt/change')`，2s tick 不重复刷新；
- `systemPrompt` 服务不存在时安全跳过；`panel: false` 不影响它，因为它不是 UI 面板；
- 不注册 `mebular_status` MCP 工具，不改 `/mebular/embed-info` wire shape。该提示仅属于
  DSH adapter，其他 MCP 客户端不保证存在。

## 7. 故障隔离

| 故障 | 行为 |
|---|---|
| daemon 未运行 | 面板显示引导；官方 MCP client 按 `failOnStartupError: false` 等待/重连，不阻塞 DSH |
| 官方 MCP peer 缺失或挂载失败 | 记录稳定错误码；面板与 `/mebular/embed-info` 继续工作 |
| host 初始化异常 | 状态路由降级为 `down`；不写 Mebular 状态，不拖垮 Mebular |
| client 失败 | 面板不出现；MCP 工具仍由 host 挂载 |
| iframe 加载失败/超时 | 显示“在浏览器打开 Console”，不保留空白 iframe |
| Console 协议不兼容 | 显示升级提示，不加载 iframe |
| runtime 文件 stale | `pid` 不存活则跳过，回退到显式配置、端口或 7331 |
| 插件卸载 | Mebular daemon、Console、store 继续运行 |

## 8. 版本与兼容

- `@mebular/dsh-plugin@0.1.0`，独立 semver，不参与 `core` / `service` / `skill` / `mcp` /
  `fleet` 五包 lockstep；
- `engines.node: >=22.19`；
- `engines.dsh: >=0.2.1-rc.2 <0.3.0`；
- `@deepseek-ai/dsh-mcp-client` 是 peerDependency：
  `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`；
- Console 通过 `/app/embed/info` 的 `embedProtocol` 做运行时校验，当前为 `1`；
- DSH 的 `dsh.client` / slot / `webServer.tapIndex` 仍是 developer preview；升级 DSH 后必须
  重跑真实 E2E。

## 9. 实际实现映射

### P7.1 · Console host adapter、embed 与 runtime 发现

- `packages/console/host.js`：`desktop` / `dsh` / `browser` 三种 host，capabilities 驱动
  动作；DSH 桥校验父 origin。
- `packages/console/console.js`、`console.css`、`deep-link.js`、`shell-boot.js`：
  `?embed=dsh` 标记、topbar 隐藏、侧栏设置入口、深链保持。
- `packages/mcp/src/serve.mjs`：`consoleSecurityHeaders()`、`buildEmbedInfo()`、
  匿名 `/app/embed/info`、`?embed=dsh` 条件放行、loopback 判定。
- `packages/mcp/src/runtime-file.mjs`：原子写、`0600`、pid guard 清理。
- 测试：`tests/console/host.test.mjs`、`tests/console/deep-link.test.mjs`、
  `tests/mcp/console-embed.test.mjs`、`tests/mcp/runtime-file.test.mjs`、
  `tests/mcp/shutdown.test.mjs`。

### P7.2 · DSH host/client 与官方 MCP peer

- `packages/dsh-plugin/index.js`：发现、attach/managed、状态路由、panel 注入、官方 MCP
  client 挂载、日志脱敏。
- `packages/dsh-plugin/client.js`：手写 ModuleLoader bundle、sidebar/main slot、iframe、
  占位与错误状态、`panel:false`。
- `packages/dsh-plugin/cordis.patch.yml`：只有一条 `mebular` host row。
- `packages/dsh-plugin/package.json`、`README.md`、`LICENSE`、`icon.svg`、`locale/*`、
  `screenshots.json`、`assets/*`。
- `scripts/verify-dsh-plugin.mjs`：128 项契约检查，含真实 `npm pack --dry-run`。
- 测试：`tests/dsh/host.test.mjs`、`tests/dsh/client-contract.test.mjs`、
  `tests/dsh/manifest.test.mjs`。

### P7.3 · 真实 E2E、截图、文档与上架材料

- 在临时 `MEBULAR_HOME` / `DSH_HOME`、非默认端口上完成 DSH Web E2E；
- 用 Chrome/CDP 验证 sidebar、iframe、`dataset.embed='dsh'`、星图、设置弹层；
- 用临时 probe 插件读取 `ctx.tools.schemas()`，证明 29 个 `mcp__mebular__*` 工具注册；
- 覆盖 `panel:false`、daemon down、卸载隔离、普通 `/console` 的 DENY / `'none'`；
- 重拍 `packages/dsh-plugin/assets/dsh-panel.jpg`（2880×1800，真实 DSH Web + Console）；
- 更新本文件、插件 README、根 README/README_CN、awesome 条目与 PR 草稿。

## 10. 验证证据（P7.3）

环境：

- macOS，Node `26.7.0`（项目要求 `>=22.19`）；
- 临时 DSH CLI `@deepseek-ai/dsh@0.2.1-rc.2`；
- 临时 `MEBULAR_HOME`、`DSH_HOME`，不读写 `~/.mebular` / `~/.dsh`；
- daemon `127.0.0.1:7391`；DSH Web `127.0.0.1:7392`（panel）、`7393`（panel:false）、
  `7394`（daemon down）。

| 检查 | 结果 |
|---|---|
| `mebular serve --port 7391` | `SERVE_READY`；`runtime.json` 写入 `pid`、`http.port=7391`、`embedProtocol=1` |
| 安装 `./packages/dsh-plugin` | profile bundles 含 `@mebular/dsh-plugin` |
| `--dump-config` | 只有 `mebular` host row；无静态 MCP row、无写死 URL |
| `/mebular/embed-info` | `status:up`、`ok:true`、`embedUrl=http://127.0.0.1:7391/console/?embed=dsh`、`loopback:true` |
| CDP sidebar | `button[aria-label="Mebular"]` 存在且 `aria-current="page"` |
| iframe | `src=http://127.0.0.1:7391/console/?embed=dsh`；sandbox 无 top navigation |
| Console frame | `dataset.embed='dsh'`；星图 canvas 2320×1718；导航 星图/共享/记忆/审计；设置六个 tab 可开 |
| 工具注册 | probe 读到 33 个工具，其中 29 个 `mcp__mebular__*` |
| `panel:false` | `window.__MEBULAR_DSH__.panel=false`；无 sidebar、无 iframe；29 个工具仍在 |
| daemon down | `status:down`、`embedUrl:null`、`reason:daemon_unreachable`；占位页，无 iframe |
| 卸载 | bundles 不再含插件；`/healthz` 仍 ok、`/console/` 200 |
| Console 安全 | 普通 `/console/`：`X-Frame-Options: DENY`、`frame-ancestors 'none'`；`?embed=dsh` 才放开 |
| 截图 | `assets/dsh-panel.jpg` 2880×1800，真实 sidebar + 共享 Console |

验证脚本结果：

- `npm test -- --runInBand tests/dsh tests/console tests/mcp`：36 suites / 427 tests 通过；
- `npm run verify:dsh-plugin`：128 checks 通过；
- `npm run lint`：exit 0；
- `npm run build`：exit 0；
- `npm run verify:console`：通过；
- `npm run verify:console:ui`：388 项通过；
- `npm run verify:mcp:http`：通过；29 工具；`memory_write` 落图、`memory_query` 召回、
  归档/解除归档/删除生命周期、bearer/OAuth/scope、单实例锁、非环回 fail-closed；
- `npm run check:docs`：7/7 通过；
- `npm pack --dry-run`：13 个文件，包含 host/client/patch/locale/README/LICENSE/icon/
  screenshots/assets。

## 11. 安全边界

- **仅 loopback 可嵌入**：非 loopback 绑定的 `/app/embed/info` 返回
  `loopback:false` / `embedConsole:false`，host 不生成 `embedUrl`；即使手动带
  `?embed=dsh`，Console 仍保持 `DENY` / `'none'`。
- **普通 Console 不回退**：只有 embed + loopback 才移除 `X-Frame-Options`。
- **状态路由**：只接受 loopback socket，其他来源 `404`；无 token、密钥、home、CLI 路径。
- **iframe 沙箱**：`allow-scripts allow-same-origin allow-forms`，不授予 top navigation、
  弹窗或下载；失败回退占位页。
- **runtime 文件**：非敏感字段、`0600`、原子写、按 pid 清理。
- **panel 注入**：只注入 `{"panel":boolean}`，`<` 转义为 `\u003c`，不注入 daemon URL
  或凭据。
- **managed 日志**：token/secret/password/api_key、`Authorization`、CLI 路径与 home 脱敏。
- **无长期 token 进 URL**：MCP 的 OAuth/凭据由官方 client 负责，不经过面板 URL。
- **只停自己的 child**：外部 daemon 永不被 host 停止。

## 12. 已知限制与风险

1. **npm 发布状态**：`@mebular/dsh-plugin@0.1.0` 随 v0.1.0 release train 发布，使用独立
   版本线；正式安装为 `dsh plugin --profile web add @mebular/dsh-plugin@0.1.0`。插件开发
   仍可从 `./packages/dsh-plugin` 或 GitHub 子目录安装。
2. **官方列表**：已收录于 awesome-dsh-plugin 的 `memory` 分类（[PR #9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)，2026-10-24 合并）；`docs/dsh/awesome-dsh-plugin-entry.yml` 保留为条目源与审计记录。
3. **仅 loopback**：公网 DSH、HTTPS loopback、非 HTTP 自定义协议不在当前
   `frame-ancestors` 白名单。
4. **Desktop origin 未在本轮验证**：`@deepseek-ai/dsh-desktop-host` 不在 npm 上，也未
   出现在公开 DSH 仓库的可检索 tree 中，无法静态确认其窗口 origin。若 Desktop 使用
   `http://127.0.0.1:<port>`，与当前 CSP 白名单一致；若改用 HTTPS 或自定义 scheme，
   需要扩展 `frame-ancestors` 并重跑 E2E。本轮只验证了 DSH Web 的
   `http://127.0.0.1:7392` origin。
5. **MCP peer 由 DSH 提供**：Jest、普通 Node 或缺少 `@deepseek-ai/dsh-mcp-client` 的宿主
   没有 MCP 工具，但面板与状态路由仍工作。
6. **runtime home 必须一致**：DSH 与 daemon 的 `MEBULAR_HOME` 不同且未设
   `daemonUrl` / `MEBULAR_HTTP_PORT` 时，自动发现不会命中。
7. **DSH preview API**：`panel:false` 依赖 `webServer.tapIndex`；slot 名称与 main key 也
   属于 developer preview，升级 DSH 后必须重新验证。
8. **临时 daemon 截图状态**：`assets/dsh-panel.jpg` 使用隔离的临时 daemon，Console 顶部
   显示“守护 未运行 / 未启用 P2P / 记忆 0”是临时实例真值；DSH 面板 header 同时显示
   “已连接”，说明嵌入链路已通。截图不是 mock，也没有伪造服务状态。
9. **MCP 工具数量随 daemon 版本变化**：P7.3 在 `0.1.0` 上实测 29 个，不承诺固定数量。
10. **卸载残留**：`dsh plugin remove` 后 pnpm 可能保留 `node_modules/@mebular/dsh-plugin`
    符号链接；它不在 profile bundles 中，不会被加载。
11. **服务托管未做系统级 E2E**：`managed` 只验证了子进程生命周期；launchd/systemd/
    Task Scheduler 的完整停止链路仍需单独验证。

## 13. 回滚

插件层：

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

只移除 DSH profile 里的 bundle；Mebular daemon、Console、store 不受影响。若当前是
`managed` 且 child 由插件启动，DSH dispose 会按 `SIGTERM` → 2s → `SIGKILL` 停止它；
需要继续使用时手动运行 `mebular serve`。pnpm 残留的 `node_modules/@mebular/dsh-plugin`
符号链接可手动删除，不影响运行。

代码层：

- P7.1 的 Console embed / runtime 是增量改动，普通 `/console` 安全头保持不变；
- `runtime.json` 是新增的非敏感发现文件；回滚后 daemon 不再写它，host 回退到
  `daemonUrl` / `MEBULAR_HTTP_PORT` / 7331；
- P7.2 的插件是独立包，回滚只需删除 `packages/dsh-plugin` 与 profile 依赖；
- npm 已发布时不要删除版本，用 `npm deprecate` 指向修复版本。

## 14. 发布 / 上架后续

> 2026-10-25 状态：本节的 npm 发布与 awesome-dsh-plugin 收录均已完成（PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167) 已合并）；以下步骤保留为发布记录。

1. 合并本分支，确认 `main` 上 `packages/dsh-plugin` 可访问。
2. 按 `docs/operations/RELEASE.md` 的 `publish-dsh` job 发布 npm；v0.1.0 使用独立版本
   `0.1.0`，不随五包 lockstep。
3. 给仓库加 `dsh-plugin` GitHub topic（代码无法完成）。
4. 用 `docs/dsh/awesome-dsh-plugin-entry.yml` 向 `awesome-dsh-plugin` 提交**一个**条目；
   不要直接改目标仓库 README。提交前确认 npm 包可见；本条已完成（PR #9167）。
5. 确认 `screenshots.json` 与 `assets/icon-180.png` 在 `main` 的 raw URL 可访问；awesome
   的 `icon:` 只接受 GitHub 托管位图，SVG 不接受。
6. README 已按 v0.1.0 的 npm 安装方式更新；收录后已改为“已收录”。
7. 后续验证：DSH Desktop origin、HTTPS loopback、DSH 新 preview 版本的 slot/tapIndex、
   系统服务停止链路。
