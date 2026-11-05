# Memory Runtime guide (0.3.2)

[中文](MEMORY_RUNTIME_CN.md) · [Documentation index](../README.md) · [v0.3.2 verification matrix](../quality/0.3.2-verification.md)

Mebular's optional **Memory Runtime sidecar** sits next to MCP. It can ingest
conversation slices, extract candidates, recall fragments, assemble a context block and
store task checkpoints for a host. It is **one extra layer over the same graph**, not a
second memory database.

The 0.3.2 release is a stability release: it makes lifecycle, local data, detail
evidence, checkpoint revisions, host failure states and diagnostics match the documented
contract. It does not add a public MCP tool, a second store or a new sync protocol.

The default is unchanged: **lightweight MCP**. A host that only needs explicit
`memory_*` / `task_*` tools never starts the sidecar. The immersive path is an explicit,
per-device opt-in.

```text
┌──────────────────────────────────────────────────────────────────┐
│ Host / Agent                                                     │
│   lightweight: MCP client ─────────────► /mcp (29 tools)          │
│   immersive:   host adapter ───────────► /memory-runtime/v1       │
└───────────────────────┬──────────────────────────┬───────────────┘
                        │                          │
                        ▼                          ▼
          ┌──────────────────────────┐   ┌──────────────────────────┐
          │ MCP daemon               │   │ Memory Runtime sidecar   │
          │ 29 public MCP tools      │◄──┤ ingest / recall / context│
          │ MemoryService            │   │ compact / self / trace   │
          │ Graph + EventLog + sync  │   │ staging / cache / Trace /│
          │ /internal/memory/v1      │   │ outbox / model settings  │
          └────────────┬─────────────┘   └──────────────────────────┘
                       │
                       ▼
          existing graph + signed events + sync + your cloud
```

The sidecar is a **separate process** (`mebular-memory-runtime serve`) and a separate
package (`@mebular/memory-runtime`). It has no write path to the graph. Every durable
object goes through the internal MCP capability API (`/internal/memory/v1`) into the
existing `GraphStore` / `EventLog`; the existing sync layer then carries it to the other
devices in your cloud (忆云). MCP remains the only graph writer.

This guide covers user-facing behaviour. The binding v0.3.2 target is the
[stability contract](../design/0.3.2-stability-contract.md). Older design documents and
v0.3.0 acceptance reports describe their own historical SHAs, not this release.

## Lightweight MCP vs immersive sidecar

| | Lightweight MCP (default) | Immersive Memory Runtime |
|---|---|---|
| Process | MCP daemon only | MCP daemon + sidecar |
| Who decides what to remember | The host model, through tools | The sidecar, from what the host explicitly sends |
| Public tools | 29 `memory_*` / `task_*` tools | Same 29 tools; no new public tool |
| Automatic recall | No | Opt-in, request-only, at most once per human turn |
| Conversation detail | Not collected | Collected by domain; local staging, settled details sync with the graph |
| Detail retention | Not applicable | `conversation`, `tool_output`, `document_slice` or explicit `pinned` |
| Model | None by Mebular | Only the source you configure; `heuristic` by default |
| Durable data | Existing graph + events + sync | Same graph + events + sync, written through capability |

Both modes read and write the **same** Mebular memory. Switching modes does not copy,
migrate, rewrite or delete nodes. Mode is device-local: one device can stay lightweight
while another device in the same cloud uses the sidecar.

## Turn it on

Prerequisites:

- Node.js 20 or newer.
- An **HTTP** MCP daemon (`mebular serve`) on this device. Stdio `mebular mcp` does not
  start the sidecar.
- The sidecar package installed separately. Mebular does not download it for you.
  Install the `@mebular/memory-runtime` package that matches the Mebular release
  (`npm install -g @mebular/memory-runtime`) so `mebular-memory-runtime` is on `PATH`,
  or point `memoryRuntime.command` at an absolute executable path.

1. Enable the MCP lifecycle switch, in **Console → Settings → 记忆运行时**, or in
   `<home>/config.json`:

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

2. Start (or restart) `mebular serve`. The daemon mounts `/internal/memory/v1`, creates a
   capability token, and asynchronously starts the sidecar. Automatic startup is
   non-blocking: MCP readiness, the 29 tools, sync and authentication do not wait for the
   sidecar.

3. Verify:

   ```bash
   mebular memory-runtime status --json
   ```

