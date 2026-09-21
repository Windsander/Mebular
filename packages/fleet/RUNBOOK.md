# Fleet 双机 Runbook（M3：真实 libp2p 传输 + 记忆同步）

> 目标：两台机器上各跑一个进程（node=任务板/发起端，worker=执行端），任务经 **core 记忆同步**
> （写入即推 + anti-entropy + 变更订阅）传递，**无共享存储、无中心服务**。
> 隐私红线与协议语义见仓库根 [`SEALING.md`](../../SEALING.md)；fleet 只消费 `@mebular/core` 公共 API。
>
> **设备上车**（安装/主密钥分发/`onboard`/`doctor`）见 [`ONBOARDING.md`](./ONBOARDING.md)——本文件的手工命令是它的底层等价形态。
> **图上授权（G1：`fleet grant`/`revoke`，配置白名单仅 bootstrap）** 见 [`ONBOARDING.md §4`](./ONBOARDING.md)。
> **常驻服务化（`fleet node`/`fleet worker` + `fleet service`）** 见 [`ONBOARDING.md §10`](./ONBOARDING.md)。

## 0. 前置

```bash
git clone https://github.com/Windsander/Mebular.git && cd Mebular
npm ci
npm run build            # 生成 dist/（@mebular/core）与 packages/fleet/dist/（@mebular/fleet）
node -v                  # >= 20
```

**共享用户主密钥（信任根）**：两台机器必须使用**同一把**用户主密钥，才能互相验证设备证书。在一台机器生成后，把文件**安全分发**到另一台（这是信任根，务必保密）：

```bash
node scripts/fleet-remote-peer.mjs --role keygen --out fleet-key.json
# 将 fleet-key.json 复制到另一台机器（scp/安全通道）
```

## 1. 先在本机两进程自证（loopback，最快）

终端 A（node）：
```bash
node scripts/fleet-remote-peer.mjs --role node \
  --device device-A --key fleet-key.json --storage ./.fleet/A.jsonl \
  --listen /ip4/127.0.0.1/tcp/0 --authorize device-B \
  --submit 5 --target-device device-B --target-agent '*' --timeout-ms 30000
```
它会先打印监听信息（含 `multiaddr` 与 `peerId`），随后提交 5 个任务并等待终态。

终端 B（worker，用 A 打印的 multiaddr / peerId）：
```bash
node scripts/fleet-remote-peer.mjs --role worker \
  --device device-B --agent echo --key fleet-key.json --storage ./.fleet/B.jsonl \
  --authorize device-A \
  --peer /ip4/127.0.0.1/tcp/<PORT>/p2p/<A_PEER_LIBP2P_ID> --peer-id <A_PEER_ID> \
  --timeout-ms 20000
```

**期望**：node 最终打印 `{"role":"node","submitted":5,"done":5,"resultsMatch":true}`；worker 打印 `{"role":"worker","executed":5,...}`。

## 2. 双机（LAN）

机器 A（node，监听 0.0.0.0:4001）：
```bash
node scripts/fleet-remote-peer.mjs --role node \
  --device device-A --key fleet-key.json --storage ./A.jsonl \
  --listen /ip4/0.0.0.0/tcp/4001 --authorize device-B \
  --submit 20 --target-device device-B --target-agent '*' --timeout-ms 120000
```
输出里 `multiaddr` 形如 `/ip4/0.0.0.0/tcp/4001/p2p/12D3Koo…`。**把 `0.0.0.0` 换成 A 的 LAN IP**（如 `192.168.1.10`）即得对端可拨地址；`peerId` 用输出里的值。

机器 B（worker，拨号到 A）：
```bash
node scripts/fleet-remote-peer.mjs --role worker \
  --device device-B --agent echo --key fleet-key.json --storage ./B.jsonl \
  --listen /ip4/0.0.0.0/tcp/4002 --authorize device-A \
  --peer /ip4/192.168.1.10/tcp/4001/p2p/12D3Koo… --peer-id <A_PEER_ID> \
  --timeout-ms 120000
```

**验证点**
1. A 打印 `listening` 后，B 能拨号成功（无 `NETWORK_*` 错误）。
2. A 打印 `done == submitted` 且 `resultsMatch: true`。
3. B 打印 `executed == submitted`（每任务恰好一次）。
4. **授权**：`--authorize` 指向对端 device；未在 node 策略中的设备（如 `device-C`）**看不到 tasks 分区**（默认拒绝）。

