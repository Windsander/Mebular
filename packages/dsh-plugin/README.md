# @mebular/dsh-plugin

把 Mebular 的记忆、任务图与共享 Console 接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

**DSH 是 Mebular 的第二个壳，不是第二套 Console。** Console 只有一份，由 Mebular daemon 在
`/console` 提供；桌面 App、浏览器和 DSH 插件打开的是同一个页面。插件本身零构建、零运行时
依赖，也不 import 任何 `@mebular/*` 包。

插件做四件事：

- 用官方 `@deepseek-ai/dsh-mcp-client` 连接 Mebular 的 `/mcp`，把记忆工具注册给 DSH；
  连接、重连、工具发现与注册都归官方 peer，插件只负责按同一套 daemon 发现结果挂载；
- 在 DSH 侧边栏加入 **Mebular** 面板，用 iframe 加载共享 Console 的 `?embed=dsh`；
- 提供只读的 `GET /mebular/embed-info`，供面板判断 daemon 状态与可嵌入性；
- 默认 `attach` 只探测已有 daemon；可选 `managed` 在 daemon 不存在时启动并托管一个
  `mebular serve` 子进程。

## 前提

- Node.js `>=22.19`
- DSH `>=0.2.1-rc.2 <0.3.0`
- 已运行的 Mebular daemon（`attach`），或已安装 Mebular CLI（`managed` 可代为启动）

先启动 Mebular App（或单独运行 daemon），确认默认端点已就绪：

```bash
curl -sS http://127.0.0.1:7331/healthz
```

默认端口是 `7331`，MCP 路径是 `/mcp`，Console 路径是 `/console`。

## 安装

v0.1.0 起从 npm 安装到 DSH 的 Web profile：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.0
```

插件开发时仍可从仓库工作树安装：

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

安装后 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 会包含
`@mebular/dsh-plugin`。重启 DSH Web 后，侧边栏出现 Mebular 图标；点击后进入全局面板。

> `@mebular/dsh-plugin` 是**独立版本线**：v0.1.0 与 Mebular v0.1.0 同一 release train，
> 但版本号只由 `packages/dsh-plugin/package.json` 决定，不进入五包 lockstep。已收录于
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `memory`
> 分类（PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)）。

插件零构建：安装不会触发 `prepare` / `allowBuilds`。`@deepseek-ai/dsh-mcp-client` 声明为
peer（兼容范围 `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`），由 DSH host 在运行时
提供，不在插件内打包。

## 配置与 daemon 发现

`cordis.patch.yml` 只插入一行 `mebular`（本插件 host，`lifecycle: attach`，
`panel: true`）。它不写死 `daemonUrl`，也不插入静态的 MCP client row。MCP 桥由 host 在
`apply` 时动态 import 官方 `@deepseek-ai/dsh-mcp-client`，并用**同一个**解析后的 daemon
origin 挂载。因此面板、`/mebular/embed-info` 与 MCP 工具始终指向同一个端口。

host 按以下顺序确定 daemon origin：

1. 显式 `daemonUrl`（含凭据的 URL 会被拒绝）；
2. `MEBULAR_HTTP_PORT`（有效端口 1–65535）；
3. `<home>/runtime.json`（daemon 在 HTTP listen 成功后原子写入；`pid` 已不存在则视为
   stale 并跳过）；
4. `http://127.0.0.1:7331`。

`<home>` 与 Mebular CLI 一致：`MEBULAR_HOME` 覆盖，缺省 `~/.mebular`。host 只读取
runtime 文件里的 `version`、`pid`、`http.host`、`http.port`、`consolePath`、`mcpPath`、
`embedProtocol`，不读取 `config.json`、身份、token 或 store。

### 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `daemonUrl` | `http://127.0.0.1:7331` | Mebular daemon origin；只接受 `http:` / `https:`，尾部斜杠会被去掉 |
| `lifecycle` | `attach` | `attach` 只探测已有 daemon，绝不启动/停止；`managed` 在 daemon 不存在时启动一个由插件托管的 `mebular serve` 子进程 |
| `panel` | `true` | `false` 时不注册 DSH sidebar/main 面板；host 仍挂载官方 MCP client，工具照常可用 |
| `cliPath` | 未设置 | 仅 `managed` 使用；可执行的 Mebular CLI 路径。也接受 `MEBULAR_CLI`，最后回退到 `PATH` 上的 `mebular` |

非法 `lifecycle` / `panel` / `cliPath` 会回退到安全默认值并写一条 `warn` 日志，不会让
DSH 启动失败。

