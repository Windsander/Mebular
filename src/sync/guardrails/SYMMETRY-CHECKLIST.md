# 对称性自证清单（C2 · 护栏包③）

> **性质**：只读审计。基线 `main@bbc2e13`。
> **对象**：「两侧各自计算、期望一致」的机制。本清单逐条给出**对照方法**（如何在现场把一个
> 机制的两侧计算放一起比）、**断言**（可自动化的判据）与**告警**（不一致时如何可见）。
> 目标不是新增协议，而是让既有机制的「不一致」从静默变为可诊断。
> 姊妹文档：`SILENT-POINTS.md`（C1）、`MIXED-VERSION-POLICY.md`（C3）、`TEST-MATRIX.md`（C5）。

## 0. 总表

图例：**对照** = 现场取证方式；**断言** = 可写进测试/巡检的判据；**告警** = 异常出口。

| # | 机制 | 两侧各自算什么 | 期望 | 对照方法 | 断言（可自动化） | 告警出口 | 现状锚点 / 缺口 |
|---|---|---|---|---|---|---|---|
| ① | **角色仲裁**（谁发起会话） | A：`isA_low = self < peer`；B：`isB_low = self < peer`（`SyncManager.ts:996`） | 恰好一侧发起：`initiate(A) ≠ initiate(B)`；发起方发 hello、响应方等 hello | 双端 debug 日志打印 `(peerDeviceId, initiate)`；daemon 形态可经 `/app/network` + 日志；单测用两种身份形态注入 | 单测：同一 `(deviceIdA, deviceIdB)` 对，双端 `initiate` 互补；行为断言：会话完成（发起方 `sentEvents` 或响应方 `receivedEvents` 非零/协议帧序正确） | 会话反复超时/`sync-failed` 且 hint = 双发起/双响应 | 无显式互补断言；测试经「会话完成」间接覆盖。**缺口：形态错位（SP-01）会让仲裁错位且无直接信号** |
| ② | **身份解析**（三名字） | 传输层 libp2p id ↔ 应用层 peerId（sha256 公钥 hex）↔ 证书 deviceId（`P2PNetwork.ts:224, 516-526`；`Libp2pProvider.ts:279-307`） | 全链路以 `certificate.deviceId` 为唯一权威；`peerId = sha256(设备公钥)` 是可验证的数学映射 | 握手后本地恒等式检查：`peerIdFromDevicePublicKey(cert.devicePublicKey).id === connection.peerId.id`（当连接键为 hex 形态时）；`peerDeviceIds` 映射表随日志打印 | 单测：三种入口（按 deviceId 拨、按 hex 拨、入站）最终解析到**同一** deviceId；`peerDeviceIds.get(peerId.id) === cert.deviceId` | `identity-unresolved` / `identity-mismatch` 计数（SP-01/02）；审计视图 | `peerDeviceIds` 学习已落地（`P2PNetwork.ts:516`）；**缺口：无恒等式断言、无计数**（P1 修复的「身份不变量⑧」将补） |
| ③ | **分区水位**（缺失判定） | A 维护 `peerWatermarks(peer, ns)`；B 维护本地 `namespaceClocks`（作者自身计数，`SyncManager.ts:1134-1153`；缺失判定 `:1214-1228`） | A 判定「B 缺什么」与 B 实际持有一致；B 自报不高于实际 | 会话结束交换 `finalVectorClock`（`sync-done`）；A 侧比对 ack 集合 vs 水位推进；B 侧比对收到集合 vs 自报 | 单测锚点已有：F1 作者自身计数、R1 自报不抬升、R2 向下修正、扩权回补；断言「A 发集合 ⊆ B 缺失集合（以 B 最终时钟复核）」 | `reportedAhead`（已发未接线，SP-29）；向下修正计数（SP-24） | 不变量执行好（`1062-1077`）；**缺口：跨端对账缺自动化**（P3 stateHash 对账补） |
| ④ | **快照门禁与水位推进** | A 依据 B 自报「空水位」决定发快照（`SyncManager.ts:766-778`）；B 应用后 ack `snapshotApplied`；A 收到 ack 才推进水位（`F4`，`:789-791`） | 「A 以为 B 已有」不早于「B 真的已应用」 | 会话日志：`snapshotSent` / `snapshotApplied` 成对；水位推进仅在 ack 后 | 已有测试：F4 正反例（`namespace-watermarks`）；断言「无 ack ⇒ 水位不推进」可重放 | 频繁「发快照但 ack 缺失」→ 会话日志 + `sync-failed` | 锚点完备（R2/R3/F4 + 快照裁剪测试）；低缺口 |
| ⑤ | **成员生效集合**（M2） | A：`getNamespaceMembership(ns).members`（发送闸门）；B：自认「我在册」并写活跃声明 | 两端对「谁在册」目的一致；不一致时**至少一端有信号** | 现有单向信号：B hello 声明订阅 + A 判定非成员 → `membershipRejected`（A 侧 `SyncResult`）；反向（B 自认成员、A 不认）**无信号** | 单测锚点：M1/M3（成员采纳、注销、显式拒绝）；断言：A 的 `membershipRejected` 非空 ⇔ B 的成员视图不含 B 声明分区 | 接线 `sync-membership-rejected`（SP-31）+ 接收方「自认成员却连续 N 轮零到达」计数（P3） | 锚点：`membership.test.ts`、POLICY-INVARIANTS §9；**缺口：接收方侧对账**（C2 新增建议） |
| ⑥ | **裁剪链 allow**（T2） | A 计算 `对端授权 ∩ 本机订阅 ∩ 对端订阅/成员`（`SyncManager.ts:1160-1194`）；B 无同构计算（只能观察结果） | A 的发送集合 ⊆ B 期望收到的集合；拒绝时 B 能区分「没被授权」与「没数据」 | A 侧 `denied` / `membershipRejected` / `reportedAhead` 已入 `SyncResult`；B 侧可用自身图上授权（`getEffectiveNamespaces(self)`）做**独立期望** | 断言：若 B 视图「我被授权 ns X 且订阅 X」且 A 已在线 ≥ N 会话，则 B 应收 `X` 的增量或见到 A 的 `denied` 为 false；否则告警 | SSE 携带 `denied`（SP-29）+ B 侧「期望有数据但零到达」计数 | A 侧信号齐（除出口，SP-29）；**缺口：B 侧独立期望与对账**（P3 建议） |
| ⑦ | **授权状态**（derivePolicyState） | A、B 各从**各自的** `__policy__` 事件集推导 `authorized/revoked/issuers/members`（`grantPolicy.ts:539-591`） | 同一事件集 ⇒ 逐字节一致（确定纯函数；`iterationBound` 属协议语义） | 对 `(authorized, revoked, issuers, members)` 做**确定性序列化 hash**（排序后），跨端比对；`__policy__` 事件集本身做集合 hash | 单测：同输入一致（已覆盖）；跨端：`stateHash` 对账（P3 主计划）；断言「共同事件集 ⇒ 同 hash」 | 对账不一致 → 未收敛/版本混用/事件缺失告警；`converged=false` 计数（SP-13） | 单端确定性锚点完备；跨端有**一次性**脚本（`verify-mcp-cross`，非 CI）；**缺口：周期性对账（P3）与 `converged` 出口（SP-13）** |
| ⑧ | **吊销隔离**（读侧 vs 写侧） | A（读侧）：被吊销 → `getAuthorizedNamespaces=[]`（不发）；B（写侧）：被吊销作者事件不应用（`SyncManager.ts:1339-1342`） | 同一 `revoked` 集合下：A 不发 ∧ B 不收；「发了但被拒」或「根本没发」都应可见 | 双计：A 侧「不发」计数（现有 `denied` 间接）；B 侧 `revokedRejected`（SP-17 建议）；比对「A 认为在发的 vs B 拒收的」 | 断言：B 收到被吊销作者事件数 > 0 ⇒ 必有 A 侧误判（A 的 revoked 视图缺记录）；反之 B 拒收计数持续增长 ⇒ B 的视图超前/误判 | `revokedRejected` 计数 + `sync-failed` 诊断 | 测试锚点 `event-trust-revocation`；**缺口：双计与比对**（SP-17） |
| ⑨ | **legacy-empty 判定**（成员资格是否启用） | A 判「该分区有无被采纳成员记录」；B 同样（各自图） | 一致 ⇒ 语义相同；不一致 ⇒ 允许的方向是「A 严 B 松 → 少收」，**不允许**「A 松 B 严 → 多收」 | 两侧 `getNamespaceMembership(ns).active` 对账（admin API 已有 `app/policy/membership`）；hello 声明与闸门结果比对 | 断言：A 的 `membershipRejected` 非空 ⇔ 两端 `active` 判定不一致（或 B 未写声明）——该信号已可判别 | `membershipRejected`（接线后）+ 两端 `active` 巡检对比 | 语义在 POLICY-INVARIANTS 固化（legacy-empty 安全方向）；**缺口：巡检对比工具** |
| ⑩ | **配置面一致性**（各端配置） | `sync.policyIssuers`（跨端一致语义；C1 后配置仅 bootstrap，图上声明可覆盖——混跑旧端或依赖配置时仍须一致）；`peerWhitelist`（本地）；`subscriptionNamespaces`（本地）；`peerNamespacePolicy`（本地引导） | `policyIssuers` 生效集合的**声明白名单语义**跨端可解释；其余本地语义（union/裁剪）不要求 | `getPolicyIssuers()`（图上声明 ∪ 配置）跨端比对——已有只读入口（`mebular.ts:808-810`；守护侧 `admin.mjs:363` 已用于总览）；whitelist 不一致会表现为「对端在线但零同步」 | 断言：跨端 `getPolicyIssuers()` 集合相等（或差异可由图上声明解释）；whitelist 配置校验脚本 | 巡检报告；doctor 呈现 | `verify-daemon` 覆盖部分；**缺口：跨端对比脚本**（列入 C5 可自动化项） |
| ⑪ | **push / nudge 触发** | 发起方收 nudge 起会（`:474-479`）；响应方发 nudge（`:441-452`） | 触发不对称成立（与 ① 同命）；nudge 丢失/非法应可见 | PeerFrames `onNudge` / `onInvalidNudge`（回调已定义，`PeerFrames.ts:16-23`） | 断言：响应方「发 nudge 次数」≥ 发起方「收 nudge 次数」（差值 = 在途/丢失，debug 计数） | `onInvalidNudge` → `sync-failed`（`SyncManager.ts:1027`）+ 计数 | 回调存在；**缺口：计数与比对**（SP-21） |
| ⑫ | **吊销级联分层**（握手 vs 策略） | 握手层（可选注入 `revocationCheck`，`AuthenticationHandshake.ts:96-112`）只做密码学；策略层做吊销判定（`SyncManager.ts:1390-1399`） | 分层有意：握手放行（为恢复留路）、事件/授权拒绝；**任一层单方面过宽/过严都是缺陷** | 断言：被吊销设备握手可过（记录级）但①其亲签事件被拒、②读侧授权为 `[]`；恢复（新 grant）后两者解除 | 测试锚点：`event-trust-revocation`、`cert-chain`；断言「握手拒绝 ≠ 吊销」分类错误（错误码区分） | 握手层错误码与策略层计数分开 | 分层语义有注释、有测试；低缺口 |
| ⑬ | **stateHash 对账**（P3 锚点） | 每端计算共同域 `stateHashByNamespace`（`src/core/stateHash.ts` 已存在） | 共同域（如 `__policy__`、已收敛分区）hash 相等 | 直接比对两端 hash 值（脚本可做） | 断言：静止窗口后两两相等；差异 → 定位到分区/水位 | P3 收敛健康度面板 | 原语已存在；**一次性**跨网验收已有（`scripts/verify-mcp-cross.mjs` 共同域判据，非 CI；逻辑由 `tests/wan/mcp-cross.test.mjs` 覆盖）；**缺口 = 周期性对账与停滞呈现（P3 收敛健康度波次）** |

