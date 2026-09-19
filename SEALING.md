# Mebular 封板（SEALING）

> **封板基线**：`main = 0d78486`（PR #34 合并；含 Phase 2 D/E（A）、实时同步（B）、多签发者策略权威（C））。
> 根 tree = `d1eb7d2c5ffa87eed6c64d70ce8aed3a6ceeb333`。验收基线：**67 个测试套件 / 542 条用例全绿**；
> 覆盖率 **行 92.4% / 分支 ~79.3–79.5%**（运行间抖动），门槛 lines 85 / branches 65。
>
> 本文是**契约**：下列被钉住的红线、口径与协议语义，改动前**必须先更新本文并配回归**，否则不予合入。
> 策略推导的不变量矩阵与准入条件另见 [`src/sync/POLICY-INVARIANTS.md`](src/sync/POLICY-INVARIANTS.md)。

---

## 1. 去中心化红线（不可越界）

1. **无中心服务 / 协调者**：同步是设备直连，传输层可换（libp2p / InMemoryHub / 自建 Provider）；核心层纯 TS、不依赖网络，库/嵌入式形态可离线运行。不做云端记忆 SaaS。
2. **无全局时钟**：定序**不看墙钟**。同一签发者内按**单调序列**（`event.vectorClock[author]`）；跨签发者按**逻辑时间** `sum(vectorClock)`；并发（互不因果）以 `(作者, 内容寻址 id)` 兜底 → 完全确定、两端收敛一致（含 A/B 互吊销：逻辑序在先者胜）。
3. **权威来自用户主密钥证书链**：政策记录只有**链到用户主密钥**的设备签发才被采纳；自授、别家用户、无证书伪造一律忽略。被授权方**不可自授**。
   **委派（T2，信任模型 v2）**：**任意**持有有效证书链的设备可用**其设备密钥**为**新设备**签发**委派证书**（不要求特定设备/CA 在线，主密钥私钥可完全离线）。链为**叶→根**有序，逐跳用签发者设备公钥验签，最后一跳由用户主密钥验签；**委派跳数上界 N=4**（超长链拒绝）。**没有“指定主设备”概念**。
4. **授权可传递、无单一主设备在线要求**：引导签发者（**图上签名声明 `policy_issuer_declare` ∪ 本地配置 `sync.policyIssuers`**，可多台；见 §3 C1）之外，已被授权者可**转授**自己当时已获授权的分区（"不能给出自己没有的"）。
5. **数据本地持有、默认拒绝**：写入先本地签名 + 内容寻址哈希，不 phone-home；供给端只把记忆发给**被显式授权**的对端（`sync.peerNamespacePolicy`，未列出 = 不给任何分区）。
6. **传输/集成不构成权威**：P2P、relay、MCP、OAuth 等只管**字节通道与访问控制**，不参与政策判定，也不改变授权结果。
7. **保留命名空间 `__policy__` 对全部已认证设备可读（含被吊销者）**：这是解开「默认拒绝 + 策略在图上」bootstrap 与支持恢复所必需的**有意取舍**，代价是授权图（谁能读什么、谁被吊销）对已入网设备可见。

## 2. 一致性口径