不提供 Mebular 系统设置（身份、网络、邀请、域、审计等）。这些设置只属于 Mebular Console。

### 生命周期策略

| 模式 | 已有健康 daemon | daemon 不存在 | 插件 dispose |
|---|---|---|---|
| `attach`（默认） | 复用，只探测 | 不启动，状态 `down`，面板显示启动引导 | 不停止任何进程 |
| `managed` | 复用，不启动（`managed: false`） | 解析 CLI 后启动 `mebular serve --port <port>`，有界等待 `/healthz`；失败时清理自己的 child | 只对自己启动的 child 发 `SIGTERM`，2s 后仍未退出则 `SIGKILL` |

`managed` 是子进程兜底，不是服务安装：

- 不 import `@mebular/service`，不调用系统服务管理器；
- 不覆盖 `MEBULAR_HOME`，让 Mebular CLI 自己解析 home；
- 插件本身不写 Mebular 配置、不读密钥/token/store；daemon 自己负责 `runtime.json` 与它的 home；
- 启动前先探测 `/healthz`；已有健康 daemon（包括服务托管或桌面 App 启动的实例）只复用，
  绝不抢占或停止；
- 等待 `/healthz` 有界（默认 20s），期间状态为 `starting`；超时、spawn error 或 child 提前
  退出时，只停止自己启动的 child，状态 `down`、`reason: managed_start_failed`，不会自动
  无限重试；
- 停止顺序固定为 `SIGTERM` → 2s grace → `SIGKILL`；外部 daemon（桌面 App、服务托管、
  手动 `mebular serve`）永远不会被 host 停止；
- Windows 上 CLI 为 `.cmd` / `.bat` 时使用 `shell: true` 启动（args 固定，不接受用户拼接
  命令）；其他平台直接 exec；
- CLI 无法解析时降级为 `attach`，状态 `down`、`reason: managed_cli_missing`，不会启动任何
  进程；
- managed child 的 stdout/stderr 先脱敏再写 DSH 日志：`token` / `secret` / `password` /
  `api_key` 等值替换为 `<redacted>`，`Authorization: Bearer …` 保留协议名，CLI 路径与
  `<home>` 替换为 `<cli>` / `<home>`；单行上限 500 字符。

