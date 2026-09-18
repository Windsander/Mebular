# 策略推导不变量矩阵（`derivePolicyState` 改动的准入条件）

> 本文件随 `src/sync/grantPolicy.ts` 一起受版本控制。**任何对 `derivePolicyState`
> 行为的改动，必须先在下面的矩阵里补/改一格并配一个测试**，否则不予合入。
> 之所以放在 `src/sync/`（而非 `docs/`）：仓库的 `docs/`、`docs.design/` 被
> `.gitignore` 忽略，放在那里无法随仓库分发、也就无法作为准入条件。

规则代号：**R-a** 不可越权授予；**R-b** 吊销连坐；**R-c** 逻辑时间定序；
**R-d** grantId 精确撤销 / 恢复用新 grantId。实现为**有界不动点**（见文件头注释）。

**C1（引导签发者上图化，破坏性协议变更）**：新增记录类型 `policy_issuer_declare`，把「谁是
引导签发者」从**本地配置**改为**图上签名声明**。**生效引导集合 = 图上被采纳声明 ∪ 本地配置
`policyIssuers`**（配置降级为 bootstrap/兼容回退）。采纳**不做 R-a 检查**（无条件），因此与不动点
**无循环依赖**；但受 **R-b** 约束：**签发者**或**被声明主体**被 `device_revoke` 吊销时，该声明
**不采纳**。R-a 改为用生效引导集合，其余 R-b/R-c/R-d、不动点与 fail-closed 回退不变。

**M1–M3（订阅 = 成员资格，破坏性协议变更）**：新增记录类型 `namespace_membership`（`__policy__`，
`{ member, namespace, active, issuedAt }`），把「订阅」从**瞬时 hello 声明**升格为**持久、签名的
成员资格**。采纳**不做 R-a**（无条件，故与不动点无循环依赖），受 **R-b**（签发者/成员被吊销 →
不采纳）。每个 `(namespace, member)` 取 **R-c 定序下最新记录**的 `active`（在册/注销），确定、
顺序无关、幂等。**生效成员 = 被采纳的 active 成员 ∧ 该设备对该分区的生效授权**（授权默认拒绝
不变；成员记录**不得**放宽授权）。裁剪链（M3）：`对端授权 ∩ 对端成员资格 ∩ 本机订阅声明`；
hello 订阅声明降级为**活跃性/一致性校验**，与实际成员资格不一致时**显式拒绝/告警**。
**兼容规则（legacy-empty）**：某分区**没有任何被采纳成员记录**时视为「未启用成员资格」，沿用
既有 hello 订阅裁剪（不放松授权默认拒绝）；一旦出现该分区的成员记录，成员资格即成为该分区
**强制闸门**（非成员收不到）。旧节点（不含 M1）不识别 `namespace_membership`，只会看到
「对端未启用成员资格」→ **行为不变/少收**（安全方向，不 fail-open）；全端升级后启用严格成员资格。

## 1. 记录类型 × 签发者状态 × 对象状态

「对象状态」对 `namespace_revoke` 指其**目标 grantId**；对 `grant` 指自身 grantId；
对 `device_revoke` 指被吊销的目标设备；对 `policy_issuer_declare` 指被声明主体。

