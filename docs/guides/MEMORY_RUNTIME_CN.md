# Memory Runtime 用户指南（0.3.2）

[English](MEMORY_RUNTIME.md) · [文档索引](../README.md) · [v0.3.2 验收矩阵](../quality/0.3.2-verification.md)

Mebular 的可选 **Memory Runtime sidecar** 位于 MCP 之外。它可以替宿主采集对话片段、
抽取候选、做碎片化召回、组装上下文块，并保存任务检查点。它是**同一张图上的一层**，
不是第二套记忆库。

0.3.2 是稳定性版本：让生命周期、本地数据、详情证据、检查点 revision、宿主故障状态和
诊断与公开契约一致。它不新增公共 MCP 工具、第二套存储或新的同步协议。

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

本文讲用户可见行为；v0.3.2 的约束目标是
[稳定性契约](../design/0.3.2-stability-contract_CN.md)。较早的设计文档和 v0.3.0
验收报告只描述各自的历史 SHA，不代表本版本。

## 轻量 MCP 与沉浸式 sidecar

| | 轻量 MCP（默认） | 沉浸式 Memory Runtime |
|---|---|---|
| 进程 | 只有 MCP daemon | MCP daemon + sidecar |
| 谁决定记什么 | 宿主模型通过工具决定 | sidecar 处理宿主显式发来的内容 |
| 公共工具 | 29 个 `memory_*` / `task_*` | 仍是 29 个；不新增公共工具 |
| 自动召回 | 无 | 显式开启；仅请求级，每个用户 turn 最多一次 |
| 原始对话 | 不采集 | 按域采集；本机只 staging，沉降后的详情随图同步 |
| 详情保留 | 不适用 | `conversation`、`tool_output`、`document_slice` 或显式 `pinned` |
| 模型 | Mebular 不调用 | 只用你配置的来源；默认 `heuristic` |
| 持久数据 | 现有图 + 事件 + 同步 | 同一张图 + 事件 + 同步，经 capability 写入 |

两种模式读写的是**同一份** Mebular 记忆。切换模式不会复制、迁移、重写或删除节点。模式是
设备级设置：同一忆云里可以一台设备保持轻量，另一台使用 sidecar。

## 开启方式

前置：

- Node.js 20 或更新版本。
- 本机运行 **HTTP** MCP daemon（`mebular serve`）。stdio 的 `mebular mcp` 不会启动
  sidecar。
- 单独安装与 Mebular 版本匹配的 `@mebular/memory-runtime` 包。Mebular 不会替你下载它。
  安装后让 `mebular-memory-runtime` 出现在 `PATH`；或用 `memoryRuntime.command` 指向
  可执行文件的绝对路径。

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
profile/忆云 ID、`mode=immersive`、`pid`、心跳（`updatedAt`）和 **`tokenFile`**
（通常是 `<home>/memory-runtime/host-token`），但**不包含 token 本身**。宿主使用统一的
新鲜度规则：心跳超过 15 秒为 stale，超过 30 秒为 dead；进程存活但发现文件陈旧不算就绪。

**host token** 由 sidecar 每次启动时生成，权限 `0600`，供宿主适配器访问
`/memory-runtime/v1`。它不是 MCP capability token：capability token 由 MCP daemon
生成，只交给 sidecar。浏览器永远拿不到 host token；Console 通过 MCP 代理访问 sidecar。

MCP 里的 `memoryRuntime.*` 只承载生命周期配置（`enabled` / `command` /
`startTimeoutMs`）。模型、保留期和 HTTP 设置属于 `<home>/memory-runtime/config.json`，
不在 MCP 的 `runtime.*` 下；是否采集详情由模式决定。

Console 设置页控制记忆模式并显示 sidecar/模型状态；「高级」控制 `model.source` 以及
精选本地模型包的下载、选择和删除。Console 不提供 API `baseUrl`/`model`/`keyRef`、
raw capture 或 trace retention 编辑器。支持的 sidecar 配置值直接写入
`<home>/memory-runtime/config.json`；不存在 raw-capture 开关。

