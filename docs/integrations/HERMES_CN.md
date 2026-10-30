# 在 Hermes Agent 中使用 Mebular

[English](HERMES.md) · [返回文档索引](../README.md) · [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)

Hermes 可以通过两层接入 Mebular，两层可以同时使用：

| 层 | Hermes 得到什么 | 默认 |
|---|---|---|
| **MCP** | 官方 Mebular MCP server：显式的 `memory_*` 与 `task_*` 工具 | 配置后可用 |
| **Memory Runtime**（`MemoryProvider`） | 每轮自动召回、轮次/压缩 ingest、state-only 检查点、会话边界归档 | 自动跟随 sidecar discovery 模式；无逐宿主 enable/capture |

Provider 位于 [`integrations/hermes/mebular-memory`](../../integrations/hermes/mebular-memory/)；
可选 companion 位于
[`integrations/hermes/mebular-companion`](../../integrations/hermes/mebular-companion/)。
两者都不修改 Hermes 核心，也都不是 MCP 的前置条件。

Memory Runtime sidecar 是**独立于 MCP daemon runtime 的另一个进程**。Provider 只访问
`/memory-runtime/v1`，绝不把 MCP daemon 的 `runtime.json`、`/mcp` 端点或 `daemonUrl`
当成 sidecar。

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
工具。

轻量模式**不启动** Memory Runtime sidecar：没有 `mebular-memory-runtime` 进程，不新建
`<home>/memory-runtime/` 目录或文件，不生成 `memory-runtime.json`、host token，不监听
7341 端口，也不下载模型。如果之前用过沉浸式、`<home>/memory-runtime/` 已经存在，轻量
模式既不读取也不修改它；关闭 sidecar 不会删除已沉降记忆。

### 沉浸式 MemoryProvider

Provider 把 Hermes 的轮次接到独立 sidecar：

- `prefetch` / `queue_prefetch` → `POST /memory-runtime/v1/context`；只有旧 sidecar 没有
  `/context` 时才回落到 `/recall`；
- `sync_turn` → `POST /memory-runtime/v1/ingest`，非阻塞，按稳定的 `requestId` 去重；
- `on_pre_compress` → 归档 ingest，并 `PUT
  /memory-runtime/v1/checkpoints/:threadId` 写 **state-only** 检查点；
- `on_session_end` → 归档 ingest；默认不写检查点。

Provider **不暴露任何工具**（`get_tool_schemas()` 返回空）。MCP 仍是显式治理面，29 个
工具的语义不变。

## 启用 sidecar 与 provider

Provider 需要 0.3 Memory Runtime sidecar 正在运行。只有 MCP 设置
`memoryRuntime.enabled=true`（或你手动执行 `mebular memory-runtime start`）时，MCP daemon
才会启动它。正常流程：

1. 在 Mebular 控制台选择沉浸式记忆运行时，或直接设置 MCP 配置。MCP 配置通常在
   `<home>/config.json`（默认 profile 为 `~/.mebular/config.json`）：

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

   sidecar 需要单独安装（`npm install -g @mebular/memory-runtime` 或桌面端捆绑）；
   MCP 不会自动下载它。自动启动属于 HTTP MCP daemon（`mebular serve`），stdio
   `mebular mcp` 不会启动 sidecar。

2. 确认 sidecar 已就绪，并已发布发现文件和 host token：

   ```bash
   mebular memory-runtime status --json
   ```

   sidecar 就绪时存在 `<home>/memory-runtime.json`，其中包含 sidecar URL 和
   `tokenFile`（通常是 `<home>/memory-runtime/host-token`）。

3. 安装目录必须叫 `plugins/mebular`，因为 Hermes 用目录名作为 `memory.provider` 的值：

   ```bash
   HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

   mkdir -p "$HERMES_HOME/plugins"
   rm -rf "$HERMES_HOME/plugins/mebular"
   cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
   hermes config set memory.provider mebular
   ```

4. 验证：

   ```bash
   hermes memory status
   ```

通常**不需要**配置 token。sidecar 每次启动都会生成 host token，并把路径写进发现文件；
provider 自动读取，并在 POSIX 上拒绝组/其他可读的 token 文件。
`MEBULAR_MEMORY_RUNTIME_TOKEN` 只是测试/排障覆盖，**不是** MCP capability token；provider
不读 MCP token、`tokens.json` 或 Hermes 模型凭据。

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

