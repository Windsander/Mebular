# 控制台页面地图（哪个设置在哪个 Tab）

设置弹层分三个 Tab：**常用**（默认开）· **高级**（默认收起）· **诊断**；只读信息统一在**「关于本机」**面板（点顶栏状态徽章 `本机 · <deviceId>` 打开）。
IA 单一真源在 [`packages/console/settings-ia.js`](../../packages/console/settings-ia.js)，E1（`verify-console.mjs`）以迁移表驱动断言「不丢项：每项有且仅有唯一去处」。

## 常用（4 张任务卡，共 6 字段）

| 任务卡 | 字段 |
|---|---|
| 让别的设备能连上我 | `network.enabled` · `network.libp2p.listen` |
| 我参加哪些记忆域 | `sync.namespaces` |
| 邀请新设备上车 | `joinService.enabled` |
| Agent 怎么连我（危险项） | `mcp.http.port` · `mcp.http.auth` |

「Agent 怎么连我」卡片保留改鉴权/端口的后果与恢复说明（bearer 可粘贴 token 自救；oauth 需 env secret，否则只能改回配置）。

## 高级（16 字段 + 1 动作）

| 分组 | 字段 |
|---|---|
| 反熵与快照 | `sync.antiEntropy.enabled` · `sync.antiEntropy.intervalMs` · `sync.antiEntropy.jitterRatio` · `sync.snapshotThreshold` |
| 对端与签发者 | `sync.peerWhitelist` · `sync.policyIssuers` |
| 语义召回（可选依赖） | `semantic.enabled` · `semantic.minScore` |
| Relay 与高级网络 | `network.libp2p.relayServers` · `network.libp2p.relayUnlimited` |
| 设备接入（高级） | `joinService.bind` · `joinService.port` |
| MCP 接入（高级） | `mcp.http.host` · `mcp.http.tls` · `mcp.http.tlsKey` · `mcp.http.tlsCert` |
| 动作 | 「声明本机为引导签发者」（图上签名事件） |

## 诊断（只读 + 恢复）

- 版本与服务状态：`/healthz` 的 name/version/status、MCP 监听、TLS、控制台写入开关、P2P。
- 完整配置：`config.json` 原文（复制 / 下载）。
- **恢复指引**：auth 误切 · host 误设 · 缺证书 · 控制台打不开（含 `MCP_INSECURE_CONFIG` / `MCP_STORAGE_LOCKED` 判读）。

## 关于本机（顶栏徽章入口，只读）

身份与存储 · **同步节奏** · 运行状态（含 **地址广播**：`full/relay-only/off` 档位 · 已发布 · 已采用 · 忽略原因，C5）· 签发者状态 · **对端连接路径**（C2：每个键的 `kind/address/最近切换/lastError/候选数`，只读）· 舰队摘要 · 能力清单（11 工具）。

> 星图设备卡同样有一行只读「当前路径」（`direct`/`lan`/`relay` + 地址 + 起始时间；未连接时显示 `lastError`）。数据来自 core 候选地址簿（`settings.peers.paths`），只展示不改变授权。

> **同步节奏**（`sync.autoSync` / `sync.pushOnWrite`）已从 GUI 编辑面移除——默认常开、不建议关闭；需要改动请手工编辑 `config.json`。该处只读展示「已配置 vs 实际」双值。
>
> 所有可运行时项（host/port/auth/tls、listen/relay、semantic、join 等）在编辑面同样给「已配置 X / 实际 Y」双行，不一致时以 ⚠ 标注「写入值未生效，实际以运行时为准」。

## 保存与撤销

「常用」与「高级」两个 Tab 各自带**同一 handler** 的「保存配置 / 撤销修改」按钮：草稿跨 Tab 保留，任一 Tab 都能提交全部未保存修改（写入前仍会做 host/auth/tls 组合校验）。
