# Fleet 协议不变量矩阵（`@mebular/fleet` 改动的准入条件）

> 本文件随 `packages/fleet/src/**` 一起受版本控制。**任何对任务 envelope / 事件 / 状态机 /
> 配额行为的改动，必须先在下面的矩阵里补/改一格并配一个测试**，否则不予合入。
> 与记忆层的 [`src/sync/POLICY-INVARIANTS.md`](../../src/sync/POLICY-INVARIANTS.md) 同级；
> 记忆层的协议语义见仓库根 [`SEALING.md`](../../SEALING.md)（fleet **不改**其语义）。

红线（不可越界）：不在 core 引入任务语义；fleet 只消费 `@mebular/core` 公共 API；墙钟不进一致性判定；
禁中心化（配额 = 每设备对自己发出的量本地记账）。

## 1. 性质矩阵（性质 → 测试）

| # | 性质 | 期望 | 覆盖测试 |
|---|---|---|---|
| ① | **至少一次 + 幂等应用** | 同一 事件按 `eventId` 去重；重复投递**不改变状态、不重复执行**；同 id **不同内容**（违约/对抗输入）按稳定序列化确定性裁决 | `reducer 对重复事件幂等（去重）` · `重复投递不改变状态、不重复执行` · `同 eventId 冲突但内容不同：确定性地按稳定序列化裁决（§2.1 兜底）` · harness `applier 终态不一致` / `重复投递被再次应用` |
| ② | **因果链可追（trace/chain）** | `causedBy` 指向存在的父任务且被并入 `chain`（去重、排序） | `causedBy 与 chain 保留且去重排序` · harness `因果可追` |
| ③ | **本地配额**：每设备对自己发出的量本地记账；超额本地拒绝/排队；**无全局协调** | 设备间互不影响；超额按策略 `queue`/`reject`；账本守恒 | `按设备独立记账，超额按策略排队` · `reject 策略：超额直接拒绝` · `账本守恒：accepted + queued + rejected == 请求总量` · `release / drainQueue 只在本地搬迁` · `snapshot 按 device 字典序` · `非法输入被拒绝` |
| ④ | **`expiresAt` 只影响本机展示** | 权威状态与 `at`/`expiresAt`/`now` **无关** | `权威状态与 at / expiresAt / now 无关` · harness `墙钟无关` |
| ⑤ | **非法迁移/输入必须拒绝** | 迁移表拒绝非法与跳级；事件校验拒绝类型/状态不一致与缺失字段 | `迁移表拒绝非法与跳级` · `事件校验拒绝类型/状态不一致与缺失字段` |

## 2. 横切不变量

1. **顺序无关收敛**：事件数组任意排列（去重后）得到同一权威状态。`reduceTaskEvents` 顺序无关；
   `IdempotentTaskApplier` 随机顺序应用终态一致。**同一 `eventId` 对应不同内容**（违约/对抗输入）时，
   去重按稳定序列化（对象键递归排序）取字典序较大者**确定性裁决**——「去重后的集合」本身也与输入
   顺序无关；`eventId` 仍应满足内容寻址或全局唯一契约，本裁决仅为兜底，不改变正常路径。
   `MebularTaskEventStore` 复用同一 `dedupeEvents`，store 与 reducer 语义不漂移。
   覆盖：`任意排列得到同一权威状态` · `同 eventId 冲突但内容不同：确定性地按稳定序列化裁决（§2.1 兜底）` ·
   harness `顺序无关失败`/`applier 终态不一致`。
2. **终态裁决确定性**：并发 `done` vs `failed`（同秩）由 `TERMINAL_PRECEDENCE` 裁决（`failed` 优先），
   与到达顺序无关。覆盖：`并发 done vs failed：终态平局裁决` · 夹具 `state-machine.json` 一致性测试。
3. **未知任务**：无 `created` 事件 → `null`（不臆造状态）。覆盖：`缺少 created → null`。
4. **夹具先行一致**：线格式以 `packages/fleet/protocol/*.json` 为准；TS 常量/迁移表必须与夹具一致。
   覆盖：`tests/fleet/protocol-fixtures.test.ts` · `fixture envelope 事件流可被 reducer 消费`。