## 关闭：managed、attached 与 manual

sidecar 有三种所有权模式。它们共享一条规则：**干净关闭后，沉浸式集成不再产生新的
ingest、召回/上下文注入、Compact、Checkpoint、SelfRecord、staging、outbox 或 Hermes
spool 项。** 已有数据不会被冲刷，pending 工作不会被标成 committed。

| 模式 | 谁拥有进程 | 关闭做什么 | 还剩下什么 |
|---|---|---|---|
| **managed** | immersive 启用期间由 MCP supervisor 启动子进程。 | 撤销 capability，停止准入/重放/模型工作，在有界等待内优雅停止所拥有的子进程，移除匹配的 discovery，并轮换/撤销凭据。**不冲刷 outbox。** | 已提交图对象和本地 pending 数据保留；显式 purge 可丢弃未沉淀数据。 |
| **attached** | 已在运行的外部 sidecar；MCP 没有启动它，也不拥有其 PID。 | 撤销/断开此云的 capability，移除/禁用匹配 discovery，使宿主 API 休眠。**不停止、不 SIGTERM、不 SIGKILL 外部进程。** | 外部 PID 可以继续存活。若 sidecar 确认 capability/discovery 已撤销，会进入 dormant `mode=mcp` / `state=stopped`，并以 `409 mode_mismatch` 拒绝新工作。 |
| **manual** | 操作者启动 `mebular-memory-runtime`；Mebular 可以发现/连接，但绝不声称拥有进程。 | 同 attached。**不终止、不替换。** | 操作者的进程保留；重新启用需要显式兼容重连和新的授权。 |

干净关闭意味着 sidecar 确实进入了 dormant 准入/重放/模型行为，而不只是 discovery 消失。
如果无法确认，状态是 `degraded` 和 `disable_incomplete`（或同等可见原因），不是干净的
`stopped`。宿主适配器仍会 fail-open，且不产生新的沉浸式工作。

`mebular memory-runtime stop` 是显式操作者停止；它可以停止你要求停止的进程，但 immersive
关闭本身从不冲刷 queued 写入。重新启用会创建新的授权/discovery 代际；上一代的缓存凭据
不能唤醒实例。

## 状态模型：accepted、pending、queued、committed

0.3.2 在 sidecar、Console 和三个宿主适配器中区分传输成功与持久结果。

| 术语 | 确切含义 | **不**表示 |
|---|---|---|
| **accepted（已接受）** | 认证、模式、schema 和准入检查通过；处理开始。 | 已排队、图已提交或已同步。 |
| **pending（待完成）** | 非最终工作仍需要抽取、宿主候选、capability 响应或冲突解决。用户可见的 pending 有持久恢复记录或有界失败出口。 | 已提交，或请求已到达 MCP 的证明。 |
| **queued（已排队）** | 在宿主收到确认之前，某个操作已用稳定幂等键原子持久化到 sidecar outbox 或已披露的宿主 spool。 | 图写入。 |
| **committed（已提交）** | MCP capability 确认每一项必需写入，且对象已存在于本地图/事件日志。`duplicate` 只有解析为同一幂等逻辑对象时才计入。 | 进程健康、capability 可达、队列成功或对端同步。 |
| **failed（已失败）** | 本次尝试达到终态、显式失败，且不会自动重试。 | 在含糊超时后把可能成功的提交重新标记为确定不存在。 |
| **dead（死信）** | 已持久化的 outbox/spool 操作终态失败，保留用于有界诊断或显式处理。 | 新图对象或成功投递。 |
| **degraded（已降级）** | 伴随结果的健康属性，例如缓存召回或 heuristic 回退；可以与 committed 共存。 | 条目持久化状态，或它本身作为成功/失败证明。 |

必须行为：

