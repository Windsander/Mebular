# Mebular 人类控制台 · 交互规格（draft）

> 本地控制台：每台设备各自运行，只管理「本机给谁看什么」与「与谁连接」，
> 不替其他设备做决定。视觉参考官网第二页的『网络舞台』（星空 + 节点 + 同步粒子，
> vanilla Canvas2D）；控制台复用其视觉语言但不依赖站点代码。

本文件整理自实现前的交互规格，作为后续迭代与验收的依据。

## 布局

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ✦ Mebular 控制台   [本机 · device-A]  ● 在线   记忆 128     │ ＋ 添加设备 │
├────────────┬───────────────────────────────────────────────┬───────────────┤
│ 视图        │              星图（Canvas 2D，星空视差）        │  设备卡        │
│ ● 星图      │        ○ B ────────● C      ★=本机（中心亮星）  │  身份/在线/同步 │
│ ○ 域视图    │          ╲        ╱         实线=在线授权        │  域开关列表…    │
│ ○ 审计      │           ★ 本机           虚线=离线/待接通     │  [同步][断开]   │
│            │          ╱        ╲         灰/划=已吊销         │  [吊销设备]     │
│ [域图例]    │        ◌ D（离线）                              │               │
└────────────┴───────────────────────────────────────────────┴───────────────┘
```

- **节点 = 已知设备**：`__policy__` 事件的 issuer/subject ∪ `sync.policyIssuers`
  ∪ `sync.peerNamespacePolicy` 键 ∪ 历史事件作者。
- **连线 = 授权（方向性）**：
  - 本机 → 对端（我授权它）与对端 → 本机（它授权我）分色；
  - 已撤销 grant 以灰度/虚线残影呈现；
  - 离线对端连线为虚线；在线为实线并伴随同步粒子。
- **背景星纯装饰**；设备为高亮标记；namespace 配色色盲安全（Okabe–Ito）
  且始终有文字标签兜底；界面中文。

## 视图

### 星图（默认）

- 本机位于画布中心的亮星；对端沿轨道分布（由 deviceId 稳定哈希决定角度，
  保证刷新不跳动）。
- 节点状态：在线 = 明亮＋光晕；离线 = 暗；已吊销 = 灰化并带划除标记。
- 边状态：在线授权实线；离线/待接通虚线；已撤销的 grant 为虚线残影。
- 同步粒子沿有 pending 事件的边流动。
- 交互：
  - hover 显示提示（deviceId、在线状态、生效域）；
  - 点击设备 = 右侧设备卡。

### 域视图（表格）

- 每个本机 namespace 一行：名称、记忆数、最近更新时间、状态哈希（截断）、
  可复制。
- 用于回答「我有哪些分区、各自多少记忆」。

### 审计时间线

- 渲染 `__policy__` 事件流（grant / revoke / device_revoke）：时间、动作、
  签发者、对象、域/ grantId、当前是否有效。
- 支持按设备/域/动作过滤，并导出 JSON。

### 设备卡（右侧）

- 身份（deviceId）、在线状态、最近同步时间、`pendingEventCount`、
  只读域列表。
- D2 起：域开关（开=签新 grantId；关=`revokeGrant` 对应 grantId）、
  吊销设备、断开连接、立即同步。

### 顶栏

- 本机身份、在线状态、记忆数、`＋ 添加设备`（D3 向导）。

## 降级与空态

- 未初始化 / 网络关闭：只读降级，并显示明确原因（例如「网络未启用，
  仅显示本地记忆与授权」）。
- 无对端设备：显示空态引导，指向「＋ 添加设备」。
- 轮询间隔 2–5s；失败时保留上次数据并提示。

## 数据源（不改 core 的组装方式）

- `app.eventLog.listEvents({ namespace: '__policy__' })` → 政策记录
  （grant/revoke/device_revoke）。
- `app.getEffectiveNamespaces(deviceId)` / `app.getRevokedDevices()`。
- `app.node.getConnectionManager().getConnections()` +
  `app.node.getHandshake().getSession(peerId)?.certificate?.deviceId`
  → 在线与 deviceId 映射。
- `MemoryService.status()`（deviceId/peerId/listenAddrs/nodeCount/edgeCount/
  stateHashByNamespace/pendingEventCount）。
- 事件作者：`app.eventLog.listEvents()` 的 `author`（补全 known devices）。
- 本机 namespace 统计：聚合 `app.storage.listNodes()`（含 namespace 计数与
  最近更新时间）。

## API 契约（D1 只读）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/admin/api/overview` | `{ device, status, onlinePeers[], revokedCount }` |
| GET | `/admin/api/devices` | `[{ deviceId, online, peerId?, addrs?, lastSyncAt?, pendingEventCount?, grantedByMe[], grantedToMe[], revoked }]` |
| GET | `/admin/api/policy` | `[{ eventId, type, issuer, subject, namespaces?, grantId?, at, valid }]` |
| GET | `/admin/api/namespaces` | `[{ namespace, count, lastUpdatedAt, stateHash }]` |

