# Mebular in OpenChamber / OpenCode

[中文](OPENCHAMBER_CN.md) · [Documentation index](../README.md) · [Memory Runtime guide](../guides/MEMORY_RUNTIME.md)

OpenChamber is an OpenCode-based desktop host. Mebular supports it in two layers:

| Layer | What you get | Default |
|---|---|---|
| **MCP** | The official 29-tool Mebular server in OpenCode's global config | Available when configured |
| **Memory Runtime** (`@mebular/opencode-plugin`) | Request-only recall, event ingest, compaction checkpoints, optional current-model extraction | Follows the sidecar discovery mode; no host-level enable/collection switch |

OpenChamber reuses OpenCode's global configuration. Mebular writes only the
`mcp.servers.mebular` entry. It never writes OpenChamber's private
`opencode.managed.json` or the per-instance copies under `run/instances`.

The Memory Runtime sidecar is **a separate process from the MCP daemon runtime**. The
plugin talks only to `/memory-runtime/v1`; it never treats OpenCode/OpenChamber settings,
the MCP daemon's `runtime.json` or its `/mcp` endpoint as the sidecar.

## Boundaries

Mebular and OpenChamber keep separate memory:

- OpenChamber's native memory is **read-only** from Mebular's point of view. The assistant
  probe checks `OPENCHAMBER_MEMORY_ENABLE`, `settings.json`'s
  `agentMemoryToolEnabled`, and whether `memory.json` exists; it never reads entries.
- Mebular never imports, replaces, dual-writes or registers OpenChamber's native memory
  tool.
- The immersive plugin never reads or writes OpenChamber settings, `memory.json`, or
  managed config.
- Token values, model credentials and OpenChamber state are not exposed in logs or
  status.

If native memory is enabled, Mebular's immersive path stays opt-in; the default remains
tool-only. Turning on Mebular does not turn off OpenChamber memory.

## Two modes

### Lightweight MCP

Use the Mebular Console assistant onboarding for OpenChamber, or add the MCP server to
OpenCode's global config yourself. OpenChamber picks up the same entry after a reload:

```jsonc
{
  "mcp": {
    "servers": {
      "mebular": {
        "url": "http://127.0.0.1:7331/mcp",
        "enabled": true,
        "oauth": false,
        "codemode": false
      }
    }
  }
}
```

The same 29 `memory_*` / `task_*` tools are available. Mebular does not read the store
or identity from OpenChamber; all calls go through the daemon's `/mcp`.

Lightweight mode starts **no** Memory Runtime sidecar: no `mebular-memory-runtime`
process, no new `<home>/memory-runtime/` directory or files, no `memory-runtime.json`,
no host token, no port 7341 listener and no model download. If `<home>/memory-runtime/`
already exists from an earlier immersive session, it is neither read nor modified.

### Immersive plugin

`@mebular/opencode-plugin` (source: `packages/opencode-plugin`) is an OpenCode V2 server
plugin distributed as an independent npm package. It is HTTP-only: it does not import
`@mebular/core`, does not read Mebular config or secrets, and does not touch OpenChamber's
native memory.

Requirements:

- OpenCode **>= 2.2.0** (checked through `ctx.app.version`);
- `ctx.session.hook("context")` available;
- `ctx.session.generate` is optional; without it, current-model extraction is reported
  as unavailable;
- a running 0.3 Memory Runtime sidecar. The MCP daemon starts it only when
  `memoryRuntime.enabled=true` (normally set from the Mebular Console or
  `<home>/config.json`):

  ```jsonc
  {
    "memoryRuntime": {
      "enabled": true
    }
  }
  ```

  Confirm it with `mebular memory-runtime status --json`. A ready sidecar publishes
  `<home>/memory-runtime.json` and `<home>/memory-runtime/host-token`; the plugin reads
  both. The sidecar is installed separately (`npm install -g @mebular/memory-runtime`
  or the desktop bundle); MCP does not download it. Automatic startup belongs to the HTTP
  MCP daemon (`mebular serve`); stdio `mebular mcp` does not start the sidecar.

`@mebular/opencode-plugin` is a **separate npm package**; it is not part of
`@mebular/core`. After this release is published, install it from npm, then add it (or a
local checkout path) to OpenCode's global `~/.config/opencode/opencode.json` (not
OpenChamber's `opencode.managed.json`):

```bash
npm install @mebular/opencode-plugin
# or: npm install -g @mebular/opencode-plugin
```

```jsonc
{
  "plugins": [
    {
      "package": "@mebular/opencode-plugin",
      "options": {
        "agentId": "opencode"
        // runtimeUrl is optional; without it the plugin reads
        // <home>/memory-runtime.json and never guesses a port.
        // "runtimeUrl": "http://127.0.0.1:7341/memory-runtime/v1"
      }
    }
  ]
}
```