Once the sidecar is ready it writes `<home>/memory-runtime.json` atomically. The file
contains the URL, port, version, profile/cloud id, `mode=immersive`, `pid`, a heartbeat
(`updatedAt`) and **`tokenFile`** (normally `<home>/memory-runtime/host-token`); it never
contains the token itself. Hosts apply the same freshness rules: discovery older than
15 s is stale, older than 30 s is dead. A live process with stale discovery is not ready.

The **host token** is generated by the sidecar on each start, stored `0600`, and used by
host adapters to call `/memory-runtime/v1`. It is not the MCP capability token: the
capability token is generated by the MCP daemon and given only to the sidecar. Browsers
never receive the host token; the Console reaches the sidecar through the MCP proxy.

`memoryRuntime.*` in MCP is only lifecycle configuration
(`enabled` / `command` / `startTimeoutMs`). Model, retention and HTTP settings belong to
`<home>/memory-runtime/config.json`, not to MCP `runtime.*`; whether details are collected
is owned by the mode.

Console Settings controls memory mode and shows sidecar/model status; Advanced controls
`model.source` and curated local-pack download/selection/removal. Console does not provide
editors for API `baseUrl`/`model`/`keyRef`, raw capture or trace retention. Configure
supported sidecar values directly in `<home>/memory-runtime/config.json`; there is no
raw-capture switch.

## Turn it off: managed, attached and manual

There are three ownership modes. They share one rule: **after a clean disable, the
immersive integration creates no new ingest, recall/context injection, Compact,
Checkpoint, SelfRecord, staging, outbox or Hermes spool item.** Existing data is not
flushed, and pending work is not labelled committed.

| Mode | Who owns the process | What disable does | What remains |
|---|---|---|---|
| **managed** | The MCP supervisor starts the child while immersive is enabled. | Revokes capability, stops admission/replay/model work, gracefully stops the owned child with a bounded wait, removes matching discovery and rotates/revokes credentials. **No outbox flush.** | Settled graph objects and local pending data remain. An explicit purge may discard unsettled data. |
| **attached** | An already running external sidecar; MCP did not spawn it and does not own its PID. | Revokes/detaches this cloud's capability, removes/disables matching discovery and makes host APIs dormant. **It does not stop, SIGTERM or SIGKILL the external process.** | The external PID may stay alive. If the sidecar confirms capability/discovery revocation, it enters dormant `mode=mcp` / `state=stopped` and rejects new work with `409 mode_mismatch`. |
| **manual** | The operator starts `mebular-memory-runtime`; Mebular may discover/attach but never claims ownership. | Same as attached. **No kill and no replacement.** | The operator's process remains; re-enable requires explicit compatible reattachment and fresh authorization. |

A clean disable means the sidecar has actually entered dormant admission/replay/model
behaviour, not merely that discovery disappeared. If that cannot be confirmed, status is
`degraded` with `disable_incomplete` (or an equivalent visible reason), not a clean
`stopped`. Host adapters still fail open without creating new immersive work.

`mebular memory-runtime stop` is an explicit operator stop. It may stop the process you
asked it to stop, but immersive disable itself never flushes queued writes. Re-enable
creates a fresh authorization/discovery generation; a cached credential from the
previous generation does not wake the instance.

## State model: accepted, pending, queued, committed

0.3.2 separates transport success from durable outcomes in the sidecar, the Console and
all three host adapters.

| Term | Exact meaning | It does **not** mean |
|---|---|---|
| **accepted** | Authentication, mode, schema and admission checks passed; processing started. | Queued, graph-committed or synced. |
| **pending** | Non-final work still needs extraction, a host candidate, a capability response or conflict resolution. A user-visible pending state has a durable recovery record or a bounded failure exit. | Committed, or proof that a request reached MCP. |
| **queued** | A specific operation was atomically persisted in the sidecar outbox or a disclosed host spool with a stable idempotency key before the host was acknowledged. | A graph write. |
| **committed** | MCP capability confirmed every required write and the object(s) are present in the local graph/event log. `duplicate` counts only when it resolves the same idempotent logical object. | Process health, capability reachability, queue success or peer sync. |
| **failed** | This attempt reached a terminal, visible failure without automatic retry. | A possible commit being relabelled as definitely absent after an ambiguous timeout. |
| **dead** | A persisted outbox/spool operation is terminally failed and retained for bounded diagnosis or explicit handling. | A new graph object or successful delivery. |
| **degraded** | A health attribute accompanying a result, such as cache recall or heuristic fallback. It can coexist with committed. | An item persistence state or proof of success/failure by itself. |

