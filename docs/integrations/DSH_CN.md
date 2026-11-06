# 在 DeepSeek Harness（DSH）中使用 Mebular

[English](DSH.md) · [返回文档索引](../README.md)

`@mebular/dsh-plugin` 把 Mebular 的记忆与任务图接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），并在 DSH
侧边栏嵌入共享的 Mebular Console。它是零构建 DSH bundle，不 import `@mebular/*`，
只通过本机 CLI/HTTP 发现共享 runtime。

从 v0.2.0 开始，App 与 DSH Plugin 是**同一套本机 Mebular runtime 的两个入口**：一个
daemon、一个 `mebular-serve`、一个当前 profile/home、一份数据。Plugin 默认只
`attach`；只有用户显式选择 `managed`/`auto` 或点击面板安装时，才会启动/安装 runtime。

Mebular 0.3 在 MCP 之外增加可选的 Memory Runtime bridge。它默认关闭，因此现有
attach/managed/panel/MCP 行为在显式 opt-in 前完全不变。v0.3.2 收紧了 bridge 的
202/pending/committed 状态、checkpoint revision、冷却和 dormant 行为。见下文
[Memory Runtime（自动跟随模式）](#memory-runtime自动跟随模式)。

## 两个入口，一个 runtime

| 面 | 职责 |
| --- | --- |
| **Mebular App / shared runtime** | 控制面：runtime、daemon、service、身份、存储锁、同步、星图 Console。 |
| **DSH Plugin** | Agent 面：在侧边栏显示同一套 Console，挂载官方 MCP client，并且可以按需 ensure/启动同一个 runtime。 |

插件不会另起第二套 Console，也不直接读 store、identity 或 token。它通过共享 runtime
supervisor 的 `runtime resolve`/`supervise` 和 daemon HTTP 端点工作。

## 安装

从 npm 安装到 DSH 的 Web profile：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.3.2
```

开发时从工作树安装：

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

默认配置仍是最小值和 attach：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
```

安装后重启 DSH 会话使 profile 生效。插件不会在安装时静默下载或启动 Mebular。

### 没有 runtime 时

如果本机已有 App/CLI/service/共享 runtime，插件直接 attach，不安装任何东西。

如果都没有，面板显示 `download_required` 和「安装 Mebular Runtime」入口。用户点击后，
插件安装与自身 package 同版本的固定 `@mebular/core`：下载 → 校验 → 原子安装 → 注册
provider → init → 启动 → Console onboarding。失败会显示原因、手动命令和重试/重装/
重新检测；旧 runtime 保留，不启动半成品。

只有用户点击安装才会下载；`bootstrap: never` 会关闭该入口。

## 共享 runtime 解析

插件不会自己猜当前 profile/端口。它选择一个共享 CLI（App/CLI/shared provider），调用：

```bash
mebular runtime resolve --json
```

解析结果提供当前 `cloudRoot`/profile/home、daemon HTTP、版本、service/provider 和
bootstrap 状态；面板、MCP bridge 与 iframe 使用同一个动态 URL。

Provider 顺序为 `app > cli > shared`；shared 多版本优先 `runtime/current.json`。App
已安装但没启动时，优先启动 App provider，不会下载第二个 runtime。service 已注册时优先
service。显式 `daemonUrl` 是 pin，只 attach，不会被动态 URL 覆盖。

兼容发现顺序仍保留在无共享 CLI 的旧环境：`daemonUrl > MEBULAR_HTTP_PORT >
runtime.json > 127.0.0.1:7331`。插件只读取 `runtime.json` 的非敏感字段，不读
`config.json`、身份、token 或 store。

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `MEBULAR_CLOUD_ROOT` | 共享 root；缺省 `~/.mebular` |
| `MEBULAR_HOME` | 兼容 home/profile 发现 |
| `MEBULAR_HTTP_PORT` | 旧端口覆盖；共享 resolve 可用时以 resolve 结果为准 |
| `MEBULAR_CLI` | 显式 CLI 候选（`cliPath` 优先） |

## 生命周期

| 配置 | 行为 |
| --- | --- |
| `lifecycle: attach`（默认） | 只 resolve/probe；不启动、不停止；面板提示用户启动 App/安装 runtime。 |
| `lifecycle: managed` | 显式选择；健康 daemon 复用；service 已注册则用 service；否则用 provider 启动。 |
| `lifecycle: auto` | 显式选择，启动语义同 managed；没有 provider 时回到 `download_required`，不下载。 |
| `runtime: external` | 只 attach，永不启动/停止。 |
| `persistence: child` | 默认；插件拥有自己的 supervise 进程。 |
| `persistence: service` | 要求已有 service；未注册时提示，不安装 service。 |
| `bootstrap: prompt` | 缺 runtime 时显示安装入口（默认）。 |
| `bootstrap: never` | 不显示、不接受安装。 |

`managed`/`auto` 通过 `mebular runtime supervise` 持有 child，而不是直接 spawn
`mebular serve`。dispose 时只停止自己启动的 supervise；supervise 再有界清理它拥有的
daemon child。service/外部 daemon 不会被插件停止。

完整配置：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: managed      # attach | managed | auto
    runtime: auto           # auto | external
    persistence: child      # child | service
    bootstrap: prompt       # prompt | never
    panel: true
    # daemonUrl: ...         # 显式 pin；同时会变成 attach-only
```

非法值会回退安全默认并写 warning，不会让 DSH 激活失败。

## Memory Runtime（自动跟随模式）

Mebular 0.3.2 可以在 MCP 之外接入独立的 Memory Runtime sidecar。两层、两个进程：

| 层 | 默认 | 做什么 |
| --- | --- | --- |
| **MCP** | daemon 健康时开启 | 官方 client 挂载 `mcp__mebular__*`；29 个工具不变 |
| **Memory Runtime sidecar** | 跟随 Mebular 模式 | `/memory-runtime/v1` 上下文、ingest、压缩检查点、可选宿主任维护 |

sidecar **不是** MCP daemon runtime。DSH 绝不把 `daemonUrl`、MCP 的 `runtime.json` 或 7331
端口当作 sidecar，也不盲连 7341。适配器读取 `<home>/memory-runtime.json` 的 `mode` /
`state` / `capabilities`；轻量 MCP 没有 discovery 时不发 sidecar 请求，工具面保持 0.2。
**没有逐宿主 `memoryRuntime.enabled` / 采集开关**；旧字段忽略并 warning。

### 切换设备模式

唯一的产品开关是 Mebular 的记忆模式（`轻量 MCP` / `沉浸式`）。host 适配器自动跟随由此产生的
sidecar discovery，不需要逐宿主开启。

1. 打开 MCP 设置 `memoryRuntime.enabled`（控制台的记忆运行时开关，或
   `<home>/config.json`）：

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

   MCP daemon（HTTP，`mebular serve`）随后启动已安装的 sidecar，并写出
   `<home>/memory-runtime.json` 和 `<home>/memory-runtime/host-token`。stdio
   `mebular mcp` 不会启动它。MCP 不会自动下载 sidecar；请安装
   `@mebular/memory-runtime` 或使用桌面端捆绑。

2. 先确认 sidecar：

   ```bash
   mebular memory-runtime status --json
   ```

3. 不需要再打开 DSH 插件开关。下面的 `memoryRuntime` 组只用于显式排障/测试；正常使用可省略：

   ```yaml
   - id: mebular
     name: '@mebular/dsh-plugin'
     config:
       lifecycle: attach
       panel: true
       memoryRuntime:
         # 可选排障覆盖；以下默认开启，maintenance 默认关闭
         recall: true
         ingest: true
         checkpoints: true
         hideMemoryTools: true
         maintenance: false
         # 治理白名单；task_* 始终保留
         governanceTools: []
         memoryAgentPresets: ['mebular-memory']
         auth: auto                 # auto | bearer | none
         tokenEnv: MEBULAR_MEMORY_RUNTIME_TOKEN
         # url: 'http://127.0.0.1:7341/memory-runtime/v1'
         # tokenFile: '~/.mebular/memory-runtime/host-token'
         # token: '...'
   ```

- **发现：** `memoryRuntime.url` > `MEBULAR_MEMORY_RUNTIME_URL` >
  `<home>/memory-runtime.json`。`<home>` 依次取 `MEBULAR_HOME`、`MEBULAR_CLOUD_ROOT`、
  当前 profile。发现文件必须是 `ready`/`degraded`、`mode` 不是 `mcp`、心跳不超过 15 秒
  （30 秒为 dead）、`apiVersion=1`；否则沉浸式路径带原因禁用且不发请求。
  `mode=mcp` / `state=stopped` 是干净 dormant 信号：bridge 保持禁用，直到显式重新启用
  并发布新的沉浸式 discovery。陈旧、profile/实例不匹配的 discovery 会被拒绝，绝不猜测。
- **认证：** `memoryRuntime.token` > `tokenEnv` 指定的环境变量（默认
  `MEBULAR_MEMORY_RUNTIME_TOKEN`）> `memoryRuntime.tokenFile` > 发现 `tokenFile` >
  `<home>/memory-runtime/host-token`。这是 sidecar 的 **host token**，不是 MCP capability
  token。`auto` 有 token 时发送 `Authorization: Bearer`；`bearer` 强制要求；`none` 永不
  发送，只用于明确关闭认证的本地测试 sidecar。401 会刷新一次 token 缓存并重试。token
  不会进入日志、URL、错误或 `getState()`。
- **召回：** 只在 `agent/pre-step` 的 `step===1` 且 `decision.kind==='enter'`、且是新的
  人类 turn 时触发。调用 `POST /memory-runtime/v1/context`，只有旧 sidecar 明确返回
  404/405 时才回落到 `/recall`。命中时只保留**一条当前 source-tagged 上下文消息**：
  `role:'user'` + `source.kind='mebular-memory'`；它不是用户气泡，也不进入用户可见历史。
  绝不使用 `source.kind='user'`，不伪造新的人类 turn；按
  `(agentId, surface, query, turn)` 去重 30 分钟。召回连续超时/失败会进入有界冷却，
  而不是每轮都等待。适配器每个 human turn 先从 propose batch
  剔除所有历史 `mebular-memory` 消息，再用 session surface replacement 把上一轮 memory
  节点替换为当前命中；无命中/超时/失败时移除上一轮节点（空 system 节点不投影为模型消息），
  原样返回 decision。普通 user/assistant/tool 消息不修改。
  **平台限制：** DSH 0.2.1-rc.2 没有非持久模型上下文通道，durable `session.v4.jsonl` 会留下
  source-tagged 快照；这是平台行为，不是普通用户消息，也不意味着旧块会留在下一轮模型请求。
- **Ingest：** 监听 live own `session/event`，把 user/assistant/tool 事件批量送到
  `POST /memory-runtime/v1/ingest`；跳过 fork/resume 的 inherited prefix 和适配器自己的
  注入。队列有界（256），按 16 条/250ms 批处理；网络错误、超时、429、5xx 在首次尝试后
  最多重试两次，复用稳定的 `requestId`/`Idempotency-Key`。429 `Retry-After` 在有界延迟内
  遵守，并共享召回/写入冷却；重试接受绝不产生 committed。DSH **没有持久 ingest spool**：
  有界重试后失败的批次记录 warning 并丢弃，不会重新入队。传输成功与沉淀分开：
  202 + `queued:false` 是 **pending**，`queued:true` 是 sidecar outbox 交接，HTTP 200 +
  `extraction.status:'failed'` 是 failed，只有抽取完成且 record/detail 写入确认才计入
  committed。record/detail 部分写入报告为 partial，不提交也不回滚；可用但降级的结果保留
  `degraded` 标记，不并入成功或失败。
- **检查点：** 把 `compaction/start → summary → replacement → end` 折叠成一个
  ContextCheckpoint，并 `PUT` 到 `/memory-runtime/v1/checkpoints/:threadId`，带
  `domain=task:<threadId>`（或配置的 task domain）。只有 summary 与 replacement 都完整才
  提交；失败、中断或不完整折叠绝不会被报告为已提交。202 响应是 `pending:true` 且**没有
  已提交 revision**；适配器记录为 pending，只有权威 GET 返回图确认的 revision 才转为
  committed。更新携带最后确认的 `expectedRevision`；直接 `409 revision_mismatch` 做一次
  权威 GET 和一次重试，queued/重放冲突变为显式 pending/failed，而不是静默 rebase。capability
  让 revision 在 high-water 之上继续单调递增；删除或过期的 checkpoint 不会复用旧 revision。
  pending 与最后提交视图保持分离。DSH 没有持久 checkpoint spool：接受前中断的 checkpoint
  报告为 interrupted/failed，绝不报告为 committed；sidecar 已接受的工作从 sidecar outbox
  重放。请求不发送 `sync`。服务端要求 checkpoint 证据引用存在、类型正确、存活且同域。
- **工具面：** MCP 仍是 29 个工具，没有 `runtime_*` 工具。`hideMemoryTools` 对普通 Agent
  删除当前可见的 `mcp__mebular__memory_*`；`task_*` 和治理白名单（`governanceTools`，
  以及 `memoryAgentPresets` 中的 Agent）保留。适配器本身只走 HTTP，不注册记忆工具。
- **模型 / maintenance：** DSH 不运行、也不配置本地 Qwen 或第三方 API；请在 Mebular
  控制台选择。DSH 只有通过 `maintenance.enabled` 才能提供当前会话模型：idle 时向该模型
  要候选，再以 `extractor='host'` 提交。它不读 DSH 凭据，不把宿主模型当成 Mebular API
  调用。maintenance 关闭时，DSH 不提供宿主候选：如果 sidecar 配置为 `host`，这些
  ingest 可能保持 pending 直到候选被补上；否则按配置的 local、API 或 heuristic 来源处理。
  任何来源都不会静默调用另一个模型。

### 真实边界

- 召回块是 source-tagged 上下文消息，不是伪造的用户 turn，也不是用户可见历史。DSH
  durable session log 会留下 source-tagged 快照（平台没有非持久模型通道）；每轮由适配器
  过滤/替换，无命中不进入下一轮模型请求。该快照属于宿主，不在 Mebular 图内：Mebular
  删除、保留期到期和墓碑同步都不会擦除它；需通过 DSH 自己的会话保留/删除机制管理。
  如果未来 DSH preview 提供非持久通道，适配器应优先迁移；如果通道语义再次变化导致无法
  保证上述边界，应带 `injection_channel_unsupported` 禁用注入，而不是回退到
  `source.kind='user'`。
- DSH 只保证它实际发出的 compaction 事件；适配器不编造 summary。被中断的压缩不是已提交
  的 checkpoint。
- DSH 不暴露自己的 LLM 凭据，本适配器也不读取它们。
- DSH 没有持久 ingest/checkpoint spool。只有 Hermes provider 有持久 `queue.jsonl`；
  DSH 的失败有界且会在状态中可见。接受前中断的 checkpoint 变为 interrupted/failed，
  不会永远 pending；sidecar 已接受的 202 工作从 sidecar outbox 重放。
- DSH 的确定性测试模型和真实 DSH 进程是不同证据层。DSH E2E 证明真实宿主进程、适配器和
  运行时路径，不证明真实模型质量。v0.3.2 的新计数和边界见
  [验收矩阵](../quality/0.3.2-verification.md)，不写在本指南里。

数据边界与模型回退规则见 [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md)。

## 从 0.2 升级 / 从旧原型迁移

- **没有强制迁移。** 0.2 的记录保留原 ID、namespace、tag 和事件。旧的 `default`
  namespace 原样保留，按第三类/Other 兜底解释（`domain=default`），不会改写成 `user`。
- MCP 只保留生命周期键（`memoryRuntime.enabled`、`memoryRuntime.command`、
  `memoryRuntime.startTimeoutMs`）。详情/staging、模型、trace、retention 属于
  `<home>/memory-runtime/config.json`，不再放在 MCP 的 `runtime.*` 键下。
- 检查点和 SelfRecord 没有本地/云端二选一。没有 `sync=cloud`、`checkpoint.sync` 或
  `self.sync`；所有持久对象都经 MCP 写入，并由现有云端同步传播。
- `/runtime/v1` 不再提供，也没有兼容层。新版 DSH 适配器使用
  `/memory-runtime/v1`；仍指向 `/runtime/v1` 的旧适配器连不上 sidecar，但 MCP 和 DSH
  面板继续可用。
- 原型写到 `<home>/runtime/` 的本地数据不会被读取或迁移。不要删除
  `<cloudRoot>/runtime/`；那是 MCP daemon 的安装根，不是 sidecar 数据。
- 要关闭 sidecar，把 Mebular 记忆模式切回轻量 MCP（或
  `mebular memory-runtime stop`）。适配器看到 discovery 消失或 dormant
  `mode=mcp` / `state=stopped` 记录即停止 ingest/recall/checkpoint，不需要改宿主配置；
  attached/manual 进程可以继续存活但处于 dormant。29 个 MCP 工具和已沉降记忆保留。
  `<home>/memory-runtime/` 可保留或删除；删除它不会删除已沉降记忆。
- **版本与降级边界。** 所有设备必须运行相同的 Mebular 版本，没有混版窗口。更改包版本前
  显式运行 `mebular memory-runtime stop`。未沉降 staging/outbox 条目只在本机，不迁移、
  不保证最终沉降，并随本机目录删除而丢弃；已沉降或已同步详情仍受正常图保留/删除策略
  约束。这些数据保留说明不代表完整 0.3→0.2 回滚已验收；见
  [Memory Runtime 指南](../guides/MEMORY_RUNTIME_CN.md#从-02-和旧原型升级)。

## 轻量 MCP 保持不变

没有 sidecar/discovery 时，DSH 就是完整的 0.2 体验：同样的 29 个
`mcp__mebular__*` 工具，同样的 attach/managed 生命周期、面板和 Console。没有
`mebular-memory-runtime` 进程，不新建 `<home>/memory-runtime/` 目录或文件，不生成
`memory-runtime.json`、host token，不监听 7341 端口。如果目录是之前沉浸式留下的，轻量
模式也不会修改它。为跟随运行中的模式切换，已安装插件仍可能注册 Memory Runtime
discovery/feature listener 和 discovery 轮询 timer；“轻量”指没有 sidecar 进程或 sidecar
HTTP 请求，不是整个 DSH 插件完全不注册 listener/timer。

## 状态与面板

`GET /mebular/embed-info` 只接受 loopback，返回非敏感状态。v0.2.0 新增了
`state`、`runtimeMode`、`profile`、`provider`、`service`、`downloadRequired`、
`install`、`update`、`upgrade` 等字段；面板、MCP bridge 和 iframe 由同一份状态驱动。
`version` 是运行中的 runtime 版本；`pluginVersion` 是已安装的 DSH 插件包版本，也是
面板标题显示的版本。两者不一致时，标题 tooltip 会显示 runtime 版本。

```json
{
  "ok": true,
  "status": "up",
  "state": "up",
  "mode": "attach",
  "runtimeMode": "reused",
  "managed": false,
  "panel": true,
  "version": "0.3.2",
  "pluginVersion": "0.3.2",
  "profile": { "id": "default", "name": "我的忆云" },
  "provider": { "kind": "app", "source": "registry", "version": "0.3.2" },
  "service": { "registered": false, "running": false, "foreign": false },
  "downloadRequired": false,
  "install": { "state": "idle", "allowed": true },
  "update": { "state": "idle", "available": false, "show": false, "manual": false },
  "upgrade": { "state": "idle", "busy": false },
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

常见面板状态：

- `download_required` / `download_failed`：没有可用 runtime；显示显式安装、手动命令、
  重新检测；不自动下载。
- `provisioning` / `starting`：安装、init 或 supervisor 启动中；暂不挂 MCP tool。
- `service_conflict` / `profile_mismatch` / `port_in_use`：不会启动第二个 daemon；
  按提示检查 service/profile/端口。
- `update_available`：共享 check 发现新 stable 版本；只显示提示。
- `up`：daemon 健康且 embed 协议匹配；MCP bridge 挂载，Console 可嵌入。

状态点仍与面板共用同一份状态：绿=已连接，琥珀=启动/安装/更新中，红=未运行，
灰=首次检查未返回。悬停状态点显示当前状态。

## 更新与升级

插件在启动/刷新时调用共享 `mebular runtime check-update --json`：

- 固定官方 npm registry 的 stable 通道；24h 节流；离线/HTTP/busy 静默跳过；
- 共享 `update-state`/`update.lock`，两个入口只让一个提示；
- `promptedVersion` 在面板实际渲染 banner 后写；App 的提示也写同一状态；
- `跳过此版本` 写共享 skippedVersion；`稍后` 不写 skip、不自动重试。

只有用户点击更新才执行：

```text
mebular runtime upgrade --to latest --json
```

升级会复用 installer，更新 current/provider；service 已注册时由 core 更新并重启
`mebular-serve`；插件只重启自己拥有的 supervise，外部 daemon 不动。共享 upgrade lock
保证两个入口只执行一个；另一个等待/reconnect。失败保留旧 runtime/current/provider，
不产生第二个 daemon。

## 常驻与卸载

- Console 的「让 Mebular 常驻」安装/检查共享 `mebular-serve`；
- service 状态与常驻操作在 Console 设置中；插件面板只保留紧凑 runtime header，
  插件本身不安装 service；
- 卸载 DSH 插件只移除插件和它自己的 supervise/timer，不删除 runtime、provider、
  service 或数据；
- 显式移除常驻服务用 `mebular runtime service uninstall`；它会保留 runtime/provider/data。

## 安全

- `/mebular/embed-info` 只接受 loopback；响应不含 token、密钥、home 或 CLI 路径。
- 安装/升级是 loopback-only `POST`，要求 JSON、拒绝任意 version/URL/registry；固定源和
  固定目标由 host 读取，不由客户端传入。
- iframe 只在 daemon、embed protocol、loopback 与 `capabilities.embedConsole` 都满足时
  创建；sandbox 不含 top navigation。
- `?embed=dsh` 下 Console CSP 允许 loopback HTTP 祖先和 DSH Desktop 的
  `dsh-app://app` origin；普通 Console 请求仍保持 `frame-ancestors 'none'`。
- DSH 内嵌态隐藏锁定横幅和 onboarding 卡：它们在窄面板会压住 Console 右侧导航
  （`审计` / `设置`）。内嵌态右上角提供紧凑操作条：锁定态为 `新建忆云` /
  `加入忆云`，初始化后为 `加入忆云` / `邀请设备`。
- 共享 update/upgrade/install 锁防止两个入口重复安装或升级；日志先脱敏。

## 常见 reason

| reason | 处理 |
| --- | --- |
| `download_required` | 没有 runtime；在面板点击安装，或打开 App/安装 CLI |
| `service_conflict` / `service_unknown` / `service_foreign` | 检查 Console/service；不会启动第二个 daemon |
| `profile_mismatch` / `instance_mismatch` / `CLOUD_ALREADY_ACTIVE` | 切换到同一 profile 或停止另一个实例 |
| `port_in_use` | 释放端口或调整 Mebular 端口 |
| `runtime_resolve_failed` | 更新/重装 App/CLI 或共享 runtime |
| `supervise_failed` / `child_exited` | 检查共享 runtime 日志后重试 |
| `update_*` / `upgrade_busy` | 等另一个入口完成，或稍后重试；升级是显式动作 |
| `peer_missing` | 确认 DSH 提供 `@deepseek-ai/dsh-mcp-client` peer |

## 验证

```bash
npm test -- --runInBand tests/dsh
npm run verify:dsh-plugin
npm run verify:runtime:coexistence
```

真实 DSH Web E2E（最小支持版 + npm latest）、冷启动、单 daemon、service、更新锁和升级
回滚由 CI 与 `docs/operations/DSH_E2E.md` 覆盖。

## 发布与版本

- 版本：`0.3.2`，随统一 Mebular v0.3.2 release train（七个 lockstep npm 包加独立的 `dsh-plugin` 同版本）
- npm：`@mebular/dsh-plugin@0.3.2`
- 插件是独立适配器：代码隔离在 `packages/dsh-plugin`，由独立 npm job 发布；插件运行时从
  自己的 `package.json` 读取 pinned runtime 版本，发布 bump 不需要改插件源码。
- 发布先 `@mebular/core@0.3.2`，再 `@mebular/dsh-plugin@0.3.2`；详见
  [发布 SOP](../operations/RELEASE.md)。
- 插件已收录于
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/)
  的 `memory` 分类。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

确认 profile 中已无插件：

```bash
dsh --profile web --dump-config | grep -i mebular   # 应无输出
```

卸载只移除 DSH 插件；Mebular App、runtime、service、数据与运行中的 Console 不受影响。
不要删除 Mebular home 或 store。
