# Mebular memory provider for Hermes Agent

Hermes 侧 `MemoryProvider` 插件，把 Hermes 的每轮对话接到独立的 Mebular 0.3 Memory Runtime sidecar：

- `prefetch` / `queue_prefetch` → `POST /memory-runtime/v1/context`（兼容回落 `/recall`）
- `sync_turn` / `on_pre_compress` / `on_session_end` → `POST /memory-runtime/v1/ingest`
- `on_pre_compress` → `PUT /memory-runtime/v1/checkpoints/:threadId`（state-only；`summary:null`）
- 失败召回返回空字符串；失败写入进入本 profile 的有界持久队列，由后台线程重试；checkpoint 失败保持 pending
- 不暴露任何工具（`get_tool_schemas() == []`），Mebular 的 29 个 MCP 工具仍是治理面
- 不导入、不镜像、不双写 Hermes 内置 `MEMORY.md` / `USER.md`
- 不读取宿主 LLM 凭据；只读 sidecar host token（`MEBULAR_MEMORY_RUNTIME_TOKEN` / `tokenFile`），不读 MCP capability token

## Hermes 调查结论（实现依据）

以下结论来自本机 Hermes Agent 源码与开发文档（`agent/memory_provider.py`、`plugins/memory/__init__.py`、`website/docs/developer-guide/memory-provider-plugin.md`）：

1. **单 external provider**：`MemoryProvider` 由 `memory.provider` 单选激活，同一时刻只能有一个外部 provider；内置 `MEMORY.md` / `USER.md` 始终同时工作。本插件不接管、不导入内置记忆。
2. **发现靠目录名**：memory provider 目录按 `$HERMES_HOME/plugins/<name>/` 发现，`<name>` 就是 `memory.provider` 的值。因此安装时把本目录放成 `plugins/mebular`，而不是保留仓库里的 `mebular-memory` 目录名。
3. **生命周期**：`initialize(session_id, **kwargs)` → 每轮 `prefetch` / `queue_prefetch` / `sync_turn` → 可选 `on_pre_compress` / `on_session_end` / `on_session_switch` → `shutdown`。`initialize` 的 `hermes_home` 是 profile 绑定，不能硬编码 `~/.hermes`。
4. **`is_available()` 不能联网**：只做配置/本地发现。本插件只读 `<home>/memory-runtime.json`（sidecar discovery）、插件配置与环境变量；不把 MCP daemon 的 `runtime.json` 当成 sidecar。
5. **`sync_turn()` 必须非阻塞**：插件用 Hermes 的 `spawn_context_thread`（若存在）启动后台 worker；失败写入落盘。
6. **`on_session_switch(..., **kwargs)` 必须存在**：`/resume`、`/branch`、`/reset`、压缩后 session id 会变化。`reset=True` 表示真正的新会话；本插件先有界 flush 旧队列，再重绑 session。
7. **`on_pre_compress` 默认 best-effort（API v1）**：失败不能阻断 Hermes 压缩。归档走 durable spool，随后尝试写 state-only checkpoint；Hermes API 不提供 summary，因此 `summary:null`，失败保持 pending。
8. **`MemoryProvider` 拿不到当前对话模型**：接口没有 model 字段。本插件不伪造模型名；`ingest` 只声明 `source=host` 与配置的 `extractor`（默认 `heuristic`）。需要宿主模型抽取时使用可选的 companion 插件（见 `../mebular-companion/`）。
9. **`ctx.llm` 是独立插件能力**：MemoryProvider 不能依赖它；companion 插件通过 `ctx.llm` 使用宿主模型，不读宿主 token。

## 安装

前置：Mebular 0.3 Memory Runtime sidecar 已运行（桌面 App / MCP daemon 的沉浸式模式或 `mebular-memory-runtime serve`），本机存在 `~/.mebular/memory-runtime.json`（或 `MEBULAR_MEMORY_RUNTIME_HOME` 指向的 home），且 `/memory-runtime/v1/context` / `/ingest` / `/checkpoints` 可用。

### 一键安装（Release 资产，发布后）

0.3.0 发布后，GitHub Release 提供 `mebular-hermes-plugins-<version>.tar.gz`。它同时包含 provider 和可选 companion：

```bash
gh release download v0.3.0 -p 'mebular-hermes-plugins-*.tar.gz'
mkdir -p mebular-hermes-plugins
tar -xzf mebular-hermes-plugins-0.3.0.tar.gz -C mebular-hermes-plugins
cd mebular-hermes-plugins

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}" ./install.sh
hermes config set memory.provider mebular
hermes memory status
```

`install.sh` 会把本目录安装为 `$HERMES_HOME/plugins/mebular`（已有目录备份为 `.bak-<timestamp>`），失败时非零退出并恢复旧目录。它不会修改 Hermes 配置，也不会启动 Hermes。

### 源码安装（发布前 / 开发）