Required behaviour:

- HTTP 202 means only non-final `pending` or `queued`. It is never rendered as committed.
  `queued:true` requires a durable record; a full/failed queue returns an explicit error
  instead of 202.
- HTTP 200 is transport success only. `extraction.status:'failed'` is failed and
  `extraction.status:'pending'` is pending regardless of 2xx. A partial record/detail
  write is reported as partial, without implying atomic rollback.
- **Outbox enqueue success = queued.** **Outbox replay success = committed only after
  capability confirmation**, followed by removal of the active entry. These are separate
  events.
- A timeout after a possible commit is outcome-unknown. Retry/reconcile with the same
  idempotency key; never issue a new key for the same logical operation and never claim
  either definite success or definite non-commit without evidence.
- A 202 response and its cached idempotent response are historical outcomes, not a status
  polling API. A later authoritative read, list or checkpoint revision is what can
  establish commit.

## Checkpoints: pending, last committed and revisions

A ContextCheckpoint is always a graph object in `task:<threadId>` or `default`; local
checkpoint files are cache only.

- Revision is monotonic per checkpoint key. Updating an existing checkpoint must carry
  the last committed `expectedRevision`. A direct `409 revision_mismatch` gets one
  authoritative GET and one retry with the same logical update; a second conflict becomes
  visible failed/pending, not a blind overwrite.
- An already queued replay does **not** silently rebase onto a newer revision. A revision
  conflict becomes visible failed/dead for explicit host/user regeneration. An active
  lease conflict may retry only within the lease/deadline bound; agents never use `force`.
- A 202 checkpoint response has `pending:true` and **no committed revision**. Only a later
  graph-confirmed revision may be presented as committed. GET responses expose
  `highWater` / `latestRevision`; when a checkpoint was deleted or expired, the next
  update continues above that high-water mark instead of reusing an old revision.
- Pending and last-committed views are distinct. An offline GET returns the last committed
  object plus pending/degraded metadata, or a null checkpoint with `pendingCheckpoint`
  when nothing was ever committed. It never replaces the last committed object with a
  pending intent.
- Omitted `expiresAt` means **0: no authoritative expiry**. `retention.checkpointDays`
  changes only the local object-cache TTL. An explicitly expired checkpoint is not
  injected and reads as unavailable. Checkpoint expiry does not delete related
  MemoryRecords or Details.
- Checkpoint deletion is online-only. Offline deletion returns an explicit failure; it is
  not queued as a local pretend-delete and does not cascade to records or details.
- `recordIds`, `detailIds` and `state.references` graph IDs are validated at commit for
  existence, expected type, live state, same domain and (for details) non-expiry. Invalid
  queued references fail/dead instead of committing dangling evidence. External message
  IDs remain host references, not graph proof.
- Context order is **self → checkpoint → compact/fragment**, within the existing
  byte/token budget. `includeSelf=true` consumes the current same-agent SelfRecord.
  A legitimately absent record yields a non-degraded empty result with no self block; a
  read failure, unavailable authority or stale/unverifiable cache yields
  `degraded=true` with a stable reason. It never fabricates a current or empty success.
  `includeSelf=false` injects no self block. v0.3.2 adds no SelfRecord delete/TTL operation.
- The lease is the existing 60-second cooperative window with a server-derived `hostId`.
  Expiry permits cooperative acquisition; it does not prove the previous host stopped.
  Revision/lease is local optimistic concurrency plus a cooperation hint across synced
  replicas, not strong cross-device consistency or agent authentication.

## Details, evidence and retention

Settled conversation detail is a graph object (`type=detail_record`) with one of
`raw_chunk`, `message`, `tool_output` or `document_slice`. `raw_chunk` is the kind used for
an ordinary settled ingest chunk; it is not the name of the local staging file.

Retention follows role and `detailKind`:

| Class | Default | Used for |
|---|---:|---|
| `conversation` | 30 days | Ordinary user/assistant/system conversation detail |
| `tool_output` | 7 days | `role=tool` or `detailKind=tool_output` |
| `document_slice` | 90 days | `detailKind=document_slice` |
| `pinned` | Until explicit deletion | Explicit user/system governance only; not a normal ingest choice |

