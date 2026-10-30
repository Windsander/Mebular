# Memory Runtime 用户指南（0.3.0）

[English](MEMORY_RUNTIME.md) · [文档索引](../README.md) · [验收报告](../quality/0.3.0-memory-runtime-acceptance.md)

Mebular 0.3 在 MCP 之外增加一个可选的 **Memory Runtime sidecar**。它可以替宿主采集对话
片段、抽取候选、做碎片化召回、组装上下文块，并保存任务检查点。它是**同一张图上的一层**，
不是第二套记忆库。

默认行为不变：**轻量 MCP**。只需要显式 `memory_*` / `task_*` 工具的宿主永远不会启动
sidecar。沉浸式是每台设备显式开启的可选项。

```text
┌──────────────────────────────────────────────────────────────────┐
│ 宿主 / Agent                                                     │
│   轻量：MCP client ───────────────────► /mcp（29 个工具）         │
│   沉浸：host adapter ─────────────────► /memory-runtime/v1        │
└───────────────────────┬──────────────────────────┬───────────────┘
                        │                          │
                        ▼                          ▼
          ┌──────────────────────────┐   ┌──────────────────────────┐
          │ MCP daemon               │   │ Memory Runtime sidecar   │
          │ 29 个公共 MCP 工具        │◄──┤ ingest / recall / context│
          │ MemoryService            │   │ compact / self / trace   │
          │ 图 + 事件日志 + 同步       │   │ staging / cache / Trace /│
          │ /internal/memory/v1      │   │ outbox / 模型配置         │
          └────────────┬─────────────┘   └──────────────────────────┘
                       │
                       ▼
          现有图 + 签名事件 + 同步 + 你的忆云
```

sidecar 是**独立进程**（`mebular-memory-runtime serve`）和独立包
（`@mebular/memory-runtime`）。它没有写图的路径。所有持久对象都经过 MCP 内部能力 API
（`/internal/memory/v1`）写入现有 `GraphStore` / `EventLog`，再由现有同步层带到忆云里的
其他设备。MCP 始终是唯一的图写入者。

本文讲用户可见行为；架构契约见
[contract v2](../design/0.3.0-memory-runtime-contract-v2.md)、
[sidecar 生命周期](../design/0.3.0-memory-runtime-sidecar.md) 和
[碎片化召回](../design/0.3.0-fragmented-recall.md)。

## 轻量 MCP 与沉浸式 sidecar

| | 轻量 MCP（默认） | 沉浸式 Memory Runtime |
|---|---|---|
| 进程 | 只有 MCP daemon | MCP daemon + sidecar |
| 谁决定记什么 | 宿主模型通过工具决定 | sidecar 处理宿主显式发来的内容 |
| 公共工具 | 29 个 `memory_*` / `task_*` | 仍是 29 个；不新增公共工具 |
| 自动召回 | 无 | 显式开启；仅请求级，每个用户 turn 最多一次 |
| 原始对话 | 不采集 | 按域采集；本机只 staging，沉降后的详情随图同步 |
| 模型 | Mebular 不调用 | 只用你配置的来源；默认 `heuristic` |
| 持久数据 | 现有图 + 事件 + 同步 | 同一张图 + 事件 + 同步，经 capability 写入 |

两种模式读写的是**同一份** Mebular 记忆。切换模式不会复制、迁移、重写或删除节点。模式是
设备级设置：同一忆云里可以一台设备保持轻量，另一台使用 sidecar。

## 开启方式

前置：

- Node.js 20 或更新版本。
- 本机运行 **HTTP** MCP daemon（`mebular serve`）。stdio 的 `mebular mcp` 不会启动
  sidecar。
- 单独安装 sidecar 可执行文件。Mebular 不会替你下载它。安装
  `@mebular/memory-runtime@0.3.0`（`npm install -g @mebular/memory-runtime`），让
  `mebular-memory-runtime` 出现在 `PATH`；或用 `memoryRuntime.command` 指向可执行文件的
  绝对路径。

1. 打开 MCP 生命周期开关：**Console → 设置 → 记忆运行时**，或编辑
   `<home>/config.json`：

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

2. 启动（或重启）`mebular serve`。daemon 会挂载 `/internal/memory/v1`、生成 capability
   token，并异步启动 sidecar。自动启动是非阻塞的：MCP 就绪、29 个工具、同步和鉴权都不
   等待 sidecar。

3. 验证：

   ```bash
   mebular memory-runtime status --json
   ```

sidecar 就绪后会原子写入 `<home>/memory-runtime.json`。文件包含 URL、端口、版本、
profile/忆云 ID、`mode=immersive` 和 **`tokenFile`**（通常是
`<home>/memory-runtime/host-token`），但**不包含 token 本身**。宿主必须读发现文件，不要
硬编码 7341 端口。

