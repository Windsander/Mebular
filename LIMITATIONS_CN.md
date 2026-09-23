# 限制与取舍

> 本文件汇总 Mebular 的**已知限制与有意取舍**（此前散落在 README 中）。
> 协议契约见 [`SEALING_CN.md`](SEALING_CN.md)；英文版见 [`LIMITATIONS.md`](LIMITATIONS.md)。

## 1. 范围 / 产品

- **不是云端记忆 SaaS。** 节点由你自己运行；没有中心服务或协调者。
- **早期项目。** API 尚未稳定，npm 包尚未发布；上生产前请先评估。
- **本地优先、去中心化一致性。** 我们用强全局一致性换取可用性：在**共同授权**的命名空间内，
  任意两端最终收敛；分区只改变*谁在何时收到哪些字节*，**不改变一致性模型本身**。

## 2. 信任 / 身份

- **跨设备通信只走记忆（数据）通道。** 不提供**通用远程查询/调用**面。「应用间协议层」已**退役**；
  仅当出现下列之一时才会重新立项：流式/交互式多轮会话、大对象/媒体传输、非 Mebular 应用复用同一
  身份/授权，或必须不落盘的低延迟 RPC。
- **同机 Agent 默认可信**（设备级身份，同机 Agent 之间不做加密隔离）。跨机信任仍需一条链到用户主密钥的
  证书链 + 显式命名空间授权。
- **吊销是域收缩，不是远程抹除。** 它阻止*后续摄入*（读侧 `[]`、入站隔离、快照过滤）；不会撤回已入图的
  数据，被吊销设备**仍可建立会话**（否则无从得知恢复）。
- **吊销传播有延迟**（依赖事件同步）：一旦 `device_revoke` 事件在场，级联即时生效，因此每个对端要等到
  同步后才看见。
- **保留命名空间 `__policy__` 对所有已认证设备（含被吊销者）可读**——这是有意的 bootstrap/恢复取舍；
  授权图对已入网设备可见。
- **`policyIssuers` 是本地配置**（bootstrap）。各端必须就它达成一致，否则可能对同一批记录得出不同结论。
  留空表示「回退到已配置的允许列表」（默认拒绝不会被放松）。

## 3. 存储 / 运维

- **每个 home 单写者。** 守护持有 store 锁；第二个写者会被明确拒绝（`MCP_STORAGE_LOCKED`）。
  Fleet/Agent 必须走守护的本地 app API，而不是直接打开存储。
- **配额仅本地记账。** 没有全局账本，也没有跨对端对账；不同设备的配额相互独立。
- **基于令牌的加入是 LAN 明文 HTTP**，携带短时效、一次性的 bearer 令牌。请使用可信任的 LAN；
  跨网段加入需要 relay/额外保护（TLS/mTLS 属未来工作）。
- **尚无服务端推送（SSE）。** 本地客户端轮询（10–50 ms）；推送推迟。
- **服务日志不自动轮转**；请运行 `logrotate` 或手动清理。
- **控制台设置按「常用 / 高级 / 诊断」三个 Tab 组织**，「关于本机」面板（顶栏徽标）展示只读事实。
  `sync.autoSync` / `sync.pushOnWrite` 默认开启，且不再在 GUI 中编辑（界面只读；改需手改 `config.json`）。
  每个运行时生效字段都以「已配置 X / 实际 Y」展示，因此「写了但未生效」可被看见。
- **控制台邀请令牌内嵌 endpoint。** endpoint 由 `joinService.bind` 推导（通配 → 本机 LAN IPv4）；
  无 LAN 地址时回退回环，邀请面板会告警。拓扑需要特定地址时用 `joinService.endpoint` 或邀请面板修正。
- **把 `mcp.http.auth` 切到 `bearer`/`oauth` 会立即锁住控制台 API。** `bearer` 可在 UI 内自救
  （粘贴一个 `mebular token grant` 令牌），页面仍可达；`oauth` 需要 env secret，无法从 UI 恢复——
  把 `config.json` 改回 `auth: none`（仅回环）或提供 `MEBULAR_OAUTH_*` 后重启。
- **地址簿是 app 作用域、基于文件。** `<home>/net/peers.json`（0600）保存候选 endpoint；core 从不读文件
  （由 app 传入 store）。relay 种子存放在保留键下，启动时合并进 `relayServers`——动态 relay 能力广播留待 C5。