The sidecar derives `retentionClass` from role/kind; ordinary ingest cannot silently
extend it with `pinned`. Tool output must not default to conversation retention. Server
policy may shorten retention but never silently lengthen it. Expiry is enforced on read
even before physical cleanup, and MCP also runs authoritative detail expiry/quota
maintenance.

Evidence association:

- The canonical record↔detail association is the validated, same-domain
  `DetailRecord.recordIds` plus the existing reverse lookup. A forward
  `provenance.detailIds` field is compatibility metadata: if present it must agree, but it
  is not rewritten after settlement and is not the only lookup.
- A multi-domain extraction links only the chunks/messages that actually support each
  domain. It does not copy unrelated request chunks into every domain. If the same
  evidence genuinely supports two domains, each domain gets its own detail record and ID.
- `rawChunkIds` is compatibility metadata, not a staging-ID substitute for a graph detail
  ID.
- A recall fragment may report `detailAvailable`, `detailKinds`, `detailIds` and
  `detailAvailability` (`available`, `pending_sync`, `expired`, `deleted`,
  `quota_evicted`, `not_subscribed`, `redacted_only`). A stored detail that cannot be
  associated is reported honestly, not as a successful expansion.

Deleting a MemoryRecord tombstones linked details when no other live record references
them; deleting a detail does not delete its record. Detail expiry/quota does not delete
records, Compacts, checkpoints or SelfRecords. Local process cleanup never deletes graph
objects. **Graph deletion is not physical content erasure**: create/update events retain
node versions, and tombstoned nodes may retain content. Host-owned copies, peer snapshots,
outbox/dead bodies and the capability idempotency ledger are additional copies outside a
secure-erasure claim.

## What stays local — and what goes to your cloud

The sidecar data directory is `<home>/memory-runtime/`. It contains process data only:

| Object | Location | Cross-device | Authority and bounds |
|---|---|---|---|
| `MemoryRecord` (entity / fact / episode / skill) | Existing graph + event log | Yes, by domain subscription | Authoritative |
| `Compact` | Existing graph, same domain as its sources | Yes | Derived summary; non-empty source IDs/hashes; stale recomputed from sources |
| `SelfRecord` | Existing graph, `agent:<agentId>` | Yes | Agent self-model; hidden from ordinary queries; upsert creates a new revision |
| `ContextCheckpoint` | Existing graph, `task:<threadId>` or `default` | Yes | Task resume point; revision/lease enforced by MCP; no `expiresAt` means no authoritative expiry |
| `DetailRecord` | Existing graph + event log | Yes, while in retention and subscribed | Domain-shared detail; retention by class; evidence linked through `recordIds` |
| Staging `RawChunk` | `<home>/memory-runtime/staging/` | **No** | Unsettled local chunks; 24 h / 256 MiB default; `0700`/`0600`; deleted after settlement or bounded cleanup |
| Detail cache | `<home>/memory-runtime/cache/details/` | **No** | Read-only cache; 30 d / 256 MiB / 5,000 entries; may be stale, never authoritative |
| `RecallTrace` | `<home>/memory-runtime/traces.jsonl` | **No** | Local diagnostics; 7 d / 2,000 entries; no bodies, prompts or secrets |
| Cache / index | `<home>/memory-runtime/cache/` | No | Rebuildable; never authoritative; invalidated on tombstone/update and revalidated after recovery |
| Outbox / dead | `<home>/memory-runtime/outbox/` and `outbox/dead/` | No | 1,000 items / 16 MiB active bound; 30-day maximum queued age; dead retained 30 days |
| Capability idempotency ledger | `<home>/memory-runtime/capability-idempotency.json` | No | 24 h / 5,000 entries; minimal response fields; replay ledger, not a commit-status API |

Staging, traces, cache and outbox are bounded local process data. Cleanup runs on a
60-second maintenance timer while the sidecar is alive and idle, as well as at startup and
on writes; it is not a restart-only or lazy-only cleanup. Cleanup is dependency-aware: if
an active outbox operation still needs staging evidence, the operation is first made
visibly failed/dead at its deadline, or it completes before the evidence is removed.

There is no `sync=cloud` / `sync=local` switch and no local checkpoint mode. A checkpoint
or self record is always a cloud object; the local cache is only a cache. Deleting the
whole `<home>/memory-runtime/` directory does not delete settled memories — they are
restored from MCP/the graph. Settled detail records are domain-shared graph objects and
can be expanded on another subscribed device while they are within retention. The local
staging/cache is not the authoritative copy; only expiry, deletion, quota eviction or a
missing subscription makes detail unavailable.

