# 收敛健康度 · 小提案（P3 · 阶段 A · 待过目）

> **状态**：**小提案已批准（2026-10-16）**——阶段 B 开工 / §1.4 选项 B（`sync-done.stateFingerprints`，C3 A 类加法）/ A1 限频最小自动修复，三项均按建议通过。
> **排期**：阶段 B 排在 **W1（记忆共享 UI 收口 + core 边角）合并之后**；届时从含 W1 的新 main 起开工，等待「继续」指令。
> 本文件当前仅记录方案与批准，**未动任何产品代码**。
> **基线**：阶段 A 提案基线 `main = da90d764`；**阶段 B 开工基线 `main = 23a4468`（W1 合并后）**，本文行号已按 B 实施后 HEAD 重锚（以符号名为准，行号仅定位）。
> **权威输入**：`KEYING-FIX-PLAN.md` §2-P3；护栏包 `TEST-MATRIX.md` G-5、`SYMMETRY-CHECKLIST.md` ⑤⑥⑦⑬、
> `SILENT-POINTS.md`（P3 级条目 SP-21–29、SP-33/35/36）、`IDENTITY-INVARIANTS.md` I6、
> `KEYING-FIX-PROPOSAL.md`（教训：无裁判系统里，静默最贵）。
> **执行模型**：`deepseek/deepseek-flash` + variant `max`。
> **过目点（两个）**：① 阶段 B 是否开工；② §1.4「线协议加法式字段」决定（需产品批准）。

## 0. 一句话

把「未收敛 / 停滞」从**静默**变成 **可见（控制台/doctor）→ 可查（信号分类 + 分区/方向定位）→ 可告警（状态翻转）**；
检测层不改变任何同步/授权/水位语义；先红后绿。

设计次序：**先建不依赖对端配合的本地观察面（S1–S6），再上跨端共同域指纹对账（S7/S8）作为增强**——
键控缺陷的教训不是「跨端对账不够」，而是「故障发生时，两端都觉得自己没事，且没有任何人被告知」。

## 1. 信号清单与来源

### 1.1 本地可检测信号（不依赖对端配合）

| ID | 信号 | 来源（`main@da90d764`） | 判定口径（草案） | 级别 |
|---|---|---|---|---|
| **S1** | **出站积压停滞**（pending 无 ack 进展 / 记账矛盾） | `getPendingEvents`（`SyncManager.ts:581`）、`markEventsSynced` ack→水位（`:625`）、`resetPeerWatermarks`「被认可的修复路径」文档（`:677`） | ①**记账矛盾**：`pendingById(P) > 0`（per-event ack 集合视角）而对端水位视角无待发（`missingByWatermark(P) = ∅`）——SP-28 类「静默永久不发」的**本地直接检出**（该状态下 `maybeNotify`/anti-entropy 都会短路，无任何会话会启动）；②**无进展**：窗口内会话 `sentEvents > 0` 但 backlog 不下降（连续 ≥2 会话） | 红 |
| **S2** | **对端自报超前**（reportedAhead 再现） | `recordPeerHello` 差额（`SyncManager.ts:1271`）；出口 `SyncResult.reportedAhead`（`:116-124`） | 窗口内 ≥2 次非空 → 本机对「对端已有」的记账落后（ack 历史丢失 / 状态重置 / 对端从他处获得数据） | 黄（提示） |
| **S3** | **水位向下修正频繁** | R2 静默向下修正（`SyncManager.ts:1271` 内向下修正块；SP-24） | 窗口内修正次数 ≥3 → 对端反复「丢失状态」（清理/重入/损坏），值得解释而非静默 | 黄 |
| **S4** | **会话失败连击 / 长期退避** | `sync-failed` 事件（`:1842`）；anti-entropy 退避（`:1480-1494`，失败指数退避 ≤1h，成功复位；SP-20/23） | 同对端连续失败 ≥3，或退避深度 ≥3 仍未恢复 → 连通/协议/验签问题；「退避中」必须可见，避免被误读为「已收敛」 | 红 |
| **S5** | **键控丢弃计数增长**（P1 回归哨兵） | `getDropCounters`（`:420-424, 560-566`）；`sync-frames-dropped` 事件（`:551-557`） | `identityFailures > 0` 立即告警（修复后应恒为 0）；`nudgeDroppedStaleEntry`/`staleEntrySignals` 窗口增量 >0 → 键控/代际回归信号 | 红 |
| **S6** | **接收侧「期望却零到达」**（C2 ⑤⑥） | 本机订阅 + 本机生效授权视图（`getEffectiveNamespaces(self)`，admin 已用：`admin.mjs:494`）；会话路径无信号（C2-⑤ 现状） | 我订阅分区 X ∧ 我自认被授权 X ∧ 对端在线 ≥W ∧ 我**从未**从该对端收到 X 的任何事件 → **本地无法裁决**（对端可能确实无数据）；标「待对账」并升级该对端的对账优先级 | 黄→由 S7 裁决 |

