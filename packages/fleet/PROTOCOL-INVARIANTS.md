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
| 不安全面 | 不打印/不落盘 env 值；`CommandAgent` 以 `spawn(command, args)` 传参（无 shell） | `参数数组传参…`（断言无 shell 求值） |

真实验收：`npm run verify:fleet:agents`（真实 libp2p loopback + 确定性 fake agent，9/9）；真实 Hermes 一次性调用见阶段报告（`hermes -z` 返回约定 token）。

## 5. 准入与回归纪律

- 改动 `packages/fleet/src/**` 或 `packages/fleet/protocol/**`：先更新本矩阵对应格 + 加/改测试；
  并跑 harness（上）与 `tests/fleet/*` 全绿。
- **红→绿证据**：每条修复/新增性质须给出「临时破坏该性质 → 对应测试变红 → 还原 → 变绿」的原始输出。
- **不得**触碰 core 语义或 `SEALING.md` 协议语义；触及 → 停下报告。
