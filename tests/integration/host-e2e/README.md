# 三宿主 Host E2E

三个 suite 都跑同一条真实链路：

```text
宿主进程 + 真实宿主适配器
  -> /memory-runtime/v1
  -> 真实 Memory Runtime sidecar
  -> /internal/memory/v1（真实 MCP capability token）
  -> 真实 Runtime / GraphStore / EventLog
```

所有 suite 使用临时 home、`heuristic`、不下载模型、不跑真实 LLM、不访问外部网络，也不写用户真实 home。

```bash
node tests/integration/host-e2e/verify-host-e2e.mjs
node tests/integration/host-e2e/verify-host-e2e.mjs --host hermes,opencode
node tests/integration/host-e2e/verify-host-e2e.mjs --host dsh --dsh-version 0.2.1-rc.2 --keep
```

单独运行：

```bash
node tests/integration/host-e2e/hermes-real-runtime.mjs
node tests/integration/host-e2e/opencode-real-runtime.mjs
node tests/integration/host-e2e/dsh-real-runtime.mjs
```

DSH 可选场景：

```bash
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario enabled-discovery
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario enabled-token
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario disabled
```

`--keep` 保留临时 home / artifacts；失败时默认也会保留。DSH 会从 npm cache 安装 `@deepseek-ai/dsh` 到临时目录；若 PATH 上没有 pnpm，会临时 `npm install --prefix <tmp> pnpm@10.34.8`，不写用户全局环境。

## 覆盖

| 宿主 | 真实部分 | 已覆盖 | 未覆盖 / 边界 |
|---|---|---|---|
| DSH | 真实 `@deepseek-ai/dsh` 0.2.1-rc.2 Web profile、真实 `@mebular/dsh-plugin`、真实 Cordis `agent/pre-step` / `session/event` / `agent/created` / `tools/change`、真实 MCP daemon（`manageMemoryRuntime` + capability）、真实 sidecar、真实 Runtime | sidecar discovery / host token、`/context` recall 注入为 source-tagged `UserMessage`、同 turn anchor 去重、工具遮蔽与 `tools/change` 重放、`/ingest`（重复 session 事件只入队一次）、compaction checkpoint PUT 与 sidecar/Runtime 持久化、关闭态零 sidecar 请求；`enabled-discovery` 验证 discovery URL，`enabled-token` 验证显式 sidecar URL 的逐请求断言 | 不跑真实 DeepSeek 模型对话；不验证 DSH 浏览器/侧边栏；probe 使用 synthetic agent/session 与 synthetic tool registry，不是真实 MCP 工具调用；probe 的“新 turn”复用同一 messageId，真实 sidecar 按 `duplicate_turn` 静默（见边界 2） |
| Hermes | 真实 `integrations/hermes/mebular-memory/__init__.py`、真实 Hermes `MemoryProvider` 方法、真实 sidecar、真实 MCP capability + Runtime | discovery + host token 文件、`prefetch` `/context`、`sync_turn` `/ingest`、`on_pre_compress` 归档 + state-only checkpoint、`on_session_switch`、队列 flush/shutdown、有界 spool、system prompt 不归档、profile/status 不泄漏 token、heuristic 记录可召回、checkpoint 可读 | 本机未安装 Hermes gateway，使用仓库测试同款 `agent.memory_provider` stub；不启动真实 Hermes 进程/LLM，不验证原生 `MEMORY.md` / `USER.md` 双写（插件显式不双写），不验证 Hermes 多 profile 进程隔离 |
| OpenCode / OpenChamber | 真实 `opencode v2.2.0` `serve` + `run`、真实 `@mebular/opencode-plugin`（由 OpenCode 按 `opencode.json` 加载）、真实 sidecar、真实 MCP capability + Runtime、fake OpenAI-compatible provider（不跑真实 LLM） | 插件从 `<MEBULAR_HOME>/memory-runtime.json` 发现真实 sidecar、host token 认证、`context` hook 召回并注入真实 outgoing model request、request-only `<mebular_memory version="1" trust="untrusted">` 块、host 事件走 `/memory-runtime/v1/ingest` 并沉降到真实 Runtime/GraphStore、compaction 后 checkpoint PUT 并由 sidecar/capability 持久化、token 不进入 OpenCode state/log/session、OpenChamber 原生 `memory.json` / `settings.json` 前后 hash 不变且内容不进入 sidecar/raw/trace/Runtime | 不跑真实模型；fake provider 必须返回 OpenCode 的完整 summary 模板；不验证 OpenChamber Desktop UI、真实 MCP 工具调用、用户真实 `~/.config/opencode`；若 opencode 不可用，`--controller-fallback` 只验证 plugin controller + 真实 sidecar（会明确打印边界） |

## 已知缺陷 / 边界

1. **host-token 文件格式已统一。** 真实 sidecar 写 JSON `{ version: 1, token: "...", issuedAt, expiresAt }`（`0600`）；DSH、OpenCode、Hermes 三个适配器都直接解析该 JSON record，同时兼容手工写入的 raw token。DSH/OpenCode real E2E 不再注入 `MEBULAR_MEMORY_RUNTIME_TOKEN`，走生产 discovery + `tokenFile` 路径。
2. **DSH 新 turn 注入无法用当前 synthetic probe 断言。** probe 第二次 turn 复用同一 `messageId`，真实 sidecar 按同一 `turnId` 返回 `duplicate_turn`；因此 suite 断言“同 turn anchor 去重”与“新 turn 请求确实到达 sidecar”，但不伪造“新 messageId 必然再次注入”。adapter 的 anchor 已包含 turn，真实宿主新 turn 会带新 messageId。
3. **DSH real E2E 的 seed 由 harness 通过真实 capability API 写入。** host 请求路径只走 `/memory-runtime/v1`；suite 显式断言旧 `/runtime/v1` 已不存在（404），且不会返回 DSH ingest。
4. **OpenCode 注入块是 request-only。** 断言真实 outgoing model request 含记忆块，但 fake provider 不验证模型是否遵守“不可信背景”声明。
5. **不跑真实模型。** DSH/Hermes 不启动 LLM；OpenCode 只使用 fake OpenAI-compatible provider。所有抽取均为 `heuristic`。

## 结果（本机 2026-10-30）

```text
DSH host E2E：113 passed, 0 failed（enabled-discovery / enabled-token / disabled）
Hermes host E2E：35 passed, 0 failed
OpenCode host E2E：38 passed, 0 failed, 0 skipped
verify-host-e2e：三个宿主全部 exit 0
```

运行环境：macOS arm64、Node 26.7.0、Python 3.13.9、OpenCode 2.2.0、DSH 0.2.1-rc.2（npm cache）、无本地模型。

## 隔离与安全检查

- 每个 suite 独立 `mkdtemp` Mebular home；不读写 `~/.mebular`、`~/.config/opencode`、`~/.dsh`。
- 真实 sidecar 使用临时 `memory-runtime/config.json`（`port: 0`）与每次启动轮换的 host token；MCP capability token 只存在于 sidecar/MCP 之间。
- tap 只记录 `auth: bearer|missing|other`，不记录 token 值；断言 tap / sidecar status / capability status / OpenCode state/log / Hermes profile 不含 token。
- DSH 复用现有 `scripts/lib/dsh-e2e-world.mjs` 的临时 DSH profile 与 artifacts 脱敏；OpenCode 使用独立 `HOME` / `XDG_*`。
- 不改 `src/`、`packages/` 或宿主实现；只改 `tests/integration/host-e2e/**`。