| 记录 | 签发者状态 | 对象状态 | 期望 | 覆盖测试 |
|---|---|---|---|---|
| `namespace_grant` | 引导白名单 | grantId 未撤销 | 采纳（授权生效） | `签发者的 grant 被采纳；多个 grant 取并集` · `R-a 引导白名单…` |
| `namespace_grant` | 引导白名单 | grantId 已撤销 | **不采纳**（R-d） | `F-3：恢复必须使用新的 grantId…` |
| `namespace_grant` | 当时已被授权（含转授） | grantId 未撤销 | 采纳 | `R-a 授权转授…` |
| `namespace_grant` | 未被授权 | 任意 | **不采纳**（R-a） | `洞1…未授权设备自授提权` · `R-a 越权转授…` |
| `namespace_grant` | 已被吊销 | 任意 | **不采纳**（R-b，含**历史**：即使早于其被吊销） | `洞2…被吊销签发者的记录不再被采纳` · harness `扰动 a` |
| `namespace_revoke` | 引导白名单 / 已被授权 | grantId 在效 | 采纳（目标 grant 失效） | `撤销按 grantId 精确失效` · `F-B 正例…` |
| `namespace_revoke` | 未被授权但未被吊销 | grantId 在效 | 采纳（**有意**：撤销不要求被授权，避免 revoke↔authorized 振荡） | `未被授权但未被吊销的 namespace_revoke 仍被采纳（有意语义）` |
| `namespace_revoke` | 已被吊销 | grantId 在效 | **不采纳**（R-b，含**历史**）（F-B / F-1 回归锚点） | `F-B：被吊销签发者发出的 namespace_revoke 不得生效` · harness `扰动 b` |
| `device_revoke` | 引导白名单 / 已被授权 / 未被授权但未被吊销 | 目标未吊销 | 采纳（目标进入 `revoked`） | `设备吊销：读侧 []…` · `未被授权但未被吊销的 device_revoke 仍被采纳（有意语义）` |
| `device_revoke` | 已被吊销 | 任意 | **不采纳**（R-b，含**历史**：即使早于其被吊销） | `R-b 吊销连坐…` · `R-b 历史连坐（F-1）…` · harness `扰动 a` |
| `device_revoke` | `subject === author`（自吊销） | 任意 | **不采纳**（语义未定义；吊销须由**其他**设备发起） | `device_revoke 自吊销不采纳…` |
| `device_revoke`（恢复） | 任意有效 | 目标已吊销 → 之后有效 `grant` | 目标移出 `revoked`（R-d 恢复） | `设备吊销…之后新 grant 即恢复` · `F-A 正例…` |
| `namespace_grant`（恢复） | 任意有效 | 目标已吊销，grantId 全新 | 恢复 | `F-A 正例：全新 grantId…` |
| `namespace_grant`（伪恢复） | 任意有效 | 目标已吊销，但复用**已被撤销**的 grantId | **不恢复**（F-A） | `F-A：被 namespace_revoke 撤销过的 grantId 不能用来清除吊销状态` |
| `policy_issuer_declare` | 可信（链到主密钥）、未被吊销 | 被声明主体未被吊销 | **采纳**（进入生效引导集合；不做 R-a） | `C1 仅图声明（无本地配置）→ 自动采纳并接活` · `C1 声明与配置并集` · harness `声明采纳` |
| `policy_issuer_declare` | 已被吊销（R-b 含历史） | 任意 | **不采纳** | `C1 被吊销签发者的声明不生效` · harness `扰动 c` |
| `policy_issuer_declare` | 可信 / 任意 | 被声明主体已被 `device_revoke` 吊销 | **不采纳**（R-b 优先级：吊销设备不得成为引导签发者） | `C1 声明了被吊销设备 → 不生效` |
| `policy_issuer_declare`（伪造） | 非本用户主密钥链（别家/无证书） | 任意 | **忽略**（GraphNamespacePolicy 逐条信任过滤） | `C1 非主密钥链签名的声明被忽略` |
| 声明上位的 `namespace_grant` | 因声明而进入生效引导集合 | grantId 未撤销 | 采纳（R-a 用生效引导集合） | `C1 仅图声明下 grant 生效` · `C1 声明与 R-d 撤销交互` |
| `namespace_membership`(active) | 可信、未被吊销 | 成员未被吊销 | **采纳**：成员进入该分区成员集合；该分区进入「已启用成员资格」 | `M1 成员采纳` · 锚点① · harness `成员轴独立` |
| `namespace_membership`(注销) | 可信、未被吊销 | 成员未被吊销 | **采纳**：按 R-c 最新记录，成员移出集合（`active=false`） | `M1 注销后不再到达` · 锚点④ |
| `namespace_membership`(旧) | 可信、未被吊销 | 成员未被吊销 | 被同 `(ns,member)` 的**更晚**记录覆盖（确定序） | `M1 同键最新胜出（R-c）` |
| `namespace_membership` | 已被吊销（R-b 含历史） | 任意 | **不采纳** | harness `扰动 d` |
| `namespace_membership` | 可信/任意 | 成员已被 `device_revoke` 吊销 | **不采纳** | `M1 被吊销成员的记录不采纳` |
| `namespace_membership`（伪造） | 非本用户主密钥链 | 任意 | **忽略**（信任过滤） | 锚点⑤ |
| `namespace_handoff`（2b 审计） | 任意（退订方本地签名写入） | — | **不参与推导**：不改变 `authorized`/`revoked`/`issuers`/`members` | `2b oracle-free：清理前后策略状态一致` · `交接记录样例` |