**host token** 由 sidecar 每次启动时生成，权限 `0600`，供宿主适配器访问
`/memory-runtime/v1`。它不是 MCP capability token：capability token 由 MCP daemon
生成，只交给 sidecar。浏览器永远拿不到 host token；Console 通过 MCP 代理访问 sidecar。

MCP 里的 `memoryRuntime.*` 只承载生命周期配置（`enabled` / `command` /
`startTimeoutMs`）。采集、模型、保留期和 HTTP 设置属于
`<home>/memory-runtime/config.json`，不在 MCP 的 `runtime.*` 下。

关闭方式：把 `memoryRuntime.enabled` 设为 `false`（Console 或配置文件），和/或运行
`mebular memory-runtime stop`。这只停止新的采集和注入，**不会**删除图或已经沉降的记忆。

## 模型：四个来源，不静默下载

sidecar 不会在背后替你选模型。四个来源：

| 来源 | 运行位置 | 网络 | 默认 | 作用 | 失败时 |
|---|---|---|---|---|---|
| `heuristic` | sidecar 进程内 | 无 | **是** | 确定性规则抽取、关键词扩展、gist 选择 | 只可能是代码 bug；返回错误 |
| `local` | sidecar + 本机 `llama-server` | 安装后无 | 否 | 本地 Qwen 抽取/摘要/排序 | 回退 `heuristic`，`degraded=true` |
| `host` | 宿主模型 | 宿主决定 | 否 | 宿主提交 `CandidateRecord`；sidecar 不反向调用宿主 | 没有候选 → `202 pending`；不偷偷换模型 |
| `api` | 一个 OpenAI-compatible endpoint | 有，需显式允许 | 否 | 没有本地算力时的远程抽取/摘要 | 超时/5xx → `heuristic`；不换供应商 |

`heuristic` **不是模型**，也不学习。它是一个小的确定性规则引擎。因此全新安装无需模型
文件、无需模型调用也能离线工作。

### 本地 Qwen 包必须显式安装

本地 Qwen 是可选项。源码树和 npm tarball **不包含**模型权重，也不包含 `llama-server`
二进制。需要显式安装精选包：

```bash
mebular models list
mebular models install --pack qwen3.5-9b-instruct-q4_k_m
mebular models select qwen3.5-9b-instruct-q4_k_m
```

模型包在使用前会按 manifest 和 SHA-256 校验，绝不会静默下载或更新。sidecar 仍需要
`llama-server` 可执行文件（在 `PATH`，或配置 `model.local.enginePath`）。缺少模型包或
引擎时，选择 `local` 会回退 `heuristic` 并在状态里报告 `degraded` 和原因；它不会猜下载
URL，也不会编造哈希。模型设置和模型文件留在本设备，不进入共享记忆或同步。

### host 候选不是模型调用

`host` 模式下由宿主适配器在 `/ingest` 里提交结构化候选。sidecar 不读宿主凭据、不发现
宿主 endpoint，也不调用宿主模型。如果宿主指定 `host` 却没有提交候选，请求保持
`pending`；sidecar 不会替换成别的模型。

### 第三方 API 只接受密钥引用

`api` 来源必须同时配置 `baseUrl`、`model`、`keyRef` 和 `allowRemote=true`。`keyRef`
只接受：

- `env:VARIABLE_NAME`
- `keychain:<service>` 或 `keychain:<service>/<account>`（0.3 为 macOS Keychain）
- `file:relative/path`（相对 Mebular home，文件必须私有）

明文密钥不会进入 `config.json`、图 metadata、事件、日志、Console 或 status。除本机
loopback HTTP 外，非 HTTPS endpoint 会被拒绝；带 userinfo 或云 metadata 地址也会被
拒绝。超时、5xx 或 429 会回退 `heuristic`，并通过 `status.degraded` / `warnings` 可见。

`model.source="auto"` 的解析顺序：请求携带的 host 候选 → 已安装的本地包 → 显式允许的
API → `heuristic`。它不会自行开启网络。

## 本地保留什么，什么进入忆云

sidecar 数据目录是 `<home>/memory-runtime/`，其中只有过程数据：