### 只关闭面板，保留 MCP

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    panel: false
```

`panel: false` 时 sidebar 入口与 `main` 面板都不注册；`/mebular/embed-info` 仍可访问，官方
MCP client 仍在 `apply` 时挂载。host 通过 DSH `webServer.tapIndex` 注入
`window.__MEBULAR_DSH__={"panel":false}`，client 在 `apply` 时读取。

### 端口与环境变量

| 变量 | 作用 |
|---|---|
| `MEBULAR_HTTP_PORT` | 覆盖 daemon 端口（默认 `7331`）；host、面板、MCP 桥一起跟随 |
| `MEBULAR_HOME` | Mebular home，用于定位 `runtime.json`；缺省 `~/.mebular` |
| `MEBULAR_CLI` | `managed` 模式下 Mebular CLI 路径的候选（`cliPath` 优先） |
| `DSH_HOME` | DSH 自己的 profile 根；与 Mebular home 无关 |

端口覆盖示例：

```sh
MEBULAR_HTTP_PORT=7332 dsh --profile web
```

`managed` 启动的 `--port` 取自最终解析出的 `daemonUrl` 端口。MCP client 不自己读端口、
不自己重连：连接、重连与工具注册全部归官方 peer；daemon 未启动时它按
`failOnStartupError: false` 等待并重试。

## 验证

安装并重启后，先看 profile 组合结果：

```bash
dsh --profile web --dump-config | grep -A6 mebular
```

应该只看到一条 `mebular` host row（`name: '@mebular/dsh-plugin'`），没有静态的
`@deepseek-ai/dsh-mcp-client` row，也没有写死的 URL。

工具列表里应出现 `mebular` 服务下的工具，命名形如：

```text
mcp__mebular__*
```

例如让 DSH 调用 `mcp__mebular__*` 中的记忆检索/写入工具；能返回 Mebular 的数据即接通。
DSH 与 Mebular App 同时保持运行，Mebular App 继续独立运行、继续负责存储与控制台，不会因为
安装插件而退出或消失。

P7.3 在 `@deepseek-ai/dsh@0.2.1-rc.2`、临时 home 与非默认端口上实测：侧边栏出现 Mebular，
iframe 为 `/console/?embed=dsh`，Console 内 `dataset.embed='dsh'`、星图与设置正常；
临时 probe 插件从 `ctx.tools.schemas()` 读到 29 个 `mcp__mebular__*` 工具（总计 33 个，
其余为 DSH 自带工具）。工具数量会随 daemon 版本变化，不承诺固定值。

面板状态可单独检查（只接受 loopback 请求）：

```bash
curl -sS http://127.0.0.1:7331/app/embed/info
curl -sS http://127.0.0.1:<dsh-port>/mebular/embed-info
```

`/mebular/embed-info` 返回非敏感状态 JSON（`status`、`mode`、`managed`、`panel`、
`version`、`embedProtocol`、`consoleUrl`、`embedUrl`、`mcpUrl`、`loopback`、`reason`）。
只有 daemon、`/app/embed/info` 的 `loopback`、`embedProtocol`、`capabilities.embedConsole`
全部满足时才返回 `embedUrl`；否则面板显示占位页，不加载 iframe。

## 状态契约

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

- `status`：`up`（daemon 健康）、`down`（不可达/未健康）、`starting`（managed 正在启动并
  等待 healthz）。`starting` 时 `embedUrl` 为 `null`，面板不加载 iframe。
- `mode`：当前生效的生命周期。CLI 缺失时从 `managed` 降级为 `attach`。
- `managed`：仅当当前 daemon 由本插件启动且 child 仍在运行时为 `true`；复用外部 daemon 时
  始终为 `false`。
- `panel`：当前 `panel` 配置的非敏感快照。`panel: false` 时 client 不注册槽位，但该只读
  路由仍可用于诊断。
- `reason`：稳定诊断码，成功为 `null`。当前包括 `daemon_unreachable`、`daemon_unhealthy`、
  `embed_info_unavailable`、`embed_not_ok`、`not_loopback`、
  `embed_protocol_unsupported`、`embed_unsupported`、`embed_url_invalid`、
  `managed_cli_missing`、`managed_start_failed`。
- 不返回 token、密钥、home 路径、CLI 路径或进程环境。

状态路由只接受 loopback 请求；其他来源返回 `404`，响应带 `Cache-Control: no-store`。
1s 状态缓存由生命周期持有，`starting` 期间不缓存失败。

## 架构边界

```text
DSH host                         Mebular daemon
  ├─ cordis.patch.yml            ├─ /healthz
  │   └─ mebular (index.js)      ├─ /app/embed/info
  │       ├─ GET /mebular/embed-info
  │       └─ mounts official mcp-client ──┼─ /mcp
  └─ client.js
      └─ iframe ─────────────────┼─ /console/?embed=dsh