### 1.2 跨端增强信号（需交换指纹；见 §1.4 决策）

| ID | 信号 | 口径 | 级别 |
|---|---|---|---|
| **S7** | **共同域图指纹不一致**（C2 ⑬ / G-5） | 会话尾交换 `computeStateHashByNamespace`（`src/core/stateHash.ts:30-53`）的相关域指纹；只比**双方共同键**（与 `verify-mcp-cross.mjs:63-66`、`wan-sync.mjs:195` 同规则）；连续 2 个静止窗口不一致 → 未收敛（列出分区） | 红 |
| **S8** | **策略视图指纹不一致**（C2 ⑦） | `derivePolicyState` 输出的确定性序列化（排序集合，`grantPolicy.ts:479`；输入读取/信任过滤 `:566`）SHA-256；同一事件集必等。图指纹不含 `__policy__`（策略是事件、非节点），故单列 | 红 |
| **S9** | **未知事件类型计数**（解释性，SP-26） | `applyRemoteEvent` 未知类型 → `stale`（`src/sync/apply.ts:97-100`）；计数落 `SyncResult` 可选字段 | 灰（解释 S7 不匹配的版本混用成因；旧端侧本地可见） |

### 1.3 设计原则

- **不发明协议事件**：健康状态**不写入图/事件账**（不碰存储语义；审计时间线=E2 事件账，不新增图层）。
- **指纹只作诊断**：绝不因指纹差异放宽授权、推进水位或跳过闸门（C2 §2 告警方向铁律）。
- **解释性扣除**：`denied=true`（未授权）与 `membershipRejected` 非空（成员不一致，`SyncManager.ts:1378-1386`）不按「异常停滞」计入，归因呈现。
- **消费既有出口**：S2/S3/S9 是既有内部信号接出口（SP-24/29 的落地）；S1/S5 建立在 P1 已落地的计数与修复路径之上。

### 1.4 决策单列：共同域指纹是否走 C3 A 类加法式变更

**现状事实（支撑 A 类判定）**：同步帧 = 加密信道上 JSON 透传（`protocol.ts:266-271`）；校验只验**必填字段**、不拒绝未知字段（hello `:156`、ack `:225`）；`sync-done` 的载荷除 `finalVectorClock` 外**无任何消费者**（`:115`，收发两侧均只收帧不读内容）。C3 政策（`MIXED-VERSION-POLICY.md` §2）：**既有帧 + 新增可选字段 = A 类**（事例：`sync-offer.snapshot`、`sync-ack.snapshotApplied`）；**新增消息类型不是 A 类**（nudge 教训，§2 注意事项）——因此**不新增消息类型**。

