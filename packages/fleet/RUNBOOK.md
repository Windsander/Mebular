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
- 或使用 core 的 circuit relay（`network.libp2p.relayServer` / `relayServers`）；relay 默认限额、需显式 `--unlimited`（见 README「广域网同步」与 core 文档）。
- 广域网自证（non-evidence）命令见 README；真实跨公网证据当前**未达成**（`docs.design/g3r-blocker-*.md`）。

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
