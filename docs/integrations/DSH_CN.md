# 在 DeepSeek Harness（DSH）中使用 Mebular

[English](DSH.md) · [返回文档索引](../README.md)

`@mebular/dsh-plugin` 把 Mebular 的记忆与任务图接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），并在 DSH
侧边栏嵌入共享的 Mebular Console。它是零构建 DSH bundle：一条 `mebular` host row 在运行时
发现 daemon，动态挂载官方 `@deepseek-ai/dsh-mcp-client`（Streamable HTTP），并让 iframe
指向与桌面 App 相同的 Console。

## 一套 Console，两个壳

| 面 | 职责 |
| --- | --- |
| **Mebular App / 守护进程** | 控制面：身份、存储锁、信任、同步、星图 Console。 |
| **DSH** | Agent 面：理解并调用 Mebular 工具，同时在侧边栏显示同一套 Console。 |

插件不会替换 App：它不另起第二套 Mebular Console、不直接读本地存储、不 import
`@mebular/*`。唯一契约是守护进程公开的 HTTP 接口：`/healthz`、`/app/embed/info`、
`/mcp` 和 `/console/?embed=dsh`。

## 前提

1. 先启动 Mebular App，或单独运行守护进程：

   ```bash
   mebular serve            # 默认 HTTP / MCP / Console 端口 7331
   curl -sS http://127.0.0.1:7331/healthz
   ```

2. 确认默认 MCP 端点为 `http://127.0.0.1:7331/mcp`。

> **用 HTTP，不要用 stdio。** stdio 会另起一个 Mebular 进程，和 App 的守护进程抢 storage
> lock（`MCP_STORAGE_LOCKED`）。本插件不声明 stdio transport，也不写 `command:`。

## 安装

从 npm 安装到 DSH 的 Web profile：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
```

插件开发时仍可从仓库工作树安装：

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

`@mebular/dsh-plugin` 是独立适配器：代码隔离在 `packages/dsh-plugin`，由独立 npm job
发布；版本随统一 Mebular release train，六个 npm 包同版本。插件已收录于
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 **memory**
分类（PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)）。

包内自带 `cordis.patch.yml`，只插入一条 host row：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
```

没有静态 MCP row，也没有写死的 `daemonUrl`。host 激活时解析 daemon URL，用同一个 origin
挂载官方 MCP client，并注册 sidebar / main 面板。重启 DSH 会话使 profile 生效。

## 验证

```bash
dsh --profile web --dump-config | grep -A6 mebular
```

输出块里应只有 `mebular` host row（`name: '@mebular/dsh-plugin'`），没有
`@deepseek-ai/dsh-mcp-client` row，也没有 `url:`。

DSH 会话里的工具名形如 `mcp__mebular__*`（例如某个记忆读写或任务工具）。调用一次并拿到
Mebular 的数据，就说明图已接通。侧边栏 Mebular 面板应显示同一套 Console；它的状态来自
仅限 loopback 的 `GET /mebular/embed-info`。

即使面板没有打开，Mebular 侧边栏图标也会带一个小状态点：绿色表示已连接，琥珀色表示启动中
或降级，红色表示未运行，灰色表示首次检查尚未返回。状态点与面板共用同一个轮询和状态源；
悬停状态点可看到当前状态。共享状态与恢复规则见
[表面状态契约](../architecture/SURFACES.md)。

如果调用返回 `NOT_INITIALIZED`，先在 Console 里新建 / 加入忆云；同一个 MCP 会话会自动
恢复，不需要重启守护进程。

守护进程未运行时，插件根本不会挂载 MCP client，因此不存在需要等待或调用的
`mcp__mebular__*` 工具。面板仍会加载并显示引导，Agent 也会收到一条短状态提示（见下文），
日志会给出
`mcp bridge unavailable (daemon_unreachable): start the Mebular app or run "mebular serve"`。
启动守护进程（或运行 `mebular serve`）后，插件会在下一次健康检查时自动挂载工具，面板也随
之恢复，不需要重启 DSH。`attach` 永远不会替你启动守护进程。

## daemon 发现与端口

默认端口是 `7331`。host 按以下顺序解析 daemon：

1. 插件配置里显式的 `daemonUrl`（拒绝含凭据的 URL）；
2. `MEBULAR_HTTP_PORT`；
3. `<home>/runtime.json`（daemon 在 HTTP listener 绑定后写入；`pid` 已不存在则视为 stale
   并跳过）；
4. `http://127.0.0.1:7331`。

`<home>` 与 Mebular CLI 一致：`MEBULAR_HOME`，缺省 `~/.mebular`。host 只读取非敏感发现
字段（`version`、`pid`、`http.host`、`http.port`、`consolePath`、`mcpPath`、
`embedProtocol`），不读 `config.json`、身份、token 或 store。