| 选项 | 内容 | 利 | 弊 / 风险 |
|---|---|---|---|
| **A** 不动线协议 | 跨端对账降级为带外（脚本 `verify-mcp-cross` 模式，人工/CI 触发，非周期）；本地信号 S1–S6 全量保留 | 零协议面；零混测负担 | 「两端都以为自己收敛」的残余静默类（同水位不同内容、apply 半失败、`__policy__` 未收敛）无法周期自查；G-5 的「周期化」不成立 |
| **B（推荐）** C3 A 类加法 | `sync-done` 增加**可选**字段 `stateFingerprints: { graphs: Record<ns, sha256hex>, policy?: sha256hex }`；仅 `sync.convergence.enabled` 时携带；接收侧缺字段 → 跳过对账（不告警）；图谱按会话相关域裁剪 + 本地时钟缓存，会话尾每端一次 | 周期性对账**零新增帧**、零帧序影响；旧端天然忽略；离线/relay/委派路径不敏感；新↔旧=N-1 窗口内安全降级（`unverifiable`） | 帧体略增（每域 64B hex，仅启用+仅会话尾一次）；指纹含分区集合信息——但只发给已互信且 hello 本已披露分区/水位的对端（范围见 `STAGE-SCOPE.md` 单用户前提）；需要 G-3 行为模拟混测（下方 §4 R4） |

> 备选位置说明：`hello` 是会话**前**状态（对「静止收敛」是陈旧值）；`ack` 是半程状态；**`sync-done`（各自已完成本会话 apply 后发送）语义上最准确**，选它。
> **请示**：批准 B → 阶段 B 含该字段；不批准 → 阶段 B 只做本地层 S1–S6，跨端对账维持带外。**S1–S6 不依赖本决定。**

## 2. 机制

### 2.1 检测周期 / 去抖 / 静止窗口

- **开关**：新增配置 `sync.convergence`（形状照 antiEntropy 先例，`config.mjs:233`、`config-schema.mjs:125-156`）：
  `enabled`（常驻入口/守护默认 true；**core 默认 false**，库行为零变化）、`evalIntervalMs`（默认 60s）、`quietMs`（默认 60s）。
- **触发**：eval 定时器 + 事件驱动复评（`sync-completed`/`sync-failed`/`sync-frames-dropped`/本地 `event-appended`）。
- **去抖（翻转滞回）**：进入告警需**连续 2 次**评估命中（`identityFailures` 例外，立即）；解除需连续 2 次条件消失；翻转时才发状态事件。
- **静止窗口**：无会话在途 **且** 自上次本机写入/收到事件 ≥ `quietMs` 才允许下「收敛」判词——避免把在途/并发写判成未收敛。

### 2.2 停滞判定口径（S1 展开）

- 口径①（矛盾检出，核心新能力）：`pendingById(P) > 0 ∧ missingByWatermark(P) = ∅`（或反向）→ 直接判「记账矛盾」。
  该状态下 `maybeNotify`（`:473-481`）与 `shouldAntiEntropySync`（`:1473-1483`）均已短路，**没有任何既有路径会启动会话**——这正是 SP-28 描述的死锁，S1 把它变成一次告警 + 一次受控修复（见 2.3）。
- 口径②（无进展）：窗口内 ≥2 个完成会话 `sentEvents > 0` 且 `getPendingEvents(P)` 最小值不下降 → 对端不确认。
- 两口径均先在**内存快照**上判定（`getPendingEvents` + 新增只读诊断 getter `getBacklogDiagnostics(peer)`：返回两口径计数，纯读、无行为变化）。

### 2.3 与 anti-entropy 的关系（复用而非新造）与重试策略

