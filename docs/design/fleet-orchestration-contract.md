# Mebular Fleet 黑盒任务编排 · 边界与契约 v1

**状态**：v1.0 / P0 冻结稿，2026-11-04
**阶段**：P0（只冻结边界与契约；不写生产代码）
**上位计划**：《Mebular Fleet · 黑盒任务编排（本期）》（Chief 持有；未经 CR 不修改 step、scope、Gate）
**协议夹具**：[`plan.example.json`](../../packages/fleet/protocol/plan.example.json)、[`card.example.json`](../../packages/fleet/protocol/card.example.json)
**相关既有契约**：
- [`packages/fleet/DESIGN.md`](../../packages/fleet/DESIGN.md)（fleet 设计与任务=记忆）
- [`packages/fleet/PROTOCOL-INVARIANTS.md`](../../packages/fleet/PROTOCOL-INVARIANTS.md)（协议不变量与准入纪律）
- [`SEALING_CN.md`](../../SEALING_CN.md)（记忆层协议语义，fleet 不改）
- [`0.3.0-immersive-product-contract.md`](./0.3.0-immersive-product-contract.md)（0.3 产品边界）

> 本文只细化上位计划，不扩大 scope。本文与上位计划冲突时，以上位计划为准；本文未写明的新需求一律走 CR，不得由执行会话自行解释。
>
> P0 只新增本文档与 `packages/fleet/protocol/plan.example.json`、`card.example.json`。不改 `src/`、`tests/`、`packages/console/`、`packages/mcp/`；不新增 MCP 方法，不新增人类 UI。

---

## 0. 一页结论

1. **人类 UI 零新增入口**：不加导航、页面、设置项、Advanced/Fleet 页面或任务面板。
2. **MCP 任务面冻结**：现有 16 个 task 方法不新增、不删除、不改名；必填字段与旧调用语义不变；只允许 optional 字段 additive 扩展；不新增 `plan_*` / `agent_card_*`。
3. **Fleet 厚、MCP 薄**：plan、card、routing、join、materializer 全部在 Fleet 内部；MCP 只提交意图、查询状态、控制任务。
4. **一任务一执行者**：本期只做 assign；不做开放抢单、claim、lease 或竞价。
5. **计划先于执行**：plan 不可变、版本化，DAG 在 plan 层整体校验；task 层只保留执行者派生树；执行中不改图，改图 = 新 plan 版本。
6. **没有下一版**：本期必须完整交付；新需求只能 CR 纳入本期或明确拒绝，不存在“下一版再补”。

G0 要求 Chief + 独立 Reviewer 签字；P0 说不清就不进入 P1。

---

## 1. 纲领与术语

### 1.1 五条纲领

| # | 纲领 | 含义 | 违反即红牌 |
|---|---|---|---|
| 1 | 人类 UI 零新增入口 | 导航、页面、设置、Advanced、任务面板、Fleet 页面全部不变；plan/card 只做 internal | 新增任何人类入口 |
| 2 | MCP 任务面冻结 | 16 个 task 方法名称、必填字段、旧调用方式不变；只允许 optional additive；不新增 `plan_*` / `agent_card_*` | 新增/删除/改名方法，或新增必填字段 |
| 3 | Fleet 厚、MCP 薄 | plan、card、route、policy、join、materializer 都在 Fleet 内部；MCP 只负责提交、查询、控制 | 把 plan/card 做成公共 MCP 方法或 UI |
| 4 | 一任务一执行者 | 本期只做 assign；任务创建时 `to` 固定，执行者不抢单 | 开放抢单/claim/lease/竞价 |
| 5 | 计划先于执行 | plan 不可变、版本化；DAG 先整体校验；task 只保留派生树；改图 = 新 plan 版本 | 执行中原地改图、跨 plan 依赖 |

### 1.2 “没有下一版”

- 本期（P0–P7）就是最终交付；没有 P8、没有 v2、没有“后续版本再补”。
- 新需求 → CR → **纳入本期**或**明确拒绝**。CR 不能写“延后到下一版”。
- Gate 不接受“主要功能完成，剩下以后补”；测试绿不等于验收完成。
- P0 结束若仍有说不清的边界，停止在 G0，不进入 P1。

### 1.3 术语（冻结）

| 术语 | 定义 |
|---|---|
| **Fleet** | 跨设备多 Agent 协作层；任务以记忆事件承载，复用既有同步与信任。 |
| **Chief** | 当前规划会话；守边界、派发执行会话、Gate 审核、CR、更新 plan、最终收口。Chief 不写阶段代码；若必须写，不能自审。 |
| **执行会话** | 每个阶段一个独立会话；只做一个阶段，不得进入下一阶段。 |
| **Reviewer** | 与执行会话分离的只读审核会话；不写代码；结论只有 pass/fail。 |
| **Coordinator / Materializer** | Fleet 内部按 plan 推进的执行器；只推进 ready step，不拥有扩 scope 权力。 |
| **plan（`task_plan`）** | internal 记忆节点；不可变、版本化；描述 goal、budget、policy 与 step DAG。 |
| **plan version** | 同一 `planId` 的单调版本；每次改图/重试生成新版本；旧版本永久保留。 |
| **root task** | `task_submit` 携带完整 plan 时创建的 plan 级 orchestration task；taskId `${planId}#${version}#root`；目标为保留设备/Agent sentinel `{device:"__plan__", agent:"__plan__"}`；由 materializer 管理状态；不是 step。 |
| **step** | plan 中的一个节点；有 `stepId`、`intent`、`dependsOn`、可选 `to`/`route`、`acceptance`。 |
| **ready step** | 依赖已满足、预算/策略允许、尚未物化的 step。 |
| **materialize** | 把 ready step 变成真实 task；taskId 确定性生成；append 幂等。 |
| **task 派生树** | 执行者用既有 `created` + `trace.causedBy`/`chain` 派生的任务树；plan 依赖不是 task 边。 |
| **join / reduce** | plan 级汇合；`join` 是屏障，`reduce` 是屏障+聚合；只在条件满足后创建对应 task。 |
| **MR** | root plan 本期唯一一次合并请求提交；MR 是 root plan 的最后一个 step；root done 在 MR 后。子 plan 不提交 MR。 |
| **capability card** | 能力卡；从 config + ExecutorRegistry + 运行环境编译；硬过滤边界。 |
| **role card** | 角色卡；本机 runtime 从任务历史 + 会话摘要生成；shadow，软排序，不能授权。 |
| **status view** | 状态视图；派发方实时计算，不落盘、不同步；只用于软排序。 |
| **route** | 候选解析与选择；返回 `chosen` + `why`；空候选 `NO_TARGET`。 |
| **policy** | `allowedDevices` / `allowedAgents` / `requireCapabilities` / `maxParallel` / `allowSubcontract`；子 plan 只能收紧。 |
| **acceptance** | 每个 step 的验收条件；step 完成必须同时满足 task 终态、子树终态、acceptance。 |
| **subtree complete** | step task 及其全部派生后代都到终态；任一后代失败则 step 失败。 |
| **internal** | `metadata.internal === true`（或既有保留 namespace）的内部对象；默认列表/计数/搜索/图遍历不返回。 |
| **`why`** | route 的结构化解释：硬过滤、排序、tie-break、policy、role card 状态。 |
| **`NO_TARGET`** | 无合法候选的确定性结论；附 `why` 与拒绝原因；不得静默改派。 |
| **MR receipt** | 某 root `planId` 的 MR 终态证据；用于保证跨版本只提交一次 MR。 |
| **shadow** | 角色卡只计算、只给内部测试看，不参与派发；有提升并经 G5 才能启用软排序。 |

---

## 2. 范围与边界

### 2.1 必须完成（in scope）

- 三张卡：能力卡、角色卡（shadow）、状态视图。
- plan 节点、validator、materializer、版本化、重启/换机恢复。
- route + policy + 可解释选择（`why` / `NO_TARGET`）。
- plan 级 join（`all` / `any` / `quorum`）、subtree complete、acceptance、MR 门禁。
- 三机 E2E、故障注入、UI/MCP 回归、文档与 runbook。
- 独立审核与最终 MR。

### 2.2 明确不做（out of scope）

- 任意动态 P2P DAG、执行中改图、跨 plan 依赖。
- 开放抢单 / claim / lease / 竞价。
- 全局调度器、leader 选举、集中注册服务。
- 主 UI 任务面板、新导航、Advanced/Fleet 页面、新设置项。
- 原始对话存储或训练；角色卡存原始对话。
- 修改 core 语义、修改 `TaskEvent` 线格式、新增 `TaskEvent` 类型。
- 混合版本 coordinator（coordinator 必须是新版本）。
- 超出验收阈值的性能优化。

### 2.3 边界表

| 边界 | 冻结规则 |
|---|---|
| MCP | 16 个 task 方法冻结；不新增、不删除、不改名；旧调用不变；只允许 optional additive；不新增 `plan_*` / `agent_card_*` |
| 人类 UI | 导航/页面/设置不变；无 Advanced；无任务面板；无 plan/card 入口 |
| 内部数据 | plan/card 标 `internal`；记忆列表、域计数、搜索、图遍历默认隐藏 |
| 事件流 | plan/card 不进 fleet SSE；星图只显示真实 task `created` 事件 |
| 配置 | 新字段 optional；旧 `fleet.config.json` 仍有效 |
| 旧端 | 旧 worker 能执行普通 task；旧 peer 忽略 plan/card；旧 config 有效；coordinator 必须新版本 |
| 隐私 | 角色卡只存摘要/标签/证据引用；不存原始对话；不存 command/env/凭据 |
| 线格式 | `FLEET_PROTOCOL_VERSION=1` 与 `TaskEvent` 线格式不变；plan/card 是内部记忆记录，不是 task 事件 |

### 2.4 范围纪律

- P0 只写文档与协议 fixture；不写生产代码，不改测试。
- 每个执行会话只做一个阶段；结束即停，等待 Gate。
- 需要改动 P0 范围之外的文件：停止并报告，不自行扩 scope。
- 任何新需求：停止 → 写 CR → Chief + Reviewer 决定纳入本期或拒绝。

---

## 3. MCP Surface Freeze

### 3.1 冻结的 16 个 task 方法

以下名称、scope、必填输入冻结。任何新增、删除、改名、改必填字段、改旧调用语义都是红牌。

| # | MCP 方法 | scope | 必填输入 | 冻结的旧行为 |
|---|---|---|---|---|
| 1 | `task_submit` | `task.write` | `intent`, `to` | 提交 root/child；旧调用按随机 taskId 创建；非幂等 |
| 2 | `task_submit_batch` | `task.write` | `tasks` | 逐项调用 `task_submit`；返回逐项结果 |
| 3 | `task_cancel` | `task.write` | `taskId` | 普通 task：未终态写 failed（reason=CANCELLED），已终态 `already-terminal`；`rootTaskId`：plan 级取消并级联清理（§3.5/§8.6） |
| 4 | `task_retry` | `task.write` | `taskId` | 普通 task：以新任务重试，`causedBy` 原任务；plan-owned root/step/MR：`PLAN_RETRY_REQUIRED`，不建任务 |
| 5 | `task_status` | `task.read` | `taskId` | 单任务权威状态 |
| 6 | `task_list` | `task.read` | 无 | 列出任务，可按 status/from 过滤 |
| 7 | `task_history` | `task.read` | `taskId` | 单任务全部事件，确定序 |
| 8 | `task_children` | `task.read` | `taskId` | 直接子任务（`trace.causedBy`） |
| 9 | `task_summarize` | `task.read` | `taskId` | 从 root 可达子图汇总 |
| 10 | `task_subscribe` | `task.write` | 无 | 按 cursor 返回变化任务（单次） |
| 11 | `task_negotiate` | `task.write` | `taskId`, `kind`, `round` | 协商消息；`messageId` 幂等 |
| 12 | `chatter_send` | `task.write` | `topic`, `text` | 配额制闲聊发送；本地记账 |
| 13 | `chatter_inbox` | `task.write` | 无 | 闲聊收件箱；幂等、确定序 |
| 14 | `task_quota` | `task.read` | 无 | 本机配额状态 |
| 15 | `task_targets` | `task.read` | 无 | L1 授权对端 ∩ Agent 目录 |
| 16 | `board_create` | `task.write` | `name` | 建板 = 建域 + 本机订阅 + 邀请 |

> 数量断言：`TASK_TOOLS.length === 16`；名称集合与上表完全一致；不存在匹配 `/^(plan|agent_card)_/` 的方法。
>
> CLI 与 MCP 能力对等：`fleet <name>` / `mebular <name>` 仍是上表 16 个同名等价子命令（含 `chatter_*` / `board_create`）；不新增 `fleet plan_*` / `fleet agent_card_*`。

