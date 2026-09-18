# Relay 部署与运维（transport-only）

> **定位**：circuit relay 只做**字节转发**，是纯传输；按 [`SEALING.md`](../../SEALING.md) §1.6「传输/集成不构成权威」，
> relay **不参与**授权、策略、一致性判定。**可自托管、可替换**（换 relay 或改用手动 multiaddr 不影响记忆语义）。

## 1. 部署

- 依赖可选包：`@libp2p/circuit-relay-v2` + `@libp2p/identify`（已在 `optionalDependencies`）。
- 单命令起 relay（本机/服务器）：

```bash
node scripts/wan-sync.mjs relay --port 4001 --unlimited
# 输出 listening multiaddr（/ip4/0.0.0.0/tcp/4001/p2p/<RELAY_ID>）
```

- peer 侧配置 relay：`network.libp2p.relayServers: ['/ip4/<relay>/tcp/4001/p2p/<RELAY_ID>']`（fleet `onboard`/配置或 `Mebular` 选项）。
- 受限资源：默认 relay 有限额；`--unlimited` 仅用于可信自托管。**不要**把无限额 relay 暴露到公网。

## 2. 网络与加固

- **隔离/仿真**：`docker-compose.wan.yml`（relay + 两个 NAT 后 peer，无入站端口）→ `npm run verify:wan:l2:docker`。
- **本机 relay-only 断言**：`npm run verify:wan:l2`（无 docker 也可跑）。
- **加固清单（既有，未改线格式）**：
  - 帧大小上限 `MAX_FRAME_BYTES = 4 MiB`（`encodeFrame`/解码越界抛错）——`tests/p2p/Libp2pProvider.test.ts`。
  - 连接数上限 `ConnectionManager.maxConnections`（默认 100，超限拒绝新连接）——`tests/p2p/ConnectionManager.test.ts`。
  - 对端白名单 `sync.peerWhitelist`（未列对端的已认证会话被忽略）——`tests/sync/wan-hardening.test.ts`。
- **监听告警**：`fleet doctor` 对 `0.0.0.0`/公网监听给出 `WARN` + 修复建议（改绑回环/LAN + 经 relay，或防火墙仅放行已授权对端）。

## 3. 故障与降级

- relay 不可达：peer 仍可用**手动 multiaddr 直连**（`direct-degraded`）；`wan-sync`/`verify:wan:l2` ⑤ 验证。
- relay 重启 / 对端地址变更：重预留 + 经 relay 恢复（`verify:wan:l2` ③④）。
- 确定性故障注入（丢包/延迟）：有界收敛且失败可观测——`tests/sync/wan-hardening.test.ts`（L4）。

## 4. 相关

- 双机手工命令：[`RUNBOOK.md`](./RUNBOOK.md)（§3 跨 NAT/公网）。
- 上车/权限：[`ONBOARDING.md`](./ONBOARDING.md)。
- 诚实边界：跨公网（L3）证据留给**真机阶段**；本文件所述均为本机/CI 可重复仿真。
