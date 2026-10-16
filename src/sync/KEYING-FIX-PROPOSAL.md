# 键控修复提案（P1·A2 出稿 · 等待检查点①复核）

> 基线：`main = bbc2e13`（worktree `fix-conn-identity`，分支自最新 main）
> 复现工具：`scripts/keying-repro.mjs`（红/绿样本）+ `scripts/keying-preload.mjs`（分层探针，不改产品代码）
> 状态：**A1 钉死完成；本文件为 A2 提案；未动产品代码。收到"继续"后进 B 阶段。**

## 1. A1 钉死结论（证据先行）

### 1.1 复现结果（一表）

| 拓扑/开关 | 结果 | 说明 |
|---|---|---|
| 计划原文场景：daemon×daemon，B（delegated）主动拨 A（root），单连接 | **绿**（缺陷未现） | A→B、B→A、membership、auto-grant 全通；`defectRed:false` |
| 追加变体：A 拨 B / B 先写 / 无 whitelist 预置 | 绿 | 单连接下各姿态均正常 |
| **追加第二条连接**（`EXTRA_DIAL=hex`：B 以 `derivePeerIdHex(A)` 为拨号键再拨 A） | **红（确定性）** | **B 亲签事件零落 A**；A→B 亦断；`defectRed:true`，连跑 6 次恒定 |
| 追加第二条连接（`EXTRA_DIAL=device`：以 deviceId 为键再拨） | **红** | 同上（任何"与首拨不同的键"均触发） |

命令：`npm run build && EXTRA_DIAL=hex node scripts/keying-repro.mjs`（KEEP=1 保留沙箱与原始证据）。

关键原始输出（同一 run）：
```
A: connmgr.setConnection {"key":"<hex(B)>","connTag":1}      # 第一条入站（B 首拨）
A: connmgr.setConnection {"key":"<hex(B)>","connTag":7}      # 第二条入站（B 二拨）——同一键，覆盖
A: sm.onPeerNudge {"key":"<hex(B)>","initiate":true,"current":false}   # 旧 entry 收 nudge → 静默丢弃
A: sm.syncWithDevice {"connTag":7}                            # 对新连接发起的会话 30s 超时（无 sent/received）
B: frames.setSessionActive {"ftag":2,"active":true}           # 新连接 responder 就绪……
B: sm.runSession.start  …（entry2 从未出现）                    # ……但会话体从未启动（队列被旧会话占住）
B: mq.push {"qtag":12,"len":141,"waiters":1}                  # A 的 hello 已解密进新连接信道队列
B: mq.yield {"qtag":12,"len":141}                             # 已被拉出队列
（此后 ftag:2 无 frames.readerNext —— 无人读会话帧）
B: sm.scheduleSyncTrigger {"key":"12D3Koo…"}                  # 只有旧 entry 触发
B: sm.deliverTrigger + nudge（走旧连接）                       # → A 旧 entry 静默丢弃（见上）
```

### 1.2 真实触发条件（为什么主网会中、集群脚本没暴露）

真实 `fleet join` 上车会把邀请方地址**双键**写入被邀请方地址簿（`tests/fleet/join-daemon.test.ts:84-88` F-C12-1：`deviceId` 与 `derivePeerIdHex(邀请方公钥)`），而 mDNS 通告的 id 恰是 `derivePeerIdHex` 形态（`P2PNetwork.ts:282-289`、`DeviceDiscovery` 发布 `peerId.id`）→ `handleLanDiscovery` 的 `isKnownOrAllowed`（`:593-603`）命中 → **lanAutoDial 以 hex 键对同一对端再拨一次**（`:569`、`:575`）。同一 LAN 上必然发生。
- 首拨键 = multiaddr 里的 libp2p id（`packages/mcp/src/config.mjs:257-266`）；控制台"连接"另用 **deviceId** 为键（`packages/mcp/src/serve.mjs:1286-1294`）。
- 被拨侧一律用**握手公钥派生 hex** 作连接键（`Libp2pProvider.ts:644` → `:279-286`）。
- 集群脚本 B 是手写 home（无 join hints）、且断言只查 A→B → 从未暴露（与 MESH-STATUS 描述一致）。

### 1.3 断点（精确到行）与因果链

以下按触发顺序，全部在复现 run 中留证：

1. **同一对端在两侧落不同键**（拨号侧可 3 形态：libp2p id / deviceId / 派生 hex；被拨侧恒派生 hex）：
   - 拨号键注入：`Libp2pProvider.ts:670-685`（`new Libp2pConnection(stream, peerId, address)`，peerId 原样）；
   - 被拨键派生：`Libp2pProvider.ts:644`（`fromLibp2pPeerId`）+ `:279-286`；
   - 第二拨的产生：`P2PNetwork.ts:548-590`（`handleLanDiscovery`，`:569` peerRef=`{id: 发现层hex}`，`:575` `connectToPeer`）、`:593-603`（`isKnownOrAllowed`，地址簿 hex 命中）。
   - 去重只按"本地键"：`ConnectionManager.ts:134`（`this.connections.get(peerId.id)`）→ 不同键 = 放行第二条连接。