## 发现与认证

URL 优先级从高到低：

1. `$HERMES_HOME/mebular-memory.json` 的 `runtime_url`；
2. `MEBULAR_MEMORY_RUNTIME_URL`；
3. sidecar 写出的 `<home>/memory-runtime.json`；
4. 没有可用发现 → provider 保持禁用（`runtime_not_discovered`）。

`<home>` 依次取 `MEBULAR_MEMORY_RUNTIME_HOME`、`MEBULAR_HOME`、当前 Mebular profile
（缺省 `~/.mebular`）。Provider 不做网络扫描、不猜端口，也不读 MCP daemon 的
`runtime.json`。

Token 优先级：

1. `MEBULAR_MEMORY_RUNTIME_TOKEN`；
2. 同名 Hermes secret scope；
3. 发现文件的 `tokenFile`（默认 `<home>/memory-runtime/host-token`）。

只有回环 `http://` 可以不带 TLS。非回环 sidecar 必须使用 HTTPS；此时对话文本会离开
本机。401 时 provider 会重读一次 token 文件；仍失败则召回为空、写入留在 spool。

## 配置

Provider 的普通配置优先读环境变量，再读 `$HERMES_HOME/mebular-memory.json`。
`runtime_url` 是例外：如上面的发现顺序所示，配置文件优先于环境变量。常用项：

| 配置 | 默认 | 含义 |
|---|---|---|
| `runtime_url` | 自动发现 | Memory Runtime sidecar 根地址，例如 `http://127.0.0.1:7341` 或 `http://127.0.0.1:7341/memory-runtime/v1` |
| `agent_id` | `hermes` | 稳定的逻辑 Agent ID；对应 `agent:hermes` |
| `domain` | 空 | 可选的写入域；留空由 sidecar 分类。请求不再发送单独的 `namespace` |
| `extractor` | `heuristic` | `heuristic`、`local` 或 `auto`；本 provider 不使用远端 `api` 抽取 |
| `recall_limit` | `8` | 召回片段上限（provider 实际把请求上限压到 3 个片段） |
| `recall_token_budget` | `2000` | 召回上下文 token 预算 |
| `recall_timeout` | `1.5` | 召回超时（秒） |
| `ingest_timeout` | `3.0` | 单次 ingest HTTP 超时（秒） |
| `archive_flush_timeout` | `1.5` | 压缩前尝试 flush 归档的最长等待（秒） |
| `checkpoint_timeout` | `2.5` | checkpoint PUT/GET 超时（秒） |
| `queue_limit` | `100` | 有界持久 spool 上限 |

环境变量：`MEBULAR_MEMORY_RUNTIME_URL`、`MEBULAR_MEMORY_RUNTIME_TOKEN`、
`MEBULAR_MEMORY_RUNTIME_HOME`、`MEBULAR_HOME`、`MEBULAR_MEMORY_AGENT_ID`、
`MEBULAR_MEMORY_DOMAIN`、`MEBULAR_MEMORY_EXTRACTOR`、
`MEBULAR_MEMORY_RECALL_LIMIT`、`MEBULAR_MEMORY_RECALL_TIMEOUT`、`MEBULAR_MEMORY_INGEST_TIMEOUT`、
`MEBULAR_MEMORY_CHECKPOINT_TIMEOUT`、`MEBULAR_MEMORY_QUEUE_LIMIT`。

完整键位与环境变量见
[`integrations/hermes/mebular-memory/README.md`](../../integrations/hermes/mebular-memory/README.md)。

## 会写入什么

- `sync_turn` 只发送最后一个 user 消息之后的片段，避免每轮重复发送整段历史。assistant
  的 `tool_calls` 与 `role=tool` 结果会展开为文本；system 消息和二进制/多模态载荷被跳过。
- `on_pre_compress` / `on_session_end` 发送有界对话快照（最多 100 chunks / 约 1.7MB，
  超出时保留最近证据）。
- ingest 请求带 `agentId`、`threadId`、`source=host`、`extractor`、`chunks` 和可选的
  `domain`，不发送 `namespace`、`capture` 或 `sync`；采集与详情沉降由 sidecar 模式负责。