## 写端点（D2）

- `POST /admin/api/grants`
- `POST /admin/api/grants/:grantId/revoke`
- `POST /admin/api/devices/:deviceId/revoke|connect|disconnect|sync|reset-watermarks`

二次确认文案（必须写清）：

- 撤销域：『Y 不会再收到 X 的新记忆；**已同步内容不会撤回**；可用新授权恢复』
- 吊销设备：『Y 无法再接收你的任何分区，其签发的政策记录不再被采纳；
  **已同步数据不回撤**；可重新授权恢复』

安全：

- **CSRF token**：页面加载签发，写请求校验（防 localhost 跨站请求）。
- 写操作要求 `memory.admin` scope。
- 静态托管路径白名单防穿越；复用 serve 现有鉴权（默认 loopback；非环回
  强制 TLS + auth）。

## 添加设备向导（D3）

1. 展示本机 deviceId/peerId/multiaddrs/relay + 复制；粘贴对方
   multiaddr/deviceId。
2. `connectToPeer`（连接中 / 失败原因可行动 / 已连接）。
3. 选共享域（默认全不选，显示将共享记忆计数）→ 签发 grant → 显示 grantId。

## 验证

- `npm -w @mebular/console run verify`：起真实 serve（临时 `MEBULAR_HOME`，
  预置 `__policy__` 事件与记忆节点），断言 `/console` 与静态资源 200、
  只读 API JSON 结构正确、写端点未授权 403、路径穿越被拒。
- `?mock=1`：用内置演示数据渲染，便于无网络验收。


---

## v2 · 去中心化语义与视觉规格（2026-09-18）

### 词表（去中心化）

| 旧 | 新 |
|---|---|
| 添加设备 / 接入对端 / 网络舞台 | **连接新对端** / 我的关系图 |
| 吊销设备 | **屏蔽该设备**（本机范围、单向、不回撤已同步数据） |
| 在线 / 离线 | **与我连接中 / 未连接** |
| 网络未启用 / 网络关闭 | **未启用 P2P**（仅本机记忆与授权） |
| 已吊销 | 已被我屏蔽 |

规则：所有计数与关系均标注"**本机视角**"；星图只表示"我与已知对端的关系"，不代表全网拓扑；
"授权"（可否读我的数据）与"成员资格"（分区协作在册）是两个概念，UI 分开展示。

### 关系模型（四层）

1. **连接**：我与对端的字节通道（可拨入/可接受）
2. **授权**：我允许对端读我的哪些分区（`namespace_grant`；默认拒绝）
3. **成员资格**：分区协作在册（`namespace_membership`；启用后是强制闸门，须与授权同时满足）
4. **屏蔽**：本机不再采纳对端政策记录、也不再向其发送（`device_revoke`）

### 审计事件（6 类）

`namespace_grant` / `namespace_revoke` / `device_revoke` / `policy_issuer_declare` /
`namespace_membership` / `namespace_handoff`——审计视图与过滤器必须完整覆盖。

