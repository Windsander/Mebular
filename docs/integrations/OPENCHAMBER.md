# Mebular in OpenChamber / OpenCode

[中文](OPENCHAMBER_CN.md) · [Documentation index](../README.md) · [Memory Runtime guide](../design/0.3.0-memory-runtime.md)

OpenChamber is an OpenCode-based desktop host. Mebular supports it in two layers:

| Layer | What you get | Default |
|---|---|---|
| **MCP** | The official 29-tool Mebular server in OpenCode's global config | Available when configured |
| **Memory Runtime** (`@mebular/opencode-plugin`) | Request-only recall, event ingest, compaction checkpoints, optional current-model extraction | Off; explicit opt-in |

OpenChamber reuses OpenCode's global configuration. Mebular writes only the
`mcp.servers.mebular` entry. It never writes OpenChamber's private
`opencode.managed.json` or the per-instance copies under `run/instances`.

## Boundaries

Mebular and OpenChamber keep separate memory:

- OpenChamber's native memory is **read-only** from Mebular's point of view. The
  assistant probe checks `OPENCHAMBER_MEMORY_ENABLE`, `settings.json`'s
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

### Immersive plugin

`packages/opencode-plugin` is an OpenCode V2 server plugin. It is HTTP-only: it does not
import `@mebular/core`, does not read Mebular config or secrets, and does not touch
OpenChamber's native memory.

Requirements:

- OpenCode **>= 2.2.0** (checked through `ctx.app.version`);
- `ctx.session.hook("context")` available;
- `ctx.session.generate` is optional; without it, current-model extraction is reported
  as unavailable.

Add the plugin directory to OpenCode's global `~/.config/opencode/opencode.json` (not
OpenChamber's `opencode.managed.json`):

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/mebular/packages/opencode-plugin",
      "options": {
        "runtimeUrl": "http://127.0.0.1:7331",
        "agentId": "opencode"
      }
    }
  ]
}
```

Reload/restart OpenChamber yourself; Mebular does not send an `opencode reload` to a
running host.

## What the plugin does

- **Recall:** on a new user turn, calls `POST /runtime/v1/recall` and pushes one
  request-only `<mebular_memory trust="untrusted">` block (at most 8 KiB) into the
  outgoing model request. It does not write session history or instructions.
- **Ingest:** subscribes to session events and sends user/assistant/tool/compaction
  content to `POST /runtime/v1/ingest` with bounded, idempotent batches. Model requests
  never wait for ingest.
- **Checkpoints:** folds a compaction into a ContextCheckpoint and writes it through
  `/runtime/v1/checkpoints/:threadId`.
- **Tool masking:** ordinary agents have `mebular_*` tools hidden; a governance
  allowlist can keep them for designated agents.
- **Model:** `modelSource=heuristic` by default. Only explicit `host`/`current` makes the
  plugin call `ctx.session.generate` after a completed turn; failures, timeouts and
  unparseable output fall back to Runtime heuristic extraction. It never calls the model
  inside the `context` hook and never reads host credentials.

## Configuration

Priority: plugin options > environment > plugin config file > defaults. Common options:

| Key | Default | Meaning |
|---|---|---|
| `runtimeUrl` | — | Runtime base URL; missing disables the plugin |
| `token` | — | Bearer token, used only in the `Authorization` header |
| `agentId` | `opencode` | Logical agent ID |
| `capture` | `off` | `off` or `local`; local keeps RawChunks on this device |
| `recall` / `ingest` / `checkpoints` | `true` | Enable each path |
| `modelSource` | `heuristic` | `heuristic` or `host`/`current` |
| `hideMemoryTools` | `true` | Hide Mebular memory tools from ordinary agents |
| `governanceAgents` | `mebular-memory`, `mebular-governance` | Agents that keep the tools |
| `recallTimeoutMs` | `800` | Recall timeout; failures inject nothing |
| `recallTokenBudget` | `2000` | Context budget for recall |
| `maxContextBytes` | `8192` | Hard cap for the injected block |
| `maxChunkBytes` | `16384` | Per-chunk ingest limit |

Environment variables: `MEBULAR_RUNTIME_URL`, `MEBULAR_RUNTIME_TOKEN`,
`MEBULAR_RUNTIME_AGENT_ID`, `MEBULAR_RUNTIME_NAMESPACE`, `MEBULAR_RUNTIME_MODEL`.
The plugin config file defaults to `$MEBULAR_HOME/opencode-plugin.json`.

## Current-model limits

OpenCode does not give the plugin a model credential, and the plugin does not ask for
one. When `host`/`current` is selected, it uses the host's own `ctx.session.generate`
after a turn. This has three consequences:

- extraction happens after the turn, not inside recall;
- `session.generate` missing or failing means heuristic fallback, not a fake host call;
- the runtime records `extractor='host'`, not a fabricated model ID.

The runtime's global model setting still applies to the ingestion path. Configure local
Qwen or an API in Mebular Console if you want the runtime itself to extract; configure
`modelSource=host` if you specifically want the current OpenCode model to produce
candidates.

## Failure behavior

- Recall timeout, no hit or HTTP error: no block is injected; the request continues.
- Ingest is fire-and-forget with bounded queues; failures are counted and do not block
  the model loop.
- A failed or interrupted compaction is not reported as a committed checkpoint.
- If the plugin's OpenCode version or context hook is unsupported, it disables itself
  with a reason instead of failing the host.
- MCP remains available even when the immersive plugin is disabled.

## Uninstall

Remove the plugin entry from OpenCode's global `plugins` array, or uninstall the package,
then reload OpenChamber. The MCP entry and Mebular data are separate; remove them only if
you also want to stop using Mebular in this host.

## More detail

- [Plugin README](../../packages/opencode-plugin/README.md)
- [Memory Runtime guide](../design/0.3.0-memory-runtime.md)
- [DSH integration](DSH.md) · [Hermes integration](HERMES.md)
