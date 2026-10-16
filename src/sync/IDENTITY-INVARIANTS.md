# 身份不变量（Identity Invariants）v1.0

> 落定于 P1·B 阶段（键控修复）。配套修复：连接/会话/信道内部键控统一到**单一身份口径**，
> 同设备多连接收敛为单活；静默丢弃一律发声。实现锚点见每条的「实现」。
> 配套复现/矩阵：`scripts/keying-repro.mjs`、`scripts/verify-keying-matrix.mjs`；
> 提案留档：`src/sync/KEYING-FIX-PROPOSAL.md`（含 §1.4 更正记录）。

## 术语

- **身份键（deviceId）**：握手证书 `certificate.deviceId`——事件 author、策略/授权、
  角色仲裁、水位/ack 的键。
- **规范对端键（canonical peer key）**：`sha256hex(对端证书设备公钥)`
  （`canonicalPeerIdFromCertificate`；与 `derivePeerIdHex` 同算法同形态）——
  连接/信道/会话路由、nudge、在线登记、事件送达回执的键。
- **拨号键（dial key）**：`connectToPeer` 的入参 id（libp2p id / deviceId / 派生 hex /
  任意地址注释）——**只作寻址提示**，不得进入任何映射/信任/角色判定。

## 不变量

### I1 · 单一权威身份
跨层身份 = 握手证书 `deviceId`（+ 证书公钥）。认证成功后，会话对外暴露的
`peerId` 一律规范化为**规范对端键**；拨号键只在本端连接事务内使用。
**取不到权威身份 = 显式失败 + 告警**（禁止静默兜底成传输层 id）。

实现：`AuthenticationHandshake`（认证成功时 `session.peerId = canonicalPeerIdFromCertificate(...)`、
`session.connection` 回填）；`SyncManager.attachToNode`（缺证书 deviceId → 计数
`identityFailures` + `sync-failed` + 告警，不登记对端）。

### I2 · 一键一槽（键规范化）
per-peer 状态（连接、信道、在线登记、push 定时器、水位/ack）内部一键一槽；
同一对端在进程内只能有一个**规范键**。同设备的多条物理连接 = 同一逻辑对端，
必须共享/替换同一状态槽。

实现：`P2PNode.peerKeyAliases`（本地键→规范键）、通道按规范键维护
（`channelOwner` 归属比对）、`SyncManager.onlinePeers` 以会话（规范）键登记。

### I3 · 角色互补（去形态依赖）
`initiate` 由双方**必然一致**的键（`deviceId` 字典序）导出；两侧必须互补。
任何一侧解析不到权威身份时显式失败，不得以别种形态参与仲裁。

实现：`SyncManager.attachToNode`（`initiate = this.deviceId < certificate.deviceId`；
保留原语义，兜底已删）。回归：`tests/p2p/keying-canonicalization.test.ts`。

### I4 · 同设备单活连接（认证后收敛）
同一规范键出现**新的已认证连接**时：新连接胜出，旧连接**显式退役**（关闭），
其信道/会话登记按**连接代际**清理，不误伤新连接。
**收敛只发生在认证成功之后**：第二次认证失败不得影响旧连接的正常服务。

实现：`P2PNode.convergePeerConnection` / `retireConnection`；
`ConnectionManager.disconnect(peerId, connection)`（按对象关闭 + 身份守卫的清理）；
`connection-closed` 事件携带连接对象，清理处全部做代际比对；
握手失败恢复同键原有已认证会话（`restoreAuthenticatedSessionOnFailure`）。
对抗回归：`tests/integration/keying-convergence.test.ts`（异主同名证书再拨 → 旧连接继续服务）。

### I5 · 代际隔离（重连/双拨/再拨）
每次重连、双拨、异键再拨都产生新的连接代际；旧代际的读取者（PeerFrames）、
信道与队列必须被解除，不得与新代际共享。会话串行化按**连接粒度**
（同信道串行、异连接/异对端互不饿死）。

实现：旧连接关闭 → 其信道泵自然收束；`SyncManager.sessionQueues`（每连接队列）；
`getChannel(peerId, { connection })` 只返回属于该连接的信道。
回归：`tests/sync/session-queue-isolation.test.ts`、矩阵 `reconnect-*` 场景。

### I6 · 丢弃必须发声（无静默）
任何「因身份/键控问题丢弃帧、丢弃 nudge、忽略陈旧登记」都必须有分类计数 +
可观测事件；禁止裸 `return`。三类计数：
`nudgeDroppedStaleEntry` / `staleEntrySignals` / `identityFailures`（+ `sync-frames-dropped` 事件）。

实现：`SyncManager.noteDropped` / `getDropCounters`。
回归：`tests/sync/drop-counters.test.ts`。

### I7 · 不变量可测（验收面）
上述不变量由固定用例面覆盖：
- 单测：会话规范化、丢弃计数、每连接队列；
- 集成：第二键再拨收敛（hex/device/任意拨号键三形态）、对抗（二次认证失败）；
- 集群矩阵（`npm run verify:keying:matrix`）：四方向 × {单连接, hex 再拨, deviceId 再拨}
  + 重连竞态（拨号侧/被拨侧重启 + 掉线事件回填）+ 冒名第二连接 + #122 主网流程
  + 混合版本抽查（旧端↔新端，降级如实记录）。

## 与线协议/策略/存储的关系

- 线协议零改动：认证帧、同步帧、multiaddr、证书/事件格式均不变（同版本互通；
  混合版本抽查见矩阵，旧端双拨行为保持原样、连接面不倒退）。
- 策略/存储语义零改动：deviceId 语义、授权/成员资格/水位/ack 口径不变；
  本修复只统一**内部键控**与**清理/退役**纪律。
