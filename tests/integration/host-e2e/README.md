# 三宿主真实 Runtime Host E2E

用**真实 `/runtime/v1` HTTP**（临时 home、`heuristic`、不下载模型）验证三个宿主的真实客户端/适配器。每个 suite 都启动 `startHttpServer` + 真实 `RuntimeService`，而不是 fake server。

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
| Hermes | 真实 `integrations/hermes/mebular-memory/__init__.py`、真实 Hermes `MemoryProvider` 方法、真实 Runtime HTTP | `prefetch`、`sync_turn`、`on_pre_compress`、`on_session_switch`、队列 flush/shutdown、durable spool、bearer、system prompt 不归档、profile 不持久化 token、heuristic 记录可召回 | 本机未安装 Hermes gateway，使用仓库测试同款 `agent.memory_provider` stub；不启动真实 Hermes 进程/LLM，不验证原生 `MEMORY.md` / `USER.md` 双写（插件显式不双写），不验证 Hermes 多 profile 进程隔离 |
| OpenCode / OpenChamber | 真实 `opencode v2.2.0` `serve` + `run`、真实 `@mebular/opencode-plugin`（由 OpenCode 按 `opencode.json` 加载）、真实 Runtime HTTP、fake OpenAI-compatible provider（不跑真实 LLM） | 插件真实加载、`context` hook 召回并注入真实 outgoing model request、request-only `<mebular_memory trust="untrusted">` 块、host 事件走真实 `/ingest` + 本地 raw、compaction 后真实 checkpoint PUT 并持久化、bearer、token 不进入 OpenCode state/log/session | 不跑真实模型；fake provider 必须返回 OpenCode 的完整 summary 模板；不验证 OpenChamber Desktop UI、真实 MCP 工具调用、用户真实 `~/.config/opencode`；若 opencode 不可用，`--controller-fallback` 只验证 plugin controller + 真实 Runtime（会明确打印边界） |

## 已知契约差异 / 缺陷证据

1. **OpenCode 的 context query 带 JSON 引号。** OpenCode 2.2 通过 `session.context` / `context` hook 给出的 message content 是 JSON 字符串形态（例如 `"\"Remember ...\""`）。插件把该字符串原样作为 `/runtime/v1/context` 的 `query`；Runtime 的关键词基线是整串子串匹配，所以普通未加引号的记忆不会命中。`opencode-real-runtime.mjs` 用 host candidate 写入同样的带引号文本，才能让真实 `/context` 返回 block；测试里有一条 `OpenCode context query 保留 JSON 引号（已记录契约差异）` 专门记录这个行为。建议插件在 `messageText` / `extractLastUserTurn` 解包 JSON 字符串，或 Runtime 对 query 做 tokenize/去引号。这不是本次测试改实现解决的问题。
2. **OpenCode ingest 保留引号，heuristic 锚定句式不命中。** 同一 JSON 字符串形态被插件送入 `/ingest`，raw 捕获正常，但 `^以后默认用…` 这类 heuristic 规则不会匹配（文本以 `"` 开头）。因此本 suite 不把“OpenCode ingest 必须产生 MemoryRecord”作为通过条件；它断言真实 ingest/raw 路径。这个差异和上一条同源。
3. **DSH check `ingest 复用 requestId`** 只断言 adapter 的 `Idempotency-Key` 与 body `requestId` 一致；真实 Runtime 的 `duplicate` 语义由 `tests/runtime` 覆盖，本 suite 不注入失败/重试（fake E2E 仍覆盖三次重试）。
4. **`GET /runtime/v1/status.version` 当前返回 `0.2.4`**（仓库 `package.json` / `APP_VERSION`），而契约草案示例为 `0.3.0`。本 suite 不把它作为宿主适配断言；如果 0.3.0 发布时统一 bump 版本号，这属于发布步骤，不是 adapter 缺陷。临时 home 没有 profiles registry 时 `identity.profileId` 为 `null`，与“本机注册表”语义一致。

## 结果（本机 2026-10-29）

```text
DSH host E2E：75 passed, 0 failed（enabled-bearer / enabled-none / disabled）
Hermes host E2E：24 passed, 0 failed
OpenCode host E2E：22 passed, 0 failed
```

运行环境：macOS arm64、Node 26.7.0、Python 3.13.9、OpenCode 2.2.0、DSH 0.2.1-rc.2（npm cache）、无本地模型。

## 隔离与安全检查

- 每个 suite 独立 `mkdtemp` Mebular home；不读写 `~/.mebular`、`~/.config/opencode`、`~/.dsh`。
- 真实 Runtime 使用临时 user master key；bearer token 只写入临时 tokens.json 并只经 `Authorization` 发送。
- tap 只记录 `auth: bearer|missing|other`，不记录 token 值；断言 `tap` / Runtime `status` / OpenCode state/log / Hermes profile 不含 token。
- DSH 复用现有 `scripts/lib/dsh-e2e-world.mjs` 的临时 DSH profile 与 artifacts 脱敏；OpenCode 使用独立 `HOME` / `XDG_*`。
- 不改 `src/`、`packages/` 或宿主实现；只新增 `tests/integration/host-e2e/**`。
