# 静默点全清点（C1 · 护栏包②）

> **性质**：只读审计（不改任何产品逻辑）。基线 `main@bbc2e13`（行号以该版本为准）。
> **范围**：全链路 —— p2p（发现/连接/握手/信道）→ sync（会话/裁剪/apply/水位）→
> 信任与授权（trust / grantPolicy / autoGrant）→ 守护接线（packages/mcp）。
> **方法**：对上述目录逐文件人工通读 + `catch`/`.catch(`/`??`/`continue`/`return`
> 等模式全量检索，逐条确认「确无计数/日志/结果字段/告警出口」才计入。
> **姊妹文档**：`POLICY-INVARIANTS.md`（策略推导不变量）、`SYMMETRY-CHECKLIST.md`（C2）、
> `MIXED-VERSION-POLICY.md`（C3）、`STAGE-SCOPE.md`（C4）、`TEST-MATRIX.md`（C5）。

## 0. 图例与结论摘要

**类型**：
- **丢弃**：事件/帧/记录被有意跳过，但不产生任何可观测信号；
- **兜底**：权威值缺失/异常时退回次级值继续执行，退化不可观测；
- **失败**：操作失败被吞掉，调用方/用户无从得知。

**优先级**（出口建议的实施顺序，不是缺陷严重度）：
- **P0**：与「键控缺陷」同源，参与造成「事件永不落图」类故障（P1 修复直接覆盖）；
- **P1**：数据面静默丢失/静默拒绝，已有安全语义但缺信号，可导致排障失明；
- **P2**：诊断/运维可观测性缺口（无安全后果，但故障不可解释）；
- **P3**：体验/未来健康面板（P3 收敛健康度波次顺带落地）。

**摘要统计**：共清点 **42** 条。其中 P0 = 2、P1 = 7、P2 = 14、P3 = 14、有意静默（已复核、
无需变更）= 5。最值得优先的：**SP-01 / SP-02**（身份与公钥兜底，P0）与
**SP-04 + SP-12 + SP-13**（认证失败/信任过滤/策略推导异常无任何出口，P1）。
同时发现 **3 类「已发声但无人听」的信号**：`auth-failed`（握手层）、`sync-membership-rejected`、
`connection-timeout`/`dial-retry-scheduled`（见 SP-04、SP-31、SP-07 备注）——信号存在但全仓
无消费者，等价于静默。

---

