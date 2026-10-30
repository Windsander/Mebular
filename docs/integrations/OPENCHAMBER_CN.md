# 在 OpenChamber / OpenCode 中使用 Mebular

[English](OPENCHAMBER.md) · [返回文档索引](../README.md) · [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)

OpenChamber 是基于 OpenCode 的桌面宿主。Mebular 通过两层接入：

| 层 | 得到什么 | 默认 |
|---|---|---|
| **MCP** | OpenCode global 配置里的官方 29 工具 Mebular server | 配置后可用 |
| **Memory Runtime**（`@mebular/opencode-plugin`） | request-only 召回、事件 ingest、压缩检查点、可选当前模型抽取 | 自动跟随 sidecar discovery 模式；无逐宿主 enable/采集开关 |

OpenChamber 复用 OpenCode 的 global 配置。Mebular 只写 `mcp.servers.mebular`，永不写
OpenChamber 私有的 `opencode.managed.json` 或 `run/instances` 下的实例副本。

Memory Runtime sidecar 是**独立于 MCP daemon runtime 的另一个进程**。插件只访问
`/memory-runtime/v1`，绝不把 OpenCode/OpenChamber 设置、MCP daemon 的 `runtime.json` 或
`/mcp` 端点当成 sidecar。

## 边界

Mebular 与 OpenChamber 的记忆保持分离：

- 从 Mebular 的视角看，OpenChamber 原生记忆是**只读**的。助手探测只检查
  `OPENCHAMBER_MEMORY_ENABLE`、`settings.json` 的 `agentMemoryToolEnabled`，以及
  `memory.json` 是否存在；绝不读取条目。
- Mebular 不导入、不替换、不双写，也不注册 OpenChamber 的原生记忆工具。
- 沉浸式插件不读、不写 OpenChamber 设置、`memory.json` 或 managed config。
- token、模型凭据和 OpenChamber 状态不会出现在日志或状态里。

原生记忆开启时，Mebular 的沉浸式路径仍需显式 opt-in；默认仍是 tool-only。开启 Mebular
不会关闭 OpenChamber 的记忆。

## 两种模式

### 轻量 MCP

用 Mebular 控制台的 OpenChamber 助手接入，或自己把 MCP server 加进 OpenCode global
配置。OpenChamber 重载后会读取同一个条目：

```jsonc
{
  "mcp": {
    "servers": {
      "mebular": {
        "url": "http://127.0.0.1:7331/mcp",
        "enabled": true,
        "oauth": false,
        "codemode": false
      }
    }
  }
}
```

同一套 29 个 `memory_*` / `task_*` 工具可用。Mebular 不从 OpenChamber 读取 store 或身份；
所有调用都走守护的 `/mcp`。

轻量模式**不启动** Memory Runtime sidecar：没有 `mebular-memory-runtime` 进程，不新建
`<home>/memory-runtime/` 目录或文件，不生成 `memory-runtime.json`、host token，不监听
7341 端口，也不下载模型。如果之前用过沉浸式、`<home>/memory-runtime/` 已经存在，轻量
模式既不读取也不修改它。

### 沉浸式插件

`packages/opencode-plugin` 是 OpenCode V2 服务端插件。它只走 HTTP：不 import
`@mebular/core`，不读 Mebular 配置或密钥，也不碰 OpenChamber 原生记忆。

前置条件：

- OpenCode **>= 2.2.0**（通过 `ctx.app.version` 检测）；
- `ctx.session.hook("context")` 可用；
- `ctx.session.generate` 可选；缺失时当前模型抽取会被如实标记为不可用；
- 0.3 Memory Runtime sidecar 正在运行。只有 `memoryRuntime.enabled=true` 时 MCP daemon
  才会启动它（通常从 Mebular 控制台或 `<home>/config.json` 设置）：

  ```jsonc
  {
    "memoryRuntime": {
      "enabled": true
    }
  }
  ```

  用 `mebular memory-runtime status --json` 确认。就绪的 sidecar 会发布
  `<home>/memory-runtime.json` 和 `<home>/memory-runtime/host-token`，插件读取两者。
  sidecar 需要单独安装（`npm install -g @mebular/memory-runtime` 或桌面端捆绑）；
  MCP 不会自动下载它。自动启动属于 HTTP MCP daemon（`mebular serve`），stdio
  `mebular mcp` 不会启动 sidecar。