5. **oracle-free 扰动**：删掉某终态任务的全部事件，其它任务状态不变（任务相互独立）。
   覆盖：harness `删除终态任务 … 改变了其它任务`（逐条失败即抛错）。

## 3. 覆盖它的 harness（`tests/fleet/protocol-invariants.test.ts`）

固定种子（`mulberry32(0xfeef)`）、可复现，`scenarios=300`。每组随机生成 1–4 个任务、随机
`claims`/终态/`expiresAt`/`trace`/`at`，叠加随机洗牌与重复，断言上表性质；并做一条 oracle-free
扰动（删终态任务 → 其它不变）。运行日志形如：

```
[fleet-invariants] scenarios=300 tasks=<n> anomalies=0
```

`anomalies` 必须为 0（断言），任何性质破坏都会以 `fail(...)` 抛出并计数。

## 4. M4：Agent 路由与适配器（目标一）

| 单元 | 期望 | 覆盖测试 |
|---|---|---|
| Agent 路由 | 按 `to.agent` **精确**选择执行器；`'*'` 仅匹配 `to.agent === '*'` | `ExecutorRegistry：按 agent 名字路由` · `通配 "*" 只在 to.agent 为 "*" 时命中` · verify `agent=echo/fake` |
| 未知 agent | **显式失败**（`failed`，`reason = UNKNOWN_AGENT: <name>`），**不静默回退**到 echo | `FleetWorker：注册表 + 未知 agent 显式失败` · verify `agent=nope` |
| 适配器超时 | `failed`，`reason = TIMEOUT after <ms>ms`；进程被 kill | `超时：failed 带 TIMEOUT 原因` · verify `agent=slow` |
| 适配器非零退出 | `failed`，`reason = EXIT_<code>: <stderr 尾巴>` | `非零退出：failed 带 exit code 与 stderr 尾巴` · verify `agent=fail` |
| stdout 截断 | 按**字节**截断并附 `…[truncated N bytes]`；成功结果 = 截断后 stdout | `输出超限：按字节截断并附标记` · `成功：结果为 stdout（截断）` · verify `agent=big` |
| 参数数组传参 | prompt 作为**单个参数**、无 shell 求值（防注入） | `参数数组传参：prompt 作为单个参数、无 shell 解释（防注入）` |
| 并发上限 | 可配；同一执行器实例内 FIFO 串行 | `并发上限可配：concurrency=1 串行、=2 并行` |
| Hermes argv | `[-p P][-t T][-m M][--in DIR] -z <prompt> --usage-file <tmp>`；成功解析 `usage.session_id` | `拼出 hermes 参数（-p/-t/-m/--in/-z/--usage-file）` · `成功解析 usage.session_id` |
| 参数传参 | `spawn(command, args)` 传参，无 shell（防注入） | `参数数组传参…`（断言无 shell 求值） |
| **env 不外流** | 子进程只继承 `ENV_ALLOWLIST`（PATH/HOME/… + `HERMES_HOME`）+ 显式 `options.env`；**不继承 daemon 全量 env**（凭据不外流）；不打印/不落盘 env 值 | `env 白名单：不继承 daemon 的任意环境变量（判别锚点）` |

| OpenChamber（中立 client） | `HttpOpenChamberSeam`：POST `endpoint` + token（内联/文件+`tokenJsonPath`）+ 可配 `authHeader` + timeout；成功→`{text,sessionId}`；错误/超时→清晰错误；**错误不夹带 token** | `成功：返回 text/sessionId…` · `token 从文件读取…` · `可配 authHeader` · `负例：错误/未授权/超时/非 JSON…` · `负例：缺 endpoint / 缺 token` · `OpenChamberAgent 归一…` |
| OpenChamber（provider #1） | 桥 daemon `POST /agent/run-once`（可替换：替换只改 provider 侧，不改 fleet 代码；契约见 `OPENCHAMBER-SEAM.md`） | verify `--with-openchamber`（E2E + 直连 session + 负例） |