## 1. 连接与身份（p2p）

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-01 | `src/sync/syncmgr/SyncManager.ts:988` | 兜底 | `peerDeviceId = session.certificate?.deviceId ?? session.peerId.id`：证书缺失时静默退回「对端会话键」（可能是 libp2p id / hex peerId / 人工传入串三种形态之一）。角色仲裁、白名单、直连快路径全部基于该值——形态错位即静默失配（#122 缺陷同源）。 | P1 修复删除兜底：取不到 `certificate.deviceId` ＝显式失败 + 计数（`identity-unresolved`）+ `sync-failed` 事件。 | **P0** |
| SP-02 | `src/sync/syncmgr/SyncManager.ts:992-994` | 兜底 | `publicKey = session.certificate ? hexToBytes(...) : session.peerId.pubKey`：无证书时退回 `peerId.pubKey`——daemon 按地址拨号场景该字段是**空占位数组**（`config.mjs:262` 构造 `{id, multihash: new Uint8Array(), pubKey: new Uint8Array()}`）。后果：对端亲签事件验签必然失败，且报错是误导性的 `signature verification failed`。 | 同 SP-01：无证书即显式失败；错误信息区分 `identity-missing` 与 `signature-invalid`。 | **P0** |
| SP-03 | `src/sync/syncmgr/SyncManager.ts:989-991` | 丢弃 | `peerWhitelist` 未命中 → `return`，无计数/日志。白名单是字符串精确匹配；一旦 `peerDeviceId` 形态错位（SP-01），**整台对端的同步被静默关闭**。 | 命中检查失败时 debug 日志 + 计数（`whitelist-dropped`）；与 SP-01 修复联动。 | P1 |
| SP-04 | `src/p2p/P2PNetwork.ts:731-751, 850-856`；`src/p2p/handshake/AuthenticationHandshake.ts:307, 386` | 失败 | 入站认证失败：`handleIncomingConnection` catch 后仅关连接 + 调用 `P2PNetwork.emit('auth-failed', …)`——该 `emit` 是**空壳**（`:854 void args`）。握手层的 `auth-failed` 事件同样**全仓无监听者**。后果：任何入站认证失败（证书过期、链不完整、nonce 验签失败）完全不可见，机器人在 LAN 上被拒也无从诊断。 | 两处 emit 接到公开事件流（`onWarn`/事件总线）+ 计数（按原因分类）+ 控制台呈现。 | P1 |
| SP-05 | `src/p2p/P2PNetwork.ts:786-794` | 失败 | 加密信道建立失败：`started.catch` 仅把表项删掉（供重试），无日志/计数。消费方要等到 `getChannel` 轮询超时（默认 5s，`873-892`）才以 `Secure channel not ready` 报错。 | `onWarn` + 计数（`channel-establish-failed`）；错误挂上对端 id。 | P2 |
| SP-06 | `src/p2p/P2PNetwork.ts:448-459, 516-526, 548-630, 699-706`（8 处） | 失败 | 地址簿 `upsert`/`alias`/`remove` 全部 `.catch(() => undefined)`（connectToPeer 学习、握手学习、LAN 发现/撤销、直连升级）。地址簿写失败（磁盘满/权限）使自动选路静默退化回显式地址。 | 计数 + 节流告警（写失败率）；地址簿本身是 hints，保持非致命。 | P2 |
| SP-07 | `src/p2p/connection/ConnectionManager.ts:226-234` | 失败 | 退避重拨 `this.connect(peerId).catch(() => undefined)`：重拨再次失败静默（等下一次退避）。`dial-retry-scheduled` 事件已发但**全仓无监听者**。 | 计数（attempts/success/fail）+ 接到告警出口；配合 doctor 呈现「正在退避」。 | P2 |
| SP-08 | `src/p2p/connection/EndpointBook.ts:109-117` | 失败 | `FileEndpointStore.load` 读失败/损坏 → **静默返回空簿**；后续任何 `upsert` 都会用「空簿 + 新条目」覆盖原文件——历史候选**不可逆丢失**（peer 仍可被重新学到，但 relay seeds / 配对 hints 丢失需要重配对）。 | 读损坏时备份原文件（rename `.bak`）+ 计数 + 告警；空簿标记 `loaded=false` 阻止立即覆写。 | P2 |
| SP-09 | `src/p2p/transport/Libp2pProvider.ts:636-649` | 丢弃 | 入站流：无上层 handler 或 peerId 非 Ed25519 内嵌形态 → 直接 `close()`，无日志/计数。后果：拨进来的陌生/坏格式对端被拒原因不可见（红队/互操作排查困难）。 | 计数（`rejected-inbound`，按原因）+ debug 日志。 | P3 |
| SP-10 | `src/p2p/transport/Libp2pProvider.ts:655-661` | 失败 | relay 预约（best-effort dial）失败静默：靠上层读 `getMultiaddrs` 是否含 `/p2p-circuit` 间接判断。 | 计数 + onWarn；doctor 呈现「relay 预约未成功」。 | P3 |

