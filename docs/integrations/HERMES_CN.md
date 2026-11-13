# 在 Hermes Agent 中使用 Mebular

[English](HERMES.md) · [返回文档索引](../README.md) · [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)

Hermes 可以通过两层接入 Mebular，两层可以同时使用：

| 层 | Hermes 得到什么 | 默认 |
|---|---|---|
| **MCP** | 官方 Mebular MCP server：显式的 `memory_*` 与 `task_*` 工具 | 配置后可用 |
| **Memory Runtime**（`MemoryProvider`） | 每轮自动召回、轮次/压缩 ingest、state-only 检查点、会话边界归档 | 自动跟随 sidecar discovery 模式；无逐宿主 enable/采集开关 |

v0.3.2 收紧了 provider 的持久 spool、checkpoint 重放和失败出口。宿主 spool 条目是 pending
宿主工作，不是已提交图对象；所有 committed 状态仍来自权威 sidecar/图 revision。

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

3. 从 Release 资产安装（**0.3.4 发布后**可用；发布前用下面的源码命令）。安装目录必须叫
   `plugins/mebular`，因为 Hermes 用目录名作为 `memory.provider` 的值：

   ```bash
   gh release download v0.3.4 -p 'mebular-hermes-plugins-*.tar.gz'
   mkdir -p mebular-hermes-plugins
   tar -xzf mebular-hermes-plugins-0.3.4.tar.gz -C mebular-hermes-plugins
   cd mebular-hermes-plugins

   HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}" ./install.sh
   hermes config set memory.provider mebular
   ```

   安装脚本把 provider 放到 `plugins/mebular`，把 companion 放到
   `plugins/mebular-companion`。已有目录先备份为 `.bak-<timestamp>`；失败时非零退出并
   恢复旧目录。目录名必须是 `mebular`，**不是** `mebular-memory`。

   发布前从源码安装：

   ```bash
   HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
   mkdir -p "$HERMES_HOME/plugins"
   cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
   cp -R integrations/hermes/mebular-companion "$HERMES_HOME/plugins/mebular-companion"
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

安装或启用 provider 不会导入、镜像或双写 Hermes 内置的 `MEMORY.md` / `USER.md`；内置
记忆继续由 Hermes 维护。

可选 companion（宿主模型候选，已由同一个 `install.sh` 安装）：

```bash
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
`runtime.json`。发现必须新鲜（15 秒 stale / 30 秒 dead）且兼容；`mode=mcp` /
`state=stopped` 表示 dormant，会禁用召回、ingest 和 checkpoint，直到显式重新启用并发布
新的 discovery。

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
| `sync_max_attempts` | `12` | 单条重试终态界限；达到后进入 dead，而不是永久 warning |

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
state-only 元数据，绝不把归档文本或模型猜测当 summary。尚未提交的 checkpoint 在 provider
确认 pending 之前持久化到现有 `queue.jsonl`；如果持久化失败，provider 报告失败，而不是
接受仅存在于内存的 pending。重启后重新打开单写者 spool，并用稳定 ID 重放 checkpoint 条目。
202/queued 交接只移除宿主副本，不声称图已沉淀。只有返回权威 revision 后才报告为
committed。最终未确认的 checkpoint 在配置的重试界限进入 dead，不会静默永久 pending，
也不会阻断 Hermes 压缩。服务端要求 checkpoint 证据引用存在、类型正确、存活且同域。

## 失败行为

- 召回失败返回空字符串，当前轮次继续。连续失败会进入 30 秒冷却，避免每轮都等超时。
- ingest 结果在移除 spool 条目前分类：`committed` 要求抽取完成且 record/detail 写入确认；
  `handoff` 表示 202/queued 把重放所有权交给 sidecar outbox；`failed`（包括 detail 部分
  失败）保留宿主副本直到有界 dead 出口；pending 抽取留在 spool。传输 2xx 本身绝不等于
  committed。
- 失败或 pending 写入留在 `$HERMES_HOME/mebular-memory/queue.jsonl`（`0600`，默认 100 条 /
  16 MiB，最长 30 天或更早操作截止时间），由后台 worker 按有界退避和 `Retry-After`
  重试。spool 是单进程文件；不要在同一个 `HERMES_HOME` 运行两个 Hermes 写者。
- `sync_max_attempts`（默认 12）是终态界限。达到后条目以可见原因进入 dead，而不是只发
  warning。不可重试的 `invalid_request`/`payload_too_large` 类错误直接进入 dead。
- `mode_mismatch`/`cloud_mismatch` 是 dormant 状态，不是暂时性故障：worker 停止新增工作，
  保留已持久化的 pending 条目，按有界间隔探测模式，并让 D2 过期把长期离线的条目移入 dead。
  它不会删除或冲刷 spool。
- 认证失败在 `sync_max_attempts` 内重试；持续 401/403 变为 dead/可见，而不是无限循环。
  模式或认证失败绝不会让 spool 无限增长。
- checkpoint 失败从同一 spool 重放。只有 sidecar 返回权威 revision 后才报告 committed；
  202 只是 pending/queued。
- 如果 dead 文件无法写入，provider 会保留有界 `dead-pending`、orphan-dead-pending 或
  `quarantine.jsonl` 记录（或可见的 live-queue 标记），而不是静默丢失诊断。状态会报告
  `spool.dead`、`spool.deadPending`、`spool.orphanDeadPending`、`spool.quarantine`
  以及字节/年龄字段。状态还会区分 `ingestDegraded`、committed 和 failed。
- sidecar 不可用时，召回为空、写入留在队列、检查点 pending；Hermes 主流程不受影响。
  删除 provider 或原生 `MEMORY.md`/`USER.md` 与 Mebular 图是分开的。
- 通过 `agent.memory_provider` 运行 provider 只是适配器证据，不等于真实 Hermes 进程。
  real/fake 边界和 v0.3.2 新计数见
  [验收矩阵](../quality/0.3.2-verification.md)。

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
- 要关闭 sidecar，设置 `memoryRuntime.enabled=false`（或显式运行
  `mebular memory-runtime stop`）。managed 模式停止拥有的进程；attached/manual 模式可以
  保留外部进程但使其 dormant。29 个 MCP 工具和已沉降记忆保留。
  `<home>/memory-runtime/` 可保留或删除；删除它不会删除已通过 MCP 沉降的记忆。只禁用或
  移除 Hermes provider 不会停止 sidecar。
- **版本与降级边界。** 所有设备必须运行相同的 Mebular 版本，没有混版窗口。更改包版本前
  显式停止 sidecar。未沉降 staging/outbox 条目只在本机，不迁移、不保证最终沉降，并随
  本机目录删除而丢弃；已沉降或已同步详情仍受正常图保留/删除策略约束。这些数据保留说明
  不代表完整 0.3→0.2 回滚已验收；见
  [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md#从-02-和旧原型升级)。

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