### 3.2 additive 规则

- 方法名称、数量、scope 不变。
- **必填字段不新增、不删除、不改名**；旧调用参数与返回字段语义不变。
- 只允许 **optional** 字段扩展；调用方不传时行为与旧版完全一致。
- 已有枚举值不删除、不改义；新增枚举值必须走 CR，且旧值仍可用。
- 输出只允许 additive；旧字段不删除、不改名、不改类型。
- 未知 optional 字段由实现忽略；不得因未知字段拒绝旧调用。
- 不新增 `TaskEvent` 类型；不改 `TaskEvent` 线格式。
- 不新增 `plan_*` / `agent_card_*` 方法；不把 plan/card 注册成 MCP tool。
- `task_retry` 对 plan-owned task 返回 `PLAN_RETRY_REQUIRED`；这是既有方法仅针对新 plan task 的错误语义扩展，普通 task 旧行为不变（§3.5）。

### 3.3 本契约批准的全部 optional 扩展

本版本**只批准**以下三个扩展；其它字段一律 CR。

| 方法 | 方向 | 字段 | 形状 | 规则 |
|---|---|---|---|---|
| `task_submit` | 输入 optional | `plan` | **完整 plan 定义**（schema 按 §6.2） | 由调用方 Agent 直接提交；Fleet 校验后创建 internal plan 节点 + root task，返回 `planId` / `version` / `rootTaskId`；旧调用不传时完全不变 |
| `task_status` | 输出 optional | `plan` | plan progress 对象 | 仅当 taskId 是 plan root/step/MR 时出现；旧调用仍只读 `state`；不改变旧字段 |
| `task_targets` | 输出 optional | `cards` | capability card 摘要数组 | 只含能力卡摘要，不含角色卡原文/原始对话；旧 `targets` 不变；A 不强制使用 |

plan 提交的约束：

- `plan` 必须是 §6.2 的完整记录，包含 `planId`、`version`、`owner`、`goal`、`budget`、`policy`、`steps`；不是内部 ref，也不是 plan 片段。
- `task_submit` 的旧必填字段 `intent` / `to` 仍保留。plan 提交时：
  - 调用者设备必须是 `plan.owner.device`；跨设备代提交不在本期 scope。
  - **所有 plan 的 owner = 提交该 plan 的调用设备/Agent**：root plan owner=A；sub-plan 由执行 step 的设备 B/C 提交，owner=B/C。`parent` 只做 provenance/policy 校验，不改变 owner。
  - `to` 必须是 `{ device: "__plan__", agent: "__plan__" }`（保留的设备/Agent sentinel；不是用户设备/执行器）。
  - `intent` 是 root task 的意图摘要；不得为空。
- `__plan__` 是保留 device/agent sentinel；`fleet.config.json` 不得配置真实 device/agent 为 `__plan__`，否则配置校验失败。
- Fleet 在 `task_submit` 内完成：plan schema/DAG/policy 校验 → 幂等检查 → 写 internal plan 节点 → 创建 root task。root plan 的 root task `trace.chain=[]`；sub-plan 的 root task `trace.causedBy=父 step taskId`。成功后返回 `{ ok:true, planId, version, rootTaskId, taskId: rootTaskId, ... }`。
- **幂等**：同一 `planId + version + 规范化内容` 重复提交 → 返回已有 plan/root task，不重复写 plan、不重复建 root task；若 plan 已存在但 root task 缺失，按确定性 taskId 补建一次。`planId + version` 相同但规范化内容不同 → `PLAN_CONFLICT`，不创建任何对象。
- 规范化内容 = 去除 `createdAt` 与存储 metadata 后、按对象键递归排序的 UTF-8 JSON；其余字段（含 `reason`/`parent`/`steps`）全部参与比较。
- **不新增 MCP 方法**；不提供 `plan_*` / `agent_card_*`；不通过 `memory_write` 创建 `task_plan`（现有 `memory_write` 类型不变）。
- 内部 materializer 创建 step task 走 Fleet 内部 API，**不走 MCP**；MCP 只暴露完整 plan 提交与只读进度，不暴露内部 `planRef`。
- `task_status.plan` 是派生进度摘要，不返回 plan 定义、step 定义或可修改 plan 的引用。

`task_status.plan` 的最小形状：

```json
{
  "planId": "plan-demo-001",
  "version": 2,
  "rootTaskId": "plan-demo-001#2#root",
  "status": "running",
  "steps": [
    { "stepId": "collect", "status": "done", "via": "reuse", "sourceTaskId": "plan-demo-001#1#collect" },
    { "stepId": "build-ui", "status": "dispatched", "via": "task", "taskId": "plan-demo-001#2#build-ui" },
    { "stepId": "mr", "status": "pending", "blockedBy": ["pre-mr"] }
  ],
  "mr": { "submitted": false }
}
```

- `status` / `step.status` 是**派生值**，不是第二套持久状态机；plan 节点本身不被改写。
- `via` = `task`（当前版本物化）或 `reuse`（复用旧版本）；`taskId` 只在 `via=task` 时出现，`sourceTaskId` 只在 `via=reuse` 时出现。
- `mr` 字段必须始终存在：root plan 为 `{submitted:boolean}`；sub-plan 固定为 `{applicable:false, submitted:false}`。
- `blockedBy` 是 stepId 或原因码数组，用于观测；不是 task 依赖。
- `plan` 输出允许 additive；P2 不得改变 `state` 的旧字段。

`task_submit.plan` 成功返回的最小形状：

```json
{ "ok": true, "planId": "plan-submit-001", "version": 1, "rootTaskId": "plan-submit-001#1#root", "taskId": "plan-submit-001#1#root" }
```

`task_targets.cards` 的最小形状（仅能力卡摘要）：

```json
[
  { "device": "device-B", "agent": "worker", "version": 7, "capabilities": ["fleet.task", "code.write"], "online": true, "inflight": 1 }
]
```

### 3.4 旧端兼容

| 旧端 | 必须成立 |
|---|---|
| 旧 worker | 能执行普通 task；plan step task 对它是普通 task；不需要理解 `dependsOn`/plan；root task 的 `to.device="__plan__"` 与任何真实设备不匹配，旧 `targetsMe` 直接跳过，不执行、不写 failed、不影响 plan 状态 |
| 旧 peer | 忽略 internal plan/card 节点；不因未知内部对象报错；root/step task 仍是普通任务事件 |
| 旧 config | `fleet.config.json` 仍有效；新增字段全部 optional |
| 旧 MCP 调用 | 16 个方法旧参数、旧返回字段、旧错误语义不变 |
| coordinator | **必须新版本**；混合版本 coordinator 不支持；旧 coordinator 不处理 plan |
| 线格式 | `FLEET_PROTOCOL_VERSION=1` 与 `TaskEvent` 不变；plan/card 不写入 task 事件 |

### 3.5 plan-owned task 控制

**plan-owned task** = 某 plan version 的 root task、step task、MR task（taskId 严格匹配 `${planId}#${version}#root` 或 `${planId}#${version}#${stepId}`）。执行者由 step task 派生的普通子任务（如 `${stepTaskId}~c0`）是 ordinary task，不属于 plan-owned。

| 操作 | 行为 |
|---|---|
| `task_retry(plan-owned taskId)` | 返回 `ok:false`、`error:"PLAN_RETRY_REQUIRED"`；不创建新任务、不写 created；必须走新 plan version（`task_submit.plan`） |
| `task_retry(ordinary taskId)` | 完全保持旧语义：新任务 + `causedBy` 原任务 |
| `task_cancel(rootTaskId)` | plan 级取消：root task failed(CANCELLED) + 停止新物化 + best-effort 取消该 version 所有非终态 step task 及其派生树 |
| `task_cancel(stepTaskId)` | 既有 step 级取消：该 step task 及其派生子树 failed(CANCELLED) |
| `task_cancel(ordinary taskId)` | 完全保持旧语义 |

- 不新增 MCP 方法/输入字段；`PLAN_RETRY_REQUIRED` 是既有 `task_retry` 对 plan-owned task 的错误语义扩展。
- `PLAN_RETRY_REQUIRED` 只对 plan-owned task 生效；不得影响普通 task 的 retry。
- 错误 shape 最小为 `{ ok:false, taskId, error:"PLAN_RETRY_REQUIRED" }`；允许附加 `planId`/`version`/`stepId` 便于诊断，但不得创建任务。
- plan 级取消的识别只依赖 rootTaskId（`#root`）；不新增 plan handle 字段或方法。
- root task 已终态时，`task_cancel(rootTaskId)` 与普通 task 一致返回 `already-terminal`，不再级联取消 step task。

---

## 4. 人类 UI 与可见性冻结

### 4.1 零新增入口

禁止：

- 新导航项、新页面、新路由、新设置项、新开关。
- Advanced / Fleet / Plan / Card / Task 面板。
- 在既有页面加“查看计划”“查看能力”“查看角色”入口。
- 新的人类操作按钮、图表、列表、筛选器。

允许：

- 既有任务列表/星图继续显示**真实 task**；plan step task 是真实 task，可以出现。
- plan step task 只按既有任务展示；不得展示 plan/card 内容、步骤列表、plan 导航或 plan 专属面板。`taskId` 只是标识，不是 UI 入口。
- 既有管理/调试面在显式 `includeInternal` 时读取 internal 对象（现有能力，不新增入口）。

### 4.2 internal 可见性

plan/card 必须落为 internal 记忆对象：

```text
metadata.internal = true
metadata.internalObject.kind =
  "task_plan"              // plan 节点
  "agent_capability_card"  // 能力卡
  "agent_role_card"        // 角色卡
```

- `metadata.internal === true` 是唯一通用判别键；保留 `__*` namespace 仍按现有规则视为 internal（`__policy__` 除外）。
- 默认记忆列表、域计数、搜索、图遍历、管理面摘要**不得返回** plan/card。
- 域计数不得把 internal 对象计入普通记忆数量；不得新增“internal 计数”UI。
- 状态视图不落盘；不产生 internal 节点。
- plan/card 不进 fleet SSE。
- 不新增公开/内部 HTTP 端点；P1–P7 只能复用既有读写路径。

### 4.3 事件流与星图

- fleet SSE 只广播真实 task `created` 事件，payload 字段保持：
  `{ at, fromDeviceId, toDeviceId, taskId, eventType: "created", namespace }`。
- 只接受 `task_event` 节点、任务 namespace、`content.type === "created"`；其它一律不广播。
- plan/card 不是 `task_event`，不得出现在 SSE、星图、航线计数。
- 不新增 SSE 事件名（如 `plan_created` / `card_updated`）。
- 星图只显示真实 task `created`；plan step task 是真实 task，可显示；plan/card 不显示。

### 4.4 UI 验收

- 导航、页面、设置项与改动前一致；提供截图或 DOM 断言。
- 记忆列表/域计数/搜索不出现 plan/card。
- 不出现新 SSE 事件名；星图只收真实 task `created`。
- 任何“新增入口”即红牌，停止并开 CR。

---

## 5. 三张卡

三张卡都不是 MCP 配置出来的，而是生成/计算出来的。

| 卡片 | 来源 | 生成者 | 存储 | 用途 |
|---|---|---|---|---|
| 能力卡 | fleet config + ExecutorRegistry + 运行环境 | 每台设备的 fleet worker/daemon | internal 记忆节点；设备签名；版本化 | 硬过滤 |
| 角色卡 | 任务历史 + memory runtime 会话摘要 + 反馈 | 本机 runtime job | internal 记忆节点；confidence/evidence | 软排序（shadow 期不参与） |
| 状态视图 | 在线状态 + 在途任务 + 最近成败/时延 | 派发方实时计算 | 不落盘、不同步 | 决定现在给谁 |

### 5.1 能力卡（`agent_capability_card`）