## 3. 跨 NAT / 公网

- 优先：把 A 的 4001 端口做端口转发，B 用公网地址拨号。
- 或使用 core 的 circuit relay（`network.libp2p.relayServer` / `relayServers`）；relay 默认限额、需显式 `--unlimited`。**部署/加固/降级见 [`RELAY-OPS.md`](./RELAY-OPS.md)**（transport-only、可自托管/替换；`verify:wan:l2` 与 docker NAT 仿真）。
- 广域网自证（non-evidence）命令见 README；真实跨公网证据已排入**最后阶段的真机/公网验收**（本机 `verify:wan:l2` 与 `verify:wan:l2:docker` 只做仿真）。

## 3.5 广域网同步命令（自证 / 非证据）

`scripts/wan-sync.mjs` 把「两主机增量同步 + 冲突收敛」脚本化，接 circuit relay 与手动 multiaddr 两条寻址路径。

```bash
# 本地编排自测（共享身份 + 两阶段 + relay 密文；non-evidence，退出码 0）
npm run verify:wan:cross:selftest
# 隔离自测：两个独立进程 + 各自独立存储 + 无共享路径（non-evidence）
npm run verify:wan:cross:selftest:isolated
# 本地回归（loopback，非证据）
npm run verify:wan            # 手动 multiaddr 直连
npm run verify:wan:relay      # 内嵌 circuit relay
# relay-only / NAT 仿真（CI 同款）
npm run verify:wan:l2
npm run verify:wan:l2:docker

# 跨机两阶段（异网段，无需共享文件系统）：先分发用户主密钥，再 A=peer / B=cross
node scripts/wan-sync.mjs user-keygen --out key.json
node scripts/wan-sync.mjs relay --port 4000 --unlimited            # 可选，异网段需要
node scripts/wan-sync.mjs peer  --role a --user-master-key-file key.json \
  --bind /ip4/0.0.0.0/tcp/4001 --relay <relay> \
  --authorize device-B                             # 显式授权对端；否则默认拒绝，什么都不发
node scripts/wan-sync.mjs cross --device-id device-B --user-master-key-file key.json \
  --peer <A-stable-multiaddr> --peer-id <A-deviceId> --relay <relay> \
  --authorize device-A --out B-evidence.json       # cross 固定自身 deviceId，A 才能授权它
# 判定：cross 退出码 0 且 B-evidence.json 的 stateMatches=true、differentPublicNetwork=true、identityShared=true
```

- **默认拒绝是硬边界**：`sync.peerNamespacePolicy` 未列出的对端拿不到任何分区，跨机脚本必须显式 `--authorize <对端 deviceId>`；`cross` 用 `--device-id` 固定自身设备名，A 侧才能预先授权。
- 用户主密钥：`user-keygen` 生成，A/B 用同一把（否则设备证书互验失败）；也可用 `MEBULAR_USER_MASTER_KEY`（内联 JSON）。
- 协调无需共享文件：B 用 `--peer/--peer-id` 一次给定 A 的稳定地址，按图上阶段状态重试连接完成三阶段。
- 前置预检：`cross` 启动前检查 `--peer/--peer-id/--relay` 是否齐全且 **TCP 可达**；缺失/不可达立即报错（超时可用 `MEBULAR_WAN_PREFLIGHT_TIMEOUT_MS` 调整，默认 3000ms）。
- 出口判据：`MEBULAR_WAN_IP_ECHO`（缺省 `https://api.ipify.org?format=json`）取公网出口 IP；任一私网/回环 → false，取不到 → 未知（绝不误判 true）。
- relay 默认**限额**；需显式 `--unlimited` 才允许任意协议过 circuit；`relay --capture <path>` 可捕获线上字节供「只见密文」取证。
- 诚实边界：上述本机命令都是 **non-evidence**；真实跨公网验收已排入最后阶段（本机 `verify:wan:l2*` 只做仿真）。

## 4. 一键验收脚本（CI 同款）