1. **最终收敛（eventual），非强一致**：在双方**共同授权（且实际传输）**的分区集合内，任意两端最终收敛到同一图状态（事件内容寻址 + 向量时钟 + 确定性冲突裁决）。分区只改变「谁在何时收到哪些字节」与召回组织方式，**不改变一致性模型本身**。
2. **水位是 `per-(对端, 分区, 作者)`**：只在**同一分区内**比较作者计数，绝不拿对端累积全局时钟当「已有」；本机上报（hello）与快照水位同样只取作者自身计数。某分区因未授权被跳过后，**扩权即可回补**历史事件。
3. **水位只由本机掌握的两个事实推进**：对端 **ack** 与**已确认快照**（`snapshotApplied`）。对端 hello 的自报水位**不抬升**本机记录（差异经 `sync-completed.reportedAhead` 暴露）。**2c 例外——自报只允许向下修正**：对端自报某作者计数**低于**本机记录时，把本机水位**下调**到自报值（作者缺失 = 0），用于**再订阅恢复**（退订方清理后上报空时钟 → 对端从 0 重发）；**绝不向上修正**。
4. **跨会话重复发送是预期行为**（方向安全：只多发、不缺发）：对端已从别处获得、本机无 ack 的事件可能被再发一次；接收端按内容寻址 id 幂等去重，**重复事件跳过验签与重放但仍 ack**，下次不再发（自愈）。`duplicates` 非零通常不是 bug。
5. **跨端一致性自检只比共同授权域**：`status().stateHash` 是**全局**哈希，两个合法持有不同分区集合的设备全局哈希必然不同（不是 bug）；请比 `status().stateHashByNamespace`，只对**双方共同拥有的域**逐一比较。
6. **快照前提与回退保护**：初始快照**只发给自报分区水位为空的对端**；接受侧仍做回退保护——仅当本地缺失或快照版本时钟**严格更新**时才写入。放宽「只发空对端」前必须先补齐快照的冲突/合并语义。
7. **连接 ≠ 持续同步**：一次连接只保证一次收敛（`autoSync`）。实时性来自**写入即推（push-on-write）**，长连兜底来自**周期 anti-entropy**；实时性依赖常驻进程，库/嵌入式默认不推送/不兜底。

## 3. 协议语义清单（改动 = 破坏性协议变更，需全端同版本）

> 以下任一项变化都必须**全端一致升级**；两端不一致可能对同一批记录/事件得出不同结论。
>
> **⚠️ 破坏性协议变更 · C1（引导签发者上图化）**：新增事件类型 `policy_issuer_declare`，并把 R-a 的
> 「引导白名单」从**本地配置**改为**生效引导集合 = 图上声明 ∪ 本地配置**。**旧节点**（不含 C1）会
> 把 `policy_issuer_declare` 视为未知类型而忽略：若新旧混跑且旧节点**未**在本地配置该签发者，则旧
> 节点不承认该签发者的授权、**可能少授权/不收敛**（安全方向：少授权，不 fail-open）。**同一集群须
> 全端升级到含 C1 的版本**；跨版本互通仅在「旧端仍用 `sync.policyIssuers` 本地配置」时成立。
>
> **⚠️ 破坏性协议变更 · M1–M3（订阅 = 成员资格）**：新增事件类型 `namespace_membership`，把「订阅」
> 从**瞬时 hello 声明**升格为**持久、签名的图上成员资格**；裁剪链改为
> `对端授权 ∩ 对端成员资格 ∩ 本机订阅声明`，hello 订阅声明降级为**活跃性/一致性校验**（不一致 →
> **显式拒绝/告警**，不静默）。**兼容规则（legacy-empty）**：某分区**没有任何被采纳成员记录**时视为
> 未启用成员资格，沿用既有 hello 订阅裁剪（**不放松授权默认拒绝**）；一旦该分区出现成员记录，即成
> 强制闸门。**旧节点**忽略 `namespace_membership`：对旧端而言该分区始终「未启用成员资格」→ 行为
> 不变或**少收**（安全方向，不 fail-open）；**退订的数据清理/继任者 ack 门禁属 2b，本轮不做**。

> **⚠️ 破坏性协议变更 · T2（委派证书链 + 加入令牌，信任模型 v2）**：握手证书新增可选 `issuer` 字段与
>   `chain`（叶→根）载荷；事件新增可选 `authorCertificateChain`。**旧节点**只做**一层**主密钥验签：
>   收到**委派证书**（`issuer` 存在 / 链长>1）时**拒绝**（安全方向，不 fail-open）→ 新旧混跑时委派设备
>   **无法接入**，须**全端升级**；旧“共享主密钥 + 主密钥直签证书”部署**继续有效**（`issuer` 缺省 = 与旧格式逐字节兼容）。
>   新增 **join 令牌**（inviter 设备私钥签名，含 TTL/一次性 nonce/可撕；**不含主密钥**）与可选 libp2p
>   `/mebular/join/1.0.0` 请求-签发协议：**任意在册设备**可作 inviter 签发委派证书。