换端口时让 daemon 与 DSH 保持一致：

```bash
MEBULAR_HTTP_PORT=7332 dsh --profile web
```

面板、`/mebular/embed-info` 与 MCP 桥都跟随同一个解析结果，不需要单独改 MCP URL。

## 生命周期：attach 或 managed

`attach` 是默认值：只探测 `/healthz`，绝不启动或停止进程。没有 daemon 时，面板显示引导，
MCP bridge 不挂载，日志给出稳定的 `daemon_unreachable` 提示。daemon 启动后自动挂载；
daemon 停止后 dispose 子 fiber 并注销工具。

`managed` 复用健康 daemon；没有 daemon 时只启动一个
`mebular serve --port <port>` 子进程，等待 `/healthz`，dispose 时只停止这个 child。
child 处于 `starting` 时不挂载 MCP bridge；`managed_start_failed` / `managed_cli_missing`
后也不挂载，并记录对应的稳定 reason。daemon 变为健康后自动挂载，不需要重启 DSH：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: managed
    cliPath: /absolute/path/to/mebular
    panel: true
```

不安装系统服务；不覆盖 `MEBULAR_HOME`；外部 daemon（桌面 App、系统服务、手动
`mebular serve`）永远不会被停止。CLI 无法解析时降级为 `attach`，状态带
`reason: managed_cli_missing`。

只想保留 MCP、不显示侧边栏面板时，设置 `panel: false`（适用于 headless / TUI profile）。

## Agent 可见状态（仅 DSH）

Mebular 的可用性不仅显示在侧边栏，也会告诉 Agent。host 注册一个 DSH system prompt
section `mebular:status`：

- daemon `up` 时文本为空，不增加 prompt token；
- `down` 时告诉 Agent Mebular 记忆不可用，请用户启动 Mebular App 或运行
  `mebular serve`，并且不要声称记忆可用；
- `starting` 说明记忆工具暂时不可用；`managed_cli_missing` / `managed_start_failed`
  给出各自的恢复动作。

该 section 与 MCP bridge 使用同一份 lifecycle 快照，不新增轮询或第二个状态源。只有文本
变化时才通过 `system-prompt/change` 通知 DSH，不会每个健康检查 tick 都刷新。它是 profile
级别的 prompt 文本，该 profile 下所有 Agent 都可能看到。

这是 DSH adapter 的能力，不是 wire 字段，也不是通用 MCP 能力。host 通过
`ctx.inject(['systemPrompt'])` 注入可选服务；旧 DSH 或没有该服务的 profile 会安全跳过，
插件激活、面板与 MCP bridge 不受影响。`panel: false` 不会关闭它。不要假设其他 MCP
客户端也有这条提示；Mebular 不新增 `mebular_status` 工具。

## 安全

- `GET /mebular/embed-info` 只接受 loopback 请求；其他来源返回 `404`。
- 响应不含 token、密钥、home 路径、CLI 路径或进程环境。
- 只有 daemon、它的 loopback 标记、embed protocol `1` 和
  `capabilities.embedConsole` 全部满足时才创建 iframe；否则显示占位页。
- iframe sandbox 为 `allow-scripts allow-same-origin allow-forms`，不授予 top navigation。
- Console 只在 loopback daemon 的 `?embed=dsh` 下移除 `X-Frame-Options`，并把
  `frame-ancestors` 限制为 loopback HTTP 祖先。
- managed child 的日志先脱敏再进入 DSH logger。

## 插件位置

包代码在本仓库的 `packages/dsh-plugin`，npm 包名为 `@mebular/dsh-plugin`。GitHub
topic 是**仓库级**的：`dsh-plugin`、`deepseek-harness`、`agent-memory` 等关键词描述整个
Mebular 仓库，而不是一个独立包仓库，所以搜索会回到这里。完整配置参考见
[插件 README](../../packages/dsh-plugin/README.md)。

## 发布与版本

- 插件是独立适配器：代码隔离在 `packages/dsh-plugin`，npm 发布由独立的 `publish-dsh`
  job 执行。
- 六个 npm 包（`core`、`service`、`skill`、`mcp`、`fleet`、`dsh-plugin`）共用统一
  Mebular release train 的同一版本。每次发布都包含该插件，不单独为 DSH 插件发版。
- 发布是幂等的：`publish-dsh` job 从 `packages/dsh-plugin/package.json` 读取版本，
  `npm view` 已存在则跳过，否则执行发布。详见[发布 SOP](../operations/RELEASE.md)。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

这只移除 DSH 插件；Mebular App、数据和运行中的 Console 不受影响。
