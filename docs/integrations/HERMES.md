# Mebular in Hermes Agent

[中文](HERMES_CN.md) · [Documentation index](../README.md) · [Memory Runtime guide](../guides/MEMORY_RUNTIME.md)

Hermes can use Mebular in two layers, and they can run together:

| Layer | What Hermes gets | Default |
|---|---|---|
| **MCP** | The official Mebular MCP server: explicit `memory_*` and `task_*` tools | Available when configured |
| **Memory Runtime** (`MemoryProvider`) | Automatic recall before a turn, turn/compaction ingest, state-only checkpoints, session-boundary archive | Off; explicit opt-in |

The provider lives in [`integrations/hermes/mebular-memory`](../../integrations/hermes/mebular-memory/).
The optional companion lives in
[`integrations/hermes/mebular-companion`](../../integrations/hermes/mebular-companion/).
Neither changes Hermes core, and neither is required for MCP.

The Memory Runtime sidecar is **a separate process from the MCP daemon runtime**. The
provider talks only to `/memory-runtime/v1`; it never treats the MCP daemon's
`runtime.json`, `/mcp` endpoint or `daemonUrl` as the sidecar.

## Hermes boundaries

Hermes supports **one external memory provider** at a time. Activating Mebular's
`MemoryProvider` selects it in that slot; it does not remove Hermes' built-in
`MEMORY.md` / `USER.md`, which stay active.

Mebular deliberately:

- does not import, mirror or dual-write `MEMORY.md` / `USER.md`;
- does not implement `on_memory_write`;
- does not replace the MCP surface or register duplicate memory tools;
- does not read Hermes' LLM token, endpoint or cookie;
- does not claim a current model when Hermes does not provide one.

## Two modes

### Lightweight MCP

Configure the Mebular MCP server in Hermes (`mcp_servers.mebular`) through the Mebular
Console assistant onboarding or Hermes' own config. The assistant then decides when to
call `memory_write`, `memory_query`, `memory_profile`, `memory_history`, task tools and
the rest. This is the same 29-tool MCP surface used by other hosts.

Lightweight mode starts **no** Memory Runtime sidecar: no `mebular-memory-runtime`
process, no new `<home>/memory-runtime/` directory or files, no `memory-runtime.json`,
no host token, no port 7341 listener and no model download. If `<home>/memory-runtime/`
already exists from an earlier immersive session, lightweight mode neither reads nor
modifies it; disabling the sidecar never deletes settled memories.

### Immersive MemoryProvider

The provider connects Hermes turns to the independent sidecar:

- `prefetch` / `queue_prefetch` → `POST /memory-runtime/v1/context`, falling back to
  `/recall` only when an older sidecar does not implement `/context`;
- `sync_turn` → `POST /memory-runtime/v1/ingest`, non-blocking and deduplicated by a
  stable `requestId`;
- `on_pre_compress` → archive ingest plus `PUT
  /memory-runtime/v1/checkpoints/:threadId` with a **state-only** checkpoint;
- `on_session_end` → archive ingest; it does not write a checkpoint by default.

The provider exposes **no tools** (`get_tool_schemas()` returns an empty list). MCP
remains the explicit governance surface, and the 29-tool surface is unchanged.

## Enable the sidecar and provider

The provider requires a running 0.3 Memory Runtime sidecar. The MCP daemon starts it only
when the MCP setting `memoryRuntime.enabled=true` (or when you start it manually with
`mebular memory-runtime start`). In the normal setup:

1. In the Mebular Console, choose the immersive memory runtime, or set the MCP config
   key directly. The MCP config is normally `<home>/config.json` (`~/.mebular/config.json`
   for the default profile):

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

   The sidecar is installed separately (`npm install -g @mebular/memory-runtime` or the
   desktop bundle). MCP does not download it automatically. Automatic startup belongs to
   the HTTP MCP daemon (`mebular serve`); stdio `mebular mcp` does not start the sidecar.

2. Confirm the sidecar is ready and has published discovery and a host token:

   ```bash
   mebular memory-runtime status --json
   ```

   While it is ready, `<home>/memory-runtime.json` exists and contains the sidecar URL
   plus `tokenFile` (normally `<home>/memory-runtime/host-token`).

3. Install the provider as `plugins/mebular`, because Hermes uses the directory name as
   the value of `memory.provider`:

   ```bash
   HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

   mkdir -p "$HERMES_HOME/plugins"
   rm -rf "$HERMES_HOME/plugins/mebular"
   cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
   hermes config set memory.provider mebular
   ```

4. Verify:

   ```bash
   hermes memory status
   ```

