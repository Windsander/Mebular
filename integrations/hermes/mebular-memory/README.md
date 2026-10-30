# Mebular memory provider for Hermes Agent

Hermes 侧 `MemoryProvider` 插件，把 Hermes 的每轮对话接到 Mebular 0.3 Memory Runtime：

- `prefetch` / `queue_prefetch` → `POST /runtime/v1/recall`
- `sync_turn` / `on_pre_compress` / `on_session_end` → `POST /runtime/v1/ingest`
- 失败召回返回空字符串；失败写入进入本 profile 的持久队列，由后台线程重试
- 不暴露任何工具（`get_tool_schemas() == []`），Mebular 的 29 个 MCP 工具仍是治理面
- 不导入、不镜像、不双写 Hermes 内置 `MEMORY.md` / `USER.md`
- 不读取宿主 LLM 凭据；只读取 Mebular 自己的 `MEBULAR_RUNTIME_TOKEN`

## Hermes 调查结论（实现依据）

以下结论来自本机 Hermes Agent 源码与开发文档（`agent/memory_provider.py`、`plugins/memory/__init__.py`、`website/docs/developer-guide/memory-provider-plugin.md`）：

1. **单 external provider**：`MemoryProvider` 由 `memory.provider` 单选激活，同一时刻只能有一个外部 provider；内置 `MEMORY.md` / `USER.md` 始终同时工作。本插件不接管、不导入内置记忆。
2. **发现靠目录名**：memory provider 目录按 `$HERMES_HOME/plugins/<name>/` 发现，`<name>` 就是 `memory.provider` 的值。因此安装时把本目录放成 `plugins/mebular`，而不是保留仓库里的 `mebular-memory` 目录名。
3. **生命周期**：`initialize(session_id, **kwargs)` → 每轮 `prefetch` / `queue_prefetch` / `sync_turn` → 可选 `on_pre_compress` / `on_session_end` / `on_session_switch` → `shutdown`。`initialize` 的 `hermes_home` 是 profile 绑定，不能硬编码 `~/.hermes`。
4. **`is_available()` 不能联网**：只做配置/本地发现。本插件只读本地 `runtime.json` / 插件配置 / 环境变量。
5. **`sync_turn()` 必须非阻塞**：插件用 Hermes 的 `spawn_context_thread`（若存在）启动后台 worker；失败写入落盘。
6. **`on_session_switch(..., **kwargs)` 必须存在**：`/resume`、`/branch`、`/reset`、压缩后 session id 会变化。`reset=True` 表示真正的新会话；本插件先有界 flush 旧队列，再重绑 session。
7. **`on_pre_compress` 默认 best-effort（API v1）**：失败不能阻断 Hermes 压缩。本插件不声明 v2 fail-closed checkpoint；归档走 durable spool。
8. **`MemoryProvider` 拿不到当前对话模型**：接口没有 model 字段。本插件不伪造模型名；`ingest` 只声明 `source=host` 与配置的 `extractor`（默认 `heuristic`）。需要宿主模型抽取时使用可选的 companion 插件（见 `../mebular-companion/`）。
9. **`ctx.llm` 是独立插件能力**：MemoryProvider 不能依赖它；companion 插件通过 `ctx.llm` 使用宿主模型，不读宿主 token。

## 安装

前置：Mebular 0.3 Runtime 正在运行（桌面 App 或 `mebular serve`），本机存在 `~/.mebular/runtime.json`，且 `/runtime/v1/recall` / `/runtime/v1/ingest` 已实现。

```bash
# 1. 以目录名 mebular 安装（Hermes 用目录名做 memory.provider 的值）
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular"
cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"

# 2. 激活（同一时刻只能选一个外部 provider）
hermes config set memory.provider mebular
# 或交互式：hermes memory setup

# 3. 仅当 Mebular 使用 bearer/oauth 时配置 token
mebular token grant --scope memory.read,memory.write
# 写入 $HERMES_HOME/.env（不要写进 config/mebular-memory.json）
# MEBULAR_RUNTIME_TOKEN=...

# 4. 验证
hermes memory status
```