```bash
npm run verify:fleet:local    # M2：单机双进程（spool 传输）5 条 + 重启韧性
npm run verify:fleet:remote   # M3：真实 libp2p loopback；含 M2 正确性集 + 授权负例 + 时延 p50/p95
npm run verify:fleet:agents   # M4：按 agent 名路由（fake agent，9/9；CI 自洽）
npm run verify:fleet:onboard  # Step 1b：onboard→双节点派活→doctor 全绿 + 失败矩阵（16/16）
npm run verify:fleet:grant    # G1：仅图上 grant 派活 / 撤销不可见 / R-a·R-d（16/16）
npm run verify:fleet:all      # 以上五者汇总 → 一个 JSON 摘要（含 skipped）
# 真实 Hermes（可选，需本机 hermes；**命令行参数**，不是环境变量）：
node scripts/verify-fleet-agents.mjs --with-hermes   # 额外派活到 hermes agent，断言哨兵 + session
```
`verify:fleet:remote` 会打印原始时延样本与 p50/p95（loopback 典型 p50≈30ms、p95≈36ms），并断言：
N≥20 全部完成且结果匹配、重复投递不重复执行、配额账本守恒、`expiresAt` 仅本机展示、重启不丢不重、未授权设备看不到 tasks。

## 5. 已知边界

- `keygen` 产出的主密钥文件是**信任根**：所有共享它的设备同属一个用户；泄露即等于身份泄露。
- libp2p 是**可选依赖**；缺包时报 `NETWORK_LIBP2P_NOT_AVAILABLE`（安装见报错提示）。
- 时延为 loopback/ LAN 实测；跨公网受 NAT/relay 影响，另行测量。
- 执行语义为**至少一次投递 + 按 taskId 幂等执行**（`EchoExecutor` 无副作用）；自定义执行器须自身幂等。

## 6. 控制台（本机 GUI）

`mebular serve` 同时提供**本机控制台**（星图 / 域视图 / 审计 / 上车向导 / 设置）；静态资源来自 `packages/console`（可用 `MEBULAR_CONSOLE_DIR` 覆盖）。

- **启动与地址**：`mebular serve` → `http://127.0.0.1:7331/console`（`mebular console` 会打印 URL）。
- **设置页分区**：设置弹层分 **常用**（默认，4 张任务卡 6 字段）/ **高级**（默认收起，16 字段 + 声明签发者）/ **诊断**（版本与服务状态、完整配置、恢复指引）；只读信息（身份与存储 / 同步节奏 / 运行状态 / 签发者 / 舰队摘要 / 能力清单）统一在 **「关于本机」**（点顶栏状态徽章打开）。页面地图见 [`docs/console/page-map.md`](../../docs/console/page-map.md)。
- **同步节奏**：`sync.autoSync` / `sync.pushOnWrite` 默认常开、不建议关闭，已从 GUI 编辑面移除（只在「关于本机 · 运行状态」只读展示真值）；需要关闭请手工编辑 `config.json`。
- **只读 / 可写**：默认可写（写端点需 `memory.admin` scope + CSRF 双提交；仅 `POST/PUT/PATCH`，`Origin` 必须同源）；`MEBULAR_CONSOLE_WRITES=0` 降级为只读。
- **鉴权 / TLS**：回环可 `auth=none`；**非回环必须** `auth=bearer|oauth` 且启用 TLS（配 `tlsKey`/`tlsCert`），否则 serve **拒绝启动**（`MCP_INSECURE_CONFIG`，不静默降级）。语义为**单一真值**：证书齐备即实际走 https（`tls=true` 表示「必须启用」，缺证书则启动失败）；`status`/`print-config`/控制台「实际运行状态」同此真值。控制台保存时也会做**组合校验**（非法 host/auth/tls 组合 → 400）。
- **邀请端点（F-C6）**：令牌里写死的 `endpoint` 必须是**新设备可达**地址。默认由守护按 `joinService.bind` 计算：通配（`0.0.0.0`）时自动取本机 LAN IPv4；也可在 `joinService.endpoint` 显式固定，或在控制台「＋ 邀请新设备」面板临时填写后重新签发（令牌随之覆盖）。若无 LAN 地址会回退回环并在面板告警。
- **auth 误切怎么恢复（F-C7）**：`mcp.http.auth` 切到 `bearer` 后控制台 API 立即 401（`/console/` 页面仍可打开，粘贴 `mebular token grant --scope memory.read,memory.admin` 生成的 token 即可自救）；切到 `oauth` 后静态 token 无效（`invalid token`）、`/register` 默认 404（未设 `MEBULAR_OAUTH_ADMIN_SECRET`/`MEBULAR_OAUTH_REGISTER_SECRET`），控制台内无法自救——编辑 `<home>/config.json` 把 `mcp.http.auth` 改回 `none`（仅回环）或补齐 env 凭证，再重启 `mebular serve`。
- **演示种子**：`node packages/console/scripts/seed-demo.mjs --home /tmp/mebular-demo` → 按提示启动 serve 并打开 `/console`。
- **误设后怎么救**（把 host 存成 `0.0.0.0` 且 auth=none / 缺证书导致 serve 拒绝启动）：直接编辑 `<home>/config.json`，把 `mcp.http.host` 改回 `127.0.0.1`，或补齐 `auth`+`tls`+`tlsKey`/`tlsCert`，再重启 `mebular serve`。
- 状态脉冲经 SSE（`/admin/events`）；记忆/设备列表仍为轮询刷新（10–50ms）。