- **常规重试 = 存量机制**：anti-entropy 周期 + 指数退避（`:1455-1494`）、nudge、重连；P3 **不新增重试路径**。检测到 S4 时把「失败连击 / 退避中」呈现出来（避免误读为收敛）。
- **最小自动修复（提议项 A1，已批准并落地）**：仅针对 S1 口径①（死锁类）：**限频**（每对端每评估窗口最多 1 次）调用既有 `scheduleSyncTrigger` 起一轮会话——会话 hello 的自报水位会触发既有的 R2 向下修正（`:1271`），从而自愈；不越过安全语义（只会多问一次/多收一轮）。
- **不做自动水位重置**：`resetPeerWatermarks`（`:677`）是既有**人工**修复动作（控制台/HTTP 已有按钮，`console.js:2600-2621`）；自动调用留作 v2 单独论证。
- **告警方向铁律**：任何对账差异默认「告警 + 保持既有安全语义（默认拒绝/少收）」，**绝不**放宽授权或水位。

### 2.4 跨端对账流程（采用选项 B 时）

1. 会话尾 `sync-done` 携带 `stateFingerprints`（图谱：仅本会话相关域 = 本机 allow ∪ 期望收到；策略：S8）。
2. 接收侧与本地实时指纹比对（共同键；空交集不算满足，同脚本口径），结果 + 时间戳存 per-peer 记录。
3. 判定：连续 2 个**静止窗口**不一致 → `diverged`（列差异分区）；一致 → `converged`；对端无字段/未启用 → `unverifiable`（不告警）。
4. 指纹计算：`computeStateHashByNamespace` 裁剪 + 时钟缓存（本机时钟未变则复用）；策略指纹仅在策略事件集变化时重算。

### 2.5 每对端状态机

`ok / stalled / diverged / unverifiable / offline`（含 `syncing` 瞬态）：S1/S4/S5 → `stalled`；S7/S8 持续不一致 → `diverged`；无指纹且有本地黄信号（S2/S3/S6）→ `unverifiable` 加「待对账」标注。

## 3. 呈现面

- **SSE（复用 `/admin/events` 通道与既有事件名）**：
  - `sync` 载荷补既有字段：`reportedAhead / denied / membershipRejected`（SP-29 接线，`serve.mjs:809-814` 现状只带 3 字段）；
  - 新增 SSE 事件 `convergence`（仅翻转时）：`{ peerDeviceId, from, to, reasons[], at }`。
- **只读 API（向后兼容的加法字段）**：`/admin/api/devices` 每设备 + `convergence` 对象（`admin.mjs:338`）；`/admin/api/overview` + 汇总（`admin.mjs:273`，供「关于本机」）。
- **控制台**：设备卡状态徽标 + 人话 + 动作入口（复用既有按钮，`console.js:2030+ / 2600-2621`）；「关于本机」汇总（`console.js:1101+` 的收敛健康段）；星图本轮不加新图层（状态色留在设备卡）；**审计时间线不动**（不把健康数据写账）。
- **doctor / status**：`mebular status` 增加收敛段（守护在跑时走只读 admin API）；`doctor`（非 `--net`）随 status 输出（`bin/mebular.mjs:488+ / 741-750`）；`doctor --net` 不重复网络层已有内容。
- **人话文案**：
  - `ok`：与「设备B」已收敛（10:32 对账）
  - `stalled`：与「设备B」停滞：12 条已发出但一直未被确认（自 10:02 起）→ [立即同步] [重置水位]
  - `diverged`：与「设备B」未收敛：分区 `work`/`notes` 指纹不一致（10:32 对账）→ [立即同步]
  - `unverifiable`：与「设备B」本地检查正常；对端未提供对账指纹（旧版本 / 未启用）
  - `offline`：离线（最后在线 09:50）

## 4. 测试与验收