真实验收：`npm run verify:fleet:agents`（真实 libp2p loopback + 确定性 fake agent，9/9）。
真实 Hermes 为**可选开关**：`node scripts/verify-fleet-agents.mjs --with-hermes`（**命令行参数**，非环境变量）；
意图为确定性哨兵指令（只输出 `FLEET_HERMES_OK`），断言：E2E `done` 且结果包含哨兵，另**直连** `HermesAgent` 断言解析出 `session_id`；原始 `ms`/`session` 随脚本输出（11/11）。
真实 OpenChamber 同模式：`node scripts/verify-fleet-agents.mjs --with-openchamber`（provider 接线在脚本侧；E2E `done` 含 `FLEET_OC_OK` + 直连 session + 负例；无桥环境缺省关、CI 用 fake provider）。

## 5. M4：三种协作形态（目标二）

| 形态 | 单元 | 期望 | 覆盖测试 |
|---|---|---|---|
| 审查 DAG | 父子边 | 由 `trace.causedBy` 推导，确定序 | `由 trace.causedBy 推导边（确定序）` · harness `DAG 边顺序无关失败` |
| 审查 DAG | **禁环** | `detectCycle` 检出；新增成环边由守卫**拒绝** | `禁环：检测 + 创建守卫（负例）` · harness `构造的森林不应有环` |
| 审查 DAG | 完成判定 | 从 root 可达的**全部**节点终态才 `complete` | `完成判定：全部可达节点终态才算完成` · harness `reachable 与独立可达性不一致` |
| 审查 DAG | 扰动 | 删叶子子树不改变**不含该叶子**的 root 判定 | harness `删叶子 … 改变了 root` |
| 审查 DAG | **E2E（两节点）** | root→子任务→汇总：**全部可达节点终态**才 `complete`；结果正确；每任务恰好执行一次；非终态子任务 → 未完成 | `F-1 审查 DAG E2E（两节点）` |
| 有限协商 | 幂等 / 顺序无关 | 按 `messageId` 去重；结果与到达顺序无关 | `幂等 + 顺序无关 + 超限失败` · harness `协商顺序无关/幂等失败` |
| 有限协商 | **步数上限** | `rounds > maxRounds` → `fail`，`reason = NEGOTIATION_LIMIT: r>N`；`accept`→proceed、`reject`→fail | `幂等 + 顺序无关 + 超限失败` · `accept → proceed；reject → fail` |
| 有限协商 | 校验 | 非法 `kind`/`round`/`from` 拒绝 | `校验与非法输入（负例）` |
| 配额制闲聊 | 本地配额 | 发送对 `from.device` 本地记账；超额按策略 queue/reject | `发送走本地配额、超额排队…` · `reject 策略 + 校验负例` · harness `闲聊账本不守恒` |
| 配额制闲聊 | 幂等 / 顺序无关 | 收件按 `messageId` 去重；`inbox()` 确定序 | `发送走本地配额…` · harness `闲聊收件顺序无关/幂等失败` |

harness：`tests/fleet/collab-invariants.test.ts`（固定种子，`scenarios=200`），含独立可达性交叉检查与删叶子/删重复的 oracle-free 扰动。协议线格式**未变**（协商/闲聊为独立消息类型，不进 `TaskEvent`）。

## 6. 准入与回归纪律

- 改动 `packages/fleet/src/**` 或 `packages/fleet/protocol/**`：先更新本矩阵对应格 + 加/改测试；
  并跑 harness（上）与 `tests/fleet/*` 全绿。
- **红→绿证据**：每条修复/新增性质须给出「临时破坏该性质 → 对应测试变红 → 还原 → 变绿」的原始输出。
- **红→绿必须重建 dist（A2）**：`verify:*` 类脚本跑的是 **`packages/fleet/dist` 产物**，所以对
  `packages/fleet/src/**`（或 core `src/**`）打补丁后，**必须先 `npm run build` 再跑**，否则红是假的
  （脚本仍在用旧 dist）。jest 直编 TS（`tests/**`）不受此影响，可直接跑。
- **不得**触碰 core 语义或 `SEALING.md` 协议语义；触及 → 停下报告。

## 7. 1d：三种协作形态接 live 通道（任务协议/worker 接线；线格式**未变**）