## 7. 配对即连（C1+C2：候选地址簿 / 自动选路 / relay seeds）

**机制在 core、策略在 app**：core 只提供引擎（注入式、离线安全），文件位置与开关由 app 决定。

- **地址簿**：`<home>/net/peers.json`（0600）。每对端多地址 + 分类（`direct` > `lan` > `relay`）+ 来源（`config` / `paired` / `learned`）+ 最近成功/失败；`__relay-seeds__` 是保留键（relay seeds，**不是对端候选**）。
- **自动选路**：`network.autoConnect`（默认 true）。`connectToPeer(peerId)` 无显式地址时按簿内候选逐个尝试；失败换候选并记录 `lastError`，全失败按 `1s×2^n`（上限 30s）退避重试；成功后写入路径状态并在 `path-changed` 广播。并发上限仍走 `maxConnections`。
- **路径查询**：`doctor --net`（排障）与控制台「关于本机 → 对端连接路径」/设备卡只读行展示 `kind/address/since/lastError`。
- **配对 hints**：`fleet invite` / 控制台邀请签发的令牌携带 `endpoints`（邀请方可达 multiaddr）、可选 `relaySeeds`、`pubReachable`；旧令牌无这些字段仍可用（**向后兼容**）。新设备 `fleet join` 后写入本机地址簿（同时写 deviceId 键与派生 peerId 键 → 首次拨号即可命中）。
- **relay seeds**：`network.relaySeeds`（配置）与令牌随附的 seeds 会被并入 `network.libp2p.relayServers`，使新设备能拨 circuit 地址。
- **中转（内部化，C6）**：不再有独立的 `mebular relay` 命令——守护内建 relay 角色，`network.relayService: 'auto'|'off'|'on'`（默认 auto）。见下方 §9。
- **relay 白名单/上限**：`network.libp2p.relayPolicy`（`allowedRelayPeers` / `deniedRelayPeers` / `maxReservations` / `reservationTtlMs` / `denyOutboundRelayedConnection`）→ 组装 libp2p `connectionGater` 与 `circuitRelay.reservations`。
- **能力共享边界**：本轮只做「配对时 hints + 配置 seeds」；relay 能力的动态广播见 C5。relay 重启会作废旧预约（libp2p 客户端不自动 re-reserve）：恢复路径是**对端重新发布 hints**（控制台/`fleet invite` 再签一次）。
- 验收：`npm run verify:connect`（hints-only 自动连通 + 杀 relay 降级/退避 + 恢复重连 + 路径状态断言）。

## 8. LAN 自动发现与 LAN↔WAN 无感切换（C3）