OpenChamber reuses the same global config, and OpenCode loads the package on start or
reload; `npm install` alone starts nothing. For local development, `package` may be the
plugin directory's absolute path instead of the npm name. Reload/restart OpenChamber
yourself; Mebular does not send an `opencode reload` to a running host.

## What the plugin does

- **Recall:** on a new user turn, calls `POST /memory-runtime/v1/context` with an 800 ms
  default timeout and pushes one request-only `<mebular_memory trust="untrusted">`
  block (at most 8 KiB) into the outgoing model request. The block is added to
  `event.system` with `metadata.requestOnly=true`; it does not write session history,
  instructions or a synthetic user message. The same user turn's tool continuations are
  de-duplicated and inject nothing.
- **Ingest:** subscribes to session events and sends user/assistant/tool/compaction
  content to `POST /memory-runtime/v1/ingest` with bounded, idempotent batches. Model
  requests never wait for ingest. Buffers are in memory, not a durable spool.
- **Checkpoints:** folds `session.compaction.ended` into a ContextCheckpoint. If the event
  carries a summary, the plugin first ingests one `system` compaction chunk, then
  `PUT`s `/memory-runtime/v1/checkpoints/:threadId` with `domain=task:<sessionId>`; a
  missing summary means no invented summary. A `revision_mismatch` triggers one GET and
  one retry; failure remains pending and is never reported as committed.
- **Tool masking:** ordinary agents have currently visible `mebular_*` tools removed from
  the request tool table; `governanceAgents` (default `mebular-memory` and
  `mebular-governance`) keep them. `mebular_status` is a plugin diagnostic tool, not an
  MCP tool. The 29 MCP tools are unchanged.
- **Model:** `modelSource=heuristic` by default. Only explicit `host`/`current` (or
  `MEBULAR_MEMORY_RUNTIME_MODEL=host`) makes the plugin call `ctx.session.generate`
  **after** a completed turn; a missing/failed/unparseable call falls back to sidecar
  heuristic extraction. It never calls the model inside the `context` hook and never
  reads host credentials.

## Discovery and authentication

URL resolution:

1. plugin option `runtimeUrl` (an explicit `url` is also accepted);
2. `MEBULAR_MEMORY_RUNTIME_URL`;
3. plugin config file (default `$MEBULAR_HOME/opencode-plugin.json`, or
   `$MEBULAR_OPENCODE_PLUGIN_CONFIG`);
4. sidecar discovery `<MEBULAR_HOME>/memory-runtime.json`;
5. no usable URL → plugin disabled with `runtime_not_discovered`.

The plugin does not blindly connect to port 7341 and never treats the MCP daemon's
`runtime.json` as the sidecar. Explicit `runtimeUrl` may be either the sidecar origin
(`http://127.0.0.1:7341`) or the full `/memory-runtime/v1` base. The obsolete
`/runtime/v1` path is rejected (`runtime_url_legacy`); non-loopback plain `http` is
rejected (`runtime_insecure_url`).

Token resolution:

1. plugin option `token`;
2. `MEBULAR_MEMORY_RUNTIME_TOKEN`;
3. plugin config file;
4. discovery `tokenFile`, default `<home>/memory-runtime/host-token`.

The token is a sidecar **host token**, not the MCP capability token. On POSIX the token
file must be `0600`; group/world-readable files are rejected (`token_file_insecure`).
The plugin only sends `Authorization: Bearer`; it never logs the token or puts it in
`getStatus()`.

## Configuration

Priority: plugin options > environment > plugin config file > discovery > defaults.
Common options:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Explicitly disable the plugin |
| `runtimeUrl` | — | Sidecar origin or `/memory-runtime/v1` base; otherwise env/config/discovery |
| `token` | — | Host bearer token; only used in the `Authorization` header |
| `tokenFile` | — | Explicit host token file; otherwise discovery `tokenFile` or `<home>/memory-runtime/host-token` |
| `agentId` | `opencode` | Logical agent ID |
| `namespace` / `namespaces` | — | Legacy recall-domain aliases; `namespace` is read-only compatibility |
| `domains` | — | v2 memory domains such as `user` / `agent:opencode`; omitted lets the sidecar choose |
| ~~`capture`~~ | — | Removed in 0.3.0: legacy value is ignored; the sidecar mode owns collection |
| `recall` / `ingest` / `checkpoints` | `true` | Enable each path |
| `modelSource` | `heuristic` | `heuristic`, or `host`/`current` for `ctx.session.generate` |
| `hideMemoryTools` | `true` | Remove `mebular_*` tools from ordinary agents |
| `governanceAgents` | `mebular-memory`, `mebular-governance` | Agents that keep the tools |
| `recallLimit` | `8` | Recall record limit |
| `recallTokenBudget` | `2000` | Context token budget |
| `maxFragments` | `3` | Maximum fragments in one context request |
| `recallTimeoutMs` | `800` | Context timeout; failure/timeout injects nothing |
| `maxContextBytes` | `8192` | Hard cap for the injected block |
| `maxChunkBytes` | `16384` | Per-chunk ingest limit |
| `maxCaptureMessages` | `12` | Recent session messages inspected when reading host context |
| `hostExtractTimeoutMs` | `15000` | Background `session.generate` timeout |