**生成输入**：`fleet.config.json` 的 `agents`、`ExecutorRegistry`、运行环境。
**生成者**：每台设备的 fleet worker/daemon；启动、配置变更、agent 注册变化时重新发布。
**签名**：设备签名；版本单调；设备移除 agent 时发布 tombstone。

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | 是 | 记录 schema 版本，固定 `1` |
| `kind` | 是 | `agent_capability_card` |
| `device` | 是 | 设备 ID |
| `agent` | 是 | Agent 名 |
| `version` | 是 | 非负整数，按 `(device, agent, kind)` 单调递增 |
| `capabilities` | 是 | 字符串标签数组；来自 config 的 optional `capabilities` + 编译结果 |
| `tools` | 是 | 该 Agent 可用的 task 工具名数组；不得包含不存在的方法 |
| `limits` | 是 | `maxConcurrency` / `maxPayloadBytes` / `timeoutMs` 等限制；数值 |
| `permissions` | 是 | `taskNamespaces` 等授权范围；不存密钥 |
| `runtime` | 是 | `os` / `arch` / `runtime` / `runtimeVersion` 等标签 |
| `provenance` | 是 | `source` / `configHash` / `registryHash` / `publishedAt` |
| `signature` | 是 | `{ alg: "Ed25519", keyId, sig }`，设备签名 |
| `tombstone` | 否 | `true` 表示该 agent 已移除；版本仍单调 |

规则：

- 不包含 command 路径、env、密钥、凭据、原始对话。
- `capabilities` 是硬过滤标签；不是授权本身，授权仍由 L1/peer/policy 决定。
- 最新版本按 `(device, agent)` 解析；同版本平局取稳定序列化较大者（确定性）。
- tombstone 是最后版本；不得在同一版本上原地修改；tombstone 后不得回退到更旧版本。
- tombstone 允许 `capabilities: []`、`tools: []`、`limits: {}`、`permissions.taskNamespaces: []`；仍保留 `device`/`agent`/`version`/`runtime`/`provenance`/`signature`。
- 正常能力卡也允许 `limits: {}` 或 `permissions.taskNamespaces: []`（表示无额外限制/无任务域授权）；`agents` 目录可以为空（该设备暂无 Agent）。
- 签名覆盖规范化后的卡片内容；实现必须固定 canonical JSON 规则。
- 能力卡只做硬过滤，不做软排序；不做授权。

### 5.2 角色卡（`agent_role_card`）

**生成输入**：本机任务历史、memory runtime 会话摘要、用户反馈。
**生成者**：本机 runtime job；不通过 MCP，不让 Agent 自己写。
**生成方式**：先规则聚合，再可选 LLM 摘要；固定 schema；不落原始对话。

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | 是 | `1` |
| `kind` | 是 | `agent_role_card` |
| `device` / `agent` | 是 | 归属 |
| `version` | 是 | 非负整数，按 `(device, agent, kind)` 单调 |
| `summary` | 是 | 短摘要；不得包含原始对话 |
| `strengths` | 是 | `[{ tag, confidence }]`；confidence `0..1` |
| `preferredIntents` | 是 | 字符串数组；意图标签 |
| `avoid` | 是 | `[{ tag, confidence }]`；软提示，不是禁止 |
| `confidence` | 是 | 总体 `0..1` |
| `evidenceRefs` | 是 | `[{ kind, id }]`；只存任务/摘要 ID 或哈希，不存原文 |
| `shadow` | 是 | 默认 `true`；shadow 期不参与派发 |
| `provenance` | 是 | `source` / `sampleSize` / `generatedAt` / `generator` |

规则：

- `confidence` 由样本量、成功率、时效、一致性计算；默认低置信度阈值 `0.5`（`< 0.5` 视为低置信度）。
- 低置信度/无卡 → 回退能力卡 + 确定性分配；不得用角色卡授权或硬过滤。
- shadow 期只计算、只给内部测试看；派发行为必须与无角色卡一致。
- 只有 shadow 指标有提升，并经 G5 审核，才允许启用软排序；启用后仍只能软排序。
- 不设人工审核 UI/入口；自动更新；内部可见性同 §4.2。
- 不存原始对话、command、env、凭据；`summary`/`strengths` 不得复述原始对话。
- 版本单调；tombstone/删除 agent 时不再参与排序。

### 5.3 状态视图（`agent_status_view`）

**生成者**：派发方实时计算；不落盘、不同步。
**输入**：sync 在线 peer、共享任务视图、本机观察（最近成败/时延）。
**用途**：只做软排序；不做授权、不做硬过滤。

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | 是 | `1` |
| `kind` | 是 | `agent_status_view` |
| `device` / `agent` | 是 | 被观察目标 |
| `online` | 是 | 来自 sync 在线 peer |
| `inflight` | 是 | 当前在途任务数 |
| `capacity` | 是 | 建议容量；`0` 视为不可接单 |
| `recentSuccessRate` | 否 | 本机观察；样本不足时省略 |
| `lastLatencyMs` | 否 | 本机观察；样本不足时省略 |
| `samples` | 否 | `{ recent, window }`；说明样本 |
| `asOf` / `ttlMs` | 是 | 本机墙钟与 TTL；仅用于展示/过期，不作跨端权威 |
| `computedBy` | 是 | 计算方设备 |

规则：

- 不落盘为记忆节点；不进入 SSE；不同步。
- 不使用跨端墙钟做权威判断；`asOf`/`ttlMs` 只影响本机是否使用该快照。
- 过期/样本不足 → 视为中性，不参与排序或降权。
- 状态视图不是能力卡，不得替代能力硬过滤。

### 5.4 卡片可见性与版本

- 能力卡/角色卡：internal 记忆节点，默认隐藏；不进入主 UI/域计数/搜索/图遍历/SSE。
- 状态视图：不存储；只在派发方内存/TTL 内使用。
- 最新版本按 `(device, agent, kind)` 解析；版本单调；tombstone 后不再作为候选。
- 任何卡片都不得包含 command/env/凭据/原始对话；发现即红牌。

---

## 6. Plan 节点

### 6.1 身份与不可变性

- plan 是 internal 记忆节点：`metadata.internal=true`，`internalObject.kind="task_plan"`。
- 逻辑记录 `kind="task_plan"`，`v=1`；`planId` 标识一条计划，`version` 标识版本。
- **唯一提交路径**：Agent A 通过既有 `task_submit` 的 optional `plan` 字段提交完整 plan 定义；Fleet 在 handler 内校验、写 plan 节点并创建 root task。A 不需要、也不能通过 `memory_write` 创建 `task_plan` internal 节点（现有 `memory_write` 类型不变）。
- **不可变**：已写入的 plan 版本不得原地修改；任何改图/重试都创建新版本。
- `planId` 在同一逻辑计划内稳定；`version` 从 `1` 单调递增；`version > 1` 必须有 `supersedesVersion = version - 1`。
- 旧版本永久保留，用于审计、恢复、MR receipt 检查和 reuse 校验。
- plan 节点作者 = `plan.owner`；复用既有记忆作者签名/信任，不新增签名协议。
- plan 节点使用**任务板同一 namespace**（`tasks` 或 `fleet.config.json` 配置的 task namespace）；不新增 `planNamespace` 字段；coordinator 授权检查也基于该 namespace。
- root task 是 plan 的 orchestration anchor：taskId `${planId}#${version}#root`，target 固定为 `{device:"__plan__", agent:"__plan__"}`，`dispatch="root-only"`，由 materializer 管理生命周期；它不是 step，也不计入 plan step 预算/并发。`__plan__` 是保留设备/Agent sentinel，真实 device/agent 不得使用。
- **root plan** 的 root task 与 step task 都是 task-tree root（`trace.chain=[]`）；它们之间不建立 task 父子边，plan 关系只由 taskId 命名与 plan 节点表达。
- **sub-plan** 的 root task 与 step task 必须由父 step task 派生：`trace.causedBy=父 step taskId`，`chain=父 chain + 父 taskId`。这样父 step 的 subtree complete 覆盖整个子 plan；这是 task-tree 派生，不是 plan-to-plan 依赖。

### 6.2 plan 记录 schema

```json
{
  "v": 1,
  "kind": "task_plan",
  "planId": "plan-demo-001",
  "version": 1,
  "reason": "initial plan",
  "owner": { "device": "device-A", "agent": "planner" },
  "goal": "…",
  "createdAt": 1700000000000,
  "budget": { "maxSteps": 8, "maxAttemptsPerStep": 2 },
  "policy": {
    "allowedDevices": ["device-B", "device-C", "device-D"],
    "allowedAgents": ["worker", "reviewer"],
    "requireCapabilities": ["fleet.task"],
    "maxParallel": 3,
    "allowSubcontract": false
  },
  "steps": [
    { "stepId": "collect", "kind": "task", "intent": "收集需求", "dependsOn": [], "acceptance": { "kind": "non-empty-result" } },
    { "stepId": "pre-mr", "kind": "reduce", "intent": "pre-MR gate", "dependsOn": ["collect"], "join": { "mode": "all" }, "acceptance": { "kind": "non-empty-result" } },
    { "stepId": "mr", "kind": "mr", "intent": "提交唯一 MR", "dependsOn": ["pre-mr"], "acceptance": { "kind": "mr-once" } }
  ]
}
```

> `version > 1` 时必须增加 `supersedesVersion: version - 1`，并可增加 `retryOfStepId`；上述 v1 示例不包含这两个字段。

| 字段 | 必填 | 规则 |
|---|---|---|
| `v` | 是 | 固定 `1` |
| `kind` | 是 | `task_plan` |
| `planId` | 是 | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`；不得含 `#` |
| `version` | 是 | 整数 `>=1`；同一 planId 单调 |
| `supersedesVersion` | `version>1` 时是 | 必须等于 `version-1`；`version=1` 时禁止 |
| `retryOfStepId` | 否 | 仅 `version>1`；必须存在于上一版本；不得指向 `mr` |
| `parent` | 否 | 仅子 plan：`{planId, version, stepId}`；父 **plan policy** 必须 `allowSubcontract=true`；父 stepId 只用于 provenance/定位父 task；step schema 不新增 `allowSubcontract`；不是执行依赖 |
| `reason` | 否 | 短审计文本；不得含原始对话/凭据 |
| `owner` | 是 | `{device, agent}` 非空；必须等于提交该 plan 的调用设备/Agent（root=A，sub-plan=执行 step 的 B/C） |
| `goal` | 是 | 非空；描述目标，不写原始对话 |
| `createdAt` | 是 | 有限数字；仅审计，不参与一致性判定 |
| `budget` | 是 | `{maxSteps, maxAttemptsPerStep}` |
| `policy` | 是 | 见 §6.3 |
| `steps` | 是 | 非空数组；`steps.length <= budget.maxSteps <= 256` |

> `parent` 缺省 = **root plan**；root plan 必须恰好一个 `kind=mr` step。带 `parent` = **sub-plan**；sub-plan 禁止 `kind=mr`，其唯一 sink 是最终执行/汇总 step。只有 root plan 能提交 MR。
>
> `task_submit.plan` 直接接收本 schema 的完整记录；`planId` / `version` 由调用方提供，Fleet 校验后原样返回，不做隐式生成。A 提交后由 Fleet 创建 plan 节点与 root task；step task 由内部 materializer 创建，不经过 MCP。

`budget`：

- `maxSteps`：整数 `1..256`，必须 `>= steps.length`；这是**每 plan 上限**，不是父 plan 的“剩余 step 预算”。
- `maxAttemptsPerStep`：整数 `1..5`；step 尝试次数 = **实际为该 step 重新物化 task 的 plan version 数**（含初始版本）；`reuse` 复用旧任务不计数；超过则拒绝新版本。

`policy`：

| 字段 | 必填 | 规则 |
|---|---|---|
| `allowedDevices` | 否 | 字符串数组；去重；必须是授权集合的子集 |
| `allowedAgents` | 否 | 字符串数组；去重 |
| `requireCapabilities` | 否 | 字符串数组；去重；所有候选必须满足 |
| `maxParallel` | 否 | 整数 `1..16`，默认 `8`；有效并发 = `min(plan.policy.maxParallel, 运行时上限)` |
| `allowSubcontract` | 否 | 布尔，默认 `false`；**plan-level 语义**：仅表示是否允许派生 sub-plan；`false` 时子 plan 提交被 `PLAN_POLICY` 拒绝。不得映射为 task `dispatch`，也不阻止普通 task-tree 子任务 |

### 6.3 step schema

| 字段 | 必填 | 规则 |
|---|---|---|
| `stepId` | 是 | `^[a-z][a-z0-9_-]{0,63}$`；同一 plan 唯一；不得含 `#`；不得为保留字 `root`（root task 专用） |
| `kind` | 否 | `task`（默认）/ `join` / `reduce` / `mr` |
| `intent` | 是 | 非空；传给执行者的任务意图 |
| `dependsOn` | 是 | stepId 数组；去重；必须存在；不得自依赖；不得指向 `mr` |
| `to` | 否 | `{device, agent}` 显式 assign；仍须过硬过滤 |
| `route` | 否 | `{require[], prefer[], strategy}`；`strategy` 本期只允许 `"deterministic"` |
| `acceptance` | 是 | 见 §6.4；每个 step 必须有 |
| `join` | 条件 | `kind=join/reduce` 必填；`kind=task/mr` 禁止；`{mode, quorum?}` |
| `reuse` | 否 | `{version}`；仅新版本；复用同 planId 旧版本同 stepId 的已完成结果 |