- **红→绿样本（沙箱，显式 `MEBULAR_USER_HOME`；先红后绿）**：
  - **R1 本地停滞（守护级、无代码注入）**：构造 `sync-state.json` 水位污染（或从快照恢复制造 ack↔水位矛盾）→ S1 红；点既有「重置水位」→ 绿。（确定性最高，对齐 SP-28。）
  - **R2 未确认积压（守护级）**：B 侧对 A 执行 `device_revoke` → A 侧「已发未被确认」红（SP-17「发送方不知情、永久重发」的可观测化）；走恢复/重入路径 → 绿（若恢复路径不适配，红样本下移集成层但不取消）。
  - **R3 指纹不一致（集成级）**：双端内存 SyncManager + storage 替身跳过一条物化（日志有、图无）→ S7 `diverged` 红；修复替身后下一会话 → 绿。
  - **R4 混测（G-3 行为模拟）**：旧端适配器**剥离** `stateFingerprints` → 新端不得报 `diverged`（应 `unverifiable`）；反向：旧端解析含未知字段的帧不失败（直证 A 类安全边界）。
- **与既有硬判据对齐**：同一 `computeStateHashByNamespace` 原语 + 共同域规则；把「共同域比较」抽为 core 共享函数（监控引用；`verify-mcp-cross.mjs` / `wan-sync.mjs` 本轮不改，加单测锁定两口径同构，防漂移）。
- **CI（`npm test` 内）**：状态机/阈值/去抖单测；`sync-done` 字段往返 + 旧端兼容单测；R3/R4 集成测试。
- **CI 可选**：`scripts/verify-convergence.mjs`（双守护沙箱红→绿 + 收敛绿；形状照 `verify-keying-matrix.mjs`）。
- **验收口径**：红样本在 stallWindow 内**确定性可见**；修复后 ≤2 个评估周期转绿；误报防护（静止窗口/去抖/解释性扣除）有单测；既有 verify 套件零回归；控制台各状态文案截图留证。

## 5. 范围红线（自我约束）

1. 不碰策略/存储语义；不新增图事件、不改 E2 账；不动线协议（唯一例外 = §1.4 选项 B，需批准）。
2. 检测有配置开关（`sync.convergence.enabled`；core 默认关）；关 = 与今日行为逐字节一致。
3. 修复只用既有路径 + §2.3-A1（限频触发，若批准）；**无自动水位重置**；不以对账为由放宽任何安全判定。
4. 先红后绿；沙箱 `MEBULAR_USER_HOME`；不碰用户实例与真实配置；PR 自理、合并归产品。

## 6. 影响面 / 回滚 / 预估规模

- **文件（阶段 B 预计）**：新增 `src/sync/convergence.ts`（监控 + 状态机 + 指纹比较）；`SyncManager.ts` 小改（`sync-done` 可选字段、S2/S3/S9 出口到 `SyncResult`、`getBacklogDiagnostics` 只读 getter）；`protocol.ts` 类型/校验；`mebular.ts` 配置接线与状态出口；`packages/mcp`：`serve.mjs`（SSE）、`admin.mjs`（设备/概览字段）、`config-schema.mjs`（新配置项）；`packages/console/console.js`（+css）；`bin/mebular.mjs`；`tests/sync` 新增 3–4 个、`tests/integration` 1 个；`scripts/verify-convergence.mjs`。
- **预估规模**：core ~350–450 LOC + 测试 ~600–800；mcp/console/CLI ~250–350；合计 ~1.2–1.6k LOC（含测试）；一个实现会话（半天量级，含沙箱标定）。
- **回滚**：开关关闭 → 零行为（字段不发、监控不跑）；或 revert 提交。**无数据迁移、不改 `sync-state.json` 格式**。
- **风险与缓解**：误报 → 阈值 + 去抖 + 静止窗口 + 解释性扣除（默认值放沙箱标定：`stallWindowMs≈15min`、`failStreak=3`、`mismatchConfirmations=2`）；指纹开销 → 会话尾一次 + 时钟缓存；帧体增大 → 每域 64B hex、仅启用、仅会话尾；混版 → `unverifiable` 降级 + R4 测试。

## 7. 与护栏文档的对应（不重复造）

