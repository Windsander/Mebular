# 在 Hermes Agent 中使用 Mebular

[English](HERMES.md) · [返回文档索引](../README.md) · [Memory Runtime 指南](../design/0.3.0-memory-runtime_CN.md)

Hermes 可以通过两层接入 Mebular，两层可以同时使用：

| 层 | Hermes 得到什么 | 默认 |
|---|---|---|
| **MCP** | 官方 Mebular MCP server：显式的 `memory_*` 与 `task_*` 工具 | 配置后可用 |
| **Memory Runtime**（`MemoryProvider`） | 每轮自动召回、轮次/压缩 ingest、会话边界归档 | 关闭；显式 opt-in |

Provider 位于 [`integrations/hermes/mebular-memory`](../../integrations/hermes/mebular-memory/)；
可选 companion 位于
[`integrations/hermes/mebular-companion`](../../integrations/hermes/mebular-companion/)。
两者都不修改 Hermes 核心，也都不是 MCP 的前置条件。

## Hermes 的真实边界

Hermes 同一时刻只允许**一个外部 memory provider**。启用 Mebular 的
`MemoryProvider` 就是把它放进这个位置；它不会关闭 Hermes 内置的
`MEMORY.md` / `USER.md`，内置记忆继续工作。

Mebular 有意保持以下边界：

- 不导入、不镜像、不双写 `MEMORY.md` / `USER.md`；
- 不实现 `on_memory_write`；
- 不替换 MCP 工具面，也不注册重复的记忆工具；
- 不读取 Hermes 的 LLM token、endpoint 或 cookie；
- Hermes 不提供当前模型时，不伪造模型名。

## 两种模式

### 轻量 MCP

通过 Mebular 控制台的助手接入，或 Hermes 自己的配置，写入
`mcp_servers.mebular`。之后由助手决定何时调用 `memory_write`、`memory_query`、
`memory_profile`、`memory_history`、任务工具等。这与其他宿主使用同一套 29 个 MCP
工具，不涉及 Runtime 模型。

### 沉浸式 MemoryProvider

Provider 把 Hermes 的轮次接到 `/runtime/v1`：

- `prefetch` / `queue_prefetch` → `POST /runtime/v1/recall`，在模型轮次前注入短记忆
  上下文；
- `sync_turn` → `POST /runtime/v1/ingest`，非阻塞，按稳定的 `requestId` 去重；
- `on_pre_compress` / `on_session_end` → 对话快照 ingest（跳过 system 消息）；
- 失败写入进入本 profile 的持久队列，后台重试，不阻塞 Hermes。

Provider **不暴露任何工具**（`get_tool_schemas()` 返回空）。MCP 仍是显式治理面，29 个
工具的语义不变。

## 安装

安装目录必须叫 `plugins/mebular`，因为 Hermes 用目录名作为 `memory.provider` 的值：

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular"
cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
hermes config set memory.provider mebular

# 仅当 Mebular 使用 bearer/OAuth 时：
mebular token grant --scope memory.read,memory.write
# 把 MEBULAR_RUNTIME_TOKEN=... 放进 $HERMES_HOME/.env，不要写进配置文件。
```

Provider 默认从 `~/.mebular/runtime.json` 读取本机 Mebular 端点，不做网络探测。它只读
`MEBULAR_RUNTIME_TOKEN`，不读 Hermes 的模型凭据。非回环 Runtime 必须使用 HTTPS；此时
对话文本会离开本机。

可选 companion（宿主模型候选）：

```bash
rm -rf "$HERMES_HOME/plugins/mebular-companion"
cp -R integrations/hermes/mebular-companion "$HERMES_HOME/plugins/mebular-companion"
hermes plugins enable mebular-companion
export MEBULAR_COMPANION_ENABLED=1
```

Companion 是普通 standalone 插件，不是第二个 `MemoryProvider`。它在 `pre_llm_call` 中
通过 Hermes 官方 `ctx.llm` 把已完成的对话整理成 Mebular `CandidateRecord`，以
`extractor="host"` 提交，不向当前消息注入任何内容。它默认关闭，因为会增加一次宿主模型
调用和延迟。

## 配置

Provider 的优先级是：环境变量 > `$HERMES_HOME/mebular-memory.json` > 本地 `runtime.json`
发现。常用项：

| 配置 | 默认 | 含义 |
|---|---|---|
| `runtime_url` | 自动发现 | Runtime 根地址，例如 `http://127.0.0.1:7331` |
| `agent_id` | `hermes` | 逻辑 Agent ID |
| `namespace` | `default` | 记忆 namespace；`__*` 是保留域 |
| `capture` | `local` | 在本机保留 RawChunk；`off` 关闭 |
| `extractor` | `heuristic` | `heuristic`、`local` 或 `auto`；本 provider 不暴露 `api` |
| `sync_enabled` | `true` | 是否每轮发送 |
| `archive_enabled` | `true` | 是否发送压缩/会话快照 |
| `recall_limit` | `8` | 单次召回上限 |
| `recall_timeout` | `1.5` | 召回超时（秒） |
| `queue_limit` | `100` | 本地 spool 上限 |

完整键位与环境变量见
[`integrations/hermes/mebular-memory/README.md`](../../integrations/hermes/mebular-memory/README.md)。

## 原生记忆与当前模型

- **原生记忆：** `MEMORY.md` / `USER.md` 仍由 Hermes 自己维护。Mebular 不读、不写、
  不导入它们；启用 provider 不会关闭它们。
- **当前模型：** Hermes 的 `MemoryProvider` API 没有当前模型字段。Mebular 不伪造模型名。
  如果希望宿主模型抽取候选，启用可选 companion；否则 Runtime 使用 `heuristic`、已安装的
  本地 Qwen 或已配置的 API（受 provider 的 `extractor` 设置约束）。
- **MCP：** provider 的工具列表为空，因此显式写入、搜索、治理与任务操作仍通过 MCP 完成。

## 失败行为

- 召回失败返回空字符串，当前轮次继续。
- 写入失败留在 `$HERMES_HOME/mebular-memory/queue.jsonl`，后台重试。不可重试错误（例如
  `mode_mismatch`、`unauthorized`、`invalid_request`）会记录 warning 后从队列移除，避免
  无限堆积。
- 队列是单进程文件 spool；不要在同一个 `HERMES_HOME` 运行两个 Hermes 写者。
- Runtime API 不可用时，召回为空、写入留在队列；Hermes 主流程不受影响。

## 卸载

```bash
hermes config set memory.provider ""
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular"
# 可选：删除 provider 队列/配置
rm -rf "${HERMES_HOME:-$HOME/.hermes}/mebular-memory" \
       "${HERMES_HOME:-$HOME/.hermes}/mebular-memory.json"
```

MCP 配置与 Mebular 数据是分开的，卸载 provider 不会删除它们。

## 更多细节

- [Provider README](../../integrations/hermes/mebular-memory/README.md)
- [Companion README](../../integrations/hermes/mebular-companion/README.md)
- [Hermes 目录说明](../../integrations/hermes/README.md)
- [Memory Runtime 指南](../design/0.3.0-memory-runtime_CN.md)