## 2. 握手与信任

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-11 | `src/sync/trust.ts:25` | 兜底 | `if (!userMasterPublicKey) return false;`：**未配置用户主公钥时，一切「非直连」事件验签静默失败**。两处后果：① 同步会话中止，错误是误导性的「signature verification failed」（实际是信任根未配置）；② `GraphNamespacePolicy.snapshot` 的逐条过滤（`grantPolicy.ts:561`）把**全部策略记录静默忽略** → 全域授权静默归零（默认拒绝兜底，但用户看到的是「授权莫名失效」）。 | ① 两个调用点区分「无信任根」与「验签失败」；② 配置期显式告警：存在 `__policy__` 事件或启用网络却无主公钥；③ 计数（`trust-root-missing`）。 | P1 |
| SP-12 | `src/sync/grantPolicy.ts:555-566` | 丢弃 | `snapshot()` 对 `__policy__` 逐条信任过滤：非可信记录**静默丢弃**，无计数。伪造/别家主密钥签发的策略记录被忽略（语义正确），但「有一条被忽略的记录」本身是安全事件，当前零信号。 | 计数（`policy-records-ignored`，可按原因细分 shape/trust）+ 审计视图呈现；异常增长告警。 | P1 |
| SP-13 | `src/sync/grantPolicy.ts:469-531` | 兜底 | `derivePolicyState` 未收敛（迭代超上限）→ 两轴保守回退，`PolicyState.converged=false` 但**全仓无任何消费者**（仅测试断言）。保守回退可能「少授权/少恢复」——即真实授权被静默降级，用户无从知晓。 | `converged=false` 时间点计数 + warn 日志 + 审计呈现；调用方（GraphNamespacePolicy）汇总暴露。 | P1 |
| SP-14 | `src/sync/grantPolicy.ts:206-245` | 丢弃 | `parseEntries` 对形状不合规的记录（缺 `grantId`/`subject`/`member`/`active` 等）静默跳过（前向兼容设计）。 | 计数（`policy-records-malformed`）；版本收敛时可断言为 0。 | P3 |
| SP-15 | `src/eventlog/EventLog.ts:76` | 兜底 | 无签名者（library 形态未配置 signer）时 `signature: ''` 静默产出**未签名事件**：本地 append 成功、事件 ID 正常，但对端一律拒绝。生产门面（Mebular.initialize）始终配 signer，此路径是库形态误用/测试漏配的温床。 | 无 signer 时 append 记 warn（或按产品口径 fail-fast）；计数（`unsigned-events`）。 | P2 |
| SP-16 | `src/sync/trust.ts:40-44`；`src/p2p/handshake/AuthenticationHandshake.ts:434-450, 522-545, 584-596` | 失败 | 各类密码学验签 catch → `false`。**fail-closed，是期望语义**（负路径的结果本身是信号）。 | 无需变更；若排障需要，可在 debug 级附原因。 | 有意静默 |

## 3. 同步会话（sync）

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-17 | `src/sync/syncmgr/SyncManager.ts:1339-1342` | 丢弃 | E·入站吊销：被吊销设备署名的事件「不应用、不入库、不 ack」——`continue` 无计数无日志。会话正常完成、双方都无信号：发送方（不知情）永久重发，接收方永久丢弃。 | session 级计数（`revokedRejected`）进 `SyncResult` + 日志；累计告警（同源持续重试 = 对端状态错误）。 | P1 |
| SP-18 | `src/sync/syncmgr/SyncManager.ts:1347-1362` | 丢弃 | `applyRemoteEvent` 返回 `'stale'`（时钟落后/并发落败/墓碑保护/标签无处安放）不计数、不上报；只有 `'applied'` 与 `duplicates` 有计数。大量落败事件在诊断上不可见。 | 计数（`stale`，可选按子原因）进 `SyncResult`。 | P2 |
| SP-19 | `src/sync/syncmgr/SyncManager.ts:1441-1471` | 丢弃 | `applySnapshot`：被吊销署名实体 `continue`（1449/1455）；`shouldApplySnapshotEntity==false`（本地更新不回退，1450/1456）`continue`。二者都无计数，只有 `applied` 计数。 | 计数（`snapshotSkippedRevoked` / `snapshotSkippedLocalNewer`）进 `SyncResult`。 | P2 |
| SP-20 | `src/sync/syncmgr/SyncManager.ts:938-943, 963-970, 1039-1042` | 失败 | 常驻循环内单次会话失败被吞（仅依赖 `runSession` 的 `sync-failed` 事件，`1535`）。library 形态默认无监听者 → 静默；mcp 形态有 SSE（`serve.mjs:820-821`）但仅透出 message 字符串（无计数/无对端分类）。 | 门面/守护默认接监听汇总计数（按 peer × 原因）；SSE 携带结构化错误码。 | P2 |
| SP-21 | `src/sync/syncmgr/PeerFrames.ts:45-53` | 丢弃 | ① 会话进行中的 `sync-nudge` 直接丢弃（设计使然，那一轮本就会同步）；② 非法 nudge 走 `onInvalidNudge` 回调、上层未接则丢。 | ① 计数（debug）；② 默认接到 `sync-failed`/告警（已是回调，接线即可）。 | P3 |
| SP-22 | `src/sync/syncmgr/SyncManager.ts:420-427` | 丢弃 | push-on-write 时「未授权 → 不发」的 `return`（默认拒绝语义正确）无任何信号；与「没有 pending」的静默跳过不可区分。 | debug 计数（`notify-skipped{unauthorized,no-pending}`）。 | P3 |
| SP-23 | `src/sync/syncmgr/SyncManager.ts:1264-1283` | 丢弃 | anti-entropy 周期性跳过（backoff / 无 pending / 会话在途）不计数。定时兜底是「静默点最终防线」，它自己为什么不动作应当可见。 | 计数三类跳过原因（P3 收敛健康度直接消费）。 | P3 |
| SP-24 | `src/sync/syncmgr/SyncManager.ts:1100-1111` | 兜底 | R2 对端自报低于本机记录 → **静默向下修正水位**（设计使然，方向安全）。频繁触发意味着对端反复「丢失状态」（清理/重入/数据损坏）。 | 计数（`watermark-down-corrections`）；异常频率告警（P3 健康面板）。 | P3 |
| SP-25 | `src/sync/protocol.ts:71-78` | 丢弃 | `sync-nudge` 无版本协商：对不识别它的旧版本对端，第一个会话帧即协议违例（`nextSyncMessage` 抛 `SYNC_PROTOCOL_VIOLATION`）→ 会话中止 → 由重试兜底。属**跨版本静默陷阱**，规则见 C3。 | C3 政策：混合版本窗口内的降级规则 + 建议后续加法式版本标识（hello 可选字段）。 | P2 |