- **策略事件类型与命名空间**：保留命名空间 `__policy__`；事件类型 `namespace_grant` / `namespace_revoke` / `device_revoke` / `policy_issuer_declare` / `namespace_membership` / `namespace_handoff`。
- **2c 重订阅恢复（reset）**：退订清理后重入须同时满足 ①本机对该分区有**生效授权**（`getEffectiveNamespaces(self)` 含该分区；默认拒绝不变）②成员**重新在册**；否则**显式失败**。重入写**图外** `<storagePath>.rejoin.<ns>.json` 标记（**不同步/无 tombstone**）并清本机该分区本地水位；本机 hello 以**空时钟**上报显式订阅的分区 → 对端按「自报水位**只允许向下修正**」从 0 重发（或按既有“空水位”门禁发初始快照，**门禁不放宽**）。**不新增同步协议、不产生 tombstone、不改 `__policy__`**（oracle-free）。**破坏性/前向差异**：旧节点无“向下修正”语义 → 对旧端重入只可能**少收**（安全方向），需同版本互通。
- **2b 退订交接（`namespace_handoff`）**：退订 = 成员资格退出（`namespace_membership(active:false)`）+ **本地彻底清理**该分区事件/节点/边与本地水位。**绝不产生 tombstone**（无任何“已删除”事件）。**清理前必须**继任者全量 ack（复用 per-event ack `getPendingEvents`，含退订方作者计数；**不新增同步协议、不放宽快照门禁**）；门禁不过 → **保持原状**。**`__policy__` 永不清理**（策略/成员/交接记录保留 → 清理不改变策略推导，legacy-empty 不退化）。`force` **仅本地 CLI**（不经 MCP/远程），仍**如实**记录 `forced:true` 与缺失明细。意图记录落在**图外**（`<storagePath>.handoff.json`）以保证崩溃后可**幂等续跑**。
- **M1–M3 成员资格（`namespace_membership`）**：`{ member, namespace, active, issuedAt, note? }`；只采纳链到主密钥且签发者/成员未被 `device_revoke` 吊销的记录（**无条件采纳，不做 R-a**）；`(namespace, member)` 取 **R-c 最新**记录的 `active`（在册/注销）。**生效成员 = active 成员 ∩ 该设备对该分区的生效授权**；成员记录**不得**放宽授权（默认拒绝不变）。**裁剪链**：对端授权 ∩ 对端成员资格 ∩ 本机订阅声明；hello 订阅声明仅作活跃性/一致性校验，不一致 **显式拒绝/告警**（`sync-completed.membershipRejected`）。**legacy-empty**：分区无成员记录时按 hello 订阅裁剪（兼容）。
- **规则 R-a/R-b/R-c/R-d**：
  - **R-a 不可越权授予**：签发者须属于**生效引导集合**（图上被采纳的 `policy_issuer_declare` 主体 ∪ 本地配置 `sync.policyIssuers`），或**当时**已获授权其声明的**全部**分区。
  - **C1 引导签发者声明（`policy_issuer_declare`）**：签发者与主体均未被 `device_revoke` 吊销时，**无条件采纳**（不做 R-a，故与不动点无循环依赖）；被吊销的签发者（R-b 含历史）或被吊销的主体 → **不采纳**。伪造/非本用户主密钥链的记录在校验阶段被忽略。
  - **R-b 吊销连坐（含历史）**：被吊销签发者的记录**一律不采纳**——其历史 `grant`、它发出的 `device_revoke` / `namespace_revoke`。**自吊销（`subject === author`）不采纳**（语义未定义；吊销须由其他设备发起）。
  - **R-c 逻辑时间定序**（见红线 2），不看墙钟。
  - **R-d grantId 精确撤销**：被 `namespace_revoke` 撤销过的 grantId **永久失效**；恢复必须用**全新 grantId**（复用旧 grantId 的「伪恢复」无效）。吊销**非终态**。