## 2. 横切不变量

1. **排列不变性**：打乱同一批记录的输入顺序，`authorized`/`revoked` 完全一致。
   覆盖：`F-B 确定性…`、随机化 harness `排列不变性`。
2. **幂等 / 不振荡**：同一输入重复推导结果相同。覆盖：`F-B 确定性…（重复读稳定）`、harness `幂等`。
3. **权威链**：被采纳的 grant 的签发者必为引导白名单成员，或**当时**已获授权其声明的全部分区；
   且签发者未被吊销、grantId 未被有效撤销。覆盖：harness `结构不变量` 与各 R-a 测试。
4. **有界 + 两轴保守回退（含闭包不变量）**：不动点迭代上限是**输入的确定纯函数**
   `2·|entries| + 2`（`iterationBound`；只用输入规模，不依赖配置 / 环境变量 / 时钟 → 同一输入在
   任何端得到**同一上限**。**这是协议语义**：改它属破坏性协议变更，需全端同版本）。
   未收敛时回退：以各轮吊销并集为初始排除集 `excluded`，**只增不减**迭代（每轮沿用
   `filterRevokes(sorted, excluded)` 与 `excluded`），直到 **`chosen.revoked ⊆ excluded`**——
   闭包不变量：输出里每个被吊销设备的记录都不被采纳 → **R-b 在回退路径上字面成立**。
   两轴**皆保守**：设备吊销轴排除更多签发者（可能少授权）；撤销轴只采纳**非排除**签发者的
   revoke（少 grant → 少授权/少恢复），**绝不 fail-open**。`PolicyState.converged=false` 可观测。
   覆盖：`F-C：…被吊销签发者的 revoke 仍不生效…` · `F-C 回退综合：撤销轴也保守…` ·
   `F-C 回退闭包：输出 revoked 里设备的记录不被采纳…` · `F-C 回退综合：设备本会因 grant 而恢复…` ·
   `迭代上限是输入的纯函数…` · `F-C 诊断…`。
5. **扰动不变性（oracle-free，F-1）**：删掉输出 `revoked` 里设备的**全部**记录（检查 a：R-b on
   grants/device_revoke）后重跑，或删掉被吊销签发者发出的 `namespace_revoke`（检查 b：R-b on
   revokes）后重跑，`authorized`/`revoked` 必须不变。二者只用「输入记录 + 输出」、不读实现内部，
   故为**真正独立**的检查（收敛结果上严格成立；非收敛回退边界除外，见 §3）。
6. **R-c 定序**：跨签发者按逻辑时间 `sum(vectorClock)`，不看墙钟。覆盖：`R-c 时钟偏移…`。
7. **保留语义不受影响**：缺 namespace = `default`、本机订阅空 = 全部、持有者只供自己订阅分区——
   这些在 `namespacePolicy`/`SyncManager` 层，策略层只产出授权/吊销，不触碰。覆盖：既有 namespace
   与 selective-sync 套件。