- **中继是守护的内部角色（C6）。** 独立的 `mebular relay` 命令已移除；守护仅在拥有公网可达监听地址或观测到
  入站直连证据时提供 relay 服务（`network.relayService`: auto/off/on），且只服务地址簿中已配对/已授权的对端，
  并受默认限额约束。由于默认限额只允许受限协议，要经 circuit 承载 Mebular 同步流需内部开关
  `network.libp2p.relayUnlimited: true`（面向终端用户不公开；仅限自托管的可信桥）。relay 角色不保存任何
  记忆/授权状态。
- **relay 重启会使预约失效。** libp2p relay 客户端在 relay 重启后不会自动重新预约；恢复靠对端重新发布
  hints（重新邀请 / 刷新令牌）。
- **打洞是尽力而为，且增加暴露面（C4）。** 当 `network.nat` 启用（默认 auto，需安装可选依赖
  `@libp2p/autonat`/`@libp2p/dcutr`）时，守护会请求 AutoNAT 对端回拨其监听地址，并经既有 relay 连接协调
  DCUtR。两者都只在传输层（绝不参与授权，不引第三方/种子基础设施），但会把本地监听地址暴露给探测对端。
  对称 NAT 下打洞可能失败——保留 relay 路径；控制台/`doctor --net` 会展示计数，因此可观测。
- **邀请二维码 + 自动授权（C7）。** 令牌可携带 `grantOnJoin`（默认开；仅在显式禁用时写入）与
  `grantTtlMs`（默认 24h；`0` = 不自动撤销）。兑换时邀请方签发一条作用域为令牌命名空间的普通
  `namespace_grant`；到期由图外台账 + 定时 `revokeGrant` 保证（TTL 属本地策略，永不进一致性）。
  二维码编码的是**内联令牌文本**；渲染依赖可选依赖 `qrcode`——缺包时只给文本令牌（不报错）。
- **地址广播（C5）隐私矩阵。** `net_endpoints` 记录（命名空间 `__net__`，经 `network.broadcast` 或把
  `__net__` 加入 `sync.namespaces` 的 opt-in）**只作 hints**，永不参与授权：

  | 档位 | 发布什么 | 谁能看见 |
  |---|---|---|
  | `full`（启用时默认） | 所有现存的 lan / public / relay multiaddr，带标签 | 仅 `__net__` 订阅者（沿用既有「授权 ∩ 成员资格 ∩ 订阅」裁剪） |
  | `relay-only` | 仅 relay multiaddr | 同上 |
  | `off` | 什么都不发布 | — |

  记录携带 `expiry`（默认 24h，可配），由**本地墙钟**评估（不进一致性）；被吊销 subject 的记录被忽略。
  旧节点完全忽略该记录类型（安全方向：更少 hints，绝不 fail-open）。
- **LAN 发现是尽力而为的 mDNS。** 库形态下除非设置 `Mebular.network.lan.defaultFactory`，否则 mDNS 关闭；
  守护（MCP）在 `network.lan.enabled` 为真时默认启用。它发布/浏览 `_mebular._tcp`；发现只对地址簿中已有
  （已配对/已配置）或显式白名单的对端自动拨号——陌生设备被忽略。mDNS 在某些沙箱/CI 中不可用，`bonjour`
  依赖以防御式加载（软降级：发现关闭 + 告警，其他传输不受影响）。真 mDNS 验收为尽力而为；确定式 harness
  （注入 fake bonjour）才是门禁。
- **控制台是本机、面向回环的。** GUI（`/console`）由守护提供；非回环暴露需要 TLS + 非 none 鉴权（启动时强制）。
  写需 `memory.admin` scope **且** CSRF；设 `MEBULAR_CONSOLE_WRITES=0` 可得严格只读控制台。实时状态走 SSE
  （`/admin/events`），但记忆/设备列表靠轮询刷新。

## 4. 数据模型 / 同步

- **快照冲突/合并语义未补齐。** 初始快照只发给自报命名空间水位为空的对端；接受侧有保护（本地缺失或严格更新）。
  放宽「只发空对端」前必须先补齐逐事件的完整冲突/合并语义。
- **不实现自动事件裁剪。** 任何未来的裁剪都必须排除尚未被*所有*已授权对端 ack 的事件；本轮只固化约束与测试。
- **跨会话重复发送是预期行为**（只多发、不缺发；接收端按内容寻址 id 去重）。
- **跨 NAT 验证仍待真实硬件**；本机 `verify:wan:l2*` 均为仿真。

---

## 英文版

完整的英文原文维护在 [`LIMITATIONS.md`](LIMITATIONS.md)。