> Hermes 的 `memory.provider` 是外部 provider 的单选开关；内置 `MEMORY.md` / `USER.md` 仍然工作。安装本插件不会关闭它们。

### 安装目录名不一致时

如果保留 `plugins/mebular-memory/` 目录名，则必须设置：

```bash
hermes config set memory.provider mebular-memory
```

但 `provider.name` 仍是 `mebular`。推荐直接安装为 `plugins/mebular`，避免混淆。

## 配置

优先级：环境变量 > `$HERMES_HOME/mebular-memory.json` > 本地 `runtime.json` 发现。

`$HERMES_HOME/mebular-memory.json`（全部可选）：

```json
{
  "runtime_url": "http://127.0.0.1:7331",
  "agent_id": "hermes",
  "namespace": "",
  "capture": "local",
  "extractor": "heuristic",
  "sync_enabled": true,
  "archive_enabled": true,
  "recall_limit": 8,
  "recall_token_budget": 2000,
  "recall_timeout": 1.5,
  "ingest_timeout": 3.0,
  "archive_flush_timeout": 1.5,
  "queue_limit": 100
}
```

- `runtime_url` 是 base URL（例如 `http://127.0.0.1:7331`，不是 `/runtime/v1` 路径）；为空时读取 `$MEBULAR_HOME/runtime.json`（默认 `~/.mebular/runtime.json`）的 `http.host` / `http.port`；不会联网探测。
- `namespace` 为空表示 `default`；以 `__` 开头的保留域会被拒绝。
- `capture`: `local`（默认，Runtime 本机保留 RawChunk）或 `off`。
- `extractor`: `heuristic`（默认、无网络）、`local`、`auto`。本插件始终发 `allowRemote=false`，所以不提供 `api`；`host` 抽取由可选 companion 提供（普通 sync 没有 candidates 会得到 `202 pending`）。
- `sync_enabled`: 是否在每轮 `sync_turn` 发送。
- `archive_enabled`: 是否在压缩前 / 会话结束时发送边界快照。

环境变量：

| 变量 | 说明 |
|---|---|
| `MEBULAR_RUNTIME_URL` | 显式 Runtime base URL，覆盖发现 |
| `MEBULAR_RUNTIME_TOKEN` | Mebular bearer token（只读这一项） |
| `MEBULAR_RUNTIME_SCHEME` | `http` / `https`，覆盖 `runtime.json` 推导 |
| `MEBULAR_RUNTIME_NAMESPACE` | 记忆 namespace |
| `MEBULAR_MEMORY_AGENT_ID` | 逻辑 Agent id，默认 `hermes` |
| `MEBULAR_MEMORY_CAPTURE` | `local` / `off` |
| `MEBULAR_MEMORY_EXTRACTOR` | `heuristic` / `local` / `auto` |
| `MEBULAR_MEMORY_SYNC` | `1` / `0` |
| `MEBULAR_MEMORY_ARCHIVE` | `1` / `0` |
| `MEBULAR_MEMORY_RECALL_LIMIT` | 召回条数上限 |
| `MEBULAR_MEMORY_RECALL_TIMEOUT` | 召回 HTTP 超时（秒） |
| `MEBULAR_MEMORY_INGEST_TIMEOUT` | 写入 HTTP 超时（秒） |
| `MEBULAR_MEMORY_QUEUE_LIMIT` | 本地 spool 上限 |

### 认证

- Mebular 回环 `mcp.http.auth: none`：不需要 token。
- `bearer`：把 `mebular token grant --scope memory.read,memory.write` 得到的 token 放到 profile 的 `$HERMES_HOME/.env` 的 `MEBULAR_RUNTIME_TOKEN`。
- `oauth`：插件只发送 `Authorization: Bearer`，不实现 OAuth 授权码/刷新流程；需要你预先取得可用 token 并放入同一环境变量，或改用 bearer / 回环 `none`。
- 非回环 Runtime 必须使用 HTTPS，并且对话/tool call 文本会离开本机；默认建议只用回环。