The bounded outbox exists for the case where MCP is temporarily unreachable. It is not a
second memory store: entries are idempotent writes that are removed after success, and
permanent failures move to `outbox/dead/` instead of retrying forever. If an
outbox/spool operation cannot be settled within 30 days or its earlier operation
deadline, it becomes visibly dead with `retention_expired`; long-offline work is not
guaranteed to settle.

Host-owned copies stay outside the graph:

- **DSH** may retain a source-tagged memory-context snapshot in its durable
  `session.v4.jsonl`. Mebular does not sync or erase that host copy. Each DSH turn
  filters/replaces the tagged node so a miss does not carry an old block into the next
  model request.
- **Hermes** keeps a persistent bounded `queue.jsonl` (plus dead/quarantine recovery
  files) under `$HERMES_HOME/mebular-memory/`; it is pending host work, not committed
  Mebular memory.
- **OpenCode/OpenChamber** has no durable host ingest/checkpoint spool. The injected block
  is request-only; non-durable interrupted work becomes visibly failed.

## Privacy and control

- **Collection follows the mode.** Lightweight MCP starts no sidecar and collects nothing.
  Immersive mode has the host adapter send explicit `/ingest` turns by domain; there is no
  separate collection switch and no first-run consent. Staging is local until the detail
  settles into the graph.
- **No model by default.** `heuristic` runs in-process and makes no network request. No
  model file is downloaded automatically. Local, host and API sources are explicit.
- **Redaction happens before persistence or network use.** Staging, outbox, Hermes spool,
  logs, status and remote-model requests receive minimized/redacted content; secrets,
  tokens, passwords and message sentinels must not appear in forbidden files or logs.
- **Staging and traces stay local.** Unsettled staging chunks and recall traces are local
  process data. Settled detail records are graph objects and sync by domain. Logs/status do
  not include original text, tokens or keys.
- **Injected memory is untrusted background data.** Hosts put it in a non-instruction
  channel, escape closing tags, and never execute commands or tool calls found in memory.
  OpenCode's block is request-only. DSH 0.2.1-rc.2 is the explicit exception to a
  non-persistent channel: its source-tagged context snapshot is stored in the host-owned
  durable `session.v4.jsonl`; Mebular deletion/retention does not erase that host copy.
- **You can turn it off.** Disable `memoryRuntime.enabled` and/or stop the sidecar. Managed
  mode stops only the owned child; attached/manual mode leaves the external process alive
  but dormant. Settled memories remain in the graph until you delete them through the
  normal MCP/Console governance path.
- **Logical, not cryptographic, isolation.** `agentId` is an assertion, not
  authentication. Domains filter what the sidecar asks for, but a holder of the host token
  or capability token can still read the local store. 0.3.2 does not claim encryption or
  namespace ACLs between agents or users.
- **Deletion is cooperative.** A tombstone syncs to peers, but an offline peer that
  already holds a copy may keep it until it reconnects. Do not describe this as guaranteed
  remote erasure.

## Host entry points

Each host keeps its own native memory; Mebular does not import, mirror or dual-write it.

- **DSH** — discovery-following `memoryRuntime` bridge in `@mebular/dsh-plugin`; recall on
  the first step of a new human turn, batched ingest, compaction checkpoints and optional
  tool hiding. See [DSH integration](../integrations/DSH.md).
- **Hermes** — `MemoryProvider` in `integrations/hermes/mebular-memory`; `prefetch`,
  `sync_turn`, archive on pre-compress and a state-only checkpoint. See
  [Hermes integration](../integrations/HERMES.md).
- **OpenChamber / OpenCode** — `@mebular/opencode-plugin` for OpenCode 2.2+; request-only
  context injection, event ingest and compaction checkpoints. See
  [OpenChamber / OpenCode integration](../integrations/OPENCHAMBER.md).

A host with no adapter can use the HTTP API directly: discover
`<home>/memory-runtime.json`, read `tokenFile`, call `/health`, `/ingest`, `/recall`,
`/context` and `/checkpoints/:threadId`, and fail open on timeout. A 202 only means
pending/queued; follow up with an authoritative read before claiming commit.

## Diagnostics: logs, doctor and outbox

