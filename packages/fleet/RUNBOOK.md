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
- **只读 / 可写**：默认可写（写端点需 `memory.admin` scope + CSRF 双提交；仅 `POST/PUT/PATCH`，`Origin` 必须同源）；`MEBULAR_CONSOLE_WRITES=0` 降级为只读。
- **鉴权 / TLS**：回环可 `auth=none`；**非回环必须** `auth=bearer|oauth` 且启用 TLS（配 `tlsKey`/`tlsCert`），否则 serve **拒绝启动**（`MCP_INSECURE_CONFIG`，不静默降级）。语义为**单一真值**：证书齐备即实际走 https（`tls=true` 表示「必须启用」，缺证书则启动失败）；`status`/`print-config`/控制台「实际运行状态」同此真值。控制台保存时也会做**组合校验**（非法 host/auth/tls 组合 → 400）。
- **邀请端点（F-C6）**：令牌里写死的 `endpoint` 必须是**新设备可达**地址。默认由守护按 `joinService.bind` 计算：通配（`0.0.0.0`）时自动取本机 LAN IPv4；也可在 `joinService.endpoint` 显式固定，或在控制台「＋ 邀请新设备」面板临时填写后重新签发（令牌随之覆盖）。若无 LAN 地址会回退回环并在面板告警。
- **auth 误切怎么恢复（F-C7）**：`mcp.http.auth` 切到 `bearer` 后控制台 API 立即 401（`/console/` 页面仍可打开，粘贴 `mebular token grant --scope memory.read,memory.admin` 生成的 token 即可自救）；切到 `oauth` 后静态 token 无效（`invalid token`）、`/register` 默认 404（未设 `MEBULAR_OAUTH_ADMIN_SECRET`/`MEBULAR_OAUTH_REGISTER_SECRET`），控制台内无法自救——编辑 `<home>/config.json` 把 `mcp.http.auth` 改回 `none`（仅回环）或补齐 env 凭证，再重启 `mebular serve`。
- **演示种子**：`node packages/console/scripts/seed-demo.mjs --home /tmp/mebular-demo` → 按提示启动 serve 并打开 `/console`。
- **误设后怎么救**（把 host 存成 `0.0.0.0` 且 auth=none / 缺证书导致 serve 拒绝启动）：直接编辑 `<home>/config.json`，把 `mcp.http.host` 改回 `127.0.0.1`，或补齐 `auth`+`tls`+`tlsKey`/`tlsCert`，再重启 `mebular serve`。
- 状态脉冲经 SSE（`/admin/events`）；记忆/设备列表仍为轮询刷新（10–50ms）。