## 4. apply（冲突应用）

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-26 | `src/sync/apply.ts:97-100` | 丢弃 | 未知事件类型 → `{ status: 'stale' }`（前向兼容设计）。新端发新类型给旧端：旧端入日志（`appendRemote` 在 `applyOffer` 先入库）但不物化——**日志有、图无**，用户只见「数据没到」。 | 计数（`unknown-event-types`）+ 日志（版本收敛后应归零）。 | P3 |
| SP-27 | `src/sync/apply.ts:320-322, 356-358, 324-326, 359-361` | 丢弃 | 标签操作在「节点缺失/墓碑上」→ `stale` 静默（注释已解释为正常路径：节点创建事件携带全量标签）。 | 并入 SP-26 的 stale 计数（按子原因）。 | P3 |

## 5. 水位（watermark）

> 水位本身的不变量执行较好（只由 ack / 已确认快照推进，`SyncManager.ts:1062-1077`；
> 自报只向下修正，`:1100-1111`；`reportedAhead` 已作为诊断出口，`:1499-1502`）。
> 剩余静默点集中在「不发」一侧与出口链路。

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-28 | `src/sync/syncmgr/SyncManager.ts:1214-1228` | 丢弃 | 「对端水位 ≥ 本机事件计数 → 判定已同步、不发」：判定错误（水位被污染）时**静默永久不发**——唯一反向信号是 `reportedAhead`（且仅当对端自报更高时才有）。 | P3 周期性 stateHash 对账（收敛健康度）；本波记录。 | P3 |
| SP-29 | `src/sync/syncmgr/SyncManager.ts:1499-1502`；`packages/mcp/src/serve.mjs:809-814` | 丢弃 | `reportedAhead`/`denied`/`membershipRejected` 只进 `SyncResult`；守护 SSE 的 `sync` 事件只带 `peerDeviceId/sentEvents/receivedEvents`——三块显式信号**没有到达任何人类界面**。 | SSE 载荷补三个字段（纯展示、不改协议）；控制台同步日志呈现。 | P2 |
| SP-30 | `src/sync/syncmgr/SyncManager.ts:609-630` | 失败 | `loadSyncState` 损坏 → 诚实抛 `STORAGE_READ_FAILED`，**不静默重置**——全链路的正面样本，保持。 | 无需变更（作为其他静默点的整改范式）。 | 有意静默 |