- 同一内容的 `requestId` 稳定；sidecar 对重试幂等去重，并可能返回 `duplicate=true`。

检查点保持如实：

```json
{
  "agentId": "hermes",
  "threadId": "hermes-s1",
  "domain": "task:hermes-s1",
  "summary": null,
  "warning": "summary_unavailable",
  "state": {
    "kind": "pre_compress",
    "messageCount": 3,
    "lastMessageId": "…",
    "transcriptHash": "sha256:…",
    "sessionId": "hermes-s1"
  },
  "recordIds": []
}
```

Hermes 的 `MemoryProvider` API v1 不提供压缩摘要。Provider 因此发送 `summary:null` 和
state-only 元数据，绝不把归档文本或模型猜测当 summary。失败或中断的检查点会留在内存
pending，在 provider 存活期间重试；它不会被报告为已提交，也不会阻断 Hermes 压缩。

## 失败行为

- 召回失败返回空字符串，当前轮次继续。连续失败会进入短暂冷却，避免每轮都等超时。
- 写入失败留在 `$HERMES_HOME/mebular-memory/queue.jsonl`（`0600`，受 `queue_limit`
  限制），由后台 worker 重试。不可重试错误（例如 `mode_mismatch`、`unauthorized`、
  `invalid_request`、`payload_too_large`）记录 warning 后从队列移除，避免无限堆积。
- 检查点失败保持 pending 并重试；sidecar 也可能把写入放进自己的 outbox。在 sidecar 返回
  已提交 revision 之前，不会报告为 committed。
- 队列是单进程文件 spool；不要在同一个 `HERMES_HOME` 运行两个 Hermes 写者。
- sidecar 不可用时，召回为空、写入留在队列、检查点 pending；Hermes 主流程不受影响。

## 从 0.2 升级 / 从旧原型迁移

- **没有强制迁移。** 0.2 的记录保留原 ID、namespace、tag 和事件。旧的 `default`
  namespace 原样保留，按第三类/Other 兜底解释（`domain=default`），不会改写成 `user`。
- MCP 只保留生命周期键（`memoryRuntime.enabled`、`memoryRuntime.command`、
  `memoryRuntime.startTimeoutMs`）。详情/staging、模型、trace、retention 属于
  `<home>/memory-runtime/config.json`，不再放在 MCP 的 `runtime.*` 键下。
- 检查点和 SelfRecord 不再有本地/云端二选一。没有 `sync=cloud`、`checkpoint.sync` 或
  `self.sync`；所有持久对象都经 MCP 写入，并由现有云端同步传播。
- 未发布的 0.3 原型路径 `/runtime/v1` 不再提供，也没有兼容层。0.3 provider 使用
  `/memory-runtime/v1`；仍指向 `/runtime/v1` 的旧适配器连不上 sidecar，但 MCP 继续可用。
- 原型写到 `<home>/runtime/` 的本地数据不会被读取或迁移。不要把它和 MCP daemon 的安装根
  `<cloudRoot>/runtime/` 混淆；只有前者是可丢弃的原型数据。
- Provider 仍接受配置文件里的 `namespace` 和 `MEBULAR_RUNTIME_NAMESPACE` 作为只读兼容
  别名，但新配置应使用 `domain` / `MEBULAR_MEMORY_DOMAIN`；请求只发送 `domain`。
- 要关闭 sidecar，设置 `memoryRuntime.enabled=false`（或 `mebular memory-runtime stop`）。
  sidecar 停止，29 个 MCP 工具和已沉降记忆保留。`<home>/memory-runtime/` 可保留或删除；
  删除它不会删除已通过 MCP 沉降的记忆。

## 卸载

```bash
hermes config set memory.provider ""
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular"
# 可选：删除 provider 队列/配置
rm -rf "${HERMES_HOME:-$HOME/.hermes}/mebular-memory" \
       "${HERMES_HOME:-$HOME/.hermes}/mebular-memory.json"
```

MCP 配置与 Mebular 数据是分开的，卸载 provider 不会删除它们；也不会删除
`MEMORY.md` / `USER.md`。

## 更多细节

- [Provider README](../../integrations/hermes/mebular-memory/README.md)
- [Companion README](../../integrations/hermes/mebular-companion/README.md)
- [Hermes 目录说明](../../integrations/hermes/README.md)
- [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)
