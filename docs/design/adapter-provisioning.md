# Adapter provisioning

[Documentation index](../README.md) · [Memory Runtime guide](../guides/MEMORY_RUNTIME.md) · [Verification report](../quality/adapter-provisioning/adapter-provisioning-verification.md)

Mebular has two layers in a host:

| Layer | What it provides | Configured by |
|---|---|---|
| **MCP** | The 29 public `memory_*` / `task_*` tools through `/mcp` | `mcp.servers.mebular` (or the host's equivalent) |
| **Adapter** | Automatic recall / ingest / checkpoints (`@mebular/opencode-plugin`, `@mebular/dsh-plugin`, Hermes `mebular` MemoryProvider) | `plugins`, DSH profile, `memory.provider` |

Connecting an assistant from the App/Console (or `mebular clients:action connect`) writes
the MCP entry and then calls `ensureAdapter(hostId)`. The adapter layer is additive: if it
fails, MCP still connects and works, and the failure is recorded in
`<home>/adapters.json` for the next repair. There is **no new page, button, locale or
CSS** for this feature; it reuses the existing “connect assistant” action and the existing
`/status` diagnostics.

## Architecture

```text
packages/mcp/src/adapters/index.mjs      descriptor registry + unsupported hosts
packages/mcp/src/adapters/opencode.mjs   OpenCode / OpenChamber
packages/mcp/src/adapters/dsh.mjs        DeepSeek Harness
packages/mcp/src/adapters/hermes.mjs     Hermes MemoryProvider
packages/mcp/src/adapter-provision.mjs   detect → package → configure → activate → verify → state
packages/mcp/src/adapter-state.mjs       <home>/adapters.json (atomic, 0600, sanitized)
packages/mcp/src/clients.mjs             connectClient → ensureAdapter (additive field)
apps/desktop/src/main/adapter-repair.mjs startup/upgrade repair for connected hosts
```

`ensureAdapter(hostId, options)` is the only write path:

1. **detect** the host (config file/dir, CLI, profile) without spawning anything that
   could mutate it;
2. **resolve the package** from the App bundle, a managed directory, or (dev/tests) the
   repository checkout — never npm and never a floating version;
3. **configure** with an idempotent merge, a byte-level backup and an atomic write;
4. **activate** only through an injected, App-owned reload/restart callback, otherwise
   `next-start`;
5. **verify** config readback, package presence and version lockstep;
6. **persist** sanitized state; on any failure roll back the config/package and record a
   stable error code.

`dryRun` performs the read-only checks and reports the planned change without writing
config, state or a managed package. It is strict: no dry-run code path creates
`<home>/adapters` or `adapters.json`.

## Host matrix

| host | adapter | Install / package | Configuration | Activation | Verification |
|---|---|---|---|---|---|
| `opencode` | `@mebular/opencode-plugin` | App bundle → `<home>/adapters/opencode-plugin/<version>`, else repository (dev) | `~/.config/opencode/opencode.json` → `plugins` merged by package/path, user entries kept | injected reload/restart when the App owns the host; otherwise `next-start` | config readback, unique entry, options `agentId=opencode` / `recall` / `ingest`, package + version, then real `/context` / `ingested` / `agentId=opencode` trace |
| `openchamber` | same plugin | same managed package | same global OpenCode config | same | same; state is recorded per `hostId` |
| `dsh` | `@mebular/dsh-plugin` | App bundle → `<home>/adapters/dsh-plugin/<version>`, else repository (dev) | official CLI only: `dsh plugin --profile <profile> add <absolute-path>`; profile resolution `option` > `DSH_PROFILE` > canonical `web` > single profile | injected reload/restart, otherwise `next-start` | official `--dump-config` when available, else profile files; package + version; then `ingested` / `agentId=dsh` |
| `hermes` | `mebular` MemoryProvider | App bundle → `<home>/adapters/hermes/<version>` → installed at `$HERMES_HOME/plugins/mebular` | `hermes config set memory.provider mebular` + readback | injected reload/restart, otherwise the next Hermes session | provider dir + `plugin.yaml` name/version/`__init__.py`, `memory.provider=mebular`, version lockstep; `sync_turn` ingest belongs to repair |
| `claude-code`, `claude-desktop`, `cursor`, `generic` | — | — | MCP only | — | `adapter=unsupported`; nothing is written |

Version lockstep: every adapter's manifest version must equal `APP_VERSION`. A missing or
mismatched package fails closed (`ADAPTER_PACKAGE_NOT_FOUND` / `ADAPTER_VERSION_MISMATCH`)
without touching the host config. An older App that does not bundle adapters resolves the
repository/`source=manual` path in a dev checkout and records that source; MCP is never
blocked.

## Install, configure, activate, roll back

### OpenCode / OpenChamber

- Only `~/.config/opencode/opencode.json` → `plugins` is written. The entry is
  `{ package: "<absolute-path>", options: { agentId: "opencode", recall: true, ingest: true } }`.
- Existing user plugins and unrelated keys are preserved. Mebular entries are deduplicated
  by package name or resolved path; the first entry keeps user options and gains the
  required ones.
- OpenChamber's private `opencode.managed.json` and `run/instances/**` are forbidden
  paths and are never written.
- The plugin takes effect at the next host start (or an App-owned reload). Provisioning
  never sends `opencode reload` to, or kills, a running host.
- Rollback restores the pre-connect bytes from the backup, or removes only Mebular's
  plugin entry when no backup exists.

### DSH

- The official CLI owns the profile. Provisioning never hand-writes DSH YAML and never
  writes DSH databases, session storage or transcripts.
- The profile must be unambiguous: explicit `profile`/`profileDir`, `DSH_PROFILE`, the
  canonical `web` profile, or a single profile. Otherwise it fails with
  `DSH_PROFILE_UNKNOWN` instead of guessing.
- Before the official `add`, the profile files (`package.json`, `cordis*.yml`,
  `pnpm-*.yaml`) are copied to `<home>/adapters/backups/dsh-profile-*`. A failed add or
  failed readback restores them.
- Rollback prefers `dsh plugin --profile <profile> remove @mebular/dsh-plugin`, then the
  profile backup.

### Hermes

- The provider is installed **only** at `$HERMES_HOME/plugins/mebular`; the directory name
  must equal the `memory.provider` value. `mebular-memory` as a directory name is rejected.
- The provider directory is staged, verified (`plugin.yaml` name/version, `__init__.py`,
  content fingerprint), then swapped in with the previous directory renamed to
  `.bak-<timestamp>`.
- `memory.provider` is changed with the official `hermes config set memory.provider
  mebular` and read back. The config is backed up byte-for-byte; a failed set restores the
  provider directory and config.
- Hermes' internal DB, session storage, provider spool (`$HERMES_HOME/mebular-memory`) and
  `MEMORY.md` / `USER.md` are never touched. Activation is the next Hermes session; the
  adapter never restarts or kills a running Hermes process.
- On a fresh data root Hermes may be unable to commit a dependency environment
  (`HERMES_CLI_ENV_UNSUPPORTED`). Provisioning then rolls back and records the boundary
  rather than writing the real host or pretending success.

## State file

`<home>/adapters.json` (`schema: 1`) is diagnostic only; the host config/package result is
authoritative. It is written atomically with mode `0600`:

```jsonc
{
  "schema": 1,
  "updatedAt": 1790000000000,
  "hosts": {
    "opencode": {
      "detected": true,
      "connected": true,
      "adapter": "installed",      // absent | installed | active | degraded | unsupported
      "version": "0.3.5",
      "source": "managed-dir",      // bundled | managed-dir | manual
      "configPath": "~/.config/opencode/opencode.json",
      "activation": "next-start",   // reload | restart | next-start
      "lastError": null,            // stable code only
      "verifiedAt": 1790000000000,
      "lastIngestedAt": 1790000000000
    }
  }
}
```

Only whitelisted scalar fields are persisted. Tokens, conversation text, memory text and
raw error messages are dropped by `sanitizeHostRecord`; a non-code `lastError` becomes
`null`. A corrupt or unknown file fails open: an empty state plus `corrupted: true`, never
a throw.

CLI (no new public MCP tool):

```bash
mebular adapter status --json         # read-only view of adapters.json
mebular adapter ensure --host dsh --json
mebular adapter repair --json         # connected hosts only
```

`ensure` accepts `--dry-run`, `--host`, `--config`, `--package`, `--expected-version` and
`--resources-path`. Failures exit non-zero with `{ ok:false, code, message }` and never
print a token or body.

## Health and repair

The adapter layer reuses the existing sidecar diagnostics instead of adding UI:

- `/status.counts.ingested` and `/status.counts.settled`;
- `/traces` entries with the host's `agentId`;
- `adapters.json` `lastIngestedAt` / `verifiedAt`.

Rules:

1. Configured but no recent `/context`/ingest evidence, or a failed provisioning step,
   records `adapter=degraded` with a stable `lastError`.
2. App startup/upgrade and `mebular adapter repair` call
   `ensureAdaptersForConnected`, which touches **only connected** hosts. Detected but
   unconnected hosts are never silently configured.
3. Repair failure records `degraded` and a log line; it never pops UI and never blocks MCP.
4. Success is `ingested>0` or a new trace with the expected `agentId`.

`connectClient` returns the adapter result as an additive `adapter` field. Existing UI and
MCP callers ignore it.

## Security boundaries

- **Consent scope:** only the existing connect action or an already-connected host is
  provisioned. Detection alone never writes a host config.
- **No downloads:** adapters ship with the App (or come from the repository in dev).
  No npm access, no floating `latest`, no remote install script.
- **Host-private paths:** OpenChamber managed config/instances, DSH databases/sessions and
  Hermes DB/session/spool/identity files are forbidden and rejected before any write.
- **Atomic, reversible writes:** `.bak-<timestamp>` backup before writes, temp+rename,
  failed writes restore the backup; rollback is explicit and idempotent.
- **No secrets or bodies:** `adapters.json`, logs and CLI JSON never contain host tokens,
  MCP tokens, API keys, conversation text or memory text. Config reads are limited to the
  adapter's own key.
- **No process control:** activation is an injected callback owned by the App. Otherwise
  `next-start`. Provisioning never signals a host process.
- **MCP-only platforms stay MCP-only:** `claude-code`, `claude-desktop`, `cursor` and
  `generic` are explicitly `unsupported`; no adapter is installed or faked.

## Verification

The real-host evidence and known boundaries are recorded in
[`docs/quality/adapter-provisioning/`](../quality/adapter-provisioning/): a real OpenCode
v2.4.1 server driven through `mebular adapter ensure` only (the adapter is the sole writer
of `opencode.json`), plus the DSH/Hermes hermetic boundaries and the no-UI-diff check.