规则：

- `kind=task`：普通执行任务；`dependsOn` 可以为空。
- `kind=join`：屏障；`dependsOn` 至少 1 个；只在 join 条件满足后创建 task。
- `kind=reduce`：屏障 + 聚合；同 join；用于 pre-MR gate/汇总。
- `kind=mr`：仅 **root plan**；恰好一个；必须是唯一 sink；不得有依赖它的 step；不得有 `join`；task 一律 `dispatch="root-only"`；acceptance 必须是 `mr-once`。sub-plan 禁止 `kind=mr`。
- **MR 是 root plan 最后 step**：除 MR 外每个 step 都必须有路径到达 MR；MR 没有后继；root plan 只有一个 sink = MR。
- **MR 的直接 pre-MR gate 必须是 `kind=join/reduce`**：MR 的 `dependsOn` 必须恰好 1 个 step；该 step 必须是 `join` 或 `reduce`，且 `join.mode="all"` 或 `quorum === dependsOn.length`。`any`、`quorum < dependsOn.length` 对 MR 非法；违规统一 `PLAN_MR`。
- **root plan 的 MR 依赖闭包必须全为 all/满 quorum**：root plan 内所有 join/reduce 都必须在 MR 依赖闭包内（所有非 MR step 都必须能到达 MR），因此 root plan **禁止任何 `any` 或部分 quorum**；`any`/部分 quorum 只允许出现在 sub-plan（sub-plan 无 MR）。
- **sub-plan 的最终 step**：sub-plan 没有 MR；必须有唯一 sink（`task`/`join`/`reduce`），其余 step 都有路径到它；sub-plan done = 该 sink complete。
- `dependsOn` 只允许引用同一 `planId + version` 的 step；跨 plan 依赖禁止。
- `reuse` 只允许引用同一 `planId` 的更早版本；不得形成跨版本环；被引用 step 必须完成且 acceptance 通过。
- 子 plan（执行者派生）必须使用新 `planId`，`owner` = 提交它的执行设备/Agent（如 B/C），可带 `parent:{planId,version,stepId}`；父 **plan policy** 必须 `allowSubcontract=true`；policy 按 §7.5 逐字段收紧；父 step 通过 task 派生树等待，不得在 plan 里引用子 plan step。
- `parent` 只用于 provenance/policy 校验，不是 `dependsOn`；不构成 plan-to-plan 执行依赖。
- 子 plan 的 root/step task 必须由父 step task 派生；子 plan 失败 = 父 step 失败，重试必须走父 plan 新版本/新父 step task，不得在同一父 task 下换子 plan 版本。
- 子 plan 不提交 MR；只有 root plan 的 MR 是本期唯一合并请求。

### 6.4 acceptance schema

```json
{ "kind": "non-empty-result", "minBytes": 1 }
{ "kind": "contains", "all": ["API_OK"], "minBytes": 1 }
{ "kind": "mr-once" }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `kind` | 是 | `non-empty-result` / `contains` / `mr-once` |
| `minBytes` | 否 | 非负整数；默认 `1`；`mr-once` 禁止 |
| `all` | `contains` 时是 | 非空字符串数组；全部命中才通过；`mr-once` 禁止 |

- `mr-once` 只允许用于 `kind=mr`。
- acceptance 只读 `resultRef` 指向的结果/证据，不存原始对话。
- acceptance 失败 = step 失败；不得静默跳过或降级为 done。
- acceptance 必须确定性；不得依赖墙钟或随机数。

### 6.5 DAG 校验（plan 层整体校验）

校验顺序固定；任一失败则 plan 无效，**不创建任何 task**。

| 代码 | 条件 |
|---|---|
| `PLAN_SCHEMA` | `v/kind/planId/owner/goal/createdAt/steps` 等形状非法；`stepId` 使用保留字 `root`；调用者设备不是 `plan.owner.device`；plan 提交的 `to` 不是 `{device:"__plan__", agent:"__plan__"}` |
| `PLAN_VERSION` | `version` 非单调、`supersedesVersion` 不是 `version-1` 或上一版本不存在、`version=1` 却带 supersedes |
| `PLAN_DUP_STEP` | `stepId` 重复或不符合正则 |
| `PLAN_MISSING_DEP` | `dependsOn` 引用不存在的 step、自依赖、重复依赖 |
| `PLAN_CYCLE` | Kahn 拓扑排序后节点数 != steps.length |
| `PLAN_BUDGET` | `steps.length > maxSteps`，`maxSteps`/`maxAttemptsPerStep` 越界；子 plan `maxSteps > parent.maxSteps`；子 plan 任务装不进父 step task 的剩余 `TaskBudget` |
| `PLAN_POLICY` | policy 形状/范围非法；子 plan 逐字段衰减不满足 §7.5；`parent` 无效；父 plan policy `allowSubcontract=false`；`owner` 不是提交者 |
| `PLAN_MR` | root plan：MR 数量 != 1、MR 有后继、存在非 MR sink、有路径到不了 MR、MR 直接依赖不是恰好 1 个 join/reduce、MR 依赖闭包内任意 join/reduce 为 `any` 或 `quorum < dependsOn.length`；sub-plan：出现 MR、或存在非唯一 sink |
| `PLAN_ACCEPTANCE` | acceptance 形状与 kind 不匹配 |
| `PLAN_REUSE` | reuse 版本非法、引用不存在、定义变化、旧结果未完成 |
| `PLAN_CONFLICT` | 同一 `planId + version` 已存在，但规范化内容不同；不创建任何对象 |
| `PLAN_STATE_INVALID` | plan 节点/root task 不一致（如只有孤儿 root task、或 plan 存在但状态损坏） |

- 拓扑排序使用 **Kahn + stepId 字典序** 作为确定性 tie-break。
- ready set 按 stepId 字典序处理；同一 plan version 在任何设备上得到同一顺序。
- `reuse` 校验：旧版本同 `stepId` 的规范化 step（去除 `reuse`）必须与当前一致；旧任务必须 terminal done 且 acceptance 通过；否则 `PLAN_REUSE`。
- 校验通过后 plan 才能进入 materializer；校验失败只记录 plan 无效，不写 task。

### 6.6 确定性 taskId

```text
step taskId    = ${planId}#${version}#${stepId}
root taskId    = ${planId}#${version}#root
```

示例：

```text
plan-demo-001#1#root
plan-demo-001#1#collect
plan-demo-001#1#build-api
plan-demo-001#2#build-ui
```

规则：

- `planId`/`stepId` 不得含 `#`；`stepId` 不得为保留字 `root`；因此 `taskId` 可无歧义解析。
- `version` 用十进制、无前导零；同一 plan version 的 taskId 恒定。
- 任何 step（含 join/reduce/mr）都使用 step 规则；root task 使用 `root` 规则；不允许其它特例 ID。
- `task_submit(plan=...)` 写 root task 的 `created` 时 `eventId = ${rootTaskId}#created`；materializer 写 step task 时 `eventId = ${stepTaskId}#created`。
- 重复提交/重复物化/重复投递由既有 eventId 与 taskId 去重。
- 同一 taskId 不得跨 plan version 复用；重试 = 新 version = 新 root/step taskId。
- taskId 是 plan/step 与 task 的唯一关联；**不修改 `TaskEvent` 线格式**，不加 `planId`/`dependsOn` 字段。

### 6.7 task 层只保留派生树

- plan 不是 task；plan 依赖不是 `TaskEvent` 边。
- **root plan**：`task_submit(plan=...)` 创建 root task（`trace.chain=[]`）；每个 step 物化为独立 task-tree root（`trace.chain=[]`）；root task 与 step task 之间不建立父子边。
- **sub-plan**：root task 与每个 step task 都由父 step task 派生（`trace.causedBy=父 step taskId`，`chain=父 chain + 父 taskId`）；父 step 的 subtree complete 覆盖整个子 plan。
- plan 依赖不写成 `causedBy`；sub-plan 的 `causedBy` 表达 task-tree 派生（分包），不是 plan-to-plan 依赖。
- 执行者派生 subtask 时使用既有 `created` + `trace.causedBy`/`chain`；task 树禁环。
- plan 依赖/版本关系只存在于 plan 节点与 taskId 命名；执行者不需要理解 plan。
- step 完成 = step task 终态 + 该 task 派生子树全部终态 + acceptance 通过。
- root task 只承载 plan 生命周期；`task_children(rootTaskId)` 为空；plan 进度用 `task_status.plan`，不要用 task 子任务列表推导。
- 子树中任一后代 failed/cancelled → step 失败；不得用“主任务 done”掩盖子任务失败。
- plan-owned task（root/step/MR）调用既有 `task_retry` 必须返回 `PLAN_RETRY_REQUIRED`，**不得**创建普通派生任务；plan 重试必须走新 plan version（§3.5/§8.5）。执行者由 step task 派生的 ordinary child 仍可按旧语义 retry。
- 旧 worker 只看到普通 task；旧 peer 只看到任务事件；plan/card 对它们不可见。

### 6.8 materializer 算法（冻结）

materializer 每轮只做以下事：

```text
0. 确保 root task 存在（taskId=`${planId}#${version}#root`）；由 materializer 用既有事件
   queued → claimed → running 推进 root；不经过 MCP，不派发给 worker。
1. 读取最新 plan version（按 planId 取最大 version），校验；无效则停止该 plan。
2. 从 plan + task 事件派生 step 状态；不维护第二套持久状态机。
3. 计算 ready set：dependsOn 全部 complete，且未被物化/未完成/未失败。
4. 按 stepId 字典序处理 ready step，直到有效 maxParallel 用满：
   a. reuse：校验旧版本任务 terminal done + acceptance；通过则标记 done，不建新 task。
   b. join/reduce：join 条件满足才创建 task；不满足则等待或按 §8 失败。
   c. 普通 task：硬过滤/route/policy 通过才创建；NO_TARGET → blocked，不建 task。
   d. 创建 task 前按确定性 taskId 查重；已存在则跳过（幂等）。
5. 通过 Fleet 内部 API 写 step task；eventId=`${stepTaskId}#created`；
   root plan step 用 trace.chain=[]；sub-plan step 用 trace.causedBy=父 step taskId；
   **不根据 allowSubcontract 设置 task dispatch**（普通 task-tree 子任务仍由既有
   TaskBudget/root dispatch/planner 控制）。该路径不经过 MCP `task_submit`。
6. plan 完成/失败/取消时，用既有事件把 root task 推进到 done/failed；root task 不计入
   maxParallel，也不写 plan 状态字段。