Environment variables: `MEBULAR_MEMORY_RUNTIME_URL`, `MEBULAR_MEMORY_RUNTIME_TOKEN`,
`MEBULAR_MEMORY_RUNTIME_AGENT_ID`, `MEBULAR_MEMORY_RUNTIME_NAMESPACE`,
`MEBULAR_MEMORY_RUNTIME_DOMAIN`, `MEBULAR_MEMORY_RUNTIME_MODEL`, and
`MEBULAR_OPENCODE_PLUGIN_CONFIG`. Legacy `MEBULAR_MEMORY_RUNTIME_CAPTURE` is ignored.

The plugin config file defaults to `$MEBULAR_HOME/opencode-plugin.json` and may contain a
`{ "memoryRuntime": { ... } }` object or flat keys. It never reads Mebular's `config.json`,
OpenChamber settings, `memory.json` or managed config.

## Current-model limits

OpenCode does not give the plugin a model credential, and the plugin does not ask for
one. When `host`/`current` is selected, it uses the host's own `ctx.session.generate`
after a turn. This has three consequences:

- extraction happens after the turn, not inside recall;
- `session.generate` missing, failing, timing out or returning no parseable candidates
  means heuristic fallback, not a fake host call;
- the sidecar records `extractor='host'`, not a fabricated model ID.

## Failure behavior

- Recall timeout, no hit or HTTP error: no block is injected; the request continues, and
  repeated failures enter a 30 s cooldown.
- Ingest is fire-and-forget with bounded in-memory queues; failures are counted and do
  not block the model loop. There is no durable ingest spool in this plugin.
- A failed or interrupted compaction is not reported as a committed checkpoint. A
  `revision_mismatch` gets one read-and-retry; still failing stays pending/visible.
- If the OpenCode version or context hook is unsupported, the plugin disables itself with
  a reason instead of failing the host.
- MCP remains available even when the immersive plugin is disabled.

## Upgrade from 0.2 / old prototype

- **No forced migration.** 0.2 records keep their IDs, namespaces, tags and events. The
  old `default` namespace is preserved as the third/Other fallback (`domain=default`) and
  is not rewritten to `user`.
- MCP keeps only lifecycle keys (`memoryRuntime.enabled`, `memoryRuntime.command`,
  `memoryRuntime.startTimeoutMs`). Detail/staging, model, trace and retention settings belong to
  `<home>/memory-runtime/config.json`, not to MCP `runtime.*` keys.
- Checkpoints and SelfRecords have no local/cloud switch. There is no `sync=cloud`,
  `checkpoint.sync` or `self.sync`; all durable objects go through MCP and existing cloud
  sync.
- `/runtime/v1` is not served and has no compatibility layer. Point `runtimeUrl` at the
  `/memory-runtime/v1` base (or omit it and use discovery). An old plugin still pointed at
  `/runtime/v1` is rejected/disabled; MCP keeps working.
- Prototype data under `<home>/runtime/` is not read or migrated. Do not delete
  `<cloudRoot>/runtime/`; that is the MCP daemon install root, not sidecar data.
- To turn the sidecar off, set `memoryRuntime.enabled=false` or remove the plugin entry
  from OpenCode's `plugins` array. The sidecar stops; 29 MCP tools and settled memories
  remain. `<home>/memory-runtime/` may be kept or deleted; deleting it does not delete
  settled memories.

## Uninstall

Remove the plugin entry from OpenCode's global `plugins` array, or uninstall the package,
then reload OpenChamber. The MCP entry and Mebular data are separate; remove them only if
you also want to stop using Mebular in this host.

## More detail

- [Plugin README](../../packages/opencode-plugin/README.md)
- [Memory Runtime guide](../guides/MEMORY_RUNTIME.md)
- [DSH integration](DSH.md) · [Hermes integration](HERMES.md)