| 输入 | 本提案消化为 |
|---|---|
| G-5（TEST-MATRIX：stateHash 周期化/常驻化） | S7/S8 + §2.4 流程 + R3/R4 |
| C2 ⑤⑥（接收侧对账 / 期望零到达） | S6（本地不可裁决 → 对账优先级） |
| C2 ⑦（derivePolicyState 对账 / converged 出口） | S8（策略指纹）；SP-13 的 `converged=false` 计数作为解释项并入 |
| C2 ⑬（stateHash 对账） | S7 |
| SP-21–29 / SP-33 / SP-35 / SP-36（P3 级静默点） | S1–S5 的出口；SP-29 的 SSE 接线即 §3 第一项 |
| SP-24（向下修正无计数）/ SP-28（水位污染静默不发） | S3 / S1-① |
| I6「丢弃必须发声」 | 本提案把其推广为「**未收敛必须发声**」：S5 消费 P1 丢弃计数；所有回执信号可计数、可断言 |
| KEYING 教训（活锁/孤儿/静默丢弃） | S1 口径①直指同构死锁；S5 为键控回归哨兵 |

## 8. 批准与排期记录（2026-10-16）

- 产品「一次性通过」完整计划（`MEMSHARE-CLOSEOUT-PLAN.md` §1）；本提案三项决定按建议批准：
  ① 阶段 B 开工；② §1.4 选项 B（`sync-done.stateFingerprints`，C3 A 类加法字段）；③ A1 限频最小自动修复。
- **排期**：阶段 B 在 **W1（记忆共享 UI 收口 + core 边角）合并后**开工；届时从含 W1 的新 main 起，
  先重跑本文 file:line 锚点核对（行号将随 W1 漂移），再进实现。
- console 呈现对齐 **W1-A 之后的新设备卡**；其余按本提案与 §5 红线执行。
- **在收到「继续」之前不动代码。**

## 9. 阶段 B 实施记录（2026-10-16；自 `main = 23a4468`，W1 合并后）

### 9.1 落点（实施后 HEAD）

- 新增 `src/sync/convergence.ts`：`ConvergenceMonitor`（状态机：`ok/stalled/diverged/unverifiable/offline/syncing`）、
  `compareStateFingerprints`（共同域判据，含期望收/发集合）、`hashPolicyState`（策略视图指纹）。
- `src/sync/protocol.ts`：`sync-done.stateFingerprints?`（C3 A 类可选字段）+ `parseStateFingerprints`（宽容解析，畸形降级不失败）。
- `src/sync/syncmgr/SyncManager.ts`：会话尾指纹交换与 `sync-fingerprint` 事件（两侧不对称路径均覆盖）；
  `SyncResult` 增 `ackedOutgoing` / `watermarkDownCorrections` / `unknownEventTypes`；`getBacklogDiagnostics` /
  `requestSession`（A1）/ `getOnlinePeers`（只读）。
- `src/sync/apply.ts`：`isApplyableEventType`（S9 计数依据）。
- `src/mebular.ts`：`sync.convergence` 接线（core 默认关）+ `getConvergenceStatus()` / `onConvergence()` +
  指纹报告（图分区块哈希 + 策略视图哈希）。
- `packages/mcp`：`config.mjs`（守护默认开）、`config-schema.mjs`（internal 旋钮）、`admin.mjs`（devices/overview）、
  `serve.mjs`（SSE `sync` 补 `reportedAhead/denied/membershipRejected` + `convergence` 事件）、`bin/mebular.mjs`（status）。
- `packages/console/console.js`：设备卡「同步健康」、关于本机「收敛健康」、SSE `convergence`、mock 数据；
  `verify-console.mjs` 增 P3 锚点（E1 通过）。
- 测试：`tests/sync/convergence-monitor.test.ts`（11 例）、`tests/sync/convergence-fingerprints.test.ts`（15 例）；
  脚本 `scripts/verify-convergence.mjs`（3 场景：基线收敛 / 记账矛盾红→绿（人工重置水位）/ A1 自动自愈）。