## 6. 成员与授权（policy）

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-31 | `src/sync/syncmgr/SyncManager.ts:1174-1193` | 丢弃 | 成员闸门只覆盖一个方向：「对端自称订阅但非成员 → `membershipRejected`（已显式）」。反向——**「发送方认定我不在成员集 → 什么都不发」接收方零信号**；`sync-membership-rejected` 事件也已发出但**全仓无监听者**。 | 事件接线（告警/SSE）；接收方侧对账信号见 C2-④。 | P1 |
| SP-32 | `src/mebular.ts:1162-1168` | 兜底 | `ingestNetEndpointsEvent`：吊销集合读取失败 → `revoked = []` —— 安全判定**静默 fail-open**（仅影响 hints，不涉授权，但违反全仓 fail-closed 纪律，模板不良）。 | catch → 保守忽略该条 hint + 计数；专项回归锚点。 | P2 |
| SP-33 | `src/mebular.ts:1141-1155` | 失败 | `ingestNetEndpointsFromSync` 读事件失败吞掉；`netEndpointsStatus.ignored` 已分五类计数（好样板）但**读失败不在其中**。 | 计数补一类（`read-failed`）。 | P3 |
| SP-34 | `src/mebular.ts:687-709` | 失败 | 自动签发评估器三处 `.catch(() => undefined)`（首评/周期/会话触发）：评估抛错（如存储异常）静默——「订阅了但没被授权」的用户看到的是永远等待。 | 计数 + warn（或接 `sync-failed` 同形事件）；连续失败告警。 | P2 |
| SP-35 | `src/mebular.ts:875-884` | 兜底 | `hasRejoinReset` 读失败 → `false`：重置声明**静默丢失**（重入方不再上报空时钟，对端不重发，表现为「重入后拉不到历史」而无任何提示）。 | 除 `ENOENT` 外的读失败计数 + warn。 | P3 |
| SP-36 | `src/mebular.ts:918-940` | 兜底 | `readHandoffIntent` 读失败 → `null`：崩溃恢复意图静默失效（幂等重跑可自愈，但恢复路径偏离无信号）。 | 除 `ENOENT` 外计数。 | P3 |
| SP-37 | `src/sync/namespacePolicy.ts`（全文） | — | `ConfigNamespacePolicy`/`CompositeNamespacePolicy`：未授权一致返回 `[]`（默认拒绝显式），无静默点。 | 无需变更。 | 有意静默 |
| SP-38 | `packages/mcp/src/serve.mjs:1296-1302` | — | `findConnectionByDevice` 未命中 → 显式 409 `not_connected`（替代了旧的静默路径）。 | 无需变更（正面样本）。 | 有意静默 |
| SP-42 | `src/sync/grantPolicy.ts`（S1 `security.rejections`） | — | **新增安全门槛的拒绝不静默**：`PolicyState.security.rejections` 逐条携带 `{eventId, reason}`（§3.4E 八类），`admitted` 暴露有资格批准的设备；未收敛回退仍保留 `rejections` 与 `converged=false`。**不新增静默点**（证明缺失/无效、批准缺失或非因果、批准人位次吊销/未准入、approver=author/subject、nonce 重放均可见）。 | 无需变更；S2/S3 把 `security.rejections` 接到审计/安全卡/「需要注意」（只读）。 | 有意静默（正面样本） |

## 7. 守护接线（packages/mcp）

| ID | 位置 | 类型 | 现状与后果 | 出口建议 | 优先级 |
|---|---|---|---|---|---|
| SP-39 | `packages/mcp/src/config.mjs:257-266` | 失败 | daemon 启动按 `config.network.peers` 拨号：`connectToPeer` 失败 `catch {}`（注释「由后续 anti-entropy / doctor 暴露」）——但 anti-entropy 的跳过也静默（SP-23），首次连通性失败可能长时间无信号。 | 启动日志（成功/失败×对端）+ 计数；doctor 呈现拨号状态。 | P2 |
| SP-40 | `packages/mcp/src/serve.mjs:1843-1848` | 兜底 | `/app/join/invite`：请求体 JSON 解析失败 → `payload = {}` 静默默认（TTL 900s、默认 namespace）。调用方拿到「成功」但参数被吞。 | 返回 400（与其他路由一致）；至少计数。 | P3 |
| SP-41 | `packages/mcp/src/serve.mjs:800-806` | 失败 | SSE `send` 在 `res.write` 抛错时吞掉（连接已断开）。 | 无需变更（SSE 断连是常态）。 | 有意静默 |

---

## 8. 复用清单：把「已发声但无人听」的信号接上线

清点中发现三个**信号已存在、消费者为零**的点。它们比新增信号成本更低，建议并入 P1/P2 一起接线：

| 信号 | 发出点 | 目标出口 |
|---|---|---|
| `auth-failed`（握手层事件） | `AuthenticationHandshake.ts:307, 386` | 公开事件流 / `onWarn` + 计数；控制台设备页 |
| `sync-membership-rejected` | `SyncManager.ts:1191` | SSE `sync` 事件 + 计数（与 SP-31/SP-29 合并） |
| `connection-timeout` / `dial-retry-scheduled` | `ConnectionManager.ts:398, 234` | doctor / 控制台网络状态（SP-07） |

> 注：本表所有「出口建议」都是提案；P1 键控修复只负责 SP-01/SP-02/SP-03 的显式化，
> 其余按优先级排期，不得顺手夹带进 P1 的 PR（范围红线）。
