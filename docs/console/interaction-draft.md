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
