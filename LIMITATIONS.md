# Limits & Trade-offs

> This file collects Mebular's **known limits and deliberate trade-offs** (previously scattered in the README).
> Chinese summary at the end. Protocol contracts live in [`SEALING.md`](SEALING.md).

## 1. Scope / product

- **Not a cloud memory SaaS.** Nodes are yours to run; there is no central service or coordinator.
- **Early project.** APIs are not stable and no npm package is published yet; evaluate before production.
- **Local-first, decentralized consistency.** We trade strong global consistency for availability: within the
  **commonly authorized** namespaces, any two peers eventually converge; partitions only change *who gets which
  bytes, when*, not the consistency model.

## 2. Trust / identity

- **Cross-device communication goes through the memory (data) channel only.** There is **no general remote
  query/RPC** surface. An "application protocol layer" is **retired**; it is revisited only if one of these appears:
  streaming/interactive multi-turn sessions, large-object/media transfer, non-Mebular apps sharing the same
  identity/authorization, or low-latency RPC that must not be persisted.
- **Same-machine agents are mutually trusted** (device-level identity, no encryption isolation between agents on
  one machine). Cross-machine trust still requires a certificate chain to the user master key + explicit namespace grant.
- **Revocation is domain shrinkage, not remote erasure.** It stops *future ingestion* (read side `[]`, inbound
  isolation, snapshot filtering); it does not retract data already in the graph, and revoked devices may still open
  sessions (otherwise they could never learn about recovery).
- **Revocation propagation is delayed** by event sync: the cascade is immediate once the `device_revoke` event is
  present, so each peer only sees it after syncing.
- **Reserved namespace `__policy__` is readable by all authenticated devices (including revoked ones)** — a
  deliberate bootstrapping/recovery trade-off; the authorization graph is visible to enrolled devices.
- **`policyIssuers` is local configuration** (bootstrap). Peers must agree on it, otherwise they may derive
  different conclusions for the same records. Empty means "fall back to the configured allow-list" (default deny is not relaxed).

## 3. Storage / operations

- **Single writer per home.** The daemon holds a store lock; a second writer is rejected with a readable error
  (`MCP_STORAGE_LOCKED`). Fleet/agents must go through the daemon's local app API rather than opening the store directly.
- **Quota is local accounting only.** No global ledger, no cross-peer reconciliation; different devices' quotas are independent.
- **Token-based joins are plaintext HTTP over LAN** with a short-lived, single-use bearer token. Use a trusted LAN;
  cross-segment joins need a relay/extra protection (TLS/mTLS is future work).
- **No server push (SSE) yet.** Local clients poll (10–50 ms); push is deferred.
- **No automatic log rotation** for services; run `logrotate` or clean up manually.
- **Console invite tokens embed an endpoint.** The endpoint is derived from `joinService.bind` (wildcard → this host's LAN IPv4); with no LAN address it falls back to loopback and the invite panel warns. Fix it via `joinService.endpoint` or the invite panel if your topology needs a specific address.
- **Switching `mcp.http.auth` to `bearer`/`oauth` locks the console API immediately.** `bearer` is recoverable inside the UI (paste a `mebular token grant` token) and the page stays reachable; `oauth` needs env secrets and cannot be recovered from the UI — edit `config.json` back to `auth: none` (loopback only) or supply `MEBULAR_OAUTH_*` and restart.
- **Console is local and loopback-oriented.** The GUI (`/console`) is served by the daemon; non-loopback exposure
  requires TLS + non-none auth (enforced at startup). Writes need `memory.admin` scope **and** CSRF; set
  `MEBULAR_CONSOLE_WRITES=0` for a strictly read-only console. Live status uses SSE (`/admin/events`), but
  memory/device lists refresh by polling.

## 4. Data model / sync

- **Snapshot conflict/merge semantics are incomplete.** Initial snapshots are sent only to peers reporting an empty
  namespace watermark; acceptance is guarded (missing locally or strictly newer). Relaxing "empty peers only"
  requires full per-event conflict/merge semantics first.
- **No automatic event pruning.** Any future pruning must exclude events not yet acked by *all* authorized peers;
  this round only fixes the constraint and tests.
- **Cross-session duplicate sends are expected** (send-more-never-less; receivers dedupe by content-addressed id).
- **Cross-NAT verification is still pending on real hardware**; local `verify:wan:l2*` are simulations.

---

## 中文要点

- **不是云 SaaS**：节点自管，无中心服务/协调者；项目早期、API 未稳定、未发 npm。
- **跨设备只走记忆通道**，不提供通用远程查询/调用；「应用间协议层」已退役（出现流式会话/大对象/非 Mebular 复用身份/低延迟 RPC 再立项）。
- **同机 Agent 默认可信**（设备级身份、不做加密隔离）；跨机仍需证书链 + 显式分区授权。
- **吊销是域收缩**：不回撤已入图数据、仍可建会话；级联在事件同步到达后生效（有传播延迟）；`__policy__` 对已认证设备（含被吊销者）可读。
- **单写者**：守护持 store 锁，第二个写者明确拒绝；**配额仅本地记账**；令牌加入为 LAN 明文 HTTP+bearer。
- **控制台**：仅本机/回环（非回环需 TLS+非 none 鉴权，启动强制）；写需 `memory.admin` scope + CSRF，可 `MEBULAR_CONSOLE_WRITES=0` 只读；状态脉冲走 SSE，列表轮询刷新。邀请令牌的 endpoint 由 `joinService.bind` 推导（通配取 LAN IPv4，无 LAN 则回环并告警）；`auth` 切到 bearer/oauth 会立即锁住控制台 API（oauth 只能改回配置自救）。
- **尚无记忆推送**（本地 10–50ms 轮询）；服务日志不自动轮转。
- **快照冲突/合并语义未补齐**；**不实现自动事件裁剪**（约束：必须排除未被所有已授权对端 ack 的事件）；跨会话重复发送是设计。
- **跨 NAT 真机验收仍待**（本机 `verify:wan:l2*` 为仿真）。