- HTTP 202 只表示非最终的 `pending` 或 `queued`，绝不渲染为 committed。`queued:true`
  要求持久记录；队列满/失败返回显式错误，而不是 202。
- HTTP 200 只表示传输成功。无论是否 2xx，`extraction.status:'failed'` 是 failed，
  `extraction.status:'pending'` 是 pending。部分 record/detail 写入报告为 partial，
  不暗示原子回滚。
- **outbox 入队成功 = queued。** **outbox 重放成功只有在 capability 确认后才 = committed**，
  随后移除活动条目。这是两个独立事件。
- 可能已提交之后的超时属于结果未知。使用同一幂等键重试/对账；绝不能为同一逻辑操作签发
  新键，也不能在没有证据时声称确定成功或确定未提交。
- 202 响应及其缓存幂等响应是历史结果，不是状态轮询 API。后续权威读取、列表或 checkpoint
  revision 才能确立提交。

## 检查点：pending、最后提交与 revision

ContextCheckpoint 始终是 `task:<threadId>` 或 `default` 中的图对象；本地 checkpoint 文件
只是缓存。

- revision 按 checkpoint 键单调递增。更新现有 checkpoint 必须携带最后提交的
  `expectedRevision`。直接 `409 revision_mismatch` 会做一次权威 GET 并用同一逻辑更新重试
  一次；第二次冲突变为显式 failed/pending，而不是盲目覆盖。
- 已经 queued 的重放**不会**静默 rebase 到更新 revision。revision 冲突变为显式
  failed/dead，由宿主/用户显式重新生成。活动 lease 冲突只能在 lease/截止界限内重试；
  agent 永不使用 `force`。
- 202 checkpoint 响应带 `pending:true` 且**没有已提交 revision**。只有后续图确认的
  revision 才能显示为 committed。GET 响应暴露 `highWater` / `latestRevision`；checkpoint
  被删除或过期后，下一次更新会继续高于 high-water，而不是复用旧 revision。
- Pending 和最后提交视图保持分离。离线 GET 返回最后提交对象加 pending/degraded 元数据；
  如果从未提交过，则返回 null checkpoint 加 `pendingCheckpoint`。绝不用 pending 意图替换
  最后提交对象。
- 省略 `expiresAt` 表示 **0：没有权威过期时间**。`retention.checkpointDays` 只改变本地
  对象缓存 TTL。显式过期的 checkpoint 不会被注入，读取为不可用；checkpoint 过期不会删除
  关联 MemoryRecord 或 Detail。
- checkpoint 删除仅在线进行。离线删除返回显式失败，不会排队为本地假装删除，也不级联删除
  record/detail。
- `recordIds`、`detailIds` 和 `state.references` 中的图 ID 在提交时验证存在性、预期类型、
  存活状态、同域以及（对 detail）未过期。无效的 queued 引用会 failed/dead，而不是提交
  悬空证据。外部 message ID 仍是宿主引用，不是图证明。
- 上下文顺序是 **self → checkpoint → compact/fragment**，并遵守现有字节/token 预算。
  `includeSelf=true` 消费同一逻辑 agent 的当前 SelfRecord；合法不存在时产生非 degraded
  的空结果且没有 self 块；读取失败、权威不可用或缓存陈旧/无法验证时返回
  `degraded=true` 和稳定原因。它绝不伪造当前/空成功。`includeSelf=false` 不注入 self 块。
  v0.3.2 不新增 SelfRecord delete/TTL 操作。
- lease 使用现有 60 秒协作窗口和服务端派生的 `hostId`。过期允许协作获取，但不能证明前一个
  宿主已停止。revision/lease 是本地乐观并发加跨同步副本的协作提示，不是强跨设备一致性或
  agent 认证。

## 详情、证据与保留

已沉淀对话详情是图对象（`type=detail_record`），kind 为 `raw_chunk`、`message`、
`tool_output` 或 `document_slice`。`raw_chunk` 是普通已沉淀 ingest chunk 的 kind，不是本地
staging 文件的名字。