- **`derivePolicyState` 迭代上限 = 输入的确定纯函数** `iterationBound(entries) = 2·|entries| + 2`。**这是协议语义**：只用输入规模，不依赖配置/环境/时钟 → 同一输入在任何端得到同一上限。
- **未收敛 = fail-closed 两轴保守回退**：`revokedGrantIds = ∅`（不采纳任何 revoke）且 `revokedIn = 各轮吊销并集的闭包`，迭代直到输出 **`revoked ⊆ excluded`**（R-b 在回退路径**字面成立**）；绝不 fail-open。`PolicyState.converged = false` 可观测（含 `iterations`）。
- **`maxIterations` 不可由生产注入**：`GraphNamespacePolicy` 构造**无**该选项，生产恒用 `iterationBound`；`DerivePolicyOptions.maxIterations` 标注 `@internal`，**仅测试专用**。
- **水位持久化格式 v2**：`.sync-state.json`（`namespaceClocks` 分区水位 + per-event ack 集合 + `snapshotApplied`）。
- **默认拒绝与裁剪链**：`sync.peerNamespacePolicy` 未列出 = 拒绝（空数组 = 明确不允许）；裁剪链 = **对端授权 ∩ 对端成员资格 ∩ 本机订阅声明**（M1–M3；成员资格未启用时退化为对端订阅声明），同时作用于 **offer 与初始快照**。拒绝非静默（`sync-completed.denied`；成员不一致 → `sync-completed.membershipRejected`）。
- **订阅声明**：`sync.namespaces` 声明本机订阅；未配置/空 = 参与全部。声明随 `sync-hello` 以 `subscribeAll` + `namespaces` **必填**下发；**缺字段/类型错视为协议违例并中止会话**；`subscribeAll=false` + 空清单 = 明确不订阅任何分区。
- **`sync-nudge` 帧无载荷**；携带业务载荷视为协议违例。
- **推送/兜底默认值**：`pushOnWrite` 与 `antiEntropy`——库/嵌入式 **关**，常驻（`serve` / MCP）**开**。anti-entropy 默认 `intervalMs = 10min`、`jitterRatio = 0.2`（±20%）；无 pending **短路跳过**、会话在途跳过、失败指数退避、jitter 防齐步走。push-on-write 节流 50ms 合并。
- **生效引导集合 = 图上声明 ∪ 本地配置**（C1）：`sync.policyIssuers` 为**兼容回退/bootstrap**，缺省空；
  **不再要求各端一致**——图上 `policy_issuer_declare` 会随 `__policy__` 同步到各端，任一端无需本地配置
  即可采纳同一签发者。混跑旧节点时，旧节点仍需本地配置（见本 § 顶部 C1 说明）。

## 4. 推迟项（本轮封板明确不做）

- **F/G 剩余**：
  - **G（快照的完整冲突/合并语义）**：放宽「初始快照只发自报空水位的对端」（§2.6）前必须先补齐的部分——
    物化快照当前只做接受侧**回退保护**与「严格更新」门禁，**不做逐事件的冲突裁决/合并**。
  - **F（多应用协议）**：在同一记忆/传输基底上承载**多种应用级协议**（各应用自定事件类型与语义，共享同步/策略/授权基座）。
    **⚠️ F 为候选定义、待用户确认**：仓库内 F1–F4 是修复编号，未找到 F 族的原始定义。
- **会话多路复用**。
- **quorum / 阈值签名**（多签发者已有，但无门限）。
- **`expiresAt` 强制生效**（字段已预留，不引入跨端时钟依赖；移入 fleet MVP 范围）。
- **fleet（`@mebular/fleet`）已落地 M0–M4**（**不改 core/SEALING 语义**）：M0 骨架/边界、M1 协议模型（事件/状态机/本地配额 + 不变量 harness）、M2 单机双进程（spool）、M3 真实 libp2p + 记忆同步、M4 **agent 路由**（注册表 + Command/Hermes 适配器）与**三种协作形态模型**（审查 DAG / 有限协商 / 配额制闲聊 + 矩阵 + 随机 harness）。
  入口见 `packages/fleet/DESIGN.md`、`PROTOCOL-INVARIANTS.md`、`RUNBOOK.md`。**OpenChamber 会话接缝：已解决**（provider #1 = 桥 daemon `POST /agent/run-once`；provider #2 = Self-Skills `skills/oc-node-provider` 的 Node 版，复用 `oc-bridge.js`，Windows 无需 Python/Hermes；fleet 侧 `HttpOpenChamberSeam` 保持中立——替换 provider 不改 fleet 代码，见 `packages/fleet/OPENCHAMBER-SEAM.md`）。**剩余推迟**：执行器生产化/运维细节（可选）。**协作形态 live 通道接线（1d）已完成**。