### 视觉规格

- 背景：移植官网第二页 `nebula.js`（正交投影星云 + 轻雾）与 `stars.js`（10 层视差、色温/辉光）
- 设备：本机金色主星、对端蓝星、离线灰、已屏蔽带划除；连线方向分色（我授权=蓝 / 它授权=黄），
  双向时平行偏移；同步粒子与状态脉冲
- **深度层次（关键）**：每个设备分配稳定深度层（本机=1，对端 0.30–0.92 由 id 哈希决定）；
  近者更大/更亮/光晕更强/标签更大，远者反之；指针移动时按深度产生**差速视差**（近动多、远动少），
  远者先画、近者覆盖，形成前后层次与轻微漂浮
- **本机信标**：白热小核 + 暖色内环 + 极亮中点（核心微脉动，`shimmer`）+ 极淡外环 +
  **倾斜轨道伴星**（轨道在 45° 倾角下投影为椭圆，约 14s 一圈：后半个周期从星体**背后**穿过
  ——先画、更小更暗、被核心/光晕遮挡；前半个周期绕到**前面**——后画、更大更亮；轨道后半弧更暗、
  前半弧更亮）+ 4 长/4 短细衍射星芒；整体半径收敛（≈3.2×节点半径），标签置于光晕之外并带暗影；
  `prefers-reduced-motion` 时全部静止
- **背景闪烁**：官网 stars/nebula 的动画常量以**毫秒**计（`twinkleSpeed≈0.0004/ms`），
  必须喂毫秒时间；表现为恒星式细微明暗（600ms 内亮星像素亮度变化数十级）
- **指针缓动**：视差指针 target/current 双值 + 每帧缓动；移出画布不重置，避免“跳星”
- **航道（连线）**：连线不再是平面箭头，而是空间航道——端点留白 + 双向平行偏移 +
  法线弧高（含两端深度差偏置）；线上为细点状航线 + 外侧微光底；航向以小箭标表示
- **远近明暗过渡**：两端亮度取各自深度（本机端亮、远端暗），较远（深度更低）的一端
  再按航道长度衰减（最低至 12%）→ 远端近乎“消融在远方”；两端极短渐隐仅用于软化接点
- **持续流动**：虚线以 `lineDashOffset` 沿航道方向缓移（在线时约 6px/s，无缝循环，轻柔如星距），
  辅以极轻的亮度呼吸（相位按对端哈希稳定）；在线且有待发事件时另有航线灯流动；
  `prefers-reduced-motion` 时全部静止
- **舰队出航（同步动效）**：SSE `sync` 事件（含 `peerDeviceId/sentEvents/receivedEvents`）
  与手动「立即同步」触发——按数据流向从起点星发出 2–6 艘小编队（细长三角舰体 + 尾迹），
  沿航道飞行约 1.7s，抵达后绽放光环与光晕；收发各有其队（蓝色=我发出、黄色=我收到）；
  `prefers-reduced-motion` 下不出航
- **编队随机化**：航线/楔形/散开三种队形随机；每舰航速、舰体大小、横向错位、蛇形摆动
  相位均随机；最多同时 8 队防刷屏
- **彩蛋（稀有）**：约 2% **彗星**（单舰、更快、长尾、短促闪光）、约 5% **彩虹信使**
  （尾迹与舰体色相循环）、约 8% **旗舰**（1.6× 舰体 + 白色核心 + 双环更大绽放）
- **主星细节**：科技刻度环（24 刻度反向缓转）+ 内环三段异速等离子弧 + 约 4.2s 一圈的
  心跳扩散环 + 偶发耀斑式闪亮（约 20s 一次）；本机纵向浮动收敛到 ±0.7px（此前 ±6px），
  避免“出戏”
- 性能护栏：帧率自适应降级（high 星云+雾 → balanced 无雾 → low 仅星空）；`prefers-reduced-motion`
  时静态渲染；目标 60fps