保留期由 role 和 `detailKind` 决定：

| 类别 | 默认 | 用于 |
|---|---:|---|
| `conversation` | 30 天 | 普通 user/assistant/system 对话详情 |
| `tool_output` | 7 天 | `role=tool` 或 `detailKind=tool_output` |
| `document_slice` | 90 天 | `detailKind=document_slice` |
| `pinned` | 直到显式删除 | 仅显式 user/system 治理；普通 ingest 不能选择 |

sidecar 根据 role/kind 推导 `retentionClass`；普通 ingest 不能用 `pinned` 静默延长保留。
工具输出不得默认按 conversation 处理。服务端策略可以缩短保留期，但绝不静默延长。读取时
即使尚未物理清理也会执行过期检查；MCP 还执行权威的 detail 过期/配额维护。

证据关联：

- 规范的 record↔detail 关联是经过验证的同域 `DetailRecord.recordIds` 加现有反向查询。
  前向 `provenance.detailIds` 是兼容元数据：存在时必须一致，但沉淀后不会重写，也不是唯一
  查询方式。
- 多域抽取只为每个域关联实际支撑的 chunk/message，不把请求中无关的 chunk 复制到每个域。
  如果同一证据确实支撑两个域，每个域创建自己的 detail record 和 ID。
- `rawChunkIds` 是兼容元数据，不是图 detail ID 的 staging-ID 替代。
- 召回碎片可以报告 `detailAvailable`、`detailKinds`、`detailIds` 和
  `detailAvailability`（`available`、`pending_sync`、`expired`、`deleted`、
  `quota_evicted`、`not_subscribed`、`redacted_only`）。已存储但无法关联的 detail 会被
  如实报告，不会伪装成成功展开。

删除 MemoryRecord 时，如果其关联 detail 没有其他存活记录引用，则写入墓碑；删除 detail
不会删除 record。detail 过期/配额不会删除 record、Compact、checkpoint 或 SelfRecord。
本地进程清理绝不会删除图对象。**图删除不是物理内容擦除**：create/update 事件保留节点
版本，墓碑节点仍可能保留内容。宿主副本、对端快照、outbox/dead 正文和 capability 幂等
账本都是额外副本，不在安全擦除承诺内。

## 本地保留什么，什么进入忆云

sidecar 数据目录是 `<home>/memory-runtime/`，其中只有过程数据：

| 对象 | 位置 | 跨设备 | 权威性与边界 |
|---|---|---|---|
| `MemoryRecord`（entity / fact / episode / skill） | 现有图 + 事件日志 | 是，按域订阅 | 权威 |
| `Compact` | 现有图，与来源同域 | 是 | 派生摘要；非空 source ID/hash；stale 按来源重算 |
| `SelfRecord` | 现有图，`agent:<agentId>` | 是 | Agent 自我模型；普通查询不可见；upsert 创建新 revision |
| `ContextCheckpoint` | 现有图，`task:<threadId>` 或 `default` | 是 | 任务恢复点；revision/lease 由 MCP 执行；无 `expiresAt` 即无权威过期 |
| `DetailRecord` | 现有图 + 事件日志 | 保留期内且已订阅时可读 | 域内共享详情；按类别保留；通过 `recordIds` 关联证据 |
| staging `RawChunk` | `<home>/memory-runtime/staging/` | **否** | 未沉降本机 chunk；默认 24 小时 / 256 MiB；`0700`/`0600`；沉降后有界清理 |
| 详情 cache | `<home>/memory-runtime/cache/details/` | **否** | 只读缓存；30 天 / 256 MiB / 5,000 条；可能 stale，不是权威 |
| `RecallTrace` | `<home>/memory-runtime/traces.jsonl` | **否** | 本机诊断；7 天 / 2,000 条；不含正文、提示词或密钥 |
| cache / index | `<home>/memory-runtime/cache/` | 否 | 可重建；不是权威；观察到墓碑/更新时失效，恢复后重新验证 |
| outbox / dead | `<home>/memory-runtime/outbox/` 与 `outbox/dead/` | 否 | 活动队列 1,000 项 / 16 MiB；最长排队 30 天；dead 保留 30 天 |
| capability 幂等账本 | `<home>/memory-runtime/capability-idempotency.json` | 否 | 24 小时 / 5,000 条；最小响应字段；重放账本，不是提交状态 API |