把插件目录加入 OpenCode global 的 `~/.config/opencode/opencode.json`（不要写
OpenChamber 的 `opencode.managed.json`）：

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/mebular/packages/opencode-plugin",
      "options": {
        "agentId": "opencode"
        // runtimeUrl 可选；不写时读取 <home>/memory-runtime.json，绝不猜端口。
        // "runtimeUrl": "http://127.0.0.1:7341/memory-runtime/v1"
      }
    }
  ]
}
```

由你自己重载/重启 OpenChamber；Mebular 不会向运行中的宿主发 `opencode reload`。

## 插件做什么

- **召回：** 新的 user turn 调用 `POST /memory-runtime/v1/context`（默认超时 800ms），把
  一段 request-only 的 `<mebular_memory trust="untrusted">` 块（最多 8 KiB）放进本次模型
  请求。该块 push 到 `event.system`，带 `metadata.requestOnly=true`；不写会话历史、不写
  instructions、不发 synthetic user message。同一 user turn 的 tool continuation 会去重，
  不重复注入。
- **Ingest：** 订阅会话事件，把 user/assistant/tool/compaction 内容以有界、幂等批次送到
  `POST /memory-runtime/v1/ingest`。模型请求从不等待 ingest。缓冲在内存中，不是持久
  spool。
- **检查点：** 把 `session.compaction.ended` 折叠成 ContextCheckpoint。事件带 summary 时，
  先 ingest 一条 `system` compaction chunk，再 `PUT
  /memory-runtime/v1/checkpoints/:threadId`，`domain=task:<sessionId>`；没有 summary 就不
  编造 summary。`revision_mismatch` 会 GET 当前 revision 并重试一次；失败保持 pending，
  绝不报告为已提交。
- **工具遮蔽：** 普通 Agent 的请求工具表会删除当前可见的 `mebular_*`；
  `governanceAgents`（默认 `mebular-memory`、`mebular-governance`）保留。`mebular_status`
  是插件诊断工具，不是 MCP 工具。29 个 MCP 工具不变。
- **模型：** 默认 `modelSource=heuristic`。只有显式选择 `host`/`current`（或
  `MEBULAR_MEMORY_RUNTIME_MODEL=host`）时，插件才会在**一轮完成后**调用
  `ctx.session.generate`；缺失、失败、超时或输出无法解析时回退 sidecar 的 heuristic
  抽取。它绝不在 `context` hook 里调用模型，也不读取宿主凭据。

## 发现与认证

URL 优先级：

1. 插件 option `runtimeUrl`（也接受 `url`）；
2. `MEBULAR_MEMORY_RUNTIME_URL`；
3. 插件配置文件（默认 `$MEBULAR_HOME/opencode-plugin.json`，或
   `$MEBULAR_OPENCODE_PLUGIN_CONFIG`）；
4. sidecar 发现 `<MEBULAR_HOME>/memory-runtime.json`；
5. 没有可用 URL → 插件禁用并报 `runtime_not_discovered`。

插件不盲连 7341，也不把 MCP daemon 的 `runtime.json` 当作 sidecar。显式 `runtimeUrl` 可以
写 sidecar 根地址（`http://127.0.0.1:7341`）或完整的 `/memory-runtime/v1` base。旧
`/runtime/v1` 会被拒绝（`runtime_url_legacy`）；非回环 plain `http` 会被拒绝
（`runtime_insecure_url`）。

Token 优先级：

1. 插件 option `token`；
2. `MEBULAR_MEMORY_RUNTIME_TOKEN`；
3. 插件配置文件；
4. 发现文件 `tokenFile`，默认 `<home>/memory-runtime/host-token`。

Token 是 sidecar 的 **host token**，不是 MCP capability token。POSIX 下 token 文件必须为
`0600`，组/其他可读会被拒绝（`token_file_insecure`）。插件只发送
`Authorization: Bearer`，不会记录 token，也不会把它放进 `getStatus()`。

## 配置

优先级：插件 options > 环境变量 > 插件配置文件 > 发现 > 默认值。常用项：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 显式关闭插件 |
| `runtimeUrl` | — | sidecar 根地址或 `/memory-runtime/v1` base；缺省走环境/配置/发现 |
| `token` | — | Host bearer token；只用于 `Authorization` |
| `tokenFile` | — | 显式 host token 文件；缺省用发现 `tokenFile` 或 `<home>/memory-runtime/host-token` |
| `agentId` | `opencode` | 逻辑 Agent ID |
| `namespace` / `namespaces` | — | 旧召回域别名；`namespace` 仅只读兼容 |
| `domains` | — | v2 记忆域（如 `user` / `agent:opencode`）；缺省由 sidecar 决定 |
| ~~`capture`~~ | — | 0.3.0 已删除；旧值忽略，采集由 sidecar 模式负责 |
| `recall` / `ingest` / `checkpoints` | `true` | 是否启用各路径 |
| `modelSource` | `heuristic` | `heuristic`，或 `host`/`current` 使用 `ctx.session.generate` |
| `hideMemoryTools` | `true` | 对普通 Agent 删除 `mebular_*` 工具 |
| `governanceAgents` | `mebular-memory`、`mebular-governance` | 保留工具面的 Agent |
| `recallLimit` | `8` | 召回记录上限 |
| `recallTokenBudget` | `2000` | 上下文 token 预算 |
| `maxFragments` | `3` | 单次 context 最多片段数 |
| `recallTimeoutMs` | `800` | context 超时；失败/超时静默不注入 |
| `maxContextBytes` | `8192` | 注入块硬上限 |
| `maxChunkBytes` | `16384` | 单 chunk ingest 上限 |
| `maxCaptureMessages` | `12` | 每次捕获检查的最近会话消息数 |
| `hostExtractTimeoutMs` | `15000` | 后台 `session.generate` 超时 |