8. **生效引导集合的并集与确定性（C1）**：`issuers = 图上被采纳声明 ∪ 配置 policyIssuers`；
   声明是无条件采纳（不做 R-a），但受 R-b 约束（签发者或主体被吊销 → 不采纳）。
   - **无循环依赖**：采纳不依赖 `authorized`，仅是 `(entries, 配置, revokedIn)` 的纯函数 → 不动点
     未知量仍是 `(revokedGrantIds, revokedIn)`，结构不变。
   - **顺序无关 + 幂等**：声明按确定序（R-c）处理，`issuers`/`authorized`/`revoked` 与输入排列无关、
     重复推导一致。覆盖：harness `排列不变性`/`幂等`、`C1 声明顺序无关且幂等`。
   - **oracle-free 扰动 c（声明轴）**：删掉「输出 `revoked` 里设备签发的**全部**声明」后重跑，
     `authorized`/`revoked` 在收敛不动点上必须不变；配置为空时删掉**全部**声明必须**不减授权**
     地改变（即声明的存在只可能**增加**签发者 → 只可能增加授权，删除不会增加授权）。
     覆盖：harness `扰动 c` 与 `C1 空配置删声明 → 授权单调不增`。
9. **成员资格（M1–M3）**：
   - **持久 + 签名 + 无循环**：`namespace_membership` 与 grant/declare 同在 `__policy__`，只采纳链到
     主密钥、且签发者/成员未被吊销的记录；采纳不做 R-a（纯函数于 `revokedIn`）→ 不动点结构不变。
   - **确定 + 顺序无关 + 幂等**：每个 `(namespace, member)` 取 R-c 序最新记录的 `active`；打乱输入一致。
   - **生效成员 = 成员 ∧ 授权**：`getNamespaceMembers(ns) = active成员 ∩ { d : ns ∈ 生效授权(d) }`；
     成员记录**不得**改变 `authorized`/`revoked`（信息不回流授权）——独立轴。
   - **默认拒绝不放松**：无授权则无数据流动，即使有成员记录。
   - **legacy-empty**：无成员记录的分区沿用 hello 订阅裁剪；有记录则成员资格强制（非成员收不到）。
   - **oracle-free 扰动 d（成员轴独立）**：删掉**全部**成员记录后重跑，`authorized`/`revoked` 必须
     **完全不变**（成员不参与授权推导）；且 `members`/`membershipNamespaces` 清空。
     覆盖：harness `扰动 d` · `M1 成员轴独立于授权`。
   - **显式拒绝（M3）**：对端 hello 声明订阅了「它并非成员」的分区时，发送侧必须**显式**记录
     `membershipRejected`（非静默）；`sync-completed` 对其可见。
     覆盖：`M3 非成员声明订阅 → 显式拒绝` · `M3 成员但 hello 未声明 → 仍按成员发送`。
10. **退订交接（2b）**：
   - **无 tombstone**：退订是**物理删除**本分区事件/节点/边；**绝不追加任何“已删除”事件**。
     `namespace_handoff` 仅审计，不参与推导。
   - **`__policy__` 保留**：清理仅针对目标分区，绝不触碰 `__policy__`（成员/授权/声明/交接记录）。
     → 清理前后 `derivePolicyState` 结果**完全一致**（oracle-free）；legacy-empty 不退化。
   - **全量 ack 门禁（H1）**：清理前要求继任者已 ack 退订方在该分区的**全部**事件（per-event ack，
     `getPendingEvents(successor)` 无该分区残留；含退订方自己作为作者的事件）。**复用既有 ack 机制、
     不新增同步协议、不放宽快照门禁**；不自证、不看对端自报水位。门禁不过 → **保持原状**（不半清）。
   - **验前不删 + 幂等可续（H3/H4）**：先校验 → 写成员注销 + 交接记录 → 写**图外**意图文件 → 物理删除 →
     清本地水位 → 移除意图。崩溃后重跑：意图在则**续跑删除**（幂等）。
   - **成员闸门仍在**：清理不删成员记录 → 该分区仍处于「已启用成员资格」，非成员仍收不到（不退回 legacy）。
   - **`force` 仅本地**：跳过 ack 门禁，但交接记录**如实**标注 `forced:true` 与未覆盖作者明细；
     不经 MCP/远程暴露。
   - 覆盖：`2b ① 覆盖足→清理成功且策略保留` · `② 覆盖不足→中止且数据原封不动` · `③ force→forced:true` ·
     `④ 中断→续跑且无 tombstone` · `⑤ 清理后成员闸门仍在` · `2b 多端 B/C 数据不丢`。