staging、trace、cache 和 outbox 都是有界本地过程数据。sidecar 存活且空闲时每 60 秒运行
维护，也在启动和写入时运行；不是只在重启或惰性触发。清理感知依赖：如果活动 outbox 操作
仍需要 staging 证据，会先让该操作在截止时间显式 failed/dead，或先完成它，再删除证据。

没有 `sync=cloud` / `sync=local` 开关，也没有本地 checkpoint 模式。checkpoint 和 self
record 始终是忆云对象；本地 cache 只是缓存。删除整个 `<home>/memory-runtime/` 不会删除
已沉降记忆——它们会从 MCP/图恢复。沉降后的详情是域内共享的图对象：只要仍在保留期内且域已
订阅，其他设备也能展开。本机 staging/cache 不是权威副本；只有过期、删除、配额淘汰或未订阅
才会让详情不可用。

有界 outbox 只用于 MCP 暂时不可达的情况。它不是第二套记忆库：条目是幂等写请求，成功后
立即删除；永久失败会移动到 `outbox/dead/`，不会无限重试。如果 outbox/spool 操作在 30 天或
更早的操作截止时间内无法沉淀，会以 `retention_expired` 显式进入 dead；长期离线的未沉淀
工作不保证投递。

宿主自有副本不在图内：

- **DSH** 可能在 durable `session.v4.jsonl` 中保留 source-tagged 记忆上下文快照。Mebular
  不同步也不擦除该宿主副本。DSH 每轮过滤/替换带标记节点，使命中失败时不把旧块带入下一次
  模型请求。
- **Hermes** 在 `$HERMES_HOME/mebular-memory/` 下保留持久有界 `queue.jsonl`（以及
  dead/quarantine 恢复文件）；它是 pending 宿主工作，不是已提交 Mebular 记忆。
- **OpenCode/OpenChamber** 没有持久宿主 ingest/checkpoint spool。注入块仅存在于本次请求；
  非持久的中断工作显式变为 failed。

## 隐私与控制

- **采集跟随模式。** 轻量 MCP 不启动 sidecar，也不采集任何内容。沉浸式由宿主适配器按域
  显式 `/ingest` 当前轮次；没有单独的采集开关，也没有首次开启的授权。staging 在本机，
  详情沉降后进入图。
- **默认不调用模型。** `heuristic` 在进程内运行，不发网络请求。不会自动下载模型文件。
  本地、host 和 API 来源都需要显式配置。
- **脱敏发生在持久化或联网之前。** staging、outbox、Hermes spool、日志、状态和远程模型
  请求接收最小化/脱敏内容；机密、token、密码和消息哨兵不得出现在禁止的文件或日志中。
- **staging 和 Trace 留在本机。** 未沉降的 staging chunk 与召回轨迹属于本机过程数据；
  已沉降的详情是图对象，按域同步。日志/状态不包含原文、token 或密钥。
- **注入的记忆是不可信背景数据。** 宿主把它放在非 instruction 通道里，转义闭合标签，
  不执行记忆里出现的命令或工具调用。OpenCode 的块仅在本次请求内。DSH 0.2.1-rc.2 是
  非持久通道的明确例外：source-tagged 上下文快照会写入宿主自己的 durable
  `session.v4.jsonl`；Mebular 的删除/保留策略不会擦除该宿主副本。
- **可以关闭。** 关闭 `memoryRuntime.enabled` 和/或停止 sidecar。managed 只停止拥有的
  子进程；attached/manual 保留外部进程但使其 dormant。已沉降记忆仍留在图里，直到你通过
  正常 MCP/Console 治理路径删除。
