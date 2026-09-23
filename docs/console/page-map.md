# 控制台页面地图（哪个设置在哪个 Tab）

## 首次上手（引导态：建新 / 加入）

家目录**真正为空**（无 `config.json`、无 `user-master-key.json`、无 `<storagePath>.identity.json`）时，`mebular serve` **不自举 root**，而是进入**引导态**：只服务 `/healthz` + `/console` 引导页 + `/app/provision/*`（其余 admin API 一律 `409 provision_required`），且**仅 loopback**。

引导页两个入口（全程 GUI，不需要命令行）：

| 入口 | 动作 | 结果 |
|---|---|---|
| **建新 Mebular** | `POST /app/provision/create`（设备名可改；填名字即可，带 `device-` 前缀也不会重复拼接——见「设备名归一化」） | 生成 root 主密钥 + 写 `config.json`（`joinService.enabled=true`、`mcp.http` 回环、`network` 默认）→ **自动重启** → 正常态（「＋ 邀请新设备」可用） |
| **加入已有 Mebular** | `POST /app/provision/join`（粘贴邀请令牌；复用 fleet 令牌验签/兑换） | 取回**委派证书链**（delegated，**无主私钥**）+ 主公钥（仅公钥）+ inviter hints 入 `<home>/net/peers.json` → **自动重启** → 正常态（授权分区 = 令牌分区） |

错误可读：令牌过期 / 签名不符 / 端点不可达 / 已使用 → 页面直接显示原因；重复调 provision → `409`；失败**不残留半成品**（仍可重试）。未以服务方式运行时给出手动重启命令（`nohup mebular serve …`）。

**设备名归一化（F-ONB-1）**：设备名先 sanitize，再去掉**所有重复的 `device-` 前缀**，最后拼一次前缀 —— 输入 `TestB` / `device-TestB` / `device-device-TestB` 都得到 `device-TestB`；空名 → `device-local`。两个输入框带「将使用 deviceId: …」实时预览。

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

**邀请面板（C7 扫码即通）**：一次性令牌 + **二维码**（内容=令牌文本，服务端渲染 SVG，可选依赖缺省时只给文本）+ `fleet join` 命令 + 「兑换后自动授权（作用域=令牌分区，默认 24h 到期自动撤销）」说明。

## 高级（14 字段 + 1 动作）

| 分组 | 字段 |
|---|---|
| 反熵与快照 | `sync.antiEntropy.enabled` · `sync.antiEntropy.intervalMs` · `sync.antiEntropy.jitterRatio` · `sync.snapshotThreshold` |
| 对端与签发者 | `sync.peerWhitelist` · `sync.policyIssuers` |
| 语义召回（可选依赖） | `semantic.enabled` · `semantic.minScore` |
| 设备接入（高级） | `joinService.bind` · `joinService.port` |
| MCP 接入（高级） | `mcp.http.host` · `mcp.http.tls` · `mcp.http.tlsKey` · `mcp.http.tlsCert` |
| 动作 | 「声明本机为引导签发者」（图上签名事件） |

> **暴露面收敛（B）**：`network.libp2p.relayServers` 改为**只读**（自动 relay 池 = config seeds ∪ 令牌 hints ∪ 地址簿学习，见「关于本机 · 只读状态」）；`network.libp2p.relayUnlimited` 转为 internal（GUI 不渲染，需手工编辑 `config.json`）。字段元数据由服务端单一真源 `packages/mcp/src/config-schema.mjs` 驱动（`/admin/api/settings.configSchema`），控制台不再重复声明。

## 诊断（只读 + 恢复）

- 版本与服务状态：`/healthz` 的 name/version/status、MCP 监听、TLS、控制台写入开关、P2P。
- 完整配置：`config.json` 原文（复制 / 下载）。
- **最近一次应用结果**：状态（已生效 / 重启中 / 未按预期生效 / 已回滚）、时间、字段清单、原因、备份路径、逐项校验。
- **恢复指引**：auth 误切 · host 误设 · 缺证书 · 控制台打不开（含 `MCP_INSECURE_CONFIG` / `MCP_STORAGE_LOCKED` 判读）。

## 关于本机（顶栏徽章入口，只读）

身份与存储 · **同步节奏** · **只读状态（自动推导）**（relay 池 / LAN 发现 / 桥 / 打洞 / 广播 / join 端点 / TLS / 邀请授权 TTL，均带「未生效原因」）· 运行状态（含 **地址广播**：`full/relay-only/off` 档位 · 已发布 · 已采用 · 忽略原因，C5）· 签发者状态 · **对端连接路径**（C2：每个键的 `kind/address/最近切换/lastError/候选数`，只读）· 舰队摘要 · 能力清单（11 工具）。

> 星图设备卡同样有一行只读「当前路径」（`direct`/`lan`/`relay` + 地址 + 起始时间；未连接时显示 `lastError`）。数据来自 core 候选地址簿（`settings.peers.paths`），只展示不改变授权。

> **同步节奏**（`sync.autoSync` / `sync.pushOnWrite`）已从 GUI 编辑面移除——默认常开、不建议关闭；需要改动请手工编辑 `config.json`。该处只读展示「已配置 vs 实际」双值。
>
> 所有可运行时项（host/port/auth/tls、listen/relay、semantic、join 等）在编辑面给**三元组**「已配置 X / 实际 Y / 未生效原因」，原因由服务端计算（`/admin/api/settings.effective`）。

## 保存与撤销

「常用」与「高级」两个 Tab 各自带**同一 handler** 的「保存 / 撤销修改」按钮：草稿跨 Tab 保留，任一 Tab 都能提交全部未保存修改（写入前仍会做 host/auth/tls 组合校验）。

**保存即生效（G）**：

- 改动含需重启项 → 按钮显示「保存并重启」，保存后**自动重启**（服务托管时）并轮询等待恢复；全为即时（热路径）项 → 就地生效，不重启。
- 恢复后显示 **绿色「已生效（字段清单）」**（逐字段生效校验通过）或 **红色「未按预期生效」/「已回滚」**。
- **自锁防护**：改动命中 `mcp.http.auth` / `mcp.http.host` / `mcp.http.tls` 时先二次确认（重启后控制台可能不可达；失联请手工编辑 `config.json` 改回），未确认则返回 `needsConfirmation` 且不写盘、不重启。
- **回滚兜底**：新配置启动失败（如 join 端口被占）→ 自动用 `config.json.bak` 回滚并重启旧实例；原因写入诊断页「最近一次应用结果」。
- 未以服务方式运行（前台 nohup）→ 返回手动命令 + 备份路径（待重启横幅保留，可「一键重启」或复制命令）。
