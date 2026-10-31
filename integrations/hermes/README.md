# Hermes integration（Mebular 0.3）

本目录只包含 Python 侧集成，不依赖 Mebular TypeScript 源码，也不修改 Hermes 核心：

| 目录 | 类型 | 作用 |
|---|---|---|
| [`mebular-memory/`](./mebular-memory/) | `MemoryProvider`（外部 memory provider，单选） | 自动 recall + 每轮 ingest + 压缩/会话边界归档 |
| [`mebular-companion/`](./mebular-companion/) | 普通插件，`kind: standalone` | 可选：用宿主模型 `ctx.llm` 抽取 `CandidateRecord` |

## Hermes 调查结论

基线源码：本机 Hermes Agent（`~/.hermes/hermes-agent`）的 `agent/memory_provider.py`、`agent/memory_manager.py`、`plugins/memory/__init__.py`、`website/docs/developer-guide/memory-provider-plugin.md`、`plugin-llm-access.md`、`hooks.md`。

1. **单 external provider**：`memory.provider` 只能选一个外部 memory provider；内置 `MEMORY.md` / `USER.md` 始终同时启用。第二个 provider 会被 `MemoryManager` 拒绝。因此 Mebular 与 RetainDB / ByteRover / Honcho 等不能同时作为 external provider。
2. **按目录名发现**：`$HERMES_HOME/plugins/<name>/__init__.py`；激活值是目录名。仓库目录叫 `mebular-memory`，安装时建议放成 `plugins/mebular`，这样 `memory.provider: mebular` 与 `provider.name == 'mebular'` 一致。
3. **生命周期**：`initialize(session_id, **kwargs)` → 每轮 `prefetch` / `queue_prefetch` / `sync_turn` → 可选 `on_pre_compress` / `on_session_end` / `on_session_switch` → `shutdown`。`initialize` 必带 `hermes_home`（profile 绑定）；不能硬编码 `~/.hermes`。
4. **`is_available()` 不联网**：只检查配置/依赖。本实现只读 `<home>/memory-runtime.json`、插件 JSON 与 Mebular 自己的环境变量；不读 MCP daemon 的 `runtime.json`。
5. **`sync_turn` 必须非阻塞**：Hermes 明确要求后台线程用 `spawn_context_thread`（profile contextvars 隔离）。本实现优先使用它。
6. **`on_session_switch` 必须接受 `**kwargs`**：`/resume`、`/branch`、`/reset`、压缩都会中途换 session id；`reset=True` 表示新会话要 flush。
7. **`on_pre_compress` 默认 best-effort（API v1）**：provider 异常不会阻断压缩。v2 fail-closed checkpoint 是 opt-in；本实现不声明 v2。
8. **`MemoryProvider` 没有当前模型接口**：不能从中拿“当前对话模型”。本实现不伪造；宿主模型抽取由普通插件通过 `ctx.llm` 完成。
9. **`ctx.llm` 是插件能力，不是 MemoryProvider 能力**：`ctx.llm.complete` / `complete_structured` 使用宿主凭据与 trust gate；插件拿不到 token。companion 因此独立、可选，核心 provider 不 import 它。
10. **工具面**：memory provider 可以提供工具，但 Mebular 0.3 决定不新增 `runtime_*` MCP 工具，29 个 MCP 工具保持不变。本 provider `get_tool_schemas()` 返回空，MCP 继续承担显式治理。

## 快速安装

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

# memory provider
mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular"
cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
hermes config set memory.provider mebular

# 可选 companion（不占 provider 名额）
rm -rf "$HERMES_HOME/plugins/mebular-companion"
cp -R integrations/hermes/mebular-companion "$HERMES_HOME/plugins/mebular-companion"
hermes plugins enable mebular-companion
export MEBULAR_COMPANION_ENABLED=1

hermes memory status
```

详细配置、认证、行为与卸载见各子目录 README。

## 数据边界

- `prefetch` / `queue_prefetch` 只发查询文本到独立 sidecar 的 `/memory-runtime/v1/context`（旧 sidecar 兼容回落 `/recall`）。
- `sync_turn` 发最近一轮 user / assistant / tool 文本到 `/memory-runtime/v1/ingest`；`on_pre_compress` / `on_session_end` 发对话快照（跳过 system；最多 100 chunks / 约 1.7MB 文本）。
- `on_pre_compress` 另发 state-only checkpoint 到 `/memory-runtime/v1/checkpoints/:threadId`；Hermes API 没有 summary，所以 `summary:null`，不编造。
- 图片/音频/文件不发送，只发占位标记；tool calls 展开为文本，tool 结果作为 `role=tool` chunk。
- 没有 `capture` 开关：详情由 sidecar 按域写入图/事件/同步；本机只保留 staging/cache/outbox，不是权威副本。
- 不导入 `MEMORY.md` / `USER.md`，不实现 `on_memory_write`，不双写。
- 只读 sidecar host token（`MEBULAR_MEMORY_RUNTIME_TOKEN` 或发现文件 `tokenFile`）；不读宿主 LLM token / cookie / endpoint，也不读 MCP capability token。

## 测试

```bash
python3 -m unittest discover -s integrations/hermes/tests -v
```

测试使用标准库 fake sidecar（`/memory-runtime/v1`），不连接真实 Mebular/Hermes，覆盖：

- `is_available` 只读 sidecar discovery，忽略 MCP daemon 的 `runtime.json`；
- 显式 `runtime_url` / env / discovery 优先级与 stale/wrong-kind 拒绝；
- host token 的 env / `tokenFile`（0600）读取，旧 token env 不会被误用；
- `prefetch` `/context` 注入、空 / 超时 / `/recall` 兼容回落；
- `queue_prefetch` 预取缓存；
- `sync_turn` 幂等与 tool call flatten；
- `on_session_switch` flush / rebind / `**kwargs`；
- `on_pre_compress` 归档、state-only checkpoint、revision 冲突重试；
- `shutdown` 有界 flush；
- 失败入队、有界 spool、恢复后重放；
- 可选 companion 的 `pre_llm_call` + fake `ctx.llm` + host candidates。

真实链路 E2E：

```bash
node tests/integration/host-e2e/hermes-real-runtime.mjs
```

## 当前风险 / 未完成

- sidecar 未启动或不可达时 recall 返回空、ingest 留在 spool、checkpoint 保持 pending；这是失败开放，不是已提交。
- `prefetch` 首次同步召回最多等 `recall_timeout`（默认 1.5s）；后台预热可避免下一轮等待。
- spool 是单进程 JSONL，不做跨进程锁；同一 `HERMES_HOME` 不应跑两个 Hermes 写者。
- companion 同步调用宿主模型，增加延迟/成本，默认关闭；不做图片抽取。
- 0.3 契约仍是草案，wire shape 可能调整；本目录以 `docs/design/0.3.0-memory-runtime-contract.md` 为准。