- **逻辑隔离，不是密码学隔离。** `agentId` 是断言，不是认证。域过滤限制 sidecar 请求哪些
  域，但持有 host token 或 capability token 的人仍能读本地存储。0.3.2 不声称 Agent 或
  用户之间有加密隔离或 namespace ACL。
- **删除是协作式的。** 墓碑会同步给对端，但已持有副本的离线设备可能保留到重新连接。不要
  把它说成有保证的远程擦除。

## 三个宿主入口

每个宿主保留自己的原生记忆；Mebular 不导入、不镜像、不双写。

- **DSH** — `@mebular/dsh-plugin` 自动跟随 discovery 的 `memoryRuntime` bridge；新人类
  turn 首步召回、批量 ingest、compaction checkpoint 和可选工具遮蔽。见
  [DSH 集成](../integrations/DSH_CN.md)。
- **Hermes** — `integrations/hermes/mebular-memory` 的 `MemoryProvider`；`prefetch`、
  `sync_turn`、压缩前归档和 state-only checkpoint。见
  [Hermes 集成](../integrations/HERMES_CN.md)。
- **OpenChamber / OpenCode** — OpenCode 2.2+ 的 `@mebular/opencode-plugin`；请求级上下文
  注入、事件 ingest 和 compaction checkpoint。见
  [OpenChamber / OpenCode 集成](../integrations/OPENCHAMBER_CN.md)。

没有适配器的宿主可以直接走 HTTP：发现 `<home>/memory-runtime.json`，读取 `tokenFile`，
调用 `/health`、`/ingest`、`/recall`、`/context` 和 `/checkpoints/:threadId`，并在超时时
失败开放。202 只表示 pending/queued；在声称提交前必须做权威读取。

## 诊断：logs、doctor 与 outbox

先看 CLI 和发现/健康端点：

```bash
mebular memory-runtime status --json
mebular memory-runtime start
mebular memory-runtime stop
mebular memory-runtime restart
mebular memory-runtime logs --json --limit 50
mebular memory-runtime doctor --json
mebular memory-runtime outbox list --json
```

`status --json` 只读，返回 `state` / `degraded` / `runtimeVersion` / `url` / `error`，不会
返回 token。sidecar 运行时，`GET /health`（无需 token，仅 loopback）告诉你进程是否就绪；
`GET /status`（host token）额外给出 capability、模型、计数、outbox 和降级原因。

**日志。** sidecar 把脱敏 JSONL 写到 `<dataDir>/logs/runtime.jsonl`，按大小/数量有界轮转。
`logs` 读取当前和轮转文件；`--limit`/`--tail` 选择最新条目。`mebular memory-runtime
logs` 和 sidecar 可执行文件的 `mebular-memory-runtime logs` 读取同一批文件。事件在写入前
和读取时都会脱敏：不含 token、消息正文、提示词、响应或真实 home 路径。日志失败不影响
运行时。

**Doctor。** `doctor --json` 把实时状态与脱敏诊断合并：最近错误、重启原因、capability/
模型状态、staging/trace/cache/detail-cache 计数、outbox/dead 计数与最老年龄、磁盘占用、
日志状态、dead 原因、最近 revision/lease 冲突，以及可能已提交的含糊操作。它还会给出下一步
建议。dead 条目、含糊操作或运行时降级时 `degraded` 为 true。

**Outbox。** `outbox list` 按操作/端点显示活动和 dead 项及最老年龄；`outbox show
<id|requestId>` 增加脱敏的单条元数据和已提交对象 ID。`outbox rebuild <id>` 用同一逻辑
操作重试，不自动 rebase；`--expected-revision N` 是显式人工覆盖。`outbox purge <id>` 丢弃
未沉淀操作，必须视为数据丢失。带有 `possibleCommit` 的 `timeout`/`network_error`/
`partial_failure` 必须通过权威回读对账，不能假定成功或不存在。