- **自动事件裁剪**：本期只固化约束与测试——**任何裁剪必须排除尚未被所有已授权对端 ack 的事件**，不实现裁剪。
- **信任模型 v2（委派证书链 + 加入令牌）已落地**（T2；契约见 §1.3、§3；验收见 S2 报告）。**剩余**：吊销的**全网传播延迟**（`device_revoke` 级联在策略层即时，但需事件同步到达各端才生效）与**跨 NAT 实测回填**。

## 5. 已知边界（有意取舍 / 需人工关注）

- **回退残差 ≤2%（非安全缺陷）**：harness 的非收敛回退路径上，扰动检查残差实测全部为「原世界回退（`converged=false`）、扰动后世界收敛（`true`）」——**世界不同**，而非回退结果里存在被采纳的被吊销者记录；回退本身由闭包不变量 `revoked ⊆ excluded` 保证 R-b 字面成立。harness 逐条打印 `[residual] …` 供复核。
- **设备吊销轴偏保守**：回退会排除更多签发者 → 可能**少授权**（安全方向，非放宽）。
- **不动点成本**：主循环最坏 `O(iterations · |entries|)`，`iterations ≤ 2·|entries|+2` → 对输入规模最坏近似 `O(n²)`；策略事件通常很少。
- **吊销是域收缩**：不回撤**已入图**数据，也无法强制远端停止；它阻止的是**后续摄入**（读侧 `[]` + 入站事件隔离 + 快照过滤）。被吊销设备**仍可建立会话**（否则无从得知恢复）。
- **保留命名空间可见性代价**：`__policy__` 对已认证设备（含被吊销者）可读，授权图可见（见 §1.7）。
- **跨会话重复发送**是设计（见 §2.4）；`duplicates` 接近 `sentEvents` 且量很大时，多半是本机同步状态被重置/丢失过——用 `mebular.resetPeerWatermarks(peerDeviceId?)` 修复（只清水位、不动 per-event ack，方向安全）。
- **服务日志无自动轮转**：`fleet service logs` 读取的常驻日志**不自动截断/轮转**，长期运行需人工 `logrotate`/定时清理（后续可补内建轮转；见 `packages/fleet/ONBOARDING.md` §10）。
- **文档一致性**：README 的测试/覆盖数字（现为 **94 套件 / 734 用例**、行 ~93% / 分支 ~81%）、anti-entropy 口径（代码默认 `10min ±20%`，即 `intervalMs 600000`）与推迟项引用（原「未做项」）均已对齐；Agent（skill + MCP）接入用法见 README「30 秒上手 · 路径一」。

## 6. 复现封板基线（可复核）

```bash
git rev-parse origin/main^{tree}        # d1eb7d2c5ffa87eed6c64d70ce8aed3a6ceeb333
npm run build && npm run lint           # 无输出
npm test                                # 67 suites / 542 tests 全绿
npm run test:coverage                   # All files 行 ~92.4% / 分支 ~79.3–79.5%（门槛 85/65）
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/sync/policy-invariants.test.ts
# [policy-invariants] scenarios=300 nonConverged=6 residualA=4 residualB=0
```

**红→绿抽验（R-b 历史连坐）**：临时把 `src/sync/grantPolicy.ts` 的
`revokedIn.has(entry.author) || ` 去掉 → `jest tests/sync/grant-policy.test.ts -t "R-b 历史连坐"` 应 **✕**；
`git checkout -- src/sync/grantPolicy.ts` 还原后应 **✓**。完成后工作区必须干净。