2. **被拨侧同键覆盖（双连接坍缩到一条记录/一个槽）**：
   - `P2PNetwork.ts:740-746`：`channels.delete(key)` → `acceptAuth` → `setConnection`（覆盖）→ `prepareChannel`（同键重建）；
   - `SyncManager.ts:999`：`onlinePeers.set(session.peerId.id, entry)` **替换旧 entry**；旧 entry 的 `PeerFrames` 仍在读旧信道（孤儿读取者）。
3. **nudge 静默丢弃**：`SyncManager.ts:475-478` — 旧 entry 收到对端 nudge（走旧连接）→ `onlinePeers.get(key) !== entry` → **无声 return**（无计数/无日志/无事件）。
4. **全局会话队列被"永久等待"的响应方会话占住（活锁）**：
   - `SyncManager.ts:1507-1511` `enqueue` = 每 SyncManager **全局**串行；
   - `SyncManager.ts:925-945` `runResponderLoop`：`await this.enqueue(() => runResponder(..., firstHelloTimeout=undefined))` —— 常驻 hello 等待**不归还队列**；
   - 第二条连接 ⇒ 第二个 responder 会话排到队尾 ⇒ 新连接的信道帧**永无会话读取者**（探针：`mq.yield qtag:12 len:141` 之后无 `frames.readerNext`；`runSession.start` 对 entry2 从未出现）。
5. **次级静默点**：新 entry 从未收到 hello ⇒ `recordPeerHello` 未执行 ⇒ `entry.namespaces=[]` ⇒ `handleLocalAppend`（`:410-417`）跳过该 entry ⇒ 新连接**永远不会发 nudge**；剩下唯一 nudge 走旧连接 → 落到第 3 条静默丢弃。⇒ **B 亲签事件永不落图（双向皆断）**。

### 1.4 与计划 §1.2 两个嫌疑断点的关系（如实更正）

- **断点① 角色仲裁（`:988/:996`）**：本缺陷中**未触发**。探针显示两侧 `session.certificate.deviceId` 均正确（`certDeviceId` 打点）、`initiate` 双侧互补（A=true / B=false）。兜底 `?? session.peerId.id` 未被执行。（兜底本身仍是隐患，本轮修复顺带按红线 1 处理，见 §2 I2/I3。）
- **断点② 信任快路径（`:1386`）**：**未触发**。B 的亲签事件根本没到 `verifyEventTrust`（同 run 中 B 的对端事件在单连接阶段 `verifyEventTrust ok:true`；复现失败阶段事件从未到达 A）。
- **真实断点 = 计划未列的第三方**：连接层"同一对端多键并存 + 被拨侧同键坍缩 + 多连接会话饥饿 + 静默丢弃"（§1.3）。

## 2. 修复方案（B 阶段实施；本阶段仅提案）

红线对照（§1.3 of plan）：不碰线协议（认证/同步帧与 multiaddr 语义不变）✓；不碰策略/存储语义 ✓；删除静默兜底、单一身份口径 ✓；先红后绿、四方向矩阵 ✓。

### 2.1 方案主体（推荐）：P2PNode 规范化 + 单活连接收敛

- **N1 规范对端键（连接/路由层唯一）**：认证完成后以 `sha256hex(certificate.devicePublicKey)` 为**连接路由键**（即被拨侧现用形态；与 `derivePeerIdHex` 同算法）。拨号侧建立 `拨号键 → 规范键` 映射；`channels`、`onlinePeers`、`pushTimers`、`getChannel` 全部走规范键。两侧对同一对端的内部键变为**同一形态**（各键自己的对端）。
- **N2 单活连接（同设备收敛）**：同一规范键出现**新的已认证连接**时：显式**退役旧连接**（关闭旧连接与其信道、解除旧 `PeerFrames` 读取者），并把 `channels/onlinePeers/connections` 迁到新连接。保证"一设备对 = 一条参与同步的连接"。
  - 效果：孤儿读取者消失（帧不再被抢）；旧 responder 会话因连接关闭自然终止（`SYNC_CONNECTION_FAILED`）→ **队列解锁**；第 3/4/5 条断点全部消解；同步在新连接上继续（事件幂等、水位不变，不丢数据）。