- **开关**：`network.lan.enabled`（默认 true；false = 不装配 mDNS 发现层）、`network.lan.autoDial`（默认 true）。
- **安全不变式**：发现事件只对「地址簿已知（paired/config，含 deviceId↔peerId 别名键）」或「`sync.peerWhitelist` 放行」的对端记录 LAN 候选并自动拨号；**陌生设备只忽略、绝不自动拨号**（`doctor --net` 会显示忽略计数）。
- **路径切换**：LAN 候选按 `classifyEndpoint` 归类为 `lan`（私有 IPv4/.local/link-local），优先级 `direct > lan > relay`；发现到新 LAN 而当前走 relay/direct → **断开重连升级**；mDNS 撤销/超时 → 移除该 LAN 候选、断开现链并回退 relay/direct；同地址重报不抖动。
- **默认 mDNS（库 vs 常驻）**：core 提供默认 bonjour factory（加载已声明依赖 `bonjour`）；**库形态默认不启用**（`Mebular.network.lan.defaultFactory` 默认 false，避免库/测试产生多播副作用），**常驻入口默认启用**（MCP 守护在 `network.lan.enabled` 为真时置 `defaultFactory: true`）。缺包/初始化失败 → **软降级**（发现禁用 + 告警，其他连接方式不受影响），可注入替代 factory。
- **观察**：`mebular doctor --net` 显示发现是否启用/在跑、LAN 候选数、忽略的陌生设备数、当前路径与 lastError；控制台「关于本机 → 对端连接路径」与设备卡显示 `kind/address/最近切换`。
- **平台/CI**：确定式 harness 走注入的假 bonjour（不依赖真 mDNS），CI ubuntu 跑 `npm run verify:lan`；真 mDNS 为「尽力而为」（受限环境 SKIP，不判红）；Windows job 不跑真 mDNS（只构建/单测 + fleet local/onboard），mDNS 行为由 ubuntu 的确定式 harness 覆盖。
- 验收：`npm run verify:lan`（已配对自动连通 / 陌生设备不拨号 / LAN 升级 / LAN 撤销降级 / 关闭发现 / 默认 factory 软降级）。

## 9. 中继内部化（C6：桥的选举自动完成）

- **没有独立 relay 命令**：`mebular relay` 已删除；中继是**守护内部角色**，与 serve 同生命周期。
- **开关**：`network.relayService: 'auto' | 'off' | 'on'`（默认 `auto`）。
  - `auto`：仅当存在**对外可达监听地址**（公网，非回环/私网）**或**观察到**入站直连证据**时才对外提供中转；否则静默不提供（不报错、不占资源）。
  - `off`：从不提供；`on`：强制提供（内部/测试开关）。
  - `network.libp2p.relayServer` 保留为**内部/测试开关**（等价 `on`），不面向用户文档。
- **白名单**：只服务地址簿中**已配对/已授权**（`paired`/`config` 来源；C2 已写 deviceId + 派生 peerId 双键）的对端；纯发现/学习来的对端不服务。
- **默认限额**：`applyDefaultLimit` + `maxReservations`（复用 `RelayPolicy`）。注意：限额只放行 **受限协议**——**Mebular 同步流经 circuit 需要内部开关 `network.libp2p.relayUnlimited: true`**（不面向用户文档，仅自托管可信桥使用）；不放开时桥仍可服务（identify 等），但同步流会被 `LimitedConnectionError` 拒绝。
- **不变式**：relay 角色**不落任何记忆/授权状态**（不写图事件、不改策略），中继流量对双方仍是端到端加密信道。
- **观察**：控制台「关于本机 → 运行状态」显示「本机当桥 开/关（原因）」与「当前经桥」（当前路径为 relay 时给出桥地址）；`mebular doctor --net` 输出 `relay` 段（mode/serving/reason/publicAddrs/allowedClients）。
- **桥的广播**：可达设备自动当桥 + 地址广播属 C5（`net_endpoints` 记录），本轮只做「本机角色判定 + 白名单 + 限额」。

## 10. 地址自动广播（C5：可达设备互相告知地址，自动用桥）

- **开关（opt-in）**：`network.broadcast: { mode: 'full'|'relay-only'|'off', ttlMs? }`，或把 `__net__` 加入 `sync.namespaces`。
  - `full`（默认档）：发布**实际存在**的 lan / public / relay 地址并打标；
  - `relay-only`：只发布 relay 地址；`off`：完全不发布。
- **语义（hints only）**：记录 `net_endpoints` 落在命名空间 `__net__`；**永不参与授权**（不改生效分区/成员/吊销，也不写 `__policy__`）。读取侧只做：subject 绑定校验 → 命名空间校验 → 过期（本地墙钟）→ 吊销级联 → 写入候选地址簿（`source=learned`）。
- **自动用桥**：收到对端记录 → 其 relay 地址进候选池 → 后续拨号可自动经其桥（与 C1 选路、C6 桥角色协同）；`relayCapable` 只是信息（不使对端有义务，也不换取权限）。
- **可见性**：记录只在 `__net__`，沿用既有「授权 ∩ 成员资格 ∩ 订阅」裁剪；旧版本节点忽略该类型（只少收 hints，安全方向）。
- **时效**：`expiry` 默认 24h（`ttlMs` 可配）；过期仅本机忽略，**不进一致性**（不影响 `stateHash`）。
- **观察**：控制台「关于本机 → 运行状态」显示「地址广播」（档位 / 已发布 / 已采用 / 忽略原因）；`mebular doctor --net` 输出 `net` 段与建议。
- 验收：`tests/sync/net-endpoints.test.ts`、`tests/p2p/net-endpoints-broadcast.test.ts`（含「注入记录不改授权」锚点）。

