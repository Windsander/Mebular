# 策略推导不变量矩阵（`derivePolicyState` 改动的准入条件）

> 本文件随 `src/sync/grantPolicy.ts` 一起受版本控制。**任何对 `derivePolicyState`
> 行为的改动，必须先在下面的矩阵里补/改一格并配一个测试**，否则不予合入。
> 之所以放在 `src/sync/`（而非 `docs/`）：仓库的 `docs/`、`docs.design/` 被
> `.gitignore` 忽略，放在那里无法随仓库分发、也就无法作为准入条件。

规则代号：**R-a** 不可越权授予；**R-b** 吊销连坐；**R-c** 逻辑时间定序；
**R-d** grantId 精确撤销 / 恢复用新 grantId。实现为**有界不动点**（见文件头注释）。

## 1. 记录类型 × 签发者状态 × 对象状态

「对象状态」对 `namespace_revoke` 指其**目标 grantId**；对 `grant` 指自身 grantId；
对 `device_revoke` 指被吊销的目标设备。

| 记录 | 签发者状态 | 对象状态 | 期望 | 覆盖测试 |
|---|---|---|---|---|
| `namespace_grant` | 引导白名单 | grantId 未撤销 | 采纳（授权生效） | `签发者的 grant 被采纳；多个 grant 取并集` · `R-a 引导白名单…` |
| `namespace_grant` | 引导白名单 | grantId 已撤销 | **不采纳**（R-d） | `F-3：恢复必须使用新的 grantId…` |
| `namespace_grant` | 当时已被授权（含转授） | grantId 未撤销 | 采纳 | `R-a 授权转授…` |
| `namespace_grant` | 未被授权 | 任意 | **不采纳**（R-a） | `洞1…未授权设备自授提权` · `R-a 越权转授…` |
| `namespace_grant` | 已被吊销 | 任意 | **不采纳**（R-b，含历史） | `洞2…被吊销签发者的记录不再被采纳` |
| `namespace_revoke` | 引导白名单 / 已被授权 | grantId 在效 | 采纳（目标 grant 失效） | `撤销按 grantId 精确失效` · `F-B 正例…` |
| `namespace_revoke` | 未被授权但未被吊销 | grantId 在效 | 采纳（**有意**：撤销不要求被授权，避免 revoke↔authorized 振荡） | `未被授权但未被吊销的 namespace_revoke 仍被采纳（有意语义）` |
| `namespace_revoke` | 已被吊销 | grantId 在效 | **不采纳**（R-b）（F-B 回归锚点） | `F-B：被吊销签发者发出的 namespace_revoke 不得生效` |
| `device_revoke` | 引导白名单 / 已被授权 / 未被授权但未被吊销 | 目标未吊销 | 采纳（目标进入 `revoked`） | `设备吊销：读侧 []…` · `未被授权但未被吊销的 device_revoke 仍被采纳（有意语义）` |
| `device_revoke` | 已被吊销 | 任意 | **不采纳**（R-b） | `R-b 吊销连坐…` |
| `device_revoke`（恢复） | 任意有效 | 目标已吊销 → 之后有效 `grant` | 目标移出 `revoked`（R-d 恢复） | `设备吊销…之后新 grant 即恢复` · `F-A 正例…` |
| `namespace_grant`（恢复） | 任意有效 | 目标已吊销，grantId 全新 | 恢复 | `F-A 正例：全新 grantId…` |
| `namespace_grant`（伪恢复） | 任意有效 | 目标已吊销，但复用**已被撤销**的 grantId | **不恢复**（F-A） | `F-A：被 namespace_revoke 撤销过的 grantId 不能用来清除吊销状态` |

## 2. 横切不变量

1. **排列不变性**：打乱同一批记录的输入顺序，`authorized`/`revoked` 完全一致。
   覆盖：`F-B 确定性…`、随机化 harness `排列不变性`。
2. **幂等 / 不振荡**：同一输入重复推导结果相同。覆盖：`F-B 确定性…（重复读稳定）`、harness `幂等`。
3. **权威链**：被采纳的 grant 的签发者必为引导白名单成员，或**当时**已获授权其声明的全部分区；
   且签发者未被吊销、grantId 未被有效撤销。覆盖：harness `权威可达闭包`（独立重放检查）。
4. **有界 + fail-closed**：不动点迭代有上限；未收敛时回退到**综合 fail-closed** 结果
   （`revokedGrantIds=∅` 且 `revokedIn=各轮吊销并集`）——不采纳任何 revoke、排除全部曾判吊销的
   签发者，**绝不放宽 R-b**（宁可少授权）；`PolicyState.converged=false` 可观测。
   覆盖：`F-C：上限内未收敛时 fail-closed 回退…` · `F-C 回退综合 fail-closed…` · `F-C 诊断…`。
5. **R-c 定序**：跨签发者按逻辑时间 `sum(vectorClock)`，不看墙钟。覆盖：`R-c 时钟偏移…`。
6. **保留语义不受影响**：缺 namespace = `default`、本机订阅空 = 全部、持有者只供自己订阅分区——
   这些在 `namespacePolicy`/`SyncManager` 层，策略层只产出授权/吊销，不触碰。覆盖：既有 namespace
   与 selective-sync 套件。

## 3. 覆盖它的 harness

`tests/sync/policy-invariants.test.ts`：固定种子的随机化 harness（≥200 组），对每组断言
排列不变性、幂等、以及一条**独立参考重放**（`referenceReplay`）：

- 只按**规格**实现、只读「输入记录 + 输出 `revoked`」，按 `compareEntries` 同规格的确定序
  **单遍**重放：grant 依 R-a/R-b/R-d 采纳、device_revoke 按**在途吊销**归属、被采纳 grant 清除
  主体吊销；断言其 `authorized`/`revoked` == 输出的 `authorized`/`revoked`。
  一致即同时满足：无越权采纳、无吊销者记录被采纳、无被撤销 grantId 被采纳、无授权遗漏。
- 该参考实现对**授权判定是顺序敏感**的（"当时已授权"必须按时点，不能用不动点闭包近似）——
  这正是 harness 第一版用「可达闭包」会误报的原因，已修正为顺序敏感的参考重放。
- 不收敛时 `PolicyState.converged=false`（实现无内部变量泄露即可观测）。