## 1. 建议的落盘顺序（与 C1 优先级对齐）

1. **P0/P1（随键控修复）**：① 的显式互补断言、② 的身份恒等式断言（这两条正是 P1「身份不变量⑧」
   的组成部分）；⑤ 的接收方信号与⑦ 的 `converged` 出口（P1 只做键控，本两条排 P2 队列）。
2. **P2（可观测性）**：④⑧ 的双计、⑥ 的 SSE 携带 `denied/reportedAhead/membershipRejected`、
   ⑩ 的跨端 `policyIssuers` 对比脚本。
3. **P3（收敛健康度波次）**：③⑦⑬ 的 stateHash 对账 + ⑤⑥ 的接收方「期望却零到达」计数。

## 2. 编写约束（给未来实现者）

- **不新增协议**：所有判据只用既有帧（hello/ack/sync-done）与既有本地状态；跨端对账走带外
  （脚本/审计 API），不得借 `__policy__` 或用户分区夹带对账数据。
- **告警方向**：任何对账差异的默认动作是**告警 + 保持既有安全语义**（默认拒绝/少收），
  **绝不**因对账差异放宽授权或水位。
- **计数命名**建议统一 `kebab-case`，随 `SyncResult` 扩展时保持可选字段（库 API 向后兼容）。
