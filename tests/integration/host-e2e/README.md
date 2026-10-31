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

## 沉浸式用户旅程（C6）

`immersive-journey.mjs` 串起同一用户主公钥下的两台真实设备：

```bash
node tests/integration/host-e2e/immersive-journey.mjs
# 等价：npm run verify:immersive-journey
```

| 设备 | 真实部分 | 覆盖 |
|---|---|---|
| A | 真实 DSH Web + Chrome/CDP + 真实 `@mebular/dsh-plugin` + 真实 sidecar/capability + 确定性测试 LLM（无外部模型） | 轻量模式零 sidecar 请求；admin 热开关后 DSH 不重启自动跟随（实测 <5s）；第一轮 ingest 写 `user` 域记录+详情；第二轮 source-tagged gist 注入；详情 verbatim + `/recall/:id/expand` + `/detail get`；无命中沉默；`memory_*` 工具隐藏；sidecar 不可达失败开放；截图/DOM/请求载荷证据 |
| B | 真实 Hermes `MemoryProvider` + 真实 sidecar/capability；真实 P2PNode/SyncManager 同步 | 设备 B 展开设备 A 的 `user` 域详情；Hermes 读取 DSH 结构化 checkpoint 并继续任务；原生 `MEMORY.md` 不变 |
| B | 真实 `opencode serve/run` + 真实 `@mebular/opencode-plugin` + fake OpenAI-compatible provider | 旧 fact 召回；同键新 fact 显式 `supersedes` 后只召回新值；旧记录 `validTo`/历史详情保留；删除墓碑+详情级联；下一轮不再召回；OpenChamber 原生 `memory.json`/`settings.json` hash 不变 |

证据默认写入 `docs/quality/0.3.0-immersive-ui/`（`MEBULAR_EVIDENCE_DIR` 可覆盖），包括 DSH `dsh-*.png/html/txt`、`dsh-llm-requests.json`、`dsh-session-history.txt`、Hermes/OpenCode 结果与 Console 截图。

本次结果（2026-10-31，macOS arm64，Node 26.7.0，DSH 0.2.1-rc.2，OpenCode 2.2.0）：

```text
沉浸式旅程：84 passed, 0 failed, 0 defects（exit 0）
```

剩余 DSH durable `session.v4.jsonl` source-tagged 快照是 DSH 0.2.1-rc.2 的平台限制，不是产品缺陷；详见 `docs/quality/0.3.0-immersive-journey.md`。

DSH 场景（默认全部）：

```bash
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario auto-discovery
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario no-discovery
node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario fail-open
```

`--keep` 保留临时 home / artifacts；失败时默认也会保留。DSH 会从 npm cache 安装 `@deepseek-ai/dsh` 到临时目录；若 PATH 上没有 pnpm，会临时 `npm install --prefix <tmp> pnpm@10.34.8`，不写用户全局环境。

## 覆盖