11. **重订阅恢复（2c）**：
   - **准入（R1）**：重入必须同时满足 ①该分区对**本设备**有**生效授权**（`getEffectiveNamespaces(self)`
     含该分区，即存在签发给本机的 grant；默认拒绝不变）②本机重新声明成员**在册**；任一不满足 →
     **显式失败**（`not-authorized` / `membership-not-active`），**不静默**。
   - **显式降水位（R2）**：复用 hello 自报——**自报水位只允许向下修正**（作者自报缺失 = 0）：
     对端据此**下调** `peerWatermarks[peer][ns]` 并从 0 重新 offer；**绝不向上修正**（不把所有
     “对端没有”误判为“已有”）。重入方**显式订阅的空分区上报空时钟**（`buildLocalNamespaceClocks`
     纳入订阅分区）→ 触发对端重发。**快照门禁不放宽**：“自报分区水位为空”的判据改为“每个分区
     时钟均无作者计数”（空对象亦算空）。**不新增同步协议**。
   - **本地重置标记（R3）**：`<storagePath>.rejoin.<ns>.json`（图外、**不同步**、无 tombstone），
     仅供本机 reset 决策与诊断。
   - **oracle-free + 幂等（R4）**：重入/reset **不改变** `__policy__` 派生结果；重复重入安全。
   - 覆盖：`2c ① 清理后重入→历史完整拉回` · `② 未授权重入→拉不到（显式失败）` ·
     `③ 未 reset 的重入→对端不重发（可诊断）` · `④ 重复 rejoin 幂等` · `⑤ 无 tombstone + __policy__ 保留`。

## 3. 覆盖它的 harness（`tests/sync/policy-invariants.test.ts`）

固定种子（`mulberry32(0xc0ffee)`）、可复现，`scenarios=300`。**C1 起随机事件含
`policy_issuer_declare`**。对每组断言：排列不变、幂等、结构不变量
（`authorized ∩ revoked = ∅`；被授权设备必曾是某条 `grant` 的主体；**生效引导集合 ⊆ 被声明主体 ∪ 配置**）、
以及**三条 oracle-free 扰动检查**（不依赖任何参考实现）：

- **检查 a（R-b on grants/device_revoke）**：对输出 `revoked` 里的每个设备，删掉它签发的**全部**
  记录后重跑，`authorized`/`revoked` 必须完全不变。
- **检查 b（R-b on revokes）**：把所有「已被吊销签发者发出的 `namespace_revoke`」删掉后重跑，
  `authorized`/`revoked` 必须完全不变。
- **检查 c（声明轴单调，C1）**：配置为空时，删掉全部 `policy_issuer_declare` 后重跑，授权只能
  **不增**（声明的存在只会增加签发者、从而只可能增加授权），且 `revoked` 不变。

二者只用「输入记录 + 输出 `revoked`」，不读实现内部中间变量，因此与实现**独立**。

**为何不再用「独立参考重放」作主证据**：早期版本以 SUT 输出 `revoked` 作为参考重放的输入，导致
`revoked` 的比对退化为「SUT 是该规则的不动点」而非「SUT 算出了正确的 `revoked`」——错误但自洽
的结果也能通过。现以扰动检查替代；参考重放与实现同规格，无法提供独立性。

**边界（有意）**：`converged=false` 时结果落入两轴保守回退，它不是不动点，故扰动检查在**回退
路径**上可能不成立。harness 因此对**收敛结果**做严格不变性断言，对**未收敛结果**只记录残差
`residualA/B` 并断言其上界（≤2%）；未收敛本身也断言在 1..5% 之间，并打印触发样例。

**残差机制（非安全缺陷）**：实测所有 `residualA` 都满足 `actual.converged=false ∧
perturbed.converged=true`——即**扰动后的世界收敛到了另一个不动点**（删除记录可能打破振荡环），
而非回退结果里存在被采纳的「被吊销签发者记录」。回退本身已由闭包不变量
`chosen.revoked ⊆ excluded` 保证 R-b 字面成立（见 §2.4 与其锚点），故残差是「世界不同」而非
R-b 违反；harness 逐条打印 `[residual] …` 以便复核该分类。