Normally you do **not** configure a token. The sidecar generates a host token on each
start and publishes its path in discovery; the provider reads that file and rejects
group/world-readable token files on POSIX. `MEBULAR_MEMORY_RUNTIME_TOKEN` is only a
test/troubleshooting override. It is **not** the MCP capability token, and the provider
never reads MCP tokens, `tokens.json` or Hermes model credentials.

Optional companion (host-model candidates):

```bash
rm -rf "$HERMES_HOME/plugins/mebular-companion"
cp -R integrations/hermes/mebular-companion "$HERMES_HOME/plugins/mebular-companion"
hermes plugins enable mebular-companion
export MEBULAR_COMPANION_ENABLED=1
```

The companion is a normal standalone plugin, not a second `MemoryProvider`. It uses
Hermes' official `ctx.llm` in `pre_llm_call` to turn completed history into Mebular
`CandidateRecord`s, submits them with `extractor="host"`, and returns no injected
content. It is off by default because it adds a host-model call and latency.

## Discovery and authentication

URL resolution, in priority order:

1. `$HERMES_HOME/mebular-memory.json` → `runtime_url`;
2. `MEBULAR_MEMORY_RUNTIME_URL`;
3. `<home>/memory-runtime.json` written by the sidecar;
4. no usable discovery → the provider stays disabled (`runtime_not_discovered`).

`<home>` comes from `MEBULAR_MEMORY_RUNTIME_HOME`, then `MEBULAR_HOME`, then the current
Mebular profile (or `~/.mebular`). The provider does **not** scan the network, guess a
port, or read the MCP daemon's `runtime.json`.

Token resolution:

1. `MEBULAR_MEMORY_RUNTIME_TOKEN`;
2. Hermes secret scope for that name;
3. discovery `tokenFile` (default `<home>/memory-runtime/host-token`).

Only a loopback `http://` URL is accepted without TLS. A non-loopback sidecar must use
HTTPS; conversation text then leaves the machine. A 401 makes the provider re-read the
token file once; persistent failure leaves recall empty and writes in the spool.

## Configuration

The provider reads ordinary settings from the environment first, then
`$HERMES_HOME/mebular-memory.json`. `runtime_url` is the exception: the config file wins
over the environment, as listed above. Common settings:

| Setting | Default | Meaning |
|---|---|---|
| `runtime_url` | discovered | Memory Runtime sidecar base URL, for example `http://127.0.0.1:7341` or `http://127.0.0.1:7341/memory-runtime/v1` |
| `agent_id` | `hermes` | Stable logical agent ID; it becomes `agent:hermes` |
| `domain` | empty | Optional write domain; empty lets the sidecar classify it. There is no separate `namespace` in requests |
| `capture` | `local` | Ask the sidecar to keep RawChunks on this device; `off` disables local raw |
| `extractor` | `heuristic` | `heuristic`, `local` or `auto`; this provider does not use remote `api` extraction |
| `sync_enabled` | `true` | Send completed turns |
| `archive_enabled` | `true` | Send pre-compression/session-end snapshots |
| `recall_limit` | `8` | Maximum recalled fragments (the provider caps the request at 3 fragments) |
| `recall_token_budget` | `2000` | Context token budget for recall |
| `recall_timeout` | `1.5` | Seconds before a recall is skipped |
| `ingest_timeout` | `3.0` | Seconds for an ingest HTTP request |
| `archive_flush_timeout` | `1.5` | Seconds to try flushing archive ingest before compression |
| `checkpoint_timeout` | `2.5` | Seconds for checkpoint PUT/GET |
| `queue_limit` | `100` | Bounded durable spool |

Environment variables: `MEBULAR_MEMORY_RUNTIME_URL`, `MEBULAR_MEMORY_RUNTIME_TOKEN`,
`MEBULAR_MEMORY_RUNTIME_HOME`, `MEBULAR_HOME`, `MEBULAR_MEMORY_AGENT_ID`,
`MEBULAR_MEMORY_DOMAIN`, `MEBULAR_MEMORY_CAPTURE`, `MEBULAR_MEMORY_EXTRACTOR`,
`MEBULAR_MEMORY_SYNC`, `MEBULAR_MEMORY_ARCHIVE`, `MEBULAR_MEMORY_RECALL_LIMIT`,
`MEBULAR_MEMORY_RECALL_TIMEOUT`, `MEBULAR_MEMORY_INGEST_TIMEOUT`,
`MEBULAR_MEMORY_CHECKPOINT_TIMEOUT`, `MEBULAR_MEMORY_QUEUE_LIMIT`.

The full key and environment-variable list is in
[`integrations/hermes/mebular-memory/README.md`](../../integrations/hermes/mebular-memory/README.md).

## What gets stored