| 对象 | 位置 | 跨设备 | 权威性 |
|---|---|---|---|
| `MemoryRecord`（entity / fact / episode / skill） | 现有图 + 事件日志 | 是，按域订阅 | 权威 |
| `Compact` | 现有图，与来源同域 | 是 | 派生摘要；源记录不变 |
| `SelfRecord` | 现有图，`agent:<agentId>` | 是 | Agent 自我模型；普通查询不可见 |
| `ContextCheckpoint` | 现有图，`task:<threadId>` 或 `default` | 是 | 任务恢复点；revision/lease 由 MCP 执行 |
| `DetailRecord` / `RawChunk` | 现有图 + 事件日志 | 保留期内且已订阅时可读 | 域内共享详情；`raw_chunk` 只是详情子类型 |
| staging | `<home>/memory-runtime/staging/` | **否** | 未沉降 chunk；默认 24 小时，沉降成功后删除 |
| 详情 cache | `<home>/memory-runtime/cache/details/` | **否** | 只读缓存；可能 stale，不是权威 |
| `RecallTrace` | `<home>/memory-runtime/traces.jsonl` | **否** | 本机诊断，默认 7 天 / 2,000 条 |
| cache / index | `<home>/memory-runtime/cache/` | 否 | 可重建；不是权威 |
| outbox | `<home>/memory-runtime/outbox/` | 否 | 有界重试队列（默认 1,000 项 / 16 MiB）；成功后删除 |

没有 `sync=cloud` / `sync=local` 开关，也没有本地 checkpoint 模式。checkpoint 和 self
record 始终是忆云对象；本地 cache 只是缓存。删除整个 `<home>/memory-runtime/` 不会删除
已沉降记忆——它们会从 MCP/图恢复。沉降后的详情是域内共享的图对象：只要仍在保留期内且域已
订阅，其他设备也能展开原文/切片。本机 staging/cache 不是权威副本；只有过期、删除、配额
淘汰或未订阅才会让详情不可用。

有界 outbox 只用于 MCP 暂时不可达的情况。它不是第二套记忆库：条目是幂等写请求，成功后
立即删除；永久失败会移动到 `outbox/dead/`，不会无限重试。

## 隐私与控制

- **采集跟随模式。** 轻量 MCP 不启动 sidecar，也不采集任何内容。沉浸式由宿主适配器按域
  显式 `/ingest` 当前轮次；没有单独的采集开关，也没有首次开启的授权。staging 在本机，
  详情沉降后进入图。
- **默认不调用模型。** `heuristic` 在进程内运行，不发网络请求。不会自动下载模型文件。
  本地、host 和 API 来源都需要显式配置。
- **staging 和 Trace 留在本机。** 未沉降的 staging chunk 与召回轨迹属于本机过程数据；
  已沉降的详情是图对象，按域同步。日志/状态不包含原文、token 或密钥。
- **注入的记忆是不可信背景数据。** 宿主把它放在仅请求级、非 instruction 的通道里，转义
  闭合标签，不执行记忆里出现的命令或工具调用。
- **可以关闭。** 关闭 `memoryRuntime.enabled` 和/或停止 sidecar。若还要删除本地过程数据，
  删除 `<home>/memory-runtime/`。已沉降记忆仍留在图里，直到你通过正常 MCP/Console 治理
  路径删除。
- **逻辑隔离，不是密码学隔离。** `agentId` 是断言，不是认证。域过滤限制 sidecar 请求哪些
  域，但持有 capability token 的人仍能读本地存储。0.3 不声称 Agent 之间有加密隔离。
- **删除是协作式的。** 墓碑会同步给对端，但已持有副本的离线设备可能保留到重新连接。不要
  把它说成有保证的远程擦除。

## 三个宿主入口

每个宿主保留自己的原生记忆；Mebular 不导入、不镜像、不双写。

- **DSH** — `@mebular/dsh-plugin` 的可选 `memoryRuntime` bridge；新人类 turn 首步召回、
  批量 ingest、compaction checkpoint 和可选工具遮蔽。见
  [DSH 集成](../integrations/DSH_CN.md)。
- **Hermes** — `integrations/hermes/mebular-memory` 的 `MemoryProvider`；`prefetch`、
  `sync_turn`、压缩前归档和 state-only checkpoint。见
  [Hermes 集成](../integrations/HERMES_CN.md)。
- **OpenChamber / OpenCode** — OpenCode 2.2+ 的 `@mebular/opencode-plugin`；请求级上下文
  注入、事件 ingest 和 compaction checkpoint。见
  [OpenChamber / OpenCode 集成](../integrations/OPENCHAMBER_CN.md)。

没有适配器的宿主可以直接走 HTTP：发现 `<home>/memory-runtime.json`，读取 `tokenFile`，
调用 `/health`、`/ingest`、`/recall`、`/context` 和 `/checkpoints/:threadId`，并在超时时
失败开放。

## 排障

先看 CLI 和发现/健康端点：

```bash
mebular memory-runtime status --json
mebular memory-runtime start
mebular memory-runtime stop
mebular memory-runtime restart
```