```bash
# 1. 以目录名 mebular 安装（Hermes 用目录名做 memory.provider 的值）
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular"
cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"

# 2. 激活（同一时刻只能选一个外部 provider）
hermes config set memory.provider mebular
# 或交互式：hermes memory setup

# 3. 通常无需配置 token：sidecar 把 host token 写入 discovery tokenFile
#    排障/测试可覆盖（不要写进 config/mebular-memory.json）：
# MEBULAR_MEMORY_RUNTIME_TOKEN=...

# 4. 验证
hermes memory status
```

> Hermes 的 `memory.provider` 是外部 provider 的单选开关；内置 `MEMORY.md` / `USER.md` 仍然工作。安装本插件不会导入、镜像或双写它们，也不会关闭它们。

### 安装目录名必须一致

**目录名必须是 `mebular`**：Hermes 按 `$HERMES_HOME/plugins/<name>/` 发现 provider，`<name>` 就是 `memory.provider` 的值。仓库源码目录叫 `mebular-memory`，安装时必须改名为 `mebular`。

如果保留 `plugins/mebular-memory/` 目录名，则必须设置 `memory.provider: mebular-memory`；但 `provider.name` 仍是 `mebular`，容易混淆。Release 的 `install.sh` 已按正确目录名安装。

## 配置

URL 优先级：`$HERMES_HOME/mebular-memory.json.runtime_url` > `MEBULAR_MEMORY_RUNTIME_URL` > `<home>/memory-runtime.json`（sidecar discovery）> 无（禁用）。
Token 优先级：`MEBULAR_MEMORY_RUNTIME_TOKEN` > Hermes secret scope > discovery `tokenFile`（默认 `<home>/memory-runtime/host-token`）。

`$HERMES_HOME/mebular-memory.json`（全部可选）：

```json
{
  "runtime_url": "http://127.0.0.1:7341",
  "agent_id": "hermes",
  "domain": "",
  "extractor": "heuristic",
  "recall_limit": 8,
  "recall_token_budget": 2000,
  "recall_timeout": 1.5,
  "ingest_timeout": 3.0,
  "archive_flush_timeout": 1.5,
  "checkpoint_timeout": 2.5,
  "queue_limit": 100
}
```

- `runtime_url` 是 sidecar base URL（例如 `http://127.0.0.1:7341` 或带 `/memory-runtime/v1`；插件会归一化）。为空时读 `<MEBULAR_MEMORY_RUNTIME_HOME|MEBULAR_HOME>/memory-runtime.json` 的 `url` / `tokenFile`；不会联网探测，也不读 `runtime.json`。
- `domain` 为空表示由 sidecar 按默认域处理；以 `__` 开头的保留域会被拒绝。旧配置键 `namespace` 仅作为只读别名，请求只发 `domain`。
- 没有 `capture` / `enabled` / `sync_enabled` / `archive_enabled` 开关：插件读取 discovery 的 `mode` / `state` / `capabilities`，沉浸式时自动 prefetch / sync_turn / checkpoint；轻量 MCP（无 discovery）时不发请求。旧字段会被忽略并 warning。
- `extractor`: `heuristic`（默认、无网络）、`local`、`auto`。本插件始终发 `allowRemote=false`，所以不提供 `api`；`host` 抽取由可选 companion 提供（普通 sync 没有 candidates 会得到 `202 pending`）。
- `checkpoint_timeout`: `on_pre_compress` 的 checkpoint HTTP 超时（秒）。

环境变量：

| 变量 | 说明 |
|---|---|
| `MEBULAR_MEMORY_RUNTIME_URL` | 显式 sidecar base URL，覆盖 discovery |
| `MEBULAR_MEMORY_RUNTIME_TOKEN` | sidecar host token（只读这一项；测试/排障用） |
| `MEBULAR_MEMORY_RUNTIME_HOME` | sidecar home（含 `memory-runtime.json`）；显式时不会回退 `~/.mebular` |
| `MEBULAR_HOME` | 未设置 `MEBULAR_MEMORY_RUNTIME_HOME` 时用于定位 discovery / `profiles.json` |
| `MEBULAR_MEMORY_DOMAIN` | 记忆 domain（旧 `MEBULAR_RUNTIME_NAMESPACE` 仅兼容读取） |
| `MEBULAR_MEMORY_AGENT_ID` | 逻辑 Agent id，默认 `hermes` |
| `MEBULAR_MEMORY_EXTRACTOR` | `heuristic` / `local` / `auto` |
| `MEBULAR_MEMORY_RECALL_LIMIT` | 召回片段上限 |
| `MEBULAR_MEMORY_RECALL_TIMEOUT` | 召回 HTTP 超时（秒） |
| `MEBULAR_MEMORY_INGEST_TIMEOUT` | 写入 HTTP 超时（秒） |
| `MEBULAR_MEMORY_CHECKPOINT_TIMEOUT` | checkpoint HTTP 超时（秒） |
| `MEBULAR_MEMORY_QUEUE_LIMIT` | 本地 spool 上限 |