- **N3 响亮失败（红线 3）**：`onPeerNudge` 等丢弃路径加计数 + 日志/事件（如 `sync-frames-dropped {reason:'stale-entry'}`）；`attachToNode` 在拿不到权威身份时**显式失败**并告警（删除 `?? session.peerId.id` 静默兜底；角色仲裁仍用 `certificate.deviceId`，两侧一致）。
- **N4 会话串行化粒度（加固，建议一并做）**：`enqueue` 从"每 SyncManager 全局"改到"每连接（或每设备对+代际）"；或让"空闲守候"不占队列。消除"任一对端空闲会话饿死其它对端/连接"的隐患（多机扩展面）。

### 2.2 备选与取舍

- 仅做 N1（不改队列）：无法解除"旧会话占队"（旧连接不关闭 ⇒ 旧 responder 永占队列 ⇒ 新连接依旧饿死）——**不充分**。
- 仅做 N4（队列改 per-connection）：能救活第二条连接的会话，但**孤儿帧读取者/旧 entry 静默丢弃**仍在（nudge 丢一半、乱序窗口仍在）——**不充分**。
- 结论：**N1+N2 为主修（必需）**；N3 为红线要求；N4 为同类隐患加固（建议同批，若主控要求最小面可拆下轮——但需在提案中挂账）。

### 2.3 影响面

- 文件：`src/p2p/P2PNetwork.ts`（键规范化、单活收敛、getChannel 路由）、`src/p2p/transport/Libp2pProvider.ts`（如需暴露规范键）、`src/sync/syncmgr/SyncManager.ts`（键口径、丢弃响亮化、队列粒度）、必要时 `handshake` 侧零改动。
- 兼容：线协议不变；同版本互通；混合版本（旧端双拨行为不变、新端收敛）不倒退（P2 的 C3 政策稿对齐）。
- 风险点：重连竞态（新连接认证前旧连接已关？需状态机：**认证成功才退役旧连接**）；relay/LAN 路径切换（`handleLanDiscovery` 的升级路径与 N2 的退役策略需统一，避免"升级即断开"抖动）；`connection-closed` 事件以规范键清理（现有 `P2PNetwork.ts:833-836` 用同键删 channels/session，需随键规范化）。
- 不触碰：`grantPolicy/apply/storage`、事件/证书格式、multiaddr 与 nudge/握手帧格式。

### 2.4 测试与回滚（B2/B3 展开）

- 红→绿锚点（B2 起编成 jest/verify 脚本）：
  1. 复现脚本由 `defectRed:true` → `false`（第二键再拨、deviceId 再拨两形态各一）；
  2. 单测：拨号侧"拨号键 ≠ 规范键"时 `channels/onlinePeers` 键一致；同键第二连接替换后旧 frames 关闭、旧 entry 无残读；
  3. 单测：`onPeerNudge` 丢弃必须计数/发声（判别性断言）。
- **四方向矩阵 × 第二连接**：A→B、B→A、委派↔委派、重连/双拨（每格：单连接基线 + 双键再拨 + 重连竞态）。
- 回滚：改动集中在 P2PNode/SyncManager，纯内部键控；回滚 = revert 提交（数据/协议零迁移）。
- 验收口径（B3）：四方向 + 主网复验（委派侧订阅→根侧自动签发）+ 丢件观察（旧丢件随重连自愈性）。

## 3. 「身份不变量」草案 v0（⑧，供主控/产品审）

- **I1 单一权威**：跨层身份 = 握手证书 `certificate.deviceId`（+证书公钥）；传输键（libp2p id / 派生 hex / deviceId）只作**寻址提示**，不得作映射/信任/角色判定的键。
- **I2 键规范化**：per-peer 状态（连接/信道/会话路由/nudge/水位/ack）内部一键一槽；同设备多连接 = 同一逻辑对端，**新连接认证成功即显式退役旧连接**，旧读取者必须解除。
- **I3 角色互补**：`initiate` 由双方必然一致的键（deviceId）导出；任一侧取不到权威身份 ⇒ 显式失败（禁静默兜底）。
- **I4 响亮失败**：丢弃/拒绝/不匹配一律计数 + 日志/事件；禁止裸 `return`。
- **I5 代际隔离**：重连/双拨产生新代际；旧代际的读取者与队列不得与新代际共享。
- **I6 可测性**:四方向 × 双拨/重连矩阵 + 红→绿锚点为上述不变量的证据面。

## 4. 附：复现/探针用法

```bash
npm run build
KEEP=1 node scripts/keying-repro.mjs                    # 计划原文场景（当前=绿）
KEEP=1 EXTRA_DIAL=hex node scripts/keying-repro.mjs     # 红样本（第二键再拨；确定性）
KEEP=1 EXTRA_DIAL=device node scripts/keying-repro.mjs  # 红样本（deviceId 键）
```
探针（`[KP]` 单行 JSON）经 `NODE_OPTIONS=--import scripts/keying-preload.mjs` 注入守护进程；覆盖 auth/conn/channel/frames/queue/session 六层，不改产品代码。