| 宿主 | 真实部分 | 已覆盖 | 未覆盖 / 边界 |
|---|---|---|---|
| DSH | 真实 `@deepseek-ai/dsh` 0.2.1-rc.2 Web profile、真实 `@mebular/dsh-plugin`、真实 Cordis `agent/pre-step` / `session/event` / `agent/created` / `tools/change`、真实 MCP daemon（`manageMemoryRuntime` + capability）、真实 sidecar、真实 Runtime | 无 `memoryRuntime` 配置的自动 discovery / host token、首轮 `/ingest`、第二轮 `/context` 注入、同 turn 去重、source-tagged `UserMessage`、sidecar detail block、无命中沉默、工具遮蔽与 `tools/change` 重放、compaction checkpoint PUT 与 sidecar/Runtime 持久化、结构化 schema 2 checkpoint、compaction 后新 turn 注入 checkpoint、无 capture 字段、轻量/无 discovery 零 sidecar 请求、sidecar 不可达失败开放；`auto-discovery` 用 tap 观测生产 discovery 请求 | 不跑真实 DeepSeek 模型对话；不验证 DSH 浏览器/侧边栏；probe 使用 synthetic agent/session 与 synthetic tool registry，不是真实 MCP 工具调用 |
| Hermes | 真实 `integrations/hermes/mebular-memory/__init__.py`、真实 Hermes `MemoryProvider` 方法、真实 sidecar、真实 MCP capability + Runtime | discovery + host token 文件、`prefetch` `/context`、`sync_turn` `/ingest`、`on_pre_compress` 归档 + state-only checkpoint、`on_session_switch`、队列 flush/shutdown、有界 spool、system prompt 不归档、profile/status 不泄漏 token、heuristic 记录可召回、checkpoint 可读、capability 详情可读、请求无 capture | 本机未安装 Hermes gateway，使用仓库测试同款 `agent.memory_provider` stub；不启动真实 Hermes 进程/LLM，不验证原生 `MEMORY.md` / `USER.md` 双写（插件显式不双写），不验证 Hermes 多 profile 进程隔离 |
| OpenCode / OpenChamber | 真实 `opencode v2.2.0` `serve` + `run`、真实 `@mebular/opencode-plugin`（由 OpenCode 按 `opencode.json` 加载）、真实 sidecar、真实 MCP capability + Runtime、fake OpenAI-compatible provider（不跑真实 LLM） | 插件从 `<MEBULAR_HOME>/memory-runtime.json` 自动发现真实 sidecar、host token 认证、`context` hook 召回并注入真实 outgoing model request、request-only `<mebular_memory version="1" trust="untrusted">` 块、host 事件走 `/memory-runtime/v1/ingest` 并沉降为真实 capability 详情、compaction 后 checkpoint PUT 并由 sidecar/capability 持久化、请求无 capture、token 不进入 OpenCode state/log/session、OpenChamber 原生 `memory.json` / `settings.json` 前后 hash 不变且内容不进入 sidecar 详情/trace/Runtime | 不跑真实模型；fake provider 必须返回 OpenCode 的完整 summary 模板；不验证 OpenChamber Desktop UI、真实 MCP 工具调用、用户真实 `~/.config/opencode`；若 opencode 不可用，`--controller-fallback` 只验证 plugin controller + 真实 sidecar（会明确打印边界） |

## 已知缺陷 / 边界

1. **host-token 文件格式已统一。** 真实 sidecar 写 JSON `{ version: 1, token: "...", issuedAt, expiresAt }`（`0600`）；DSH、OpenCode、Hermes 三个适配器都直接解析该 JSON record，同时兼容手工写入的 raw token。DSH/OpenCode real E2E 不再注入 `MEBULAR_MEMORY_RUNTIME_TOKEN`，走生产 discovery + `tokenFile` 路径。
2. **DSH 第二轮与详情使用真实新 turn。** probe 的第二轮使用新的 `messageId`，断言真实 `/context` 再次注入；详情追问使用与 seed 记录重叠的 exact/quote query，断言 sidecar detail block 被注入。sidecar 的模糊召回是 AND 语义，测试 query 必须与 seed 文本有完整词重叠，这不是 host 行为。
3. **DSH real E2E 的 seed 由 harness 通过真实 capability API 写入。** 记录与联动 `detail_record` 均经真实 capability 写入；host 请求路径只走 `/memory-runtime/v1`。suite 显式断言旧 `/runtime/v1` 已不存在（404），且不会返回 DSH ingest。
4. **OpenCode 注入块是 request-only。** 断言真实 outgoing model request 含记忆块，但 fake provider 不验证模型是否遵守“不可信背景”声明。
5. **不跑真实模型。** DSH/Hermes 不启动 LLM；OpenCode 只使用 fake OpenAI-compatible provider。所有抽取均为 `heuristic`。

## 结果（本机 2026-10-30）

```text
DSH host E2E：83 passed, 0 failed（auto-discovery / no-discovery / fail-open）
Hermes host E2E：37 passed, 0 failed
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
