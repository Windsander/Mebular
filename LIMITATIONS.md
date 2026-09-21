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
- **Console settings are organized as 常用 / 高级 / 诊断 tabs**, with read-only facts in an "关于本机" panel (top-bar badge). `sync.autoSync` / `sync.pushOnWrite` are on by default and are no longer editable in the GUI (read-only there; edit `config.json` to change). Every runtime-effective field is shown as "configured X / actual Y" so a written value that has not taken effect is visible.
- **Console invite tokens embed an endpoint.** The endpoint is derived from `joinService.bind` (wildcard → this host's LAN IPv4); with no LAN address it falls back to loopback and the invite panel warns. Fix it via `joinService.endpoint` or the invite panel if your topology needs a specific address.
- **Switching `mcp.http.auth` to `bearer`/`oauth` locks the console API immediately.** `bearer` is recoverable inside the UI (paste a `mebular token grant` token) and the page stays reachable; `oauth` needs env secrets and cannot be recovered from the UI — edit `config.json` back to `auth: none` (loopback only) or supply `MEBULAR_OAUTH_*` and restart.
- **Address book is app-scoped and file-based.** `<home>/net/peers.json` (0600) holds candidate endpoints; core never reads files (the app passes a store). Relay seeds live under a reserved key and are merged into `relayServers` at startup — dynamic relay capability broadcast is deferred to C5.
- **Relaying is an internal daemon role (C6).** The separate `mebular relay` command was removed; the daemon only offers relay service when it has a publicly reachable listen address or observed inbound direct evidence (`network.relayService`: auto/off/on), and only to peers already paired/authorized in the address book, with default limits. Because default limits only allow restricted protocols, carrying Mebular sync streams over a circuit requires the internal `network.libp2p.relayUnlimited: true` switch (undocumented for end users; trusted self-hosted bridges only). The relay role stores no memory/authorization state.
- **Relay restart invalidates reservations.** libp2p relay clients do not automatically re-reserve after a relay restart; recovery is the peer republishing hints (re-invite / refreshed token).
- **Invite QR + auto-grant (C7).** Tokens may carry `grantOnJoin` (default on; only written when explicitly disabled) and `grantTtlMs` (default 24h; `0` = no auto-revoke). On redemption the inviter signs an ordinary `namespace_grant` scoped to the token namespace; expiry is enforced by a graph-external ledger plus scheduled `revokeGrant` (TTL is local policy, never part of consistency). QR codes encode the **inline token text**; rendering uses the optional `qrcode` dependency — when absent, only the text token is shown (no error).
- **Address broadcast (C5) privacy matrix.** `net_endpoints` records (namespace `__net__`, opt-in via `network.broadcast` or adding `__net__` to `sync.namespaces`) are **hints only** and never affect authorization:
  | mode | what is published | who can see it |
  |---|---|---|
  | `full` (default when enabled) | all present lan / public / relay multiaddrs, tagged | only `__net__` subscribers (existing authorization ∩ membership ∩ subscription filtering) |
  | `relay-only` | relay multiaddrs only | same |
  | `off` | nothing | — |
  Records carry `expiry` (default 24h, configurable) evaluated by **local wall clock** (not part of consistency), and records from revoked subjects are ignored. Old nodes ignore the record type entirely (safe direction: fewer hints, never fail-open).
- **LAN discovery is best-effort mDNS.** In the library form mDNS is off unless `Mebular.network.lan.defaultFactory` is set; the daemon (MCP) enables it by default when `network.lan.enabled` is true. It publishes/browses `_mebular._tcp`; discovery only auto-dials peers already in the address book (paired/config) or explicitly whitelisted — unknown devices are ignored. mDNS is unavailable in some sandboxes/CI, and the `bonjour` dependency is loaded defensively (fail-soft: discovery disabled + warning, other transports unaffected). Real-mDNS acceptance is best-effort; the deterministic harness (injected fake bonjour) is the gate.
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
- **扫码即通（C7）**：令牌可选 `grantOnJoin`（默认开，显式关闭才写入=保持字节兼容）与 `grantTtlMs`（默认 24h，0=不自动撤销）；兑换自动授权经既有 `namespace_grant`（作用域=令牌分区），到期由图外台账 + 定时 revokeGrant 保证（TTL 属本地策略，不进一致性）；二维码内容=令牌文本，渲染依赖可选依赖 qrcode（缺包只给文本）。
- **地址自动广播（C5）**：`net_endpoints`（`__net__`，opt-in，默认 full 档）**只作 hints**，不改授权；可见性沿用既有订阅/成员/授权裁剪；`expiry` 为本地墙钟策略（不进一致性）；被吊销 subject 的记录忽略；旧节点忽略该类型（安全方向）。
- **中继内部化（C6）**：无独立 relay 命令；`network.relayService` 默认 auto（可达或见入站直连才当桥），仅服务地址簿已配对/已授权对端，默认限额，不落任何记忆/授权状态；桥的能力广播见 C5。
- **LAN 自动发现（C3）**：mDNS 尽力而为；仅对已知/白名单对端自动拨号（陌生设备忽略）；`bonjour` 缺失时发现软降级（告警，不影响其他连接）；真 mDNS 验收为尽力而为，确定式 harness 才是门禁。
- **配对即连（C1+C2）**：候选地址簿 `<home>/net/peers.json`（0600，core 不读文件、由 app 传路径）；relay 重启会作废旧预约，靠对端重新发布 hints 恢复；relay 能力动态广播留 C5。
- **控制台设置页**：常用/高级/诊断三 Tab + 「关于本机」只读面板；`sync.autoSync`/`sync.pushOnWrite` 默认常开且不再出现在编辑面（只读展示，改需手改 config.json）；运行时生效项一律「已配置 / 实际」双值。
- **控制台**：仅本机/回环（非回环需 TLS+非 none 鉴权，启动强制）；写需 `memory.admin` scope + CSRF，可 `MEBULAR_CONSOLE_WRITES=0` 只读；状态脉冲走 SSE，列表轮询刷新。邀请令牌的 endpoint 由 `joinService.bind` 推导（通配取 LAN IPv4，无 LAN 则回环并告警）；`auth` 切到 bearer/oauth 会立即锁住控制台 API（oauth 只能改回配置自救）。
- **尚无记忆推送**（本地 10–50ms 轮询）；服务日志不自动轮转。
- **快照冲突/合并语义未补齐**；**不实现自动事件裁剪**（约束：必须排除未被所有已授权对端 ack 的事件）；跨会话重复发送是设计。
- **跨 NAT 真机验收仍待**（本机 `verify:wan:l2*` 为仿真）。