`status --json` 只读，返回 `state` / `degraded` / `runtimeVersion` / `url` / `error`，不会
返回 token。sidecar 运行时，`GET /health`（无需 token，仅 loopback）告诉你进程是否就绪；
`GET /status`（host token）额外给出 capability、模型、计数、outbox 和降级原因。

**0.3.0 的日志现状：** sidecar 启动结果写到 stdout，本版本还没有持久化
`logs/sidecar.jsonl`，也没有 `mebular memory-runtime logs` 命令。排障以
`status --json`、`/health`、`/status` 以及 MCP/Console 的 sidecar 状态为准；不要寻找本
版本尚未提供的日志命令。

常见失败与处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| `not_installed` | `PATH` 或配置路径上没有 `mebular-memory-runtime` | 安装 `@mebular/memory-runtime`，或设置 `memoryRuntime.command` |
| `capability_disabled` / `/internal/memory/v1` 404 | MCP 是 0.2、只有 stdio，或 `memoryRuntime.enabled=false` | 用 0.3 的 `mebular serve` 并打开开关 |
| `capability_token_invalid` / `capability_token_missing` | token 轮换或 capability 未挂载 | 重启 MCP，再重启 sidecar |
| `version_incompatible` | sidecar 与 MCP 的 major/API 版本不匹配 | 使用匹配的 0.3.x 包 |
| `bind_failed` / 端口占用 | 7341–7350 被占用 | sidecar 会回退临时端口；读 discovery，不要硬编码 7341 |
| `degraded` + `capability_unavailable` | MCP 暂时不可达 | 对话继续；召回可能用缓存；写入进入有界 outbox |
| `degraded` + 模型原因 | 本地包/引擎或 API 不可用 | 看 `status`，安装/允许来源，或保持 `heuristic` |
| `outbox_full` | 未发送写入过多 | 恢复 MCP 连接；不要把 outbox 当持久记忆 |
| 宿主适配器收到 `401` | host token 轮换 | 重读 `tokenFile`；适配器会重试一次 |

这些情况对宿主都是失败开放：对话继续，MCP 的 29 个工具照常可用，最坏情况是不注入记忆。
sidecar 故障绝不能阻塞 MCP 启动、工具、同步或鉴权。

## 从 0.2 和旧原型升级

- **不迁移。** 0.2 的节点、事件、namespace、tag 和 ID 保持原值。不补字段、不改 ID、不重签
  事件。
- **旧 `default` 数据保留。** 0.2 的 `default` 按 Other 兜底（`domain=default`）读取，
  不会静默升级成 `user`。新的用户偏好只有在用户明确写入时才进入 `user`。
- **原型 `/runtime/v1` 已删除。** 0.3 不提供该路径，也没有兼容层。宿主适配器必须改用
  `/memory-runtime/v1`。仍指向 `/runtime/v1` 的旧适配器连不上 sidecar；MCP 和宿主其余
  功能照常。
- **原型本地数据不读取。** 旧的 `<home>/runtime/` sidecar 数据会被忽略。不要删除
  `<cloudRoot>/runtime/`：那是 MCP daemon 的安装根，不是 sidecar 数据。sidecar 使用
  `<home>/memory-runtime/` 和 `<home>/memory-runtime.json`。
- **回滚。** 关闭开关/停止 sidecar，再运行 0.2。图保留；内部对象仍存储但默认查询不可见；
  `<home>/memory-runtime/` 可保留或删除。

## 范围与限制

- 29 个公共 MCP 工具不变；不新增 `runtime_*` / `fragment_*` 工具。
- 一个忆云、一个用户。没有多用户账号、namespace ACL 或按 Agent 的密码学隔离。
- 不在后台扫描对话；只处理宿主适配器显式发来的 `/ingest`。
- 没有第二套记忆库：沉降后的详情走现有图/事件/同步，召回轨迹留在本机。不静默下载模型，
  不自动更新模型，不同步模型配置。
- 不做破坏性压缩，不自动合并冲突事实。
- 不做跨忆云联邦。
- 删除是协作式的，离线对端可能延迟。

## 验证

- [0.3.0 Memory Runtime 验收报告](../quality/0.3.0-memory-runtime-acceptance.md)：真实
  sidecar + fake capability 下的召回质量、安全和性能；只用 heuristic，不启动模型，不访问
  外部网络。
- [三宿主 E2E](../../tests/integration/host-e2e/README.md)：真实 DSH、Hermes、OpenCode
  适配器对真实 sidecar、真实 capability API 和真实图；临时 home、heuristic，不跑真实
  LLM。
- [`examples/memory-runtime-demo`](../../examples/memory-runtime-demo/README_CN.md) 演示
  真实 MCP daemon + capability + sidecar 下的 ingest → gist → 详情 → 上下文预算 →
  checkpoint 写入/读取。