```

- 本包**不 import** `@mebular/core`、`@mebular/console`、`@mebular/desktop`，也不复制
  Console 的任何 UI 或静态资源。
- Console 只有一套实现，由 Mebular daemon 提供；DSH 只负责 iframe 容器。
- 插件不打开 `store.jsonl`、不读密钥/token、不写 `~/.mebular`。
- 插件只动态 import 官方 `@deepseek-ai/dsh-mcp-client` peer；MCP 连接、重连、工具发现与
  注册仍归该官方包，host 只负责用发现的 origin 挂载它，不实现 MCP 客户端。
- 面板与 MCP 桥共享同一次 daemon 解析；不会出现“面板连 7332、工具连 7331”。

## 安全

- `GET /mebular/embed-info` 只接受 loopback 请求（检查 `req.socket.remoteAddress`），其他
  来源返回 `404`。
- 路由只返回上述非敏感 JSON；响应带 `Cache-Control: no-store`。
- 只有 daemon URL、`/app/embed/info` 的 `loopback`、`embedProtocol`、
  `capabilities.embedConsole` 全部满足时才返回可嵌入状态；否则 `embedUrl` 为 `null`，面板
  显示占位页，不加载 iframe。
- iframe 使用 `sandbox="allow-scripts allow-same-origin allow-forms"`，不授予 top
  navigation；iframe 超时或加载失败时同样回退到占位页，不保留空白框。
- Console 的 `?embed=dsh` 只在 daemon 绑定 loopback 时移除 `X-Frame-Options`，并把
  `frame-ancestors` 限制为 loopback HTTP 祖先；普通 `/console` 仍为 `DENY` / `'none'`。
- `<home>/runtime.json` 只含 version/pid/HTTP 地址/Console、MCP 路径/embed 协议，权限
  `0600`，原子写入；停止时按 pid 清理，stale 文件不会阻塞 host 回退。host 不读取 Mebular
  配置、身份、token 或 store。
- panel 全局只包含 `{"panel":boolean}`，JSON 中的 `<` 转义为 `\u003c` 后才进入内联
  `<script>`；host 不向页面注入 daemonUrl 或凭据。
- 插件不接受长期 token 进 URL。Mebular 的 OAuth/凭据协商由 MCP 客户端负责，不经过面板
  URL。
- `managed` 子进程只继承环境、不写 Mebular home；stdout/stderr 脱敏后才进 DSH 日志。

## 已知限制

- **默认不托管**：默认 `attach` 不启动、不停止 Mebular。daemon 未运行时面板显示引导与
  “在浏览器打开 Console”，官方 MCP client 保持等待/重连。只有显式 `lifecycle: managed`
  才会启动子进程，且只停止自己启动的 child。
- **仅 loopback 可嵌入**：DSH 或 Mebular 任一侧不在 loopback（例如公网 HTTPS DSH）时，
  面板只显示占位页。这是有意设计；当前 `frame-ancestors` 也只放行 HTTP loopback。
- **MCP peer 由 DSH 提供**：`@deepseek-ai/dsh-mcp-client` 是 peerDependency，不在插件内
  打包。正常 DSH 安装下 host 能在 `apply` 时解析并挂载；在 Jest、普通 Node 或缺少该 peer
  的宿主里，`import` 会失败并记录 `mcp client mount failed (ERR_MODULE_NOT_FOUND)`，面板
  与 `/mebular/embed-info` 不受影响，但 MCP 工具不可用。
- **runtime home**：host 用 `MEBULAR_HOME`（缺省 `~/.mebular`）定位 runtime.json；如果 DSH
  与 daemon 运行在不同 home，自动发现不会命中，请显式设置 `daemonUrl` 或
  `MEBULAR_HTTP_PORT`。
- **DSH preview API**：`panel` 开关依赖 DSH `0.2.1-rc.2` 的
  `webServer.tapIndex(transform)`；若未来 DSH 移除该 API，client 会因全局缺失而回退为
  `panel:true`。`dsh.client` / slot API 仍在 developer preview，升级 DSH 后需要重新验证
  `sidebar.panellist` 与 `main` keyed slot。
- **MCP 工具数量随 daemon 版本变化**：插件不承诺固定数量。
- **Desktop origin 未验证**：`@deepseek-ai/dsh-desktop-host` 不在 npm 上，也未出现在公开
  DSH 仓库可检索的 tree 中。当前 CSP 只放行 HTTP loopback；若 DSH Desktop 使用 HTTPS 或
  自定义 scheme，需要扩展 `frame-ancestors` 并重跑 E2E。
- **卸载残留**：`dsh plugin remove` 后 pnpm 可能保留 `node_modules/@mebular/dsh-plugin`
  符号链接；它不在 profile bundles 中，不会被加载。
- **截图状态**：`assets/dsh-panel.jpg` 来自隔离的临时 daemon。Console 顶部显示“守护
  未运行 / 未启用 P2P / 记忆 0”是临时实例真值，DSH 面板 header 同时显示“已连接”；
  截图不是 mock。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

确认：

```bash
dsh --profile web --dump-config | grep -i mebular   # 应无输出
```

卸载只移除 DSH 插件；Mebular daemon 与 Console 不受影响，`/healthz`、`/console/` 仍可用。
不要删除 Mebular home 或 store。

## 开发与测试

```sh
# host 纯函数 + HTTP handler + 生命周期 + 客户端契约
npm test -- --runInBand tests/dsh

# 相关回归（Console embed / MCP / runtime / shutdown）
npm test -- --runInBand tests/dsh tests/console tests/mcp

# 插件打包契约（无网络、不写文件）
npm run verify:dsh-plugin
```

`index.js` 是纯 ESM host plugin；`client.js` 是手写
`window.__ModuleLoader__.load({ id: '@mebular/dsh-plugin', factory })` 包装，仅
`require('react')`。两者都没有构建步骤。

## 发布状态

- 版本：`0.1.0`
- npm：`@mebular/dsh-plugin@0.1.0`（随 Mebular v0.1.0 release train，独立版本线）
- 官方插件列表：已收录（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `memory` 分类，PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)）
- 正式安装：`dsh plugin --profile web add @mebular/dsh-plugin@0.1.0`
- 开发安装：`dsh plugin --profile web add ./packages/dsh-plugin`
- 版本线：不进入 `core` / `service` / `skill` / `mcp` / `fleet` 五包 lockstep

## License

MIT