## 行为细节

### 写入

`sync_turn` 从 `messages` 中取**最后一个 user 消息之后**的片段，避免每轮重复发送整段历史。同一轮内容在 5 秒内的重复调用会复用同一个 `requestId`，由 Runtime 的 ingest 幂等去重（`duplicate=true`），不会产生第二条记录。支持：

- assistant 的 `tool_calls`：展开为 `[tool_call] <name>(<arguments>)` 文本；
- `role=tool` 的工具结果：作为独立 chunk；
- 多模态内容：只保留文本，图片/音频/文件以 `[image_url omitted]` 等标记代替，不发送 base64；
- 不发送 `system` 消息（避免把宿主系统提示归档）。

`on_pre_compress` / `on_session_end` 发送对话快照（同样跳过 system；受 contract 限制最多 100 chunks / 约 1.7MB 文本，超出时保留最近的证据）。`requestId` 由内容摘要决定，重复压缩重试会得到相同 id，由 Runtime 幂等去重。归档先入 durable spool，再最多等 `archive_flush_timeout` 秒；超时/失败不阻塞 Hermes。

### 队列

- 位置：`$HERMES_HOME/mebular-memory/queue.jsonl`（`0600`，父目录 `0700`）。
- 每次请求带 `Idempotency-Key: <requestId>`，body 也带 `requestId`。
- 可重试错误：超时、网络错误、5xx、429、`runtime_not_ready`。
- 不可重试错误：`mode_mismatch`、`unauthorized`、`forbidden_scope`、`invalid_request`、`payload_too_large` 等；这些请求会从 spool 删除并记录 warning，避免无限堆积。
- 队列只在同一 profile 内使用；Hermes 同一 profile 不应多进程写同一 home。

### 召回

- `prefetch` 先消费 `queue_prefetch` 预取的结果；首次或没有缓存时做一次短超时同步召回，失败返回 `""`。
- 连续失败后 30 秒内跳过同步召回，避免每轮都等超时；后台预取仍会在冷却后恢复。
- 召回结果中的内部对象（`compact` / `checkpoint` / `self_record` / `__*` namespace）会被防御性过滤。
- 无命中返回 `""`，不编造。

## 与内置记忆 / MCP 的边界

- **不导入** `MEMORY.md` / `USER.md`，也不实现 `on_memory_write`，因此没有双写。内置记忆继续由 Hermes 自己维护。
- **不替换 MCP**：`get_tool_schemas()` 返回空列表。`mebular` MCP server 的 29 个工具（`memory_*` / `task_*`）语义不变；需要显式写入、搜索、管理、技能时继续用 MCP。
- 可选镜像（把内置记忆写入 Mebular）**未实现**；如果未来要做，应作为独立 opt-in，且默认关闭，不能改变这里的“不双写”默认。

## 卸载

```bash
hermes config set memory.provider ""
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular"
# 可选：删除 $HERMES_HOME/mebular-memory/ 与 mebular-memory.json
```

## 已知限制

- 依赖 Mebular 0.3.0 的 Runtime `/runtime/v1` 端点；daemon 未启动或端点不可用时 recall 返回空、ingest 留在 spool，不影响 Hermes 主流程。
- `prefetch` 首次同步召回最多等待 `recall_timeout`（默认 1.5s）；用 `queue_prefetch` 预热后通常无等待。
- Hermes `MemoryProvider` 不暴露当前模型；本插件不伪造，`extractor=host` 的候选抽取由可选 companion 插件负责。
- 队列是单进程文件 spool，不是跨进程锁；不要在同一 `HERMES_HOME` 跑两个 Hermes 写者（Hermes 本身也不建议）。
- 图片/音频/文件不进入 Mebular；只保留占位标记。