诊断不包含 token、消息正文或真实 home 路径。

常见失败与处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| `not_installed` | `PATH` 或配置路径上没有 `mebular-memory-runtime` | 安装匹配的 `@mebular/memory-runtime`，或设置 `memoryRuntime.command` |
| `capability_disabled` / `/internal/memory/v1` 404 | MCP 较旧、只有 stdio，或 `memoryRuntime.enabled=false` | 用 `mebular serve` 并打开开关 |
| `capability_token_invalid` / `capability_token_missing` | token 轮换或 capability 未挂载 | 重启 MCP，再重启 sidecar |
| `version_incompatible` | sidecar 与 MCP 的 major/API 版本不匹配 | 使用匹配的包 |
| `bind_failed` / 端口占用 | 7341–7350 被占用 | sidecar 会回退临时端口；读 discovery，不要硬编码 7341 |
| `degraded` + `capability_unavailable` | MCP 暂时不可达 | 对话继续；召回可能用缓存；写入进入有界 outbox |
| `degraded` + 模型原因 | 本地包/引擎或 API 不可用 | 看 `status`，安装/允许来源，或保持 `heuristic` |
| `mode_mismatch` / `mode=mcp` `state=stopped` | 沉浸式 capability 已撤销；sidecar 休眠 | 显式重新启用；不要按暂时性故障重试 |
| `disable_incomplete` | sidecar 无法确认干净 dormant | 保持宿主 fail-open；检查日志/doctor 和外部进程 |
| `outbox_full` | 未发送写入过多 | 恢复 MCP 连接；查看 `outbox list`；不要把 outbox 当持久记忆 |
| `checkpoint_pending` | 202/queued checkpoint 还没有已提交 revision | 读取 checkpoint 权威视图；不要渲染为 committed |
| `detail_pending_sync` | detail 已存储但尚未关联到该召回碎片 | 沉降后重试；不要声称 detail 已被擦除 |
| 宿主适配器收到 `401` | host token 轮换 | 重读 `tokenFile`；适配器会重试一次 |

这些情况对宿主都是失败开放：对话继续，MCP 的 29 个工具照常可用，最坏情况是不注入记忆。
sidecar 故障绝不能阻塞 MCP 启动、工具、同步或鉴权。

## 从 0.2 和旧原型升级

- **不迁移。** 0.3.0 和 0.2 的节点、事件、namespace、tag 和 ID 保持原值。不补字段、
  不改 ID、不重签事件。0.3.0 以 `conversation` 保留类写入的旧 detail 保持原值。
- **0.3.0 → 0.3.2 数据安全演练。** 在集成线上完成了同一临时 home 的顺序升级和回滚：
  旧 record、detail、Compact、checkpoint 和 self record 仍可读，图和事件日志未被重写。
  见 [v0.3.2 验收矩阵](../quality/0.3.2-verification.md)。这不是混版、并发或双向兼容承诺。
- **0.2 数据只读取，不提升。** 0.2 的 `default` 按 Other 兜底（`domain=default`）读取，
  不会静默升级成 `user`。
- **原型 `/runtime/v1` 已删除。** 不提供该路径，也没有兼容层；宿主适配器必须使用
  `/memory-runtime/v1`。
- **原型本地数据不读取。** 旧的 `<home>/runtime/` sidecar 数据会被忽略。不要删除
  `<cloudRoot>/runtime/`：那是 MCP daemon 的安装根，不是 sidecar 数据。sidecar 使用
  `<home>/memory-runtime/` 和 `<home>/memory-runtime.json`。
- **全端同版本。** 本版本没有兼容层或混版窗口，所有设备必须运行相同版本。0.2.4 直升/
  降级路径未在 0.3.2 验证；上面的 0.2 说明只是数据保留说明，不是完整回滚验收。见
  [已知边界](../limitations/LIMITATIONS_CN.md)。
