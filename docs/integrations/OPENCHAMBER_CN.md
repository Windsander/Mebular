# 在 OpenChamber / OpenCode 中使用 Mebular

[English](OPENCHAMBER.md) · [返回文档索引](../README.md) · [Memory Runtime 指南](../design/0.3.0-memory-runtime_CN.md)

OpenChamber 是基于 OpenCode 的桌面宿主。Mebular 通过两层接入：

| 层 | 得到什么 | 默认 |
|---|---|---|
| **MCP** | OpenCode global 配置里的官方 29 工具 Mebular server | 配置后可用 |
| **Memory Runtime**（`@mebular/opencode-plugin`） | request-only 召回、事件 ingest、压缩检查点、可选当前模型抽取 | 关闭；显式 opt-in |

OpenChamber 复用 OpenCode 的 global 配置。Mebular 只写 `mcp.servers.mebular`，永不写
OpenChamber 私有的 `opencode.managed.json` 或 `run/instances` 下的实例副本。

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

### 沉浸式插件

`packages/opencode-plugin` 是 OpenCode V2 服务端插件。它只走 HTTP：不 import
`@mebular/core`，不读 Mebular 配置或密钥，也不碰 OpenChamber 原生记忆。

前置条件：

- OpenCode **>= 2.2.0**（通过 `ctx.app.version` 检测）；
- `ctx.session.hook("context")` 可用；
- `ctx.session.generate` 可选；缺失时当前模型抽取会被如实标记为不可用。

把插件目录加入 OpenCode global 的 `~/.config/opencode/opencode.json`（不要写
OpenChamber 的 `opencode.managed.json`）：

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/mebular/packages/opencode-plugin",
      "options": {
        "runtimeUrl": "http://127.0.0.1:7331",
        "agentId": "opencode"
      }
    }
  ]
}
```

由你自己重载/重启 OpenChamber；Mebular 不会向运行中的宿主发 `opencode reload`。

## 插件做什么

- **召回：** 新的 user turn 调用 `POST /runtime/v1/recall`，把一段 request-only 的
  `<mebular_memory trust="untrusted">` 块（最多 8 KiB）放进本次模型请求。不写会话历史，
  不写 instructions。
- **Ingest：** 订阅会话事件，把 user/assistant/tool/compaction 内容以有界、幂等批次送到
  `POST /runtime/v1/ingest`。模型请求从不等待 ingest。
- **检查点：** 把一次 compaction 折叠成 ContextCheckpoint，经
  `/runtime/v1/checkpoints/:threadId` 写入。
- **工具遮蔽：** 普通 Agent 的 `mebular_*` 工具被隐藏；治理白名单可以为指定 Agent
  保留它们。
- **模型：** 默认 `modelSource=heuristic`。只有显式选择 `host`/`current` 时，插件才会在
  一轮完成后调用 `ctx.session.generate`；失败、超时或输出无法解析时回退 Runtime 的
  heuristic 抽取。它绝不在 `context` hook 里调用模型，也不读取宿主凭据。

## 配置

优先级：插件 options > 环境变量 > 插件配置文件 > 默认值。常用项：

| 键 | 默认 | 含义 |
|---|---|---|
| `runtimeUrl` | — | Runtime 根地址；缺失时插件禁用 |
| `token` | — | Bearer token，只用于 `Authorization` 头 |
| `agentId` | `opencode` | 逻辑 Agent ID |
| `capture` | `off` | `off` 或 `local`；local 会在本机保留 RawChunk |
| `recall` / `ingest` / `checkpoints` | `true` | 是否启用各路径 |
| `modelSource` | `heuristic` | `heuristic` 或 `host`/`current` |
| `hideMemoryTools` | `true` | 对普通 Agent 隐藏 Mebular 记忆工具 |
| `governanceAgents` | `mebular-memory`、`mebular-governance` | 保留工具面的 Agent |
| `recallTimeoutMs` | `800` | 召回超时；失败不注入 |
| `recallTokenBudget` | `2000` | 召回上下文预算 |
| `maxContextBytes` | `8192` | 注入块硬上限 |
| `maxChunkBytes` | `16384` | 单 chunk ingest 上限 |

环境变量：`MEBULAR_RUNTIME_URL`、`MEBULAR_RUNTIME_TOKEN`、
`MEBULAR_RUNTIME_AGENT_ID`、`MEBULAR_RUNTIME_NAMESPACE`、`MEBULAR_RUNTIME_MODEL`。
插件配置文件默认是 `$MEBULAR_HOME/opencode-plugin.json`。

## 当前模型的限制

OpenCode 不会把模型凭据交给插件，插件也不会索取。选择 `host`/`current` 时，它使用宿主
自己的 `ctx.session.generate`，并且只在一轮结束后调用。这带来三个结果：

- 抽取发生在轮次之后，不在召回过程中；
- `session.generate` 缺失或失败时回退 heuristic，不伪造宿主调用；
- Runtime 记录 `extractor='host'`，不会编造模型 ID。

Runtime 的全局模型设置仍作用于 ingest 路径。如果希望 Runtime 自己抽取，请在 Mebular
控制台配置本地 Qwen 或 API；如果明确希望由当前 OpenCode 模型产出候选，再设
`modelSource=host`。

## 失败行为

- 召回超时、无命中或 HTTP 失败：不注入任何块，请求继续。
- Ingest 是 fire-and-forget，有界队列；失败只计数，不阻塞模型循环。
- 压缩失败或中断不会被报告为已提交的 checkpoint。
- OpenCode 版本或 context hook 不支持时，插件带原因禁用自身，不影响宿主。
- 即使沉浸式插件被禁用，MCP 仍然可用。

## 卸载

从 OpenCode global 的 `plugins` 数组移除插件条目，或卸载包，然后重载 OpenChamber。MCP
条目与 Mebular 数据是分开的；只有确实要停止在该宿主使用 Mebular 时才移除它们。

## 更多细节

- [插件 README](../../packages/opencode-plugin/README.md)
- [Memory Runtime 指南](../design/0.3.0-memory-runtime_CN.md)
- [DSH 集成](DSH_CN.md) · [Hermes 集成](HERMES_CN.md)
