# Mebular companion plugin for Hermes Agent（可选）

普通 Hermes 插件，`kind: standalone`，**不是** `MemoryProvider`。它不占用 Hermes 的“单 external memory provider”名额，也不被 `mebular-memory` 依赖。

用途：Hermes 的 `MemoryProvider` 接口拿不到“当前对话模型”，本插件在 `pre_llm_call` 中通过 Hermes 官方 `ctx.llm` 调用宿主当前模型，把最近已完成的对话抽取成 Mebular `CandidateRecord`，再以 `extractor="host"` 提交到 `POST /runtime/v1/ingest`。这样：

- 不需要伪造模型名；
- 不需要读取宿主 LLM token / endpoint；
- 核心 provider 即使没有 companion 也能正常工作（只是使用 Runtime 的 `heuristic` / `local` / `auto` 抽取）。

## 安装

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular-companion"
cp -R integrations/hermes/mebular-companion "$HERMES_HOME/plugins/mebular-companion"
hermes plugins enable mebular-companion   # 或在 config.yaml 的 plugins.enabled 中加入
```

启用抽取（默认关闭）：

```bash
export MEBULAR_COMPANION_ENABLED=1
# 或写入 $HERMES_HOME/mebular-companion.json: {"enabled": true}
```

重启 Hermes 或新会话后生效。

## 配置

`$HERMES_HOME/mebular-companion.json`（全部可选）：

```json
{
  "enabled": true,
  "runtime_url": "http://127.0.0.1:7331",
  "agent_id": "hermes",
  "namespace": "",
  "max_history_messages": 8,
  "max_history_chars": 12000,
  "max_candidates": 20,
  "llm_timeout": 12.0,
  "ingest_timeout": 2.0
}
```

环境变量：`MEBULAR_COMPANION_ENABLED`、`MEBULAR_RUNTIME_URL`、`MEBULAR_RUNTIME_TOKEN`、`MEBULAR_MEMORY_AGENT_ID`、`MEBULAR_RUNTIME_NAMESPACE`。

## 行为

1. `pre_llm_call` 收到 `conversation_history` 后，只取**最后一个 assistant 消息之前**的已完成对话；当前 user 消息不会被提前抽取。
2. 通过 `ctx.llm.complete_structured(...)`（若不可用则退回 `ctx.llm.complete(...)` + JSON 解析）请求候选。
3. 严格校验候选：
   - 只允许 `fact` / `preference` / `episode` / `observation`；
   - 必填字段非空；`confidence` 限制在 `[0,1]`；
   - `tags` 最多 32 个；拒绝 `__*` namespace；
   - 最多 `max_candidates` 条。
4. 提交：

```json
{
  "requestId": "hermes_comp_...",
  "agentId": "hermes",
  "threadId": "s1",
  "source": "host",
  "capture": "off",
  "allowRemote": false,
  "extractor": "host",
  "chunks": [],
  "candidates": [ ... ]
}
```

`capture=off`：原始对话已由核心 provider 的 `sync_turn` 归档，companion 不重复存 raw。

5. 返回 `None`，不向当前 user message 注入任何内容；召回仍由核心 provider 的 `prefetch` 负责。

## 关键限制

- **同步执行在 `pre_llm_call` 热路径**：会增加一次宿主模型调用和一次本地 HTTP 请求的延迟。Hermes 对该 hook 默认有 30s 超时；本插件默认 `llm_timeout=12s` + `ingest_timeout=2s`。默认关闭，开启前请评估成本和延迟。
- **模型 id 不写入请求**：0.3 ingest 契约没有“host 抽取模型”字段；实际 `result.model` 只写 debug 日志，不伪造 `model` 字段。`extractor=host` 表示候选由宿主模型产生。
- **每段对话只尝试一次**：用 transcript 摘要去重；失败不会重试同一段（核心 provider 仍会归档 raw，Runtime 之后可用其他 extractor 重抽）。
- 不支持多模态抽取：只把文本部分交给模型。
- 不读取宿主凭据；`ctx.llm` 的认证、fallback、审计由 Hermes 负责。
- 不改 `memory.provider`，不注册 memory provider，不提供工具。

## 卸载

```bash
hermes plugins disable mebular-companion
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular-companion"
```