Start with the CLI and the discovery/health endpoints:

```bash
mebular memory-runtime status --json
mebular memory-runtime start
mebular memory-runtime stop
mebular memory-runtime restart
mebular memory-runtime logs --json --limit 50
mebular memory-runtime doctor --json
mebular memory-runtime outbox list --json
```

`status --json` is read-only and returns `state` / `degraded` / `runtimeVersion` / `url` /
`error`; it never returns a token. For a running sidecar, `GET /health` (no token,
loopback) tells you whether the process is ready, and `GET /status` (host token) adds
capability, model, counts, outbox and degraded reasons.

**Logs.** The sidecar writes sanitized JSONL to `<dataDir>/logs/runtime.jsonl`, rotated
with bounded size/count. `logs` reads the current and rotated files; `--limit`/`--tail`
select the newest entries. `mebular memory-runtime logs` and the sidecar binary's
`mebular-memory-runtime logs` read the same files. Events are sanitized before append and
again on read: no tokens, message bodies, prompts, responses or real home paths. A log
failure never blocks the runtime.

**Doctor.** `doctor --json` combines live status with sanitized diagnostics: recent
errors, restart reason, capability/model state, staging/trace/cache/detail-cache counts,
outbox/dead counts and ages, disk usage, log status, dead reasons, the last
revision/lease conflict, and ambiguous operations that may have committed. It also prints
concrete next steps. `degraded` is true for dead entries, ambiguous operations or a
degraded runtime.

**Outbox.** `outbox list` shows active and dead operations by operation/endpoint with
oldest age; `outbox show <id|requestId>` adds sanitized per-item metadata and any
already-committed object IDs. `outbox rebuild <id>` retries the same logical operation
without automatic rebasing; `--expected-revision N` is an explicit human override.
`outbox purge <id>` discards an unsettled operation and must be treated as data loss.
A `timeout`/`network_error`/`partial_failure` with `possibleCommit` must be reconciled by
authoritative readback, not by assuming either success or absence.

Diagnostics never contain tokens, message bodies or the real home path.

Common failures and what they mean:

| Symptom | Cause | What to do |
---|---|---|
| `not_installed` | No `mebular-memory-runtime` on `PATH` / configured path | Install the matching `@mebular/memory-runtime`, or set `memoryRuntime.command` |
| `capability_disabled` / 404 on `/internal/memory/v1` | MCP is older, stdio-only, or `memoryRuntime.enabled=false` | Use `mebular serve` with the switch on |
| `capability_token_invalid` / `capability_token_missing` | Token rotated or MCP capability not mounted | Restart MCP and then the sidecar |
| `version_incompatible` | Sidecar and MCP major/API versions do not match | Use matching packages |
| `bind_failed` / port busy | 7341–7350 occupied | The sidecar falls back to a temporary port; read discovery instead of hardcoding 7341 |
| `degraded` with `capability_unavailable` | MCP temporarily unreachable | Conversation continues; recall may use cache; writes queue in the bounded outbox |
| `degraded` with model reason | Local pack/engine or API unavailable | Check `status`, install/allow the source, or stay on `heuristic` |
| `mode_mismatch` / `mode=mcp` `state=stopped` | Immersive capability was revoked; sidecar is dormant | Re-enable explicitly; do not retry as a transient outage |
| `disable_incomplete` | Sidecar could not confirm a clean dormant state | Keep hosts fail-open; inspect logs/doctor and the external process |
| `outbox_full` | Too many unsent writes | Restore MCP connectivity; inspect `outbox list`; do not treat the outbox as durable memory |
| `checkpoint_pending` | A 202/queued checkpoint has no committed revision yet | Read the checkpoint authority; do not render it as committed |
| `detail_pending_sync` | A detail is stored but not yet associated with this recall fragment | Retry after settlement; do not claim the detail was erased |
| `401` from a host adapter | Host token rotated | Re-read `tokenFile`; the adapter retries once |

All of these fail open for the host: the chat continues, MCP's 29 tools still work, and
the worst case is that no memory is injected. A failed sidecar must never block MCP
startup, tools, sync or authentication.

## Upgrading from 0.2 and the old prototype

- **No migration.** 0.3.0 and 0.2 nodes, events, namespaces, tags and IDs keep their
  values. No field is added, no ID is rewritten and no event is re-signed. Existing
  details that were written by 0.3.0 with `conversation` retention keep those values.
