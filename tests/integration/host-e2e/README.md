# 三宿主 Host E2E

DSH suite 用真实 Runtime HTTP；Hermes suite 用真实 Memory Runtime sidecar `/memory-runtime/v1` + 真实 MCP capability + 真实 Runtime；OpenCode suite 使用真实 OpenCode 进程 + 真实插件 + fake `/memory-runtime/v1` sidecar，以便逐请求断言 discovery、host token、`/context`、`/ingest` 与 checkpoint。所有 suite 使用临时 home、`heuristic`、不下载模型，不写用户真实 home。

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

`--keep` 保留临时 home / artifacts；失败时默认也会保留。DSH 会从 npm cache 安装 `@deepseek-ai/dsh` 到临时目录；若 PATH 上没有 pnpm，会临时 `npm install --prefix <tmp> pnpm@10.34.8`，不写用户全局环境。

## 覆盖

| 宿主 | 真实部分 | 已覆盖 | 未覆盖 / 边界 |
|---|---|---|---|
| DSH | 真实 `@deepseek-ai/dsh` 0.2.1-rc.2 Web profile、真实 `@mebular/dsh-plugin`、真实 Cordis `agent/pre-step` / `session/event` / `agent/created` / `tools/change`、真实 Runtime HTTP | pre-step recall 注入、同 anchor 去重、新 turn 再召回、ingest（含重复 session 事件只入队一次）、compaction checkpoint PUT + 真实本地持久化、`bearer` / `none` 两种 Runtime 认证、memory 工具遮蔽与 `tools/change` 重放、关闭态零 `/runtime/v1` 请求、artifacts 脱敏 | 不跑真实 DeepSeek 模型对话；不验证 DSH 浏览器/侧边栏；probe 使用 synthetic agent/session 与 synthetic tool registry，不是真实 MCP 工具调用；Runtime 以 `service:null` 启动，所以 `/mcp` 工具调用不是本 suite 的断言（只验证真实 HTTP 与真实插件的 memory runtime 适配器） |
| Hermes | 真实 `integrations/hermes/mebular-memory/__init__.py`、真实 Hermes `MemoryProvider` 方法、真实 Memory Runtime sidecar `/memory-runtime/v1`、真实 MCP capability + Runtime | discovery + host token 文件、`prefetch` `/context`、`sync_turn` `/ingest`、`on_pre_compress` 归档 + state-only checkpoint、`on_session_switch`、队列 flush/shutdown、有界 spool、system prompt 不归档、profile/status 不泄漏 token、heuristic 记录可召回、checkpoint 可读 | 本机未安装 Hermes gateway，使用仓库测试同款 `agent.memory_provider` stub；不启动真实 Hermes 进程/LLM，不验证原生 `MEMORY.md` / `USER.md` 双写（插件显式不双写），不验证 Hermes 多 profile 进程隔离 |
| OpenCode / OpenChamber | 真实 `opencode v2.2.0` `serve` + `run`、真实 `@mebular/opencode-plugin`（由 OpenCode 按 `opencode.json` 加载）、fake `/memory-runtime/v1` sidecar、fake OpenAI-compatible provider（不跑真实 LLM） | 插件从 `<MEBULAR_HOME>/memory-runtime.json` 发现 sidecar 并读取 `tokenFile`、host token 认证、`context` hook 召回并注入真实 outgoing model request、request-only `<mebular_memory version="1" trust="untrusted">` 块、host 事件走 `/memory-runtime/v1/ingest`（actor、无 sync）、compaction 后 checkpoint PUT 到 `task:<threadId>`、token 不进入 OpenCode state/log/session | 不跑真实模型；sidecar 是契约 fake（不验证 MCP capability/云同步）；fake provider 必须返回 OpenCode 的完整 summary 模板；不验证 OpenChamber Desktop UI、真实 MCP 工具调用、用户真实 `~/.config/opencode`；若 opencode 不可用，`--controller-fallback` 只验证 plugin controller + fake sidecar（会明确打印边界） |

## 已知差异 / 边界

1. **OpenCode 的 JSON 字符串已解包。** OpenCode 2.2 通过 `session.context` / `context` hook 给出的 message content 可能是 JSON 字符串形态；`@mebular/opencode-plugin` 现在会递归解包后再作为 `/memory-runtime/v1/context` 的 `query` 和 `/ingest` 的文本。`opencode-real-runtime.mjs` 断言 query 与 ingest chunk 都是用户原始文本，不再依赖带引号的 seed。
2. **DSH check `ingest 复用 requestId`** 只断言 adapter 的 `Idempotency-Key` 与 body `requestId` 一致；真实 Runtime 的 `duplicate` 语义由 `tests/runtime` 覆盖，本 suite 不注入失败/重试（fake E2E 仍覆盖三次重试）。
3. **`GET /runtime/v1/status.version` 在 0.3.0 下返回 `0.3.0`。** 本 suite 不把它作为宿主适配断言；临时 home 没有 profiles registry 时 `identity.profileId` 为 `null`，与“本机注册表”语义一致。

## 结果（本机 2026-10-29）

```text
DSH host E2E：75 passed, 0 failed（enabled-bearer / enabled-none / disabled）
Hermes host E2E：35 passed, 0 failed
OpenCode host E2E：22 passed, 0 failed
```

运行环境：macOS arm64、Node 26.7.0、Python 3.13.9、OpenCode 2.2.0、DSH 0.2.1-rc.2（npm cache）、无本地模型。

## 隔离与安全检查

- 每个 suite 独立 `mkdtemp` Mebular home；不读写 `~/.mebular`、`~/.config/opencode`、`~/.dsh`。
- 真实 Runtime 使用临时 user master key；bearer token 只写入临时 tokens.json 并只经 `Authorization` 发送。
- tap 只记录 `auth: bearer|missing|other`，不记录 token 值；断言 `tap` / Runtime `status` / OpenCode state/log / Hermes profile 不含 token。
- DSH 复用现有 `scripts/lib/dsh-e2e-world.mjs` 的临时 DSH profile 与 artifacts 脱敏；OpenCode 使用独立 `HOME` / `XDG_*`。
- 不改 `src/`、`packages/` 或宿主实现；只新增 `tests/integration/host-e2e/**`。