7. 不写 plan 状态、不写 step 状态、不改 plan 节点。
```

规则：

- **只推进 ready step**；依赖未完成、join 条件未满足、预算/并发/policy 不允许时不得创建 task。
- materializer 不缓存权威状态；重启后从 plan + task 事件重新计算。
- 重复物化/重复投递不产生重复 task；已存在 taskId 直接复用。
- step task 只通过 Fleet 内部 API 创建，不调用 MCP `task_submit`；MCP 不暴露 step materialization 入口或 plan ref。
- root task 由 `task_submit(plan=...)` 创建；materializer 只补状态事件，不重复创建；若发现 plan 存在但 root task 缺失，按确定性 taskId 补建一次。
- root task 的 `to` 固定为 `{device:"__plan__", agent:"__plan__"}` sentinel；新 worker 显式跳过，旧 worker 因 device 不匹配自然跳过；任何 worker 都不应执行它或写 failed。
- `allowSubcontract` 只控制 sub-plan 创建；不映射 task `dispatch`，不提供 per-step no-child 语义；普通 task-tree 子任务仍由既有 `TaskBudget`/root dispatch/planner 规则控制。
- 创建 task 失败（NO_TARGET）不写“失败”状态；step 为 blocked，下一轮重新评估。
- 预算：`maxSteps` 限制 plan step 数；`maxAttemptsPerStep` 限制重试版本；有效并发 = policy/运行时上限的较小值。
- 不修改 core 语义；不新增事件类型；不新增 MCP 方法。

### 6.9 coordinator 与恢复

- 默认 coordinator = plan owner 设备；但 **正确性不依赖 lease/leader 选举**。
- 授权设备 = 已订阅**任务板 namespace**（plan 节点所在 namespace，即 `tasks`/配置的 task namespace）、且在 owner 的 L1 授权集合内的设备；不新增 plan namespace 字段；`policy.allowedDevices` 只限制 task 目标，不限制 coordinator；未授权设备不得运行 materializer。
- owner 可以在运维上指定另一授权设备接管；接管不新增 plan 字段、MCP 方法或 UI 入口；确定性 taskId + 确定性 eventId + 既有 eventId 去重保证不重复建 task。
- materializer 写入的 task `actor` = 当前 coordinator 的 `{device, agent}`；不伪造 owner。
- root task 生命周期由 materializer 管理：提交时 `created(queued)`；开始推进时用既有 `claimed`/`running`；root plan 在 MR done 后、sub-plan 在唯一 sink complete 后写 `done`；失败/取消写 `failed`（reason 明确）。不新增事件类型。
- root task 的 `to = {device:"__plan__", agent:"__plan__"}` 是保留 orchestration sentinel；worker 不应执行；root task 不计入 plan 并发。
- **新 worker 必须显式跳过保留 target**（在 `targetsMe` 或更早判断 device/agent 是否为 `__plan__`；不得依赖 `executorFor` 返回 null 兜底），不得把 root task 写成 failed 或 `UNKNOWN_AGENT`。旧 worker 因 `to.device !== endpoint.device` 自然不匹配，不需要理解 plan。
- 并发 materializer 允许存在；冲突由既有“同 eventId 不同内容按稳定序列化确定性裁决”兜底；任务最终收敛到一个 created 事件。root task 的确定性 taskId/eventId 保证只创建一次。
- kill coordinator 后：在同一设备或另一授权设备重启 materializer，从 plan + task 事件恢复；不需要 cursor。
- 不引入全局调度器、leader 选举、claim/lease。
- 混合版本 coordinator 不支持；coordinator 必须新版本。

### 6.10 plan 进度（派生）

`plan status` 不落盘，由 plan + step 状态派生：

| 状态 | 条件 |
|---|---|
| `planned` | plan 已创建、root task 已 created/queued；尚无 step task，且未失败/取消 |
| `running` | root task claimed/running，或至少一个 step task 存在，且 plan 未完成 |
| `blocked` | root task running，有 ready step 但 NO_TARGET/等待 join/等待卡片；无永久失败 |
| `done` | root task terminal done；root plan 还要 MR task terminal done + `mr-once` 通过；sub-plan 还要唯一 sink step complete |
| `failed` | 永久失败：依赖失败、acceptance 失败、预算/重试超限、root MR 失败、root task failed；**单 step cancel/failure 默认也归入 failed**（除非新 plan version 重试） |
| `cancelled` | **仅 root plan 被显式 `task_cancel(rootTaskId)`**；单 step cancel 不把 plan 标为 cancelled |

`task_status.plan` 返回该派生进度；plan 节点本身不可变、不写状态字段。

---

## 7. route 与 policy

### 7.1 输入与输出

**输入**：plan step（`to`/`route`）、capability cards、status views、policy、L1 授权集合。
**输出**：

```json
{
  "decision": "assigned",
  "chosen": { "device": "device-B", "agent": "worker" },
  "why": {
    "code": "ASSIGNED",
    "hardFilters": ["authorized", "policy", "capability", "payload", "online"],
    "ranking": [
      {
        "device": "device-B",
        "agent": "worker",
        "score": 0.87,
        "reasons": ["online", "inflight=0/2", "success=0.95", "prefer=api"]
      }
    ],
    "tieBreak": "rendezvous-sha256",
    "roleCard": "shadow-ignored",
    "policy": "inherited"
  },
  "rejected": []
}
```

空候选：

```json
{
  "decision": "NO_TARGET",
  "chosen": null,
  "why": { "code": "NO_TARGET", "hardFilters": [], "ranking": [], "tieBreak": "rendezvous-sha256", "roleCard": "shadow-ignored", "policy": "inherited" },
  "rejected": [
    { "device": "device-C", "agent": "worker", "code": "MISSING_CAPABILITY", "detail": "ui" }
  ]
}
```

### 7.2 硬过滤（顺序固定）

| 顺序 | 过滤 | 规则 |
|---|---|---|
| 1 | 候选集 | 有显式 `to` 时只考虑该目标；否则从授权 peer + 能力卡目录取候选 |
| 2 | L1 授权 | 设备必须已订阅任务域/在白名单/信任链内；未授权直接拒绝 |
| 3 | policy | `allowedDevices` / `allowedAgents` / `requireCapabilities` / `allowSubcontract` |
| 4 | 能力卡 | `route.require` 的标签必须全部在卡片 `capabilities` 中；工具/限制必须兼容 |
| 5 | payload 可达 | 目标必须能读取 `payloadRef` 所在 namespace；`permissions.taskNamespaces` 不含 → 拒绝 |
| 6 | 在线/容量 | 自动路由排除离线；`inflight >= capacity` 排除；显式 `to` 离线/满载 → blocked，不改派 |

- 显式 `to` 也必须过硬过滤；不通过 → `NO_TARGET`（`EXPLICIT_OFFLINE` / `AT_CAPACITY` 等）+ step blocked，**不得**自动改派。
- 无能力/未授权是硬拒绝，不是降权。
- 角色卡永远不参与硬过滤/授权。
- `NO_TARGET` 不创建 task；step 为 blocked；下一轮环境变化后重新评估。

### 7.3 软排序（确定性）

只在硬过滤后的候选间排序，顺序固定：

1. 在线（自动路由已过滤离线；显式目标离线则 blocked）。
2. 负载比 `inflight / capacity` 升序；`capacity=0` 不参与。
3. `recentSuccessRate` 降序；样本不足视为中性 `0.5`。
4. `lastLatencyMs` 升序；无样本则排在同级最后。
5. `route.prefer` 标签命中数降序；未知 prefer 标签忽略，不报错。
6. 角色卡分数降序；**仅启用后**，且 `shadow=false`、`confidence >= 0.5`；shadow 期忽略。
7. rendezvous tie-break。

### 7.4 确定性 tie-break

固定使用 rendezvous SHA-256：

```text
key = ${planId}#${version}#${stepId}
score = SHA-256(key + "\0" + device + "\0" + agent)  // 256-bit unsigned
```

- 分数最高者胜；完全平局按 `(device, agent)` 字典序升序。
- 不使用随机数、墙钟、进程内轮询。
- 同一 plan version + 同一候选集合 + 同一卡片集合，必须得到同一 `chosen`。
- `task_targets` 的 `deterministicTarget` 旧行为不变；plan route 的 tie-break 不改变旧派发。

### 7.5 policy 与子 plan 衰减

policy 只能**单调收紧**，不能放宽：

```text
child.allowedDevices      ⊆ parent.allowedDevices（父缺省 = 全部授权）
child.allowedAgents       ⊆ parent.allowedAgents
child.requireCapabilities ⊇ parent.requireCapabilities（可要求更多，不能减少）
child.maxParallel         ≤ parent.maxParallel
child.allowSubcontract    = parent.allowSubcontract && child.requested
child.budget.maxSteps     ≤ parent.budget.maxSteps（每 plan 上限，不是“剩余 step”）
```

- 子 plan 的 root/step task 仍计入**父 step task 的既有 `TaskBudget`**（`maxTasks`/`maxDepth`/`maxChildren`）；`child.maxSteps` 必须能放进父 step task 的剩余 `maxTasks`。不新增预算字段，复用 core `TaskBudget`/`treeViolations`。
- 父 **plan policy** `allowSubcontract=false` → 子 plan 提交被 `PLAN_POLICY` 拒绝，不创建任何对象；`allowSubcontract=false` 不映射 task `dispatch`，不阻止普通 task-tree 子任务。
- 子 plan 使用新 `planId` + `parent:{planId,version,stepId}`；step schema 不新增 `allowSubcontract`；子 plan 不提交 MR；子 plan 的 root/step task 由父 step task 派生，父 step 通过 task 派生树等待子任务，不在 plan 里引用子 plan step。
- `parent` 只用于 provenance/policy 校验，不是执行依赖；`dependsOn` 跨 plan 一律拒绝；`reuse` 只允许同 planId 旧版本。
- route policy 拒绝返回 `POLICY_DENIED`；子 plan 结构/policy 校验失败返回 `PLAN_POLICY`；均不静默降级。

### 7.6 `why` 与原因码

`why.code`：

| 代码 | 含义 |
|---|---|
| `ASSIGNED` | 选中一个目标 |
| `NO_TARGET` | 无合法候选 |

`rejected[].code`：

| 代码 | 含义 |
|---|---|
| `UNAUTHORIZED` | L1 未授权 |
| `OFFLINE` | 自动路由离线 |
| `EXPLICIT_OFFLINE` | 显式目标离线，保持 blocked |
| `MISSING_CAPABILITY` | 缺少 required 标签/工具/限制 |
| `POLICY_DENIED` | policy 禁止 |
| `PAYLOAD_UNREACHABLE` | 无法读取 payload namespace |
| `AT_CAPACITY` | 目标满载 |
| `NO_CANDIDATES` | 初始候选为空 |

- `why` 只包含标签/计数/原因码，不含 prompt、原始对话、command/env/凭据。
- `why.roleCard` 取值：`shadow-ignored` / `disabled` / `used-soft`。
- `NO_TARGET` 必须可解释；不得只返回空对象。

### 7.7 本期只做 assign

- 任务创建时 `to` 固定；执行者不抢单、不 claim、不 lease、不竞价。
- 不做开放任务池；不做“谁先看到谁执行”。
- 不做动态改派；改派 = 新 task/新 plan 版本。
- 不做全局调度器/leader 选举。

### 7.8 角色卡在 route 中的位置

- P3 阶段角色卡尚未接入；route 只使用能力卡 + 状态视图 + policy。
- P5 shadow 期：角色卡只计算，`why.roleCard="shadow-ignored"`，不改变 `chosen`。
- G5 通过后启用：只作为软排序第 6 项；不能覆盖硬过滤，不能授权，不能改变 tie-break 的确定性。

---

## 8. join、完成与 MR

### 8.1 基本定义

- **task terminal**：`done` 或 `failed`（`task_cancel` 写 failed，reason=CANCELLED）。
- **subtree**：从 step task 沿 `trace.causedBy` 可达的任务集合（父→子，禁环）。
- **subtree complete**：子树内所有任务 terminal；且全部为 `done`。任一 `failed`/cancelled → step 失败。
- **step complete**：step task terminal `done` + subtree complete + acceptance 通过。
- **step failed**：step task failed、子树有失败、或 acceptance 失败；不得原地重试。
- **plan failed**：存在不可恢复的 step 失败、单 step cancel，或永久失败，且没有更新的 plan 版本；MR 永不提前提交。`cancelled` 只用于 root plan 被显式取消。

### 8.2 join 模式

| 模式 | 条件 | 失败条件 | 条件满足后 |
|---|---|---|---|
| `all` | 所有 `dependsOn` step complete | 任一依赖失败 | 创建 join/reduce task |
| `any` | 至少 1 个依赖 complete | 所有依赖都失败 | 创建 join/reduce task；对未完成依赖尽力 cancel |
| `quorum` | 至少 `quorum` 个依赖 complete | `completed + 仍可能成功的 pending < quorum` | 创建 join/reduce task；对未完成依赖尽力 cancel |

- `quorum` 必须是整数 `1..dependsOn.length`；`all`/`any` 禁止 `quorum`。
- **root plan 禁止任何 `any` 或部分 quorum**：MR 依赖闭包内所有 join/reduce 必须是 `all` 或满 quorum；不能只要求直接 gate 是 all/满 quorum，上游 `any` 也不行。`any`/部分 quorum 只允许出现在 sub-plan（sub-plan 无 MR，§8.4）。
- join/reduce task 只在条件满足后创建；不提前创建占位 task。
- 未完成依赖的 cancel 是 best-effort；不改变已满足的 join 条件。
- join/reduce 自身的 task 仍须 terminal done + subtree complete + acceptance 才算 step complete。
- join/reduce 的 `dependsOn` 是 plan 边，不写入 task 事件；执行者不需要理解。

### 8.3 materializer 创建 join/reduce 的条件

- 所有硬条件（依赖、policy、并发、预算）满足。
- join 条件（all/any/quorum）满足。
- 该 step 尚未物化（确定性 taskId 查重）。
- 满足条件才创建；重复检查幂等。

### 8.4 MR 门禁（仅 root plan）

- **只有 root plan**（无 `parent`）恰好一个 `kind=mr` step；MR 是唯一 sink；所有非 MR step 都有路径到 MR。sub-plan 禁止 MR。
- **直接 pre-MR gate 必须是 `kind=join/reduce`**：MR 的 `dependsOn` 必须恰好 1 个 step；该 step 必须是 `join` 或 `reduce`；其 `join.mode` 必须是 `all`，或 `quorum === dependsOn.length`。`any`、`quorum < dependsOn.length` 对 MR 非法，统一 `PLAN_MR`。
- **MR 依赖闭包全为 all/满 quorum**：root plan 内任意 join/reduce 为 `any` 或 `quorum < dependsOn.length` 都非法；不能只校验直接 gate。
- gate 必须 complete，MR 才能创建；gate 的依赖分支必须全部成功（不得用部分成功提前放行）。
- **运行时双保险**：创建 MR task 前，必须再次确认该 root plan version 的**所有非 MR step 均 complete**（task done + subtree complete + acceptance 通过），而不只是唯一 gate complete。
- MR task 一律 `dispatch="root-only"`，不得派生子任务。
- MR task 创建条件：所有非 MR step complete + 无既有 MR task + root plan 未失败/取消。
- **MR 只允许一次**：按 root `planId`（跨版本）唯一。创建新版本 MR 前必须扫描该 root planId 所有旧版本的 MR task：
  - 任一 MR task 存在且非终态 → 等待，不创建新 MR。
  - 任一 MR task terminal done → root plan done，不再创建 MR。
  - 任一 MR task terminal failed → root plan failed，不再重试 MR。
- **root done 在 MR 后**：只有 MR task terminal done + acceptance `mr-once` 通过 + root task terminal done，root plan 才能 `done`；其它 step 完成不等于 root done。
- MR receipt = 该 root planId 的 MR task 终态事件；不新增 receipt 文件/记录。重复投递由 eventId 去重；重复 MR 由 planId 唯一性阻止。
- MR 失败不自动重试；需要人工/新需求 → CR，不能静默再提交。
- sub-plan 的完成只到唯一 sink step；sub-plan 不产生 MR，也不影响 root 的 MR 唯一性。

### 8.5 失败、重试与新 plan 版本

- 失败 step 不原地改图、不改旧 plan 版本。
- 对 plan-owned root/step/MR task 调用 `task_retry` 一律 `PLAN_RETRY_REQUIRED`，不创建任务；普通 task 的 `task_retry` 旧行为不变。
- 重试 = 通过 `task_submit.plan` 提交新 plan version：
  - `version+1`、`supersedesVersion=旧 version`、`retryOfStepId=失败 step`。
  - 重新校验 DAG/policy/budget/acceptance；创建新的 plan 节点 + 新 root task（`${planId}#${newVersion}#root`），旧 root task 保留失败证据。
  - 未受影响的已完成 step 可标 `reuse:{version:旧版本}`；materializer 校验旧任务 terminal done + acceptance 后视为完成，不建新 task。
  - 失败 step 及其下游 join/reduce（root plan 还包括 MR）必须重建（新 taskId）。
  - 若旧 step 结果不满足 acceptance，`reuse` 无效，plan 拒绝；不得静默重跑。
  - `maxAttemptsPerStep` 按“新版本是否重新物化该 step”计数；`reuse` 不计数；超限 → 拒绝新版本。