- **更改包版本前显式停止 sidecar。** 未沉降的 staging/outbox 条目留在本设备，不迁移，
  也不保证最终沉降。保留 `<home>/memory-runtime/` 可让兼容的 sidecar 后续继续处理；
  删除目录会丢弃这些条目。已沉降详情仍是图对象，已同步到对端的副本继续受正常保留期、
  删除和墓碑同步约束。

## 范围与限制

- 29 个公共 MCP 工具不变；不新增 `runtime_*` / `fragment_*` 工具。
- 一个忆云、一个用户。没有多用户账号、namespace ACL 或按 Agent 的密码学隔离。
  `agentId`、actor 类型和任务参与关系都是逻辑断言。
- checkpoint 证据引用是严格的：必须存在、类型正确、存活且同域。跨域或悬空引用会失败，
  而不是提交。
- 不在后台扫描对话；只处理宿主适配器显式发来的 `/ingest`。
- 没有第二套记忆库：沉降后的详情走现有图/事件/同步，召回轨迹留在本机。不静默下载模型，
  不自动更新模型，不同步模型配置。
- 不做破坏性压缩，不自动合并冲突事实。
- 不做跨忆云联邦。
- 删除是协作式的，离线对端可能延迟；见上面的擦除边界。
- **规模证据覆盖 1k/2k 审计和 10k 全量。** 最终 10k 在真实图/capability/sidecar 上通过：
  10,000 records + 10,000 details、0 条非种子 extras、200/200 读取，cleanup 无残留；
  6/6 失败注入场景也通过。延迟来自单台非空闲宿主，不是 SLA。见
  [规模基准报告](../quality/0.3.2-scale-benchmark.md)。
- **真实模型证据是部分的。** v0.3.2 canary 已在 Qwen3-4B Q4_K_M / macOS x64 /
  test-only mirror 上通过：真实下载 2,497,280,256 bytes、官方 SHA-256 校验、
  llama.cpp b12017 启动，以及非 degraded 的 extract/summarize/planQuery。它不证明
  默认 HF transport、其他 pack/平台、模型质量或真实宿主 + 真实模型注入。见
  [0.3.2 真实模型 smoke 报告](../quality/0.3.2-model-smoke.md)。

## 验证

- [v0.3.2 验收矩阵](../quality/0.3.2-verification.md) — 测试计数、宿主边界、规模状态、
  升级/回滚证据和明确待补项。
- [v0.3.2 规模基准报告](../quality/0.3.2-scale-benchmark.md) — 1k/2k 计数审计、最终
  10k 通过、6/6 失败注入和保留的 10k 失败/根因证据。报告中的 detail-kind P1 观察是历史
  结果；召回关联修复及其回归测试在此后落地。
- [0.3.0 Memory Runtime 验收报告](../quality/0.3.0-memory-runtime-acceptance.md)：
  `c71e811` 的历史结果，真实 sidecar + fake capability；只用 heuristic，不启动模型，
  不访问外部网络，也不运行真实 MCP/core、宿主或跨设备同步。
- [三宿主 E2E](../../tests/integration/host-e2e/README.md)：历史计数和明确的 real/fake
  边界。v0.3.2 的新计数记录在验收矩阵中，不照抄 0.3.0 报告。
- [0.3.2 真实模型 smoke](../quality/0.3.2-model-smoke.md)：Qwen3-4B Q4_K_M / macOS x64 /
  test-only mirror；记录首次网络失败与 mirror 边界。
- [0.3.0 真实模型 smoke](../quality/0.3.0-model-smoke.md)：仅 Qwen3-4B Q4_K_M +
  llama.cpp b12017 / macOS arm64 的历史证据。
- [`examples/memory-runtime-demo`](../../examples/memory-runtime-demo/README_CN.md) 演示
  真实 MCP daemon + capability + sidecar 下的 ingest → gist → 详情 → 上下文预算 →
  checkpoint 写入/读取。