环境变量：`MEBULAR_MEMORY_RUNTIME_URL`、`MEBULAR_MEMORY_RUNTIME_TOKEN`、
`MEBULAR_MEMORY_RUNTIME_AGENT_ID`、`MEBULAR_MEMORY_RUNTIME_NAMESPACE`、
`MEBULAR_MEMORY_RUNTIME_DOMAIN`、`MEBULAR_MEMORY_RUNTIME_MODEL`、
`MEBULAR_OPENCODE_PLUGIN_CONFIG`。旧 `MEBULAR_MEMORY_RUNTIME_CAPTURE` 忽略。

插件配置文件默认是 `$MEBULAR_HOME/opencode-plugin.json`，可写
`{ "memoryRuntime": { ... } }` 或平铺键；它不读取 Mebular 的 `config.json`、OpenChamber
设置、`memory.json` 或 managed config。

## 当前模型的限制

OpenCode 不会把模型凭据交给插件，插件也不会索取。选择 `host`/`current` 时，它使用宿主
自己的 `ctx.session.generate`，并且只在一轮结束后调用。这带来三个结果：

- 抽取发生在轮次之后，不在召回过程中；
- `session.generate` 缺失、失败、超时或没有可解析候选时回退 heuristic，不伪造宿主调用；
- sidecar 记录 `extractor='host'`，不会编造模型 ID。

## 失败行为

- 召回超时、无命中或 HTTP 失败：不注入任何块，请求继续；连续失败进入 30 秒冷却。
- Ingest 是 fire-and-forget，有界内存队列；失败只计数，不阻塞模型循环。本插件没有持久
  ingest spool。
- 压缩失败或中断不会被报告为已提交的 checkpoint。`revision_mismatch` 会读一次并重试
  一次；仍失败则保持 pending/可见。
- OpenCode 版本或 context hook 不支持时，插件带原因禁用自身，不影响宿主。
- 即使沉浸式插件被禁用，MCP 仍然可用。

## 从 0.2 升级 / 从旧原型迁移

- **没有强制迁移。** 0.2 的记录保留原 ID、namespace、tag 和事件。旧的 `default`
  namespace 原样保留，按第三类/Other 兜底解释（`domain=default`），不会改写成 `user`。
- MCP 只保留生命周期键（`memoryRuntime.enabled`、`memoryRuntime.command`、
  `memoryRuntime.startTimeoutMs`）。详情/staging、模型、trace、retention 属于
  `<home>/memory-runtime/config.json`，不再放在 MCP 的 `runtime.*` 键下。
- 检查点和 SelfRecord 没有本地/云端二选一。没有 `sync=cloud`、`checkpoint.sync` 或
  `self.sync`；所有持久对象都经 MCP 写入，并由现有云端同步传播。
- `/runtime/v1` 不再提供，也没有兼容层。把 `runtimeUrl` 指向 `/memory-runtime/v1`
  base（或直接省略，走发现）。仍指向 `/runtime/v1` 的旧插件会被拒绝/禁用；MCP 继续
  可用。
- 原型写到 `<home>/runtime/` 的本地数据不会被读取或迁移。不要删除
  `<cloudRoot>/runtime/`；那是 MCP daemon 的安装根，不是 sidecar 数据。
- 要关闭 sidecar，设置 `memoryRuntime.enabled=false`，或从 OpenCode 的 `plugins` 数组移除
  插件条目。sidecar 停止，29 个 MCP 工具和已沉降记忆保留。`<home>/memory-runtime/`
  可保留或删除；删除它不会删除已沉降记忆。

## 卸载

从 OpenCode global 的 `plugins` 数组移除插件条目，或卸载包，然后重载 OpenChamber。MCP
条目与 Mebular 数据是分开的；只有确实要停止在该宿主使用 Mebular 时才移除它们。

## 更多细节

- [插件 README](../../packages/opencode-plugin/README.md)
- [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)
- [DSH 集成](DSH_CN.md) · [Hermes 集成](HERMES_CN.md)