- 若该 root planId 已存在任一 MR task，禁止创建重试版本；MR 唯一性优先。sub-plan 没有 MR，但仍受 parent 的预算/attempt 限制。
- **sub-plan 失败视为父 step 失败**：重试必须走父 plan 新版本/新父 step task；不得在同一个父 step task 下提交子 plan 重试版本，否则旧失败子树会污染父 step 的 subtree complete。
- 成功分支不得被静默跳过；`reuse` 必须是显式字段，并有旧任务证据。
- 失败分支不得被静默标记 done；必须新版本重跑或 plan failed。

### 8.6 cancel 与永久失败清理

- plan/step 取消仍只使用既有 `task_cancel` 语义；不新增 MCP 方法、输入字段或 plan handle 字段。
- **plan 级取消**通过 `task_cancel(rootTaskId)` 识别（root taskId 是 plan version handle）；step 级取消通过 `task_cancel(stepTaskId)`。root taskId 以 `#root` 结尾，step taskId 以 `#${stepId}` 结尾，不需要额外字段。
- root task 已终态时，`task_cancel(rootTaskId)` 返回 `already-terminal`，不再级联；与普通 task 行为一致。
- `task_cancel(rootTaskId)` 必须：
  1. 按既有语义把 root task 写为 failed（reason=CANCELLED）；
  2. 停止该 plan version 的**新物化**；
  3. best-effort 取消该 version 所有非终态 step task（按 `${planId}#${version}#` 扫描），并对每个 step task 取消其派生子树（含 sub-plan 的 root/step task）；
  4. 不改 plan 节点；plan 派生状态为 `cancelled`。
- **永久失败**（分支失败无重试、acceptance 失败、预算/重试超限、root MR 失败等）同样触发第 2–3 步清理：materializer 不再推进该 version，并 best-effort 取消所有非终态 step task 及其派生树；root task 写 failed 并带明确 reason。
- `task_cancel(stepTaskId)` 仍只取消该 step task 及其派生子树；已终态任务不变；单 step cancel/failure 默认使 plan `failed`（除非新 plan version 重试），**不**把 plan 标为 `cancelled`。`cancelled` 只表示 root plan 被显式取消。
- 取消是 best-effort 且幂等；单个取消失败不得让已进入 failed/cancelled 的 plan 复活；后续 tick 可以重试取消未终态任务。
- 已提交 MR 不撤销：MR receipt 一旦 terminal done，取消不撤销 MR，不再提交新 MR；MR 唯一性仍成立。若 MR 尚未提交，取消后不得再创建 MR。
- sub-plan 取消只影响该 sub-plan version；父 step 因 subtree 中出现 failed/cancelled 而失败，按 §8.5 走父 plan 新版本重试。

### 8.7 重复投递/重复物化

- 同一事件按 `eventId` 去重；同一 taskId 的 `created` 只应有一个事件。
- 重复 `task_submit.plan`：同 planId+version+规范化内容返回已有 plan/root；内容不同 `PLAN_CONFLICT`；不重复写 plan/root task。
- 重复 materializer tick：按 taskId 查重，不重复创建。
- 重复 join/reduce/MR 创建：按 taskId 查重；MR 再按 planId 唯一性检查。
- 任意顺序/重复投递后，plan 进度与 task 状态必须收敛；不得重复执行、不得重复 MR。

### 8.8 禁止跨 plan 依赖

- plan `dependsOn` 只能引用同 `planId + version`。
- `reuse` 只能引用同 `planId` 更早版本。
- 子 plan 是新 `planId`，可带 `parent` 做 provenance/policy 校验；子 plan 不提交 MR；子 plan 的 root/step task 必须由父 step task 派生（`causedBy`），父 step 通过 task 派生树等待，不得引用子 plan step。
- `parent` 不是执行依赖；任何 plan-to-plan 的 `dependsOn` = 红牌，停止并开 CR。

---

## 9. 验收矩阵

A1–A10 来自上位计划 §7；A11–A13 是 P0 对既有边界（隐私、policy 衰减、plan 控制负例）的验收细化，不扩大产品范围。

| ID | 场景 | 期望（必须可断言） | 证据 | Gate |
|---|---|---|---|---|
| A1 | 三机 E2E：A 通过 `task_submit.plan` 提交完整 plan，B/C/D 并行，J 验收，MR 提交 | 返回 `planId`/`version`/`rootTaskId`；plan 节点 + root task 创建成功；MR 直接 gate 是 `all` 或满 quorum join/reduce；MR 只提交一次；root task 在 MR 后 done；task 树无环；每任务恰好执行一次 | E2E 脚本日志 + plan/root/step task 导出 + MR receipt | G4/G6 |
| A2 | kill coordinator / executor 后重启；plan cancel | 从 plan + root task 恢复；不丢任务；不重复执行；taskId 不变；`task_cancel(rootTaskId)` 停止新物化并 best-effort 取消该 version 全部非终态 step task 及其 sub-plan 派生树；已提交 MR 不撤销；root 已终态时 `already-terminal` 且不级联 | kill/restart 日志 + task 列表计数 + cancel 级联清单 + already-terminal 断言 + eventId 去重记录 | G2/G4/G6 |
| A3 | 一个分支失败后重试/永久失败 | MR 不提前提交；失败分支不静默跳过；新 plan 版本重跑失败分支；成功分支 reuse 有证据；join 重建；MR 一次；root plan 所有 join/reduce 仍为 all/满 quorum；MR 前所有非 MR step complete；永久失败时停止新物化并清理非终态 step task | 两版 plan + task 事件 + join/MR 时间线 + all-non-MR-complete 断言 + cleanup 清单 | G4 |
| A4 | 重复投递同一事件/重复 materializer tick/重复 plan 提交 | 同 planId+version+规范化内容重复提交返回已有 plan/root task；内容不同 → `PLAN_CONFLICT`；不重复建 plan/root task/task/join/MR；状态收敛 | 幂等测试/冲突负例/故障注入日志 | G2/G4/G6 |
| A5 | plan 含环/缺依赖/重复 step/非法 MR gate | plan 层拒绝；不创建 plan 节点、root task 或任何 step task；task 层无环；`PLAN_CONFLICT` 不产生部分对象 | validator 负例输出 + plan/root/task 计数为 0 | G2 |
| A6 | 目标无能力/未授权/显式 to 越权 | 不会被选中；返回 `NO_TARGET`/`why`；不创建 task；显式 to 也不得改派 | route 决策日志 + 负例断言 | G3 |
| A7 | 角色卡 shadow / 低置信度 | shadow 不改变 `chosen`；低置信度回退能力卡+确定性；无原始对话 | shadow 对比报告 + 行为 diff + 隐私断言 | G5 |
| A8 | 主 UI 检查 | 导航/页面/设置不变；plan/card 不出现在列表/计数/搜索；无新 SSE；星图只收真实 task `created` | 截图/DOM 断言 + SSE 捕获 | G1/G6 |
| A9 | MCP 检查 | 16 个方法名称/必填字段不变；无 `plan_*`/`agent_card_*`；旧 `task_submit` 显式 `to` 正常；`task_submit.plan` 完整 plan 提交可用 | tool-surface 快照 + 旧调用回归 + plan 提交回归 | G1/G6 |
| A10 | 旧 worker/peer/config + root sentinel | 旧 worker 执行普通 task；旧 worker 看到 root task（`to.device="__plan__"`）不执行、不写 failed/UNKNOWN_AGENT、不影响 plan 状态；旧 peer 忽略 plan/card；旧 config 有效；coordinator 必须新版本 | 兼容性报告 + 旧端进程日志 + root task 状态不变断言 | G1/G2/G4/G6 |
| A11 | 隐私与敏感信息 | capability/role card、plan、日志、SSE 不含原始对话/command/env/凭据；role 只存摘要/标签/evidenceRefs | 静态 grep + 运行时导出 + 隐私测试 | G5/G6 |
| A12 | policy 衰减/子 plan/预算/owner/确定性 | allowedDevices/Agents ⊆ 父；requireCapabilities ⊇ 父；maxParallel ≤ 父；allowSubcontract 仅父=true 时可 true；child.maxSteps ≤ parent.maxSteps；child root/step task 装入父 step task 的 TaskBudget；owner=提交者（sub-plan B/C）；`allowSubcontract=false` 拒绝子 plan；普通 task-tree 子任务不受该字段影响；跨 plan 依赖拒绝；同输入 tie-break 恒定 | 负例测试 + 预算/treeViolations 断言 + 两次路由结果一致 | G3/G4 |
| A13 | plan-owned `task_retry` 负例 | root/step/MR task 调 `task_retry` → `PLAN_RETRY_REQUIRED`，不创建新任务、不写 created、不污染 subtree；普通 task retry 旧行为不变 | 负例断言 + task 计数不变 + 普通 task 回归 | G2/G4 |

验收判定：

- 每行必须有可复现命令/脚本与断言；截图不能单独作为唯一证据。
- 任一红牌出现 → 该 Gate fail，不进入下一阶段。
- A1–A13 全绿才算 P6 总验收完成；P7 全量独立审核不只看最后一个阶段。

---

## 10. per-session review protocol

### 10.1 角色

| 角色 | 职责 | 禁止 |
|---|---|---|
| Implementer（执行会话） | 只做一个阶段；写代码/文档/测试；提交 handoff | 进入下一阶段、自审、扩 scope |
| Reviewer（审核会话） | 只读检查 acceptance/边界/证据；输出 pass/fail | 写代码、改 plan、替 Implementer 修复 |
| Chief | 守边界、派发、Gate 签字、CR、更新 plan、最终收口 | 跳过 Gate；自己写阶段代码后自审 |