- `sync_turn` sends only the messages after the last user message, avoiding a repeated
  full transcript. Assistant `tool_calls` and `role=tool` results are included as text;
  system messages and binary/multimodal payloads are skipped.
- `on_pre_compress` / `on_session_end` send a bounded conversation snapshot (at most 100
  chunks / about 1.7 MB; the most recent evidence is kept).
- Ingest requests carry `agentId`, `threadId`, `source=host`, `capture`, `extractor`,
  `chunks` and an optional `domain`. They do not send `namespace` or `sync`.
- The provider's `requestId` is stable for the same content; the sidecar de-duplicates
  retries and can return `duplicate=true`.

Checkpoints are deliberately honest:

```json
{
  "agentId": "hermes",
  "threadId": "hermes-s1",
  "domain": "task:hermes-s1",
  "summary": null,
  "warning": "summary_unavailable",
  "state": {
    "kind": "pre_compress",
    "messageCount": 3,
    "lastMessageId": "…",
    "transcriptHash": "sha256:…",
    "sessionId": "hermes-s1"
  },
  "recordIds": []
}
```

Hermes' `MemoryProvider` API v1 does not expose a compaction summary. The provider
therefore sends `summary:null` and state-only metadata; it never uses archive text or a
model-generated guess as a summary. A failed or interrupted checkpoint remains pending
in memory and is retried while the provider lives; it is never reported as committed and
never blocks Hermes compression.

## Failure behavior

- A failed recall returns an empty string; the turn continues. Repeat failures trigger a
  short cooldown instead of waiting on every turn.
- Failed writes stay in `$HERMES_HOME/mebular-memory/queue.jsonl` (mode `0600`, bounded by
  `queue_limit`) and are retried by a background worker. Non-retryable errors (for
  example `mode_mismatch`, `unauthorized`, `invalid_request` or
  `payload_too_large`) are dropped with a warning instead of growing forever.
- Checkpoint failures stay pending and are retried; the sidecar may itself queue the
  write in its outbox. Nothing is reported as committed until the sidecar returns a
  committed revision.
- The spool is a single-process file; do not run two Hermes writers on the same
  `HERMES_HOME`.
- If the sidecar is unavailable, recall is empty, ingest stays queued and checkpoints
  stay pending; Hermes itself keeps working.

## Upgrade from 0.2 / old prototype

- **No forced migration.** 0.2 records keep their IDs, namespaces, tags and events. The
  old `default` namespace is preserved and interpreted as the third/Other fallback
  (`domain=default`); it is not rewritten to `user`.
- MCP keeps only lifecycle keys (`memoryRuntime.enabled`, `memoryRuntime.command`,
  `memoryRuntime.startTimeoutMs`). Capture, model, trace and retention settings belong to
  `<home>/memory-runtime/config.json`, not to MCP `runtime.*` keys.
- Checkpoints and SelfRecords no longer have a local/cloud choice. There is no
  `sync=cloud`, `checkpoint.sync` or `self.sync`; every durable object is written through
  MCP and synced by the existing cloud sync.
- The unreleased 0.3 prototype path `/runtime/v1` is not served and has no compatibility
  layer. A 0.3 provider uses `/memory-runtime/v1`; an old adapter pointed at
  `/runtime/v1` simply cannot reach the sidecar, while MCP continues to work.
- The prototype's local `<home>/runtime/` data is not read or migrated. Do not confuse it
  with the MCP daemon install root `<cloudRoot>/runtime/`; only the former is disposable
  prototype data.
- The provider still accepts `namespace` in its config file and
  `MEBULAR_RUNTIME_NAMESPACE` as read-only compatibility aliases, but new configuration
  should use `domain` / `MEBULAR_MEMORY_DOMAIN`. Requests always send `domain`.
- To turn the sidecar off, set `memoryRuntime.enabled=false` (or
  `mebular memory-runtime stop`). The sidecar stops; 29 MCP tools and settled memories
  remain. Keep or delete `<home>/memory-runtime/`; deleting it does not delete memories
  already settled through MCP.

## Uninstall

```bash
hermes config set memory.provider ""
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular"
# Optional: remove the provider queue/config
rm -rf "${HERMES_HOME:-$HOME/.hermes}/mebular-memory" \
       "${HERMES_HOME:-$HOME/.hermes}/mebular-memory.json"
```

MCP configuration and Mebular data are separate and are not removed by uninstalling the
provider. Disabling or removing the provider does not delete `MEMORY.md` / `USER.md`.

## More detail

- [Provider README](../../integrations/hermes/mebular-memory/README.md)
- [Companion README](../../integrations/hermes/mebular-companion/README.md)
- [Hermes directory overview](../../integrations/hermes/README.md)
- [Memory Runtime guide](../guides/MEMORY_RUNTIME.md)
