# Mebular in Hermes Agent

[中文](HERMES_CN.md) · [Documentation index](../README.md) · [Memory Runtime guide](../design/0.3.0-memory-runtime.md)

Hermes can use Mebular in two layers, and they can run together:

| Layer | What Hermes gets | Default |
|---|---|---|
| **MCP** | The official Mebular MCP server: explicit `memory_*` and `task_*` tools | Available when configured |
| **Memory Runtime** (`MemoryProvider`) | Automatic recall before a turn, turn/compaction ingest, session-boundary archive | Off; explicit opt-in |

The provider lives in [`integrations/hermes/mebular-memory`](../../integrations/hermes/mebular-memory/).
The optional companion lives in
[`integrations/hermes/mebular-companion`](../../integrations/hermes/mebular-companion/).
Neither changes Hermes core, and neither is required for MCP.

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
the rest. This is the same 29-tool MCP surface used by other hosts; no runtime model is
involved.

### Immersive MemoryProvider

The provider connects Hermes turns to `/runtime/v1`:

- `prefetch` / `queue_prefetch` → `POST /runtime/v1/recall`, injected as short memory
  context before the model turn;
- `sync_turn` → `POST /runtime/v1/ingest`, non-blocking, deduplicated by a stable
  `requestId`;
- `on_pre_compress` / `on_session_end` → conversation snapshot ingest (system messages
  are skipped);
- failures go to a durable per-profile spool and are retried without blocking Hermes.

The provider exposes **no tools** (`get_tool_schemas()` returns an empty list). MCP
remains the explicit governance surface, and the 29-tool surface is unchanged.

## Install

Install the provider as `plugins/mebular`, because Hermes uses the directory name as the
value of `memory.provider`:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/mebular"
cp -R integrations/hermes/mebular-memory "$HERMES_HOME/plugins/mebular"
hermes config set memory.provider mebular

# Only when Mebular uses bearer/OAuth:
mebular token grant --scope memory.read,memory.write
# Put MEBULAR_RUNTIME_TOKEN=... in $HERMES_HOME/.env, not in config files.
```

The provider reads the local Mebular endpoint from `~/.mebular/runtime.json` by default
and does not probe the network. It only reads `MEBULAR_RUNTIME_TOKEN`; it never reads
Hermes' model credentials. A non-loopback runtime must use HTTPS, and conversation text
then leaves the machine.

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

## Configuration

The provider reads, in priority order: environment, `$HERMES_HOME/mebular-memory.json`,
then local `runtime.json` discovery. Common settings:

| Setting | Default | Meaning |
|---|---|---|
| `runtime_url` | discovered | Runtime base URL, for example `http://127.0.0.1:7331` |
| `agent_id` | `hermes` | Logical agent ID |
| `namespace` | `default` | Memory namespace; `__*` names are reserved |
| `capture` | `local` | Keep RawChunks on this device; `off` disables |
| `extractor` | `heuristic` | `heuristic`, `local` or `auto`; `api` is not exposed by this provider |
| `sync_enabled` | `true` | Send each turn |
| `archive_enabled` | `true` | Send compaction/session snapshots |
| `recall_limit` | `8` | Maximum recalled records |
| `recall_timeout` | `1.5` | Seconds before a recall is skipped |
| `queue_limit` | `100` | Bounded local spool |

The full key and environment-variable list is in
[`integrations/hermes/mebular-memory/README.md`](../../integrations/hermes/mebular-memory/README.md).

## Native memory and current model

- **Native memory:** `MEMORY.md` / `USER.md` remain Hermes' own. Mebular neither reads
  nor writes them. Enabling the provider does not disable them.
- **Current model:** Hermes' `MemoryProvider` API has no current-model field. Mebular
  does not invent a model name. If you want the host model to extract candidates, enable
  the optional companion; otherwise the runtime uses `heuristic`, an installed local
  Qwen pack or a configured API (subject to the provider's `extractor` setting).
- **MCP:** the provider's empty tool list means MCP tools are still the way to perform
  explicit writes, search, governance and task operations.

## Failure behavior

- A failed recall returns an empty string; the turn continues.
- Failed writes stay in `$HERMES_HOME/mebular-memory/queue.jsonl` and are retried.
  Non-retryable errors (for example `mode_mismatch`, `unauthorized` or
  `invalid_request`) are dropped with a warning instead of growing forever.
- The queue is a single-process file spool; do not run two Hermes writers on the same
  `HERMES_HOME`.
- If the Runtime API is unavailable, recall is empty and ingest stays queued; Hermes
  itself keeps working.

## Uninstall

```bash
hermes config set memory.provider ""
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/mebular"
# Optional: remove the provider queue/config
rm -rf "${HERMES_HOME:-$HOME/.hermes}/mebular-memory" \
       "${HERMES_HOME:-$HOME/.hermes}/mebular-memory.json"
```

MCP configuration and Mebular data are separate and are not removed by uninstalling the
provider.

## More detail

- [Provider README](../../integrations/hermes/mebular-memory/README.md)
- [Companion README](../../integrations/hermes/mebular-companion/README.md)
- [Hermes directory overview](../../integrations/hermes/README.md)
- [Memory Runtime guide](../design/0.3.0-memory-runtime.md)