### 10.2 每次执行会话结束

1. **冻结**：停止编辑；提交/保存 patch；记录 commit/分支；之后不再改文件。
2. **自检**：跑该 step 的 targeted tests；更新 plan（Chief 持有，执行会话不直接改）与 evidence。
3. **Handoff pack**：按 §12 模板写清改了什么、跑了什么、结果、风险、下一步、相关文件；不含密钥/原始对话。
4. **独立审核**：Reviewer 只读检查 acceptance、边界、diff、证据；Implementer 不能自审。
5. **结论**：只有 `pass` / `fail`。fail = step 未完成；下一次会话先修，不进入下一步。
6. **记录**：findings 进 plan/decision log；不允许静默修复。

### 10.3 证据格式

每条证据使用稳定 ID：

```text
E-<gate>-<n>
  command: <可复现命令>
  exit: <0/非0>
  artifact: <日志/报告路径或内容哈希>
  assertion: <对应验收行/断言>
  capturedAt: <时间；仅证据时间，不作一致性判定>
```

- 证据必须可复现；命令 + exit code + 关键输出/哈希。
- UI 证据需要截图或 DOM 断言，并注明视口/主题。
- 故障注入证据需要 kill/restart/partition 的原始日志与恢复后计数。
- 证据中不得出现密钥、token、command/env 值、原始对话；需要时脱敏。
- 不得用“跑过了”“应该没问题”替代命令与输出。

### 10.4 Reviewer 检查清单

- [ ] diff 只含本阶段 in-scope 文件；未触碰 out-of-scope。
- [ ] acceptance 每一条都有证据；编号可追溯。
- [ ] MCP 方法数/名称/必填字段/旧调用未变；无 `plan_*`/`agent_card_*`。
- [ ] 人类 UI 无新增入口；plan/card internal；无 SSE 泄漏。
- [ ] 隐私：无原始对话/command/env/凭据。
- [ ] 兼容：旧 worker/peer/config；coordinator 新版本。
- [ ] 无红牌（§14）。
- [ ] 文档/runbook/changelog 与代码同步（适用阶段）。
- [ ] 证据可复现，无静默跳过。

### 10.5 结论规则

- Reviewer 只输出 `pass` 或 `fail`；findings 分 `blocker` / `non-blocking`。
- 任一 blocker 未关闭 → `fail`；step 未完成。
- `non-blocking` 可以记录为后续 step/CR，但不能是验收项缺失。
- Reviewer 不写代码；需要修复时退回 Implementer 的新会话/同一阶段会话。
- fail 后不得进入下一阶段；修复后重跑受影响 Gate。

---

## 11. CR 与版本规则

### 11.1 没有下一版

- CR 决策只有两种：**纳入本期** / **明确拒绝**。
- 不允许“延后到下一版”“P8 再做”“后续优化”。
- 纳入本期 = 更新本文档/夹具/验收矩阵 + Chief 更新 plan + 重跑受影响 Gate。
- 拒绝 = 记录理由；不得偷偷实现。

### 11.2 版本轴

| 对象 | 版本 | 规则 |
|---|---|---|
| 本契约 | `v1.0` | P0 冻结；修改走 CR + 新 minor；不改变 scope |
| plan 记录 | `v=1` | 记录 schema 版本；不兼容变更走 CR |
| plan 版本 | `version` | 同一 planId 单调；不可变；旧版本保留 |
| 能力卡 | `v=1`，`version` | 按 `(device, agent, kind)` 单调；签名；tombstone |
| 角色卡 | `v=1`，`version` | 按 `(device, agent, kind)` 单调；shadow |
| 状态视图 | `v=1` | 临时对象；不落盘；无持久版本 |
| TaskEvent / fleet 线格式 | `FLEET_PROTOCOL_VERSION=1` | 不变；不改字段/类型 |
| MCP task surface | 16 | 冻结；只允许 §3.3 的 optional 扩展 |

### 11.3 CR 模板

```markdown
### CR-<id> <短标题>

- 提出者 / 日期：
- 需求或问题：
- 影响阶段（P0–P7）：
- 影响文件/契约/夹具：
- 是否触碰红牌（§14）：是/否；哪一条：
- 方案 A / 方案 B：
- 兼容性：MCP / UI / TaskEvent / 旧 worker/peer/config：
- 测试与证据计划：
- 受影响 Gate：
- 决策：纳入本期 / 拒绝
- Chief 签字：
- Reviewer 签字：
```

### 11.4 CR 审批

- Chief + 独立 Reviewer 双方批准；Implementer 不能批准自己的 CR。
- 若 CR 改变契约：更新本文档、fixtures、验收矩阵；必要时更新 plan 版本；重跑受影响 Gate。
- 若 CR 触碰红牌（新 MCP 方法/新 UI/原始对话/开放抢单/跨 plan 依赖/重复 MR）：默认拒绝；只有 Chief 明确重开 scope 才能继续，且必须重跑 G0。
- 执行会话不得自行修改 OpenChamber plan；plan 由 Chief 持有。

### 11.5 additive 兼容规则

- 只加 optional 字段；不删/不改旧字段；不新增必填字段。
- 旧调用方不传新字段时行为不变。
- 新字段必须有默认值/缺省行为；不得因未知字段拒绝旧调用。
- 破坏性变更 = 拒绝（没有下一版）。

---

## 12. session handoff 模板

每个执行会话结束按此模板交付；Reviewer 按此检查。

```markdown
## Session handoff

- Session / Stage: P<n> <name>
- Branch / Commit: <branch>@<sha>
- Files changed:
  - <path>
- What changed:
  - <1–3 条；只写本阶段>
- Out of scope touched: none / <必须为空；有则停止>
- Tests run:
  - `<command>` → exit <code>; <关键输出/断言>
- Evidence IDs:
  - E-<gate>-<n>: <artifact/哈希>
- Gate self-check:
  - [ ] acceptance 行：<IDs>
  - [ ] MCP 16 方法不变
  - [ ] UI 零新增入口
  - [ ] plan/card internal，无 SSE 泄漏
  - [ ] 无原始对话/command/env/凭据
  - [ ] 旧 worker/peer/config 兼容（适用时）
  - [ ] 无红牌
- Red cards: none / <若有，停止并开 CR>
- Risks / open questions:
  - <仅非阻塞；阻塞项不得进入下一阶段>
- Next allowed step: P<n+1> only after Reviewer pass; this session stops.
- Reviewer checklist:
  - [ ] diff vs scope
  - [ ] acceptance evidence
  - [ ] red cards
```

约束：

- 不含密钥、token、command/env 值、原始对话。
- 不写“顺便修了”的 out-of-scope 改动；有则停止报告。
- 本会话结束即停；不得自动进入下一阶段。

---

## 13. P1–P7 Gate checklist

### G0（P0，本文档）

- [ ] 已读上位 plan；只做 P0，不进入 P1。
- [ ] 五条纲领、术语、in/out scope、“没有下一版”写清。
- [ ] MCP 16 方法冻结；只批准 §3.3 optional 扩展；无 `plan_*`/`agent_card_*`。
- [ ] plan 创建路径冻结：`task_submit.plan` = 完整 plan 定义；Fleet 校验后写 plan 节点 + root task；旧 `task_submit` 不变；不用 `memory_write` 建 plan。
- [ ] plan 提交幂等：同 planId+version+规范化内容返回已有；内容不同 `PLAN_CONFLICT`；不重复 plan/root task。
- [ ] 人类 UI 零新增入口；plan/card internal；不进 SSE；记忆列表/域计数隐藏。
- [ ] 三张卡生成方式/来源/存储/可见性冻结。
- [ ] plan schema/validator/不可变/版本/确定性 taskId（root + step）/materializer 冻结。
- [ ] root task target 固定 `{device:"__plan__", agent:"__plan__"}`；新 worker 显式跳过；旧 worker 因 device 不匹配不执行、不写 failed。
- [ ] plan 级 cancel 通过 rootTaskId 识别并级联清理；`task_retry` 对 plan-owned task 返回 `PLAN_RETRY_REQUIRED`；旧普通 task 行为不变。
- [ ] route/policy/why/NO_TARGET/assign-only 冻结。
- [ ] join/MR/subtree complete/acceptance/重试规则冻结；root plan 所有 join/reduce all/满 quorum；MR 前所有非 MR step complete。
- [ ] 子 plan policy 逐字段衰减、预算/owner 规则冻结；`allowSubcontract` 仅 plan-level，不映射 task dispatch。
- [ ] A1–A13 验收矩阵、per-session review、CR/版本、handoff 模板齐全。
- [ ] 只新增本文档 + 两个 protocol fixture；未改 `src/`、`tests/`、`packages/console/`、`packages/mcp/`。
- [ ] fixtures 是合法 JSON 且为规范来源。
- [ ] Chief + 独立 Reviewer 签字；有歧义则停止，不进入 P1。

### G1（P1 能力卡与目录）

- [ ] `agents[].capabilities` 只是 optional；旧 config 仍有效；真实 device/agent 不得配置为保留 sentinel `__plan__`。
- [ ] 能力卡从 config + ExecutorRegistry + 运行环境编译；字段符合 §5.1。
- [ ] 版本单调、设备签名、tombstone；最新版本按 `(device, agent)` 解析；tombstone 允许空 `limits`/`taskNamespaces`/`capabilities`/`tools`，不回退旧版本。
- [ ] 三机互见能力卡；旧 `task_submit` 显式 `to` 完全不变。
- [ ] 旧 worker 回归：root task `to.device="__plan__"` 不被旧 worker 执行、不写 failed/UNKNOWN_AGENT、不影响 plan 状态。
- [ ] internal 可见性：记忆列表/域计数/搜索隐藏。
- [ ] 卡片不含 command/env/密钥/原始对话。
- [ ] 无新 MCP 方法；无新人类 UI 入口。
- 证据：三机同步日志、卡片样例、UI 断言、隐私 grep、旧 worker root-task 回归。
- Reviewer 重点：MCP surface、internal 泄漏、敏感字段、旧 worker root sentinel。

### G2（P2 plan + materializer）

- [ ] `task_plan` internal、不可变、版本化；schema 符合 §6.2/§6.3。
- [ ] `task_submit.plan` 接受完整 plan；Fleet 校验后写 plan 节点 + root task，返回 `planId`/`version`/`rootTaskId`；旧 `task_submit` 完全不变。
- [ ] 同 planId+version+规范化内容重复提交返回已有；内容不同 `PLAN_CONFLICT`；不重复 plan/root task。
- [ ] validator 覆盖无环、唯一 step、依赖存在、预算/policy、root MR sink（sub-plan 唯一 sink）、MR 直接 gate all/满 quorum；错误码符合 §6.5。
- [ ] root taskId `${planId}#${version}#root`；step taskId `${planId}#${version}#${stepId}`；`eventId=${taskId}#created`；stepId 不得为 `root`。
- [ ] root task target 固定 `{device:"__plan__", agent:"__plan__"}`；新 worker 显式跳过；旧 worker 看到 root task 不执行、不写 failed、不影响 plan 状态。
- [ ] `task_retry` 对 plan-owned root/step/MR 返回 `PLAN_RETRY_REQUIRED`，不创建任务；普通 task retry 不变。
- [ ] materializer 只推进 ready step；step task 走 Fleet 内部 API，不走 MCP；append 幂等；重复物化不重复建 task。
- [ ] `maxAttemptsPerStep` 按“新版本是否重新物化该 step”计数；`reuse` 不计数。
- [ ] root task 由提交创建、由 materializer 管理状态；kill/restart 不重复创建。
- [ ] coordinator kill/restart 后从 plan + root task 恢复；不丢任务、不重复执行。
- [ ] `task_status` 返回 plan 进度；MCP 方法数仍 16；旧 worker 能执行普通 task。
- [ ] plan/card 不进 UI/SSE；任务树无环。
- 证据：双机顺序 plan E2E、plan 提交幂等/冲突、kill/restart、重复物化、validator 负例、root sentinel 回归、task_retry 负例。
- Reviewer 重点：plan 提交路径、root task 幂等、确定性 taskId、MR gate、root sentinel、task_retry 错误、MCP 不变。

### G3（P3 route + policy）