- **0.3.0 → 0.3.2 data-safety drill.** A sequential single-home upgrade and rollback
  drill passed on the integration line: old records, details, Compacts, checkpoints and
  self records remained readable; the graph and event log were not rewritten. See the
  [v0.3.2 verification matrix](../quality/0.3.2-verification.md). This is not a
  mixed-version, concurrent or bidirectional-compatibility promise.
- **0.2 data is read, not promoted.** 0.2 `default` data is read as the Other fallback
  (`domain=default`); it is not silently promoted to `user`.
- **The prototype `/runtime/v1` is gone.** It is not served and has no compatibility
  layer. Host adapters must use `/memory-runtime/v1`.
- **Prototype local data is not read.** Old `<home>/runtime/` sidecar data is ignored.
  Never delete `<cloudRoot>/runtime/`: that is the MCP daemon install root, not sidecar
  data. The sidecar uses `<home>/memory-runtime/` and `<home>/memory-runtime.json`.
- **Same-version boundary.** This release has no compatibility layer or mixed-version
  window. Run the same version on every device. A 0.2.4 direct upgrade/rollback path has
  not been verified for 0.3.2; the 0.2 notes above are data-retention statements, not a
  full rollback acceptance. See [Limitations](../limitations/LIMITATIONS.md).
- **Stop the sidecar explicitly before changing packages.** Unsettled staging/outbox
  entries stay on this device and are not migrated or guaranteed to settle. Keeping
  `<home>/memory-runtime/` leaves them for a compatible sidecar to resume; deleting the
  directory discards them. Already-settled details remain graph objects, and copies
  already synced to peers remain subject to normal retention, deletion and tombstone sync.

## Scope and limits

- 29 public MCP tools stay unchanged; no `runtime_*` or `fragment_*` tools are added.
- One cloud, one user. No per-user accounts, namespace ACLs or per-agent cryptographic
  isolation. `agentId`, actor type and task participation are logical assertions.
- Checkpoint evidence references are strict: they must exist, have the expected type, be
  live and belong to the same domain. Cross-domain or dangling references fail instead of
  committing.
- No background scanning: the sidecar only processes explicit `/ingest` input from a host
  adapter.
- No second memory store: settled details use the existing graph/events/sync; recall
  traces stay local. No silent model download, no automatic model update, no model
  configuration sync.
- No destructive compaction and no automatic merge of conflicting facts.
- No cross-cloud federation.
- Deletion is cooperative and can lag on offline peers; see the erasure boundary above.
- **Scale evidence is partial.** The 1k smoke benchmark completed twice with a real
  graph/capability/sidecar and 6/6 failure-injection scenarios. The 10k full run did not
  complete, so this release does not claim a 10k pass or extrapolate 1k latency to 10k.
  See the [scale benchmark report](../quality/0.3.2-scale-benchmark.md).
- **Real-model evidence is partial.** A real-model canary was not run for 0.3.2. The
  historical Qwen3-4B/llama.cpp smoke is evidence for that one pack/platform/SHA only.

## Verification

- [v0.3.2 verification matrix](../quality/0.3.2-verification.md) — test counts, host
  boundaries, scale status, upgrade/rollback evidence and the explicit pending items.
- [v0.3.2 scale benchmark report](../quality/0.3.2-scale-benchmark.md) — 1k smoke (two
  runs), 6/6 failure injection and the unfinished 10k status. The report's detail-kind
  P1 observation is historical; the recall association fix and its regression test landed
  afterwards.
- [0.3.0 Memory Runtime acceptance report](../quality/0.3.0-memory-runtime-acceptance.md) —
  a historical `c71e811` run with a real sidecar and fake capability; heuristic only, no
  model or external network, and no real MCP/core, host or cross-device sync.
- [Three-host E2E](../../tests/integration/host-e2e/README.md) — historical counts and
  explicit real/fake boundaries. Fresh v0.3.2 counts are recorded in the verification
  matrix, not copied from the 0.3.0 report.
- [Real-model smoke](../quality/0.3.0-model-smoke.md) — historical evidence for Qwen3-4B
  Q4_K_M plus llama.cpp b12017 on macOS arm64 only.
- The demo in [`examples/memory-runtime-demo`](../../examples/memory-runtime-demo/README.md)
  shows ingest → gist → detail → context budget → checkpoint with a real MCP daemon,
  capability API and sidecar.