## 11. 扫码即通（C7：令牌 + 二维码 + 兑换自动授权）

- **邀请（两种产物一起给）**：`fleet invite [--namespace ns] [--ttl 分钟] [--grant-ttl 小时] [--no-grant] [--no-qr]`
  - 打印**终端二维码**（内容 = 内联令牌文本，不引自定义 scheme）与**文本令牌**（JSON 的 `token` 字段）；
  - 控制台「＋ 邀请新设备」面板同样给出二维码（服务端渲染 SVG → data-uri）+ 文本 + 复制命令。
- **加入（等价入口）**：`fleet join --qr '<二维码内容>'` 与 `fleet join --token <内联|文件>` **完全等价**（`--qr` 只是先把字符串归一为 `--token`）。
- **兑换即通**：令牌缺省携带自动授权语义（`grantOnJoin` 默认 true）：新设备兑换成功后，邀请方**立即**签发一条作用域为**令牌分区**的 `namespace_grant`（走既有授权 API，不改判定语义）。
  - **有效期**：默认 **24h**（`grantTtlMs` / `--grant-ttl <小时>` 可配；`0` = 不自动撤销）；到期由图外台账 + 定时 `revokeGrant` 自动撤销（台账 `<storagePath>.join-autogrants.json`，0600）。
  - **一次性 + 绑定首个兑换设备**：nonce 先占用后签发（并发安全）；二次兑换 403 `used`；过期 403 `expired`。
  - **可 revoke**：`fleet revoke`/`mebular` 侧既有 `revokeGrant` / `revokeDevice`；撤销后该对端读侧立即为空。
  - **关闭自动授权**：`--no-grant`（或在令牌里显式 `grantOnJoin:false`）→ 新设备仍需人工批准。
- **依赖政策**：二维码依赖可选依赖 `qrcode`（精确 pin，见 [`THIRD-PARTY.md`](../../THIRD-PARTY.md)）；缺包时**只给文本**，不报错。门禁 `npm run check:deps`。
- **观察**：控制台邀请面板显示二维码与「自动授权 / 24h 到期」说明；`doctor --net` 不受影响。
- 验收：`npm run verify:invite`（令牌语义 / 渲染与降级 / 兑换即通 / TTL 撤销 / `--qr` 等价）。

## 12. 打洞（C4：AutoNAT + DCUtR）

- **开关**：`network.nat: { autonat?: boolean, dcutr?: boolean }`（默认 **auto**：可选依赖在场即启用）。
  可选依赖：`@libp2p/autonat` + `@libp2p/dcutr`（精确 pin，见 [`THIRD-PARTY.md`](../../THIRD-PARTY.md)）。
- **行为**：与对端先经 relay 建立 circuit 连接 → DCUtR 协调打洞 → 成功即出现**直连**，本机观测到直连后
  **自动把路径升级为 `direct`**（候选入库 + `path-changed`）；失败/超时**保留 relay**（不阻塞，后台按 libp2p 策略重试）。
- **可达性**：AutoNAT 自检本机是否公网可达（与 C6 的 relay 角色、C5 的 `pubReachable` 信息一致，但**互不替代**）。
- **降级**：缺任一依赖 → 打洞禁用 + 告警（`getNatStatus().loadError`），**不影响**其他连接方式（直连/relay 照常）。
- **暴露面**：AutoNAT 会对本机监听地址做**外部回拨探测**；DCUtR 经已建立的 relay 连接交换协调信息（**不新增第三方**、不引公共种子）。
  两者**都不参与授权判定**，也不改变数据面加密（端到端信道不变）。
- **观察**：控制台「关于本机 → 运行状态」显示「NAT 打洞」（AutoNAT/DCUtR 开关、直连升级次数、loadError）；
  `mebular doctor --net` 输出 `nat` 段与建议（如有 relay 连接但无直连升级 → 可能双方都是对称 NAT，属预期）。
- 验收：`npm run verify:nat`（服务装配/直连观测/软降级 + 路径升级与失败保留 + 真 libp2p 两节点 DCUtR 尽力而为）。