> 协商/闲聊消息是**独立节点类型**（`negotiation_message` / `chatter_message`），落在既有已授权
> `tasks` 分区、**不进 `TaskEvent`**；DAG 子任务用既有 `created` 事件（`trace.causedBy`/`chain`）。
> 夹具：[`protocol/collab.example.json`](./protocol/collab.example.json)（先落夹具，再由实现/测试匹配）。

| 形态 | 单元 | 期望 | 覆盖测试 |
|---|---|---|---|
| 审查 DAG | 派生 | worker 执行成功后可**按计划派生**子任务（`created` + `causedBy`/`chain`） | `1d-a DAG：root → 2 子任务 → 汇总…` · `DAG 计划夹具…` |
| 审查 DAG | 禁环 | 真实提交路径 `assertAcyclicParent` 生效；成环 → 父任务 `failed`（`DAG_CYCLE: p→c`），不静默 | `1d-a …禁环负例` |
| 审查 DAG | 完成判定 | `dagCompletion`：从 root **全部可达节点终态**才完成；`summarizeDag` 汇总 | `1d-a …DAG 完成` · `1d-a 汇总含 3 条结果` |
| 审查 DAG | 恰好一次 | 每任务恰好执行一次（`ExecutionLog`） | `1d-a 每任务恰好一次` |
| 有限协商 | 消息 | `negotiation_message` 校验 + `messageId` 幂等 + 顺序无关（`NegotiationTracker`） | `1d-b … messageId 幂等` · `协商消息夹具…` |
| 有限协商 | 轮次 | **轮替**（对端发言后才回）→ `counter`→`accept`→完成；无接受且超 `maxRounds` → `failed (NEGOTIATION_LIMIT: r>N)` | `1d-b 协商…完成` · `1d-b 超限…` |
| 配额制闲聊 | 配额 | 发送对 `from.device` 走 `LocalQuota`；`accepted/queued/rejected` 两策略确定；账本守恒 | `1d-c …reject/queue 两策略…账本守恒` · `闲聊消息夹具…` |
| 配额制闲聊 | 幂等 | 收件按 `messageId` 去重 | `1d-c …收件幂等` |
| 通用 | live E2E | 三种形态在**真实 libp2p loopback** 双端上确定性通过（fake executor） | `verify:fleet:collab`（12/12） |

## 8. WAN 准备（L2/L4/L5）：网络行为（**不改 core 语义/线格式**）

> relay 是**纯传输**：按 `SEALING.md §1.6`（传输/集成不构成权威）——relay 只转发密文字节，
> 不参与授权/一致性判定，可自托管、可替换。加固只加**边界**（连接数/帧大小/白名单），不改协议语义。

| 域 | 性质 | 期望 | 覆盖 |
|---|---|---|---|
| L2 | relay-only 连通 | 只交换 `/p2p-circuit` 地址即可连通并收敛 | `verify:wan:l2` ①（本机）+ `verify:wan:l2:docker` ①（隔离网络） |
| L2 | 授权负例 | 未授权分区经 relay 亦不可见（默认拒绝） | `verify:wan:l2` ② · docker ② |
| L2 | relay 重启恢复 | 同端口重启 relay 后重预留、恢复同步 | `verify:wan:l2` ③ |
| L2 | 地址变更恢复 | 对端换监听端口后经新 circuit 地址恢复 | `verify:wan:l2` ④ |
| L4 | 确定性故障注入 | 拨号丢包/延迟下有界收敛，丢包可观测（不静默） | `tests/sync/wan-hardening.test.ts`（L4） |
| L4 | relay 不可达降级 | 手动 multiaddr 直连可用（`direct-degraded`） | `verify:wan:l2` ⑤ |
| L5 | 加固 | 连接数上限 / 帧大小上限 / 对端白名单；不改线格式 | `tests/p2p/ConnectionManager.test.ts` · `Libp2pProvider.test.ts` · `wan-hardening` 白名单 |
| L5 | doctor 公网监听告警 | `0.0.0.0`/公网监听 → `WARN` + 修复建议（不静默，不致命） | `tests/fleet/grant.test.ts` 监听地址 |