### 9.2 与提案的偏差（均为最小化实现细节）

- 指纹计算 v1 直接按会话尾计算（提案提「时钟缓存」，当前量级可忽略；如成本显现再加缓存，不改口径）。
- 响应方常驻循环在两次会话间 `inFlight` 恒真 → `syncing` 不压过已确认的 `ok`（否则响应侧永远显示同步中）。
- S6 实现为「未对账 + 有期望参与」note（`expected-yet-unverifiable`），不做「零到达」强断言（本地不可裁决，交由 S7）。
- 键控丢弃为设备级计数：`identityFailures` 增量按设备级告警呈现给在线对端（无法精确归因到单对端）。

### 9.3 P1 情报评估台账（多跳准静默滞后；`memshare-review/SYMMETRY-CORE-BRIEF.md` §1a 条件 4）

> 备注：该文件本机未见（未同步至本机可访问路径），以下按主控转述事实记录，供后续波次核对原始简报。

**事实（转述）**：A→B→C 链式拓扑，C 的 `tasks` 数据先被成员闸门拦（成员传播本身通）；但政策事件不单独 nudge、
远端 `appendRemote` 不触发下行、`runAntiEntropyCycle` 被常驻响应方会话的**全局 `syncing` 门**挡住
（A 侧一次会话卡 86s 期间 B→C 触发全跳过）→ 准静默网络下多跳数据面**滞后/停滞**，直到任一方向有新活动或重连。

**① 覆盖评估：部分覆盖（结论）**
- 已覆盖：「发出但未被确认」（S1②）、「记账矛盾死锁」（S1①）、「失败连击/退避」（S4）、「指纹未收敛」（S7/S8）、
  「未对账/期望参与」（S6 note）；
- **未覆盖**：「在线 + 水位口径确有积压（`missingByWatermark > 0`）+ 窗口内零完成会话」——该形态当前只呈现为
  `unverifiable/awaiting-session`（未对账），**不是告警**。本情报场景正落在这一缺口内（触发被全局门挡住 → 零会话）。

**候选规则 R-S1③（检测 only；本轮未实施，超已批信号清单）**：
`online(P) ∧ missingByWatermark(P) > 0 ∧ 窗口内零完成会话 ∧ 该对端无在途会话` → `stalled(no-session-progress)`；
默认 `stallWindowMs`（15min）天然过滤常规 ≤10min 的 anti-entropy 周期抖动，只抓持续滞留。

**② A1 扩展评估：超范围（结论：不扩权）**
- 把「政策/成员变更触发的下行」纳入 A1 = 改变**触发语义**（何时开会话），超出 P3 已批范围（P3 = 观察层 + 单点 A1）。
- 技术上小可行（若后续批准）：既有 `requestSession → deliverTrigger` 路径本身**可绕过全局 `syncing` 门**
  （N4 后会话队列按连接粒度，允许异连接并发会话）；把触发源从「记账矛盾」扩到「零会话积压」或
  「收到 policy/membership 事件（de-bounce）」即可。
- 根因修复（`shouldAntiEntropySync` 全局 `syncing` 门改 per-peer / `appendRemote` 触发下行 / policy 事件 nudge）
  属 **core 触发器语义**变更，建议与「双方向入网对称」命题后续批一起评估（P1 简报同源）。

**③ 处理**：本轮**不扩权**；本台账同时抄录至 PR 正文「已知边界」节；建议后续波次立项时把 R-S1③ + 触发器语义
一起过（届时按 C3 A/B 类判定）。

---

> **回执声明**：阶段 A 提案 + 阶段 B 实施均落盘于本分支；三项决定已批准（见 §8）；B 实施证据与红线对照见 PR 正文。
> 阶段 B 期间另记录 P1 情报台账（§9.3）：R-S1③ 检测缺口与触发器语义修复建议，**未扩权**。