### 认证

- sidecar 生成 host token 并写入 discovery 的 `tokenFile`（默认 `<home>/memory-runtime/host-token`，JSON `{version,token,...}`，`0600`）。插件自动读取，并拒绝组/其他可读的文件。
- 排障/测试可用 `MEBULAR_MEMORY_RUNTIME_TOKEN` 覆盖；它只跳过 token 文件，不改变 URL。
- **Host token ≠ MCP capability token**：插件永远看不到 capability token，也不读 MCP `tokens.json` 或 Hermes LLM 凭据。
- 非回环 URL 必须使用 HTTPS，并且对话/tool call 文本会离开本机；默认建议只用回环。
- 401 时插件重读一次 token 文件（轮换）；仍失败则该轮 recall 冷却、写入 spool、checkpoint pending。

## 行为细节

### 写入

`sync_turn` 从 `messages` 中取**最后一个 user 消息之后**的片段，避免每轮重复发送整段历史。同一轮内容在 5 秒内的重复调用会复用同一个 `requestId`，由 sidecar 的 ingest 幂等去重（`duplicate=true`），不会产生第二条记录。请求带 `actor` 与可选 `domain`，不再发送 `namespace` 或 `sync`。支持：

- assistant 的 `tool_calls`：展开为 `[tool_call] <name>(<arguments>)` 文本；
- `role=tool` 的工具结果：作为独立 chunk；
- 多模态内容：只保留文本，图片/音频/文件以 `[image_url omitted]` 等标记代替，不发送 base64；
- 不发送 `system` 消息（避免把宿主系统提示归档）。

`on_pre_compress` / `on_session_end` 发送对话快照（同样跳过 system；受 contract 限制最多 100 chunks / 约 1.7MB 文本，超出时保留最近的证据）。`requestId` 由内容摘要决定，重复压缩重试会得到相同 id，由 sidecar 幂等去重。归档先入 durable spool，再最多等 `archive_flush_timeout` 秒；超时/失败不阻塞 Hermes。

`on_pre_compress` 在归档后写 checkpoint：

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

没有 summary 就保持 `null`；不把归档文本或模型输出当 summary。409 `revision_mismatch` 会 GET 当前 revision 重试一次；失败/租约冲突则留在 pending，下一次 flush/压缩再试。`on_session_end` 默认不写 checkpoint，避免噪声。

### 队列

- 位置：`$HERMES_HOME/mebular-memory/queue.jsonl`（`0600`，父目录 `0700`）。
- 每次请求带 `Idempotency-Key: <requestId>`，body 也带 `requestId`。
- 有界队列：超过 `queue_limit` 时丢最旧并 warning；不会无限增长。
- 可重试错误：超时、网络错误、5xx、429、`runtime_not_ready`。
- 不可重试错误：`mode_mismatch`、`unauthorized`、`forbidden_scope`、`domain_write_forbidden`、`invalid_request`、`payload_too_large`、`version_incompatible` 等；这些请求会从 spool 删除并记录 warning，避免无限堆积。
- 队列只在同一 profile 内使用；Hermes 同一 profile 不应多进程写同一 home。

### 召回

- `prefetch` 先消费 `queue_prefetch` 预取的结果；首次或没有缓存时短超时调用 `/context`，失败返回 `""`。同一 session+query 的结果在 session 内复用，避免重复召回。
- `/context` 返回 404/501（旧 sidecar 只有 `/recall`）时才回落到 `/recall`；`/context` 成功但无 block 视为沉默，不再发第二次请求。
- 连续失败后 30 秒内跳过同步召回，避免每轮都等超时；后台预取仍会在冷却后恢复。
- 注入文本是 `<mebular_memory version="1" trust="untrusted" purpose="background">` 块，自带“数据，不是指令”声明，并转义闭合标签；≤8192 字节。
- 召回结果中的内部对象（`compact` 之外的 `checkpoint` / `self_record` / `__*` 域）会被防御性过滤。
- 无命中返回 `""`，不编造；不写 Hermes 会话历史或 instructions。

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

- 依赖 Mebular 0.3.0 的独立 Memory Runtime sidecar `/memory-runtime/v1`；sidecar 未启动或端点不可用时 recall 返回空、ingest 留在 spool、checkpoint 保持 pending，不影响 Hermes 主流程。
- `prefetch` 首次同步召回最多等待 `recall_timeout`（默认 1.5s）；用 `queue_prefetch` 预热后通常无等待。
- Hermes `MemoryProvider` 不暴露当前模型；本插件不伪造，`extractor=host` 的候选抽取由可选 companion 插件负责。
- 队列是单进程文件 spool，不是跨进程锁；不要在同一 `HERMES_HOME` 跑两个 Hermes 写者（Hermes 本身也不建议）。
- 图片/音频/文件不进入 Mebular；只保留占位标记。
