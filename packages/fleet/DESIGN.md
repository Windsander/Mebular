# @mebular/fleet 设计（跨设备多 Agent 协作 · 任务=记忆）

> 本文件是 fleet 的设计与边界说明；**协议语义**以仓库根 [`SEALING.md`](../../SEALING.md) 为准，
> 策略推导不变量以 [`src/sync/POLICY-INVARIANTS.md`](../../src/sync/POLICY-INVARIANTS.md) 为准。
> fleet **不改 core 语义**，只消费 `@mebular/core` 的公共 API。

## 0. 一句话

把「任务」当作一类**记忆**：发起端把任务写进共享分区（如 `tasks`），目标设备上的 Agent 拾取、执行、写回状态；跨设备靠**已有的记忆同步**（写入即推 + anti-entropy + 变更订阅）传递，**无中心协调**。

## 1. 红线（不可越界）

1. **不在 core 引入任务/调度/agent 语义**；fleet 只 `import { ... } from '@mebular/core'`，**不得**深路径 `src/**`。反向依赖由 `tests/fleet/boundary.test.ts` 强制。
2. **墙钟不进一致性判定**：`expiresAt` 只是**本机任务板**的软约定（展示/排队提示），跨端权威生命周期**只由显式状态事件**驱动。
3. **禁中心化**：无注册服务、无全局账本；配额 = **每设备对自己发出的量本地记账**（本地拒绝/排队）。
4. **不改 `SEALING.md` 的协议语义**（R-a..R-d / 水位 / 一致性口径 / 线格式）。若要动 → 停下报告。

## 2. 任务 = 记忆

- **分区**：任务记录落在共享 `namespace`（默认 `tasks`），复用 core 的图上记忆与选择性同步（默认拒绝 + 显式授权）。
- **显式状态机**：`queued → claimed → running → done | failed`；状态迁移是**显式事件**，确定性、可收敛（状态**单调秩** + 终态平局裁决；见 `protocol/state-machine.json`）。
- **`expiresAt` 软约定**：仅影响本机展示与本地排队；**不触发**跨端状态迁移，也不参与权威判定。
- **因果链**：`trace.causedBy` / `trace.chain` 记录派生关系（如子任务由父任务触发）。

## 3. 三种协作形态（M4 目标；本 goal 只到 M3）

- **审查 DAG**：任务派生为有向无环图（计划 → 分派 → 审查 → 汇总）；`trace.chain` 表达父子，避免环。
- **有限协商**：任务可回写「需要澄清/反提案」，但**步数有上限**（有限协商），超限转 `failed` 并附原因。
- **配额制闲聊**：Agent 间低频信息交换，受**每设备本地配额**约束（超额本地拒绝/排队），不对全网协调。

## 4. 配额（本地记账）

- 每个设备维护 `egress(x)` 计数（对**自己发出**的任务/消息计数），超额本地拒绝或排队。
- **无全局账本**、无跨端对账；不同设备的配额互不影响（可接受的不一致，换取去中心化）。

## 5. 路线（M0→M4）

- **M0（本阶段）**：骨架 + 边界测试 + CI 接线 + 设计/协议夹具先行。
- **M1**：协议与模型（envelope / 状态机 / 配额语义）+ `PROTOCOL-INVARIANTS.md` 矩阵 + 随机化 harness（含 oracle-free 扰动检查）。
- **M2**：单机双进程最小可用（A 派活 → B 执行 → 结果回传）+ `scripts/verify-fleet-local.mjs`。
- **M3**：真跨设备（真实 libp2p 传输，loopback 先验证）+ 授权负例 + 时延统计 + 双机 runbook。
- **M4（不在本 goal 内）**：三种协作形态扩展 + 适配器（Hermes / OpenChamber 真实执行器）。

## 6. 夹具先行（fixture-first）

语言无关的 JSON 夹具放在 `packages/fleet/protocol/`：**先固定线格式与状态迁移表**，再由 TS 实现与测试去匹配，
避免「实现先行」导致线格式漂移。M0 起：`envelope.example.json`、`state-machine.json` 及其**往返/一致性测试**。

## 7. 边界与已知取舍（M0 起）

- fleet 产线格式（envelope）版本由 `FLEET_PROTOCOL_VERSION` 钉住；**改动 = 破坏性**，需全端同版本。
- 状态收敛只依赖显式事件与单调秩；终态不可逆（`done`/`failed` 不再迁移），重试以**新任务/新事件**表达。
- 时延、配额、协作形态的实测数据在 M2/M3 报告；本阶段不宣称性能。