- [ ] route 解析 `require`/`prefer`/`strategy`；硬过滤顺序符合 §7.2。
- [ ] 状态排序与 rendezvous tie-break 确定；同输入同结果。
- [ ] `why`/`NO_TARGET` 可解释；无能力/未授权不会被选中；显式 `to` 不改派。
- [ ] policy 逐字段衰减符合 §7.5（devices/agents subset、caps superset、maxParallel、allowSubcontract AND、child.maxSteps ≤ parent.maxSteps）；owner=提交者；子 plan root/step 任务装入父 step task TaskBudget；`allowSubcontract=false` 拒绝子 plan；跨 plan 依赖拒绝。
- [ ] 本期 assign-only；无 claim/lease/抢单。
- [ ] 角色卡未接入（P5 前）；MCP 方法数 16；UI 零新增。
- 证据：三机分配、越权负例、两次路由一致性、why 日志。
- Reviewer 重点：硬过滤不可绕过、policy 收紧、确定性、assign-only。

### G4（P4 join + MR）

- [ ] `all`/`any`/`quorum` 行为符合 §8.2；只在条件满足后创建 join/reduce。
- [ ] subtree complete/acceptance 正确；后代失败不被掩盖。
- [ ] MR 是 root plan 唯一最后 step；直接 pre-MR gate 是 join/reduce 且 `all` 或满 quorum；root plan 的 MR 依赖闭包内所有 join/reduce 都是 all/满 quorum；gate 必须先完成；root task 在 MR 后 done；sub-plan 不提交 MR。
- [ ] `any` 或 `quorum < dependsOn.length` 出现在 root plan 任意位置（含上游）都被 `PLAN_MR` 拒绝；部分分支成功不会提前 MR。
- [ ] 创建 MR 前运行时再次断言该 root plan version 所有非 MR step complete（done + subtree + acceptance），不只依赖 gate。
- [ ] MR 按 root planId 只提交一次；重复投递/重复版本不重复 MR。
- [ ] 分支失败不提前 MR；重试新 plan 版本；reuse 有证据；join 重建；retry 后 gate 仍为 all/满 quorum。
- [ ] `task_cancel(rootTaskId)` 是 plan 级取消：停止新物化，best-effort 取消该 version 全部非终态 step task 及 sub-plan 派生树；永久失败同样清理；已提交 MR 不撤销。
- [ ] `task_cancel(stepTaskId)` 只取消该 step 及其派生子树；普通 task_cancel 旧语义不变。
- [ ] `task_retry` 对 plan-owned root/step/MR 返回 `PLAN_RETRY_REQUIRED`，不创建派生任务；普通 task retry 不变。
- [ ] 子 plan owner=提交者；policy 逐字段衰减；child.maxSteps ≤ parent.maxSteps；child 任务装入父 step TaskBudget；`allowSubcontract=false` 拒绝子 plan；普通 task-tree 子任务不受影响。
- [ ] kill/restart 可恢复；plan 环拒绝；task 层无环；cancel 支持子树与 plan 级级联。
- [ ] 无跨 plan 依赖；MCP 方法数 16；UI 零新增。
- 证据：三机并行→J→pre-MR→MR、分支失败/重试、kill/restart、plan cancel 级联、task_retry 负例、重复投递、环负例。
- Reviewer 重点：MR 唯一、root 时序、失败不静默、取消级联、恢复。

### G5（P5 角色卡 shadow）

- [ ] `agent_role_card` schema 符合 §5.2；本机 runtime job 生成；规则优先，LLM 可选。
- [ ] confidence/evidenceRefs 正确；低置信度/无卡回退能力卡+确定性。
- [ ] shadow 期派发行为与无卡一致；`why.roleCard="shadow-ignored"`。
- [ ] 无原始对话/command/env/凭据；internal 隐藏。
- [ ] 只有 shadow 指标提升并经审核才启用；启用后仍只软排序。
- [ ] 无新 MCP 方法；无新 UI 入口。
- 证据：shadow 报告、行为 diff、低置信度负例、隐私测试。
- Reviewer 重点：shadow 不改变行为、隐私、永不授权。

### G6（P6 三机 E2E、回归与硬化）

- [ ] A1–A13 全绿。
- [ ] 故障注入：kill coordinator/executor、partition、重复投递、分支失败/重试、stale card、低置信度、plan 环。
- [ ] UI 回归：导航/页面/设置不变；plan/card 隐藏；SSE 无泄漏；星图只收真实 task `created`。
- [ ] MCP 回归：16 方法名称/必填字段不变；无 `plan_*`/`agent_card_*`；旧 `task_submit` 显式 `to` 正常。
- [ ] 兼容：旧 worker 执行普通 task；旧 peer 忽略 plan/card；旧 config 有效；coordinator 新版本。
- [ ] 观测/文档：plan/step 状态、`why`、`blockedBy`、runbook、changelog。
- [ ] 无环/死锁/重复 MR/原始对话落盘。
- 证据：E2E 脚本、故障注入报告、UI/MCP 回归报告、兼容性报告、runbook。
- Reviewer 重点：总矩阵、故障恢复、零 UI/MCP 新增、旧端兼容。

### G7（P7 独立审核与最终 MR）

- [ ] evidence pack 汇总完整；A1–A13 可追溯。
- [ ] 独立 Reviewer 全量审核：范围、正确性、兼容、UI、MCP、安全隐私、可靠性、文档。
- [ ] findings 变成 plan step；修复后重跑受影响 Gate。
- [ ] 最终 MR：diff、commits、DCO、changelog、release notes。
- [ ] 人类 UI 零新增入口；MCP 零新增方法；无 critical open。
- [ ] Chief 签字；MR 批准/合并。
- 证据：review report、final MR、CI/DCO 结果。
- Reviewer 重点：不只看最后阶段；全量范围与证据。

---

## 14. 红牌与停止条件

任一出现：**停止、开 CR、不得继续**；不得自行“临时修一下”。

| # | 红牌 |
|---|---|
| 1 | 新增 MCP 方法、删除/改名现有 16 个方法、新增必填字段、新增 `plan_*`/`agent_card_*` |
| 2 | 新增人类 UI 入口：导航/页面/设置/Advanced/Fleet/任务面板 |
| 3 | plan/card 出现在主 UI、记忆列表、域计数、搜索、星图、fleet SSE |
| 4 | 原始对话落盘；角色卡/日志/证据含原始对话、command、env、凭据 |
| 5 | 开放抢单/claim/lease/竞价 |
| 6 | 跨 plan 依赖、执行中原地改图、任意动态图 |
| 7 | 跳过测试/证据、静默修复、Gate 未过进入下一阶段 |
| 8 | 重复 MR、无法恢复的 coordinator 停摆 |
| 9 | 修改 core 语义或 `TaskEvent` 线格式 |
| 10 | 混合版本 coordinator |

发现红牌时：

1. 停止当前工作，不提交“半成品修复”。
2. 写 CR（§11.3），说明红牌编号、影响、替代方案。
3. Chief + Reviewer 决定；未批准前不继续。
4. 若 CR 纳入本期，更新契约/夹具/矩阵并重跑受影响 Gate。

---

## 15. 追溯矩阵

| 要求 | 章节 | Gate | 验收 |
|---|---|---|---|
| 人类 UI 零新增入口 | §4 | G1/G6 | A8 |
| MCP 16 方法冻结 | §3 | G1/G6 | A9 |
| 三张卡生成/可见性 | §5 | G1/G5 | A7/A11 |
| plan 创建路径/幂等/PLAN_CONFLICT | §3.3 / §6.1 / §6.5 | G0/G2 | A1/A4/A9 |
| root target sentinel/旧 worker 回归 | §3.3 / §3.4 / §6.1 / §6.9 | G0/G1/G2/G4/G6 | A10 |
| MR 依赖闭包 all/满 quorum + 全非 MR complete | §6.3 / §6.5 / §8.2 / §8.4 | G4 | A3 |
| 子 plan policy/预算/owner/allowSubcontract | §6.2 / §6.3 / §6.5 / §7.5 | G3/G4 | A12 |
| plan 级 cancel 级联 | §3.5 / §8.6 | G4 | A2/A3 |
| plan-owned task_retry 拒绝 | §3.5 / §6.7 / §8.5 | G2/G4 | A13 |
| plan 不可变/版本/DAG/materializer | §6 | G2 | A2/A4/A5 |
| route/policy/why/NO_TARGET/assign-only | §7 | G3 | A6/A12 |
| join/subtree/acceptance/MR | §8 | G4 | A1/A3/A4 |
| 三机 E2E/故障/回归/兼容 | §9 | G6 | A1–A13 |
| per-session review | §10 | 全部 | handoff/证据 |
| CR/版本/没有下一版 | §11 | 全部 | CR 记录 |
| 红牌/停止条件 | §14 | 全部 | 无红牌 |

---

## 16. 协议夹具

- [`packages/fleet/protocol/plan.example.json`](../../packages/fleet/protocol/plan.example.json)
  - `internalWrapper`：writer 负责包装的最小 `metadata.internal=true` + `internalObject.kind="task_plan"` 示例。
  - `submission`：`task_submit` 携带完整 plan 的提交形状（`intent` / `to` / `plan`）与期望返回 `planId`/`version`/`rootTaskId`；`to` 固定 sentinel `{device:"__plan__", agent:"__plan__"}`。
  - `idempotency.repeatSame` / `idempotency.conflict`：具体 payload 与 expect；同内容返回已有，内容不同 `PLAN_CONFLICT`。
  - `controls.retryRoot` / `retryStep` / `retryMr`：三种 plan-owned task 的 `PLAN_RETRY_REQUIRED` 负例。
  - `controls.cancelPlan` / `cancelTerminalRoot`：plan 级取消与已终态 `already-terminal` 不级联。
  - `plan`：root plan v1；三机并行 + join + pre-MR reduce（`all`）+ MR。
  - `retry`：同一 root `planId` 的 v2；`build-ui` 重跑，`collect`/`build-api` reuse，join/MR 重建。
  - `subPlan.parent` / `subPlan.child`：父 plan owner=A；子 plan owner=B；`parent`、policy 收紧、无 MR、唯一 sink；`subPlan.submission` 为 caller=B 的完整 `task_submit.plan` 外层；`parentStepTaskBudget` 说明父 step 的 runtime TaskBudget 足够。
  - `joinModes`：`all` / `any` / `quorum` 的 `join` 形状；`any`/部分 quorum 只允许 sub-plan，root plan 禁止。
  - `invalid.cycle`：`PLAN_CYCLE` 负例。
  - `invalid.missingDependency`：`PLAN_MISSING_DEP` 负例。
  - `invalid.mrGateAny`：MR 直接 gate 为 `any` → `PLAN_MR` 负例。
  - `invalid.mrGateUpstreamAny`：上游 join 为 `any`、直接 gate 为 `all` → `PLAN_MR` 负例。
  - `invalid.subPlanDenied`：父 plan policy `allowSubcontract=false` → `PLAN_POLICY` 负例。
- [`packages/fleet/protocol/card.example.json`](../../packages/fleet/protocol/card.example.json)
  - `internalWrapper`：capability/role 的最小 internal metadata 包装示例。
  - `capability`：能力卡（签名、版本、provenance、无敏感字段）。
  - `role`：角色卡（shadow、confidence、evidenceRefs、无原始对话）。
  - `status`：状态视图（实时、TTL、不落盘）。
  - `capabilityTombstone`：agent 移除后的 tombstone 示例；允许空 `capabilities`/`tools`/`limits`/`taskNamespaces`。

夹具是规范来源：P1–P5 的实现/测试必须先匹配夹具，再扩展 optional 字段；不得让实现先行导致形状漂移。P0 不新增 fixture 测试（P1/P2 负责）。

---

## 17. 不改变契约的实现选择

以下由 P1–P6 在实现内决定，但不得改变本契约的可见行为；若改变则走 CR：

- plan/card 在 core 中使用的具体 node `type`（如 `meta`/`fact`）与序列化位置；只要求 `metadata.internal=true` + `internalObject.kind`。
- 角色卡规则聚合的具体权重/阈值实现（默认低置信度 0.5 不变）。
- 状态视图的本地刷新间隔/TTL 具体值（`ttlMs` 由实现给定）。
- materializer 传给 task 的 `TaskBudget` 具体值；只要求不越过 plan policy、子 plan 任务装入父 step task 剩余 `TaskBudget`，且不根据 `allowSubcontract` 改写 task `dispatch`。
- 证据报告存放位置与格式细节；只要求可复现、可追溯、不含敏感信息。
- UI 回归使用的截图工具/视口；只要求覆盖既有导航/页面/设置。

---

**冻结结论**：本文件 + 两个 fixture 是 P1–P7 的边界与契约来源。任何执行会话不得自行扩 scope；没有下一版；有歧义先停 G0/CR。
