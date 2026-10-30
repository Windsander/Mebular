# Mebular in DeepSeek Harness (DSH)

[中文](DSH_CN.md) · [Documentation index](../README.md)

`@mebular/dsh-plugin` brings Mebular's memory and task graph into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), and
embeds the shared Mebular Console in the DSH sidebar. It is a zero-build DSH
bundle: it does not import `@mebular/*`; it discovers the shared local runtime
through the CLI and daemon HTTP endpoints.

Since v0.2.0, the App and the DSH Plugin are **two equal entry points to one
local Mebular runtime**: one daemon, one `mebular-serve`, one active
profile/home and one data root. The Plugin defaults to `attach`; only an
explicit `managed`/`auto` choice or a panel install starts/installs the runtime.

0.3.0 adds an optional Memory Runtime bridge next to MCP. It is off by default,
so existing attach/managed/panel/MCP behaviour is unchanged until you opt in.
See [Memory Runtime (opt-in)](#memory-runtime-opt-in) below.

## Two entries, one runtime

| Surface | Responsibility |
| --- | --- |
| **Mebular App / shared runtime** | Control plane: runtime, daemon, service, identity, storage lock, sync and the star-map Console. |
| **DSH Plugin** | Agent surface: the same Console in the sidebar, the official MCP client, and on-demand ensure/start of the same runtime. |

The Plugin never starts a second Console and never reads the store, identity or
tokens directly. It uses the shared runtime supervisor (`runtime
resolve`/`supervise`) and daemon HTTP endpoints.

## Install

Install from npm into the DSH web profile:

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.3.0
```

For development:

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

The default config is minimal and attach-only:

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
```

Restart the DSH session for the profile to take effect. Installing the Plugin
never downloads or starts Mebular silently.

### When no runtime exists

If an App/CLI/service/shared runtime exists, the Plugin attaches and installs
nothing.

If none exists, the panel reports `download_required` with an explicit
**Install Mebular Runtime** action. On click the Plugin installs the pinned
`@mebular/core` matching its own package version: download → verify → atomic
install → provider registration → init → start → Console onboarding. Failures
offer the reason, manual command, retry/reinstall and re-detect; the old runtime
is preserved and no half runtime is started.

Only the user's click triggers a download. `bootstrap: never` disables this
entry point.

## Shared runtime resolution

The Plugin does not guess the current profile or port. It selects a shared CLI
(App/CLI/shared provider) and runs:

```bash
mebular runtime resolve --json
```

The result provides the current `cloudRoot`/profile/home, daemon HTTP endpoint,
version, service/provider and bootstrap state. The panel, MCP bridge and iframe
use the same dynamic daemon URL.

Provider order is `app > cli > shared`; for multiple shared versions,
`runtime/current.json` wins. If the App is installed but stopped, the Plugin
starts the App provider instead of downloading another runtime. A registered
service takes precedence. An explicit `daemonUrl` is a pin and is attach-only;
it is never overridden by the dynamic URL.

The legacy discovery order remains available when no shared CLI is present:
`daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 127.0.0.1:7331`. Only
non-sensitive `runtime.json` fields are read; config, identity, tokens and the
store are never read.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `MEBULAR_CLOUD_ROOT` | Shared root; defaults to `~/.mebular` |
| `MEBULAR_HOME` | Compatibility home/profile discovery |
| `MEBULAR_HTTP_PORT` | Legacy port override; a successful shared resolve wins |
| `MEBULAR_CLI` | Explicit CLI candidate (`cliPath` wins) |

## Lifecycle

| Config | Behaviour |
| --- | --- |
| `lifecycle: attach` (default) | Resolve/probe only; never start or stop. The panel asks the user to start the App or install the runtime. |
| `lifecycle: managed` | Explicit opt-in. Reuse a healthy daemon; use a registered service; otherwise start via a provider. |
| `lifecycle: auto` | Explicit opt-in with managed start semantics; without a provider it returns to `download_required` and does not download. |
| `runtime: external` | Attach-only; never start or stop. |
| `persistence: child` | Default; the Plugin owns its own `runtime supervise` process. |
| `persistence: service` | Require an existing service; do not install one. |
| `bootstrap: prompt` | Show the install action when no runtime exists (default). |
| `bootstrap: never` | Hide and reject the install action. |

`managed`/`auto` hold the child through `mebular runtime supervise`, not by
spawning `mebular serve` directly. On dispose the Plugin stops only its own
supervisor; the supervisor then cleans up the daemon child it owns. Service and
external daemons are never stopped by the Plugin.

Full config:

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: managed      # attach | managed | auto
    runtime: auto           # auto | external
    persistence: child      # child | service
    bootstrap: prompt       # prompt | never
    panel: true
    # daemonUrl: ...         # explicit pin; also makes the lifecycle attach-only
```

Invalid values fall back safely with a warning; activation does not fail.

## Memory Runtime (automatic mode following)

0.3.0 can attach the independent Memory Runtime sidecar next to MCP. They are two layers
and two processes:

| Layer | Default | What it does |
| --- | --- | --- |
| **MCP** | On when the daemon is up | The official client mounts `mcp__mebular__*`; 29 tools unchanged |
| **Memory Runtime sidecar** | Follows the Mebular mode | `/memory-runtime/v1` context, ingest, compaction checkpoints, optional host maintenance |

The sidecar is **not** the MCP daemon runtime. DSH never reuses `daemonUrl`, the MCP
`runtime.json` or port 7331 as the sidecar address, and never blindly connects to 7341.
The adapter reads `<home>/memory-runtime.json` (`mode` / `state` / `capabilities`). In
light MCP there is no discovery file, so it sends no sidecar request and keeps the 0.2
tool surface. There is **no per-host `memoryRuntime.enabled` or collection switch**;
legacy values are ignored with a warning.

### Switch the device mode

The only product switch is the Mebular memory mode (`轻量 MCP` / `沉浸式`). The host
adapter follows the resulting sidecar discovery automatically.

1. Enable the MCP setting `memoryRuntime.enabled` (Console memory-runtime switch, or
   `<home>/config.json`):

   ```jsonc
   {
     "memoryRuntime": {
       "enabled": true
     }
   }
   ```

   The HTTP MCP daemon (`mebular serve`) then starts the installed sidecar and publishes
   `<home>/memory-runtime.json` plus a host token at
   `<home>/memory-runtime/host-token`. Stdio `mebular mcp` does not start it. MCP does not
   download the sidecar automatically; install `@mebular/memory-runtime` or use the
   desktop bundle.

2. Verify the sidecar before enabling the DSH group:

   ```bash
   mebular memory-runtime status --json
   ```

3. No host opt-in is required. The `memoryRuntime` group below is only for explicit
   troubleshooting/tests; omit it for normal use:

   ```yaml
   - id: mebular
     name: '@mebular/dsh-plugin'
     config:
       lifecycle: attach
       panel: true
       memoryRuntime:
         # Optional diagnostic overrides; default to true, maintenance defaults to false.
         recall: true
         ingest: true
         checkpoints: true
         hideMemoryTools: true
         maintenance: false
         # Governance allowlist; task_* is always kept.
         governanceTools: []
         memoryAgentPresets: ['mebular-memory']
         auth: auto                 # auto | bearer | none
         tokenEnv: MEBULAR_MEMORY_RUNTIME_TOKEN
         # url: 'http://127.0.0.1:7341/memory-runtime/v1'
         # tokenFile: '~/.mebular/memory-runtime/host-token'
         # token: '...'
   ```

- **Discovery:** `memoryRuntime.url` > `MEBULAR_MEMORY_RUNTIME_URL` >
  `<home>/memory-runtime.json`. `<home>` follows `MEBULAR_HOME`, otherwise
  `MEBULAR_CLOUD_ROOT`, then the current profile. Discovery must be `ready`/`degraded`,
  `mode` not `mcp`, with a heartbeat no older than 15 s and `apiVersion=1`; otherwise
  the immersive path stays disabled with a reason and no request is sent.
- **Auth:** `memoryRuntime.token` > the env var named by `tokenEnv` (default
  `MEBULAR_MEMORY_RUNTIME_TOKEN`) > `memoryRuntime.tokenFile` > discovery `tokenFile` >
  `<home>/memory-runtime/host-token`. This is the sidecar **host token**, not the MCP
  capability token. `auto` sends `Authorization: Bearer` when a token is available;
  `bearer` requires one; `none` never sends a header and is only for a local test sidecar
  that explicitly disables auth. A 401 refreshes the token cache and retries once. The
  token never appears in logs, URLs, errors or `getState()`.
- **Recall:** only on `agent/pre-step` with `step===1` and `decision.kind==='enter'`, for
  a new human turn. Calls `POST /memory-runtime/v1/context` (falls back to `/recall` only
  on an explicit 404/405 from an older sidecar). A hit appends **one request-scoped
  context message** with `role:'user'` and `source.kind='mebular-memory'`; DSH renders it
  as context injection, not a user bubble. It never uses `source.kind='user'`, never
  fabricates a new human turn, never writes session history, and is de-duplicated per
  `(agentId, surface, query, turn)` for 30 minutes. No hit, timeout or failure leaves the
  decision unchanged.
- **Ingest:** listens to live own `session/event` entries and batches user/assistant/tool
  events to `POST /memory-runtime/v1/ingest`; inherited fork/resume prefixes and the
  adapter's own injection are skipped. The queue is bounded (256), batches are 16 events
  or 250 ms, and network errors, timeouts, 429 and 5xx are retried at most twice with a
  stable `requestId`/`Idempotency-Key`. DSH has **no durable ingest spool**: after the
  bounded retries a failed batch is dropped with a warning and is not re-enqueued.
- **Checkpoints:** folds `compaction/start → summary → replacement → end` into one
  ContextCheckpoint and `PUT`s it to `/memory-runtime/v1/checkpoints/:threadId` with
  `domain=task:<threadId>` (or the configured task domain). Only a complete summary plus
  the replacement message is submitted; a failure, interruption or incomplete fold is
  never reported as committed. There is no durable checkpoint spool; failed state is
  visible in adapter status and the next compaction can write a new checkpoint. No
  `sync` field is sent.
- **Tool surface:** MCP stays at 29 tools and there are no `runtime_*` tools.
  `hideMemoryTools` removes currently visible `mcp__mebular__memory_*` from ordinary
  agents; `task_*` and the governance allowlist (`governanceTools`, plus agents in
  `memoryAgentPresets`) remain. The adapter itself only talks HTTP and registers no
  memory tools.
- **Model / maintenance:** DSH does not run or configure local Qwen or a third-party API;
  choose those in Mebular Console. DSH can supply its current session model only through
  `maintenance.enabled`: on idle it asks that model for candidates and submits them with
  `extractor='host'`. It never reads DSH credentials and never calls the model as a
  Mebular API. With maintenance off, DSH supplies no host candidates: if the sidecar is
  configured for `host`, those ingests may stay pending until candidates are supplied;
  otherwise the configured local, API or heuristic source applies. No source silently
  calls another model.

### Real boundaries

- The recall block is a source-tagged context message, not a fake user turn. If a future
  DSH preview changes this channel, the adapter is expected to disable injection with
  `injection_channel_unsupported` rather than fall back to `source.kind='user'`.
- DSH exposes no compaction summary guarantee beyond the events it emits; the adapter
  never invents one. An interrupted compaction is not a committed checkpoint.
- DSH does not expose its LLM credentials, and this adapter does not read them.
- DSH has no durable spool for ingest or checkpoints. Only the Hermes provider has a
  durable `queue.jsonl`; DSH failures are bounded and visible in status.

See the [Memory Runtime guide](../guides/MEMORY_RUNTIME.md) for the data boundaries
and model fallback rules.

## Upgrade from 0.2 / old prototype

- **No forced migration.** 0.2 records keep their IDs, namespaces, tags and events. The
  old `default` namespace is preserved as the third/Other fallback (`domain=default`); it
  is not rewritten to `user`.
- MCP keeps only lifecycle keys (`memoryRuntime.enabled`, `memoryRuntime.command`,
  `memoryRuntime.startTimeoutMs`). Detail/staging, model, trace and retention settings belong to
  `<home>/memory-runtime/config.json`, not to MCP `runtime.*` keys.
- Checkpoints and SelfRecords have no local/cloud switch. There is no `sync=cloud`,
  `checkpoint.sync` or `self.sync`; all durable objects go through MCP and existing cloud
  sync.
- `/runtime/v1` is not served and has no compatibility layer. A newer DSH adapter uses
  `/memory-runtime/v1`; an old adapter pointed at `/runtime/v1` cannot reach the sidecar,
  while MCP and the DSH panel keep working.
- Prototype data under `<home>/runtime/` is not read or migrated. Do not delete
  `<cloudRoot>/runtime/`; that is the MCP daemon install root, not sidecar data.
- To turn the sidecar off, switch the Mebular memory mode back to light MCP (or run
  `mebular memory-runtime stop`). The adapter sees discovery disappear and stops
  ingest/recall/checkpoint without host configuration; 29 MCP tools and settled memories
  remain. `<home>/memory-runtime/` may be kept or deleted; deleting it does not delete
  settled memories.

## Lightweight MCP is unchanged

With no sidecar/discovery, DSH is exactly the 0.2 experience: the
same 29 `mcp__mebular__*` tools, the same attach/managed lifecycle, panel and Console.
There is no `mebular-memory-runtime` process, no new `<home>/memory-runtime/` directory
or files, no `memory-runtime.json`, no host token and no port 7341 listener. If the
directory exists from an earlier immersive session, lightweight mode does not modify it.

## Status and panel

`GET /mebular/embed-info` is loopback-only and returns non-sensitive state.
v0.2.0 adds `state`, `runtimeMode`, `profile`, `provider`, `service`,
`downloadRequired`, `install`, `update` and `upgrade`; the panel, MCP bridge and
iframe share this state.

```json
{
  "ok": true,
  "status": "up",
  "state": "up",
  "mode": "attach",
  "runtimeMode": "reused",
  "managed": false,
  "panel": true,
  "version": "0.3.0",
  "profile": { "id": "default", "name": "My Cloud" },
  "provider": { "kind": "app", "source": "registry", "version": "0.3.0" },
  "service": { "registered": false, "running": false, "foreign": false },
  "downloadRequired": false,
  "install": { "state": "idle", "allowed": true },
  "update": { "state": "idle", "available": false, "show": false, "manual": false },
  "upgrade": { "state": "idle", "busy": false },
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

Common panel states:

- `download_required` / `download_failed`: no usable runtime; show explicit
  install, manual command and re-detect; never auto-download.
- `provisioning` / `starting`: installing, init or supervisor startup; MCP tools
  are not mounted yet.
- `service_conflict` / `profile_mismatch` / `port_in_use`: do not start a second
  daemon; follow the service/profile/port recovery message.
- `update_available`: a new stable version was found; prompt only.
- `up`: healthy daemon with a matching embed protocol; MCP bridge mounted and
  Console embeddable.

The sidebar dot shares the same source: green = up, amber = starting/installing/
updating, red = down, gray = first check pending.

## Updates and upgrade

The Plugin calls the shared `mebular runtime check-update --json` on startup or
refresh:

- fixed official npm stable channel; 24h throttle; offline/HTTP/busy is silent;
- shared `update-state`/`update.lock`; only one entry prompts;
- `promptedVersion` is written only after the panel actually renders the
  banner; the App writes the same shared state;
- **Skip this version** writes the shared skipped version; **Later** does not
  write a skip and does not auto-retry.

Only an explicit user action runs:

```text
mebular runtime upgrade --to latest --json
```

The upgrade reuses the installer and updates current/provider. If a service is
registered, core updates and restarts `mebular-serve`; the Plugin restarts only
its own supervisor. External daemons are untouched. A shared upgrade lock
allows one executor; the other waits/reconnects. On failure the old
runtime/current/provider are preserved and no second daemon is created.

## Persistence and uninstall

- Console **Keep Mebular running** installs/checks the shared `mebular-serve`;
- service status and the keep-running action live in Console settings; the
  Plugin panel only shows the compact runtime header and does not install
  services itself;
- removing the DSH Plugin removes only the Plugin and its own supervisor/timers;
  it does not delete runtime, provider, service or data;
- explicit service removal is `mebular runtime service uninstall`; it preserves
  runtime/provider/data.

## Security

- `/mebular/embed-info` is loopback-only and contains no token, key, home or CLI
  path.
- Install/upgrade are loopback-only `POST` JSON actions; arbitrary version/URL/
  registry values are rejected. The host reads the fixed source and target.
- The iframe is created only when the daemon, embed protocol, loopback and
  `capabilities.embedConsole` all match; the sandbox grants no top navigation.
- Under `?embed=dsh` the Console CSP allows loopback HTTP ancestors and the DSH
  Desktop origin `dsh-app://app`; ordinary Console requests keep
  `frame-ancestors 'none'`.
- The locked-state Console banner and onboarding card are hidden inside the DSH
  embed because they would overlap the right-side Console navigation at narrow
  panel widths. A compact upper-right action bar provides `新建忆云` /
  `加入忆云` while locked, then `加入忆云` / `邀请设备` after initialization.
- Shared update/upgrade/install locks prevent duplicate installs or upgrades;
  logs are redacted.

## Common reasons

| Reason | Action |
| --- | --- |
| `download_required` | Install from the panel, or open the App/install the CLI |
| `service_conflict` / `service_unknown` / `service_foreign` | Check Console/service; do not start a second daemon |
| `profile_mismatch` / `instance_mismatch` / `CLOUD_ALREADY_ACTIVE` | Switch to the same profile or stop the other instance |
| `port_in_use` | Free the port or change the Mebular port |
| `runtime_resolve_failed` | Update/reinstall the App/CLI or shared runtime |
| `supervise_failed` / `child_exited` | Check the shared runtime log and retry |
| `update_*` / `upgrade_busy` | Wait for the other entry; upgrades are explicit |
| `peer_missing` | Ensure DSH provides the `@deepseek-ai/dsh-mcp-client` peer |

## Verification

```bash
npm test -- --runInBand tests/dsh
npm run verify:dsh-plugin
npm run verify:runtime:coexistence
```

The real DSH Web E2E (minimum supported version and npm latest), cold start,
single daemon, service, update locks and upgrade rollback are covered by CI and
[DSH E2E](../operations/DSH_E2E.md).

## Release and version

- Version: `0.3.0`, on the unified Mebular v0.3.0 release train (six lockstep npm
  packages plus the isolated `dsh-plugin` share the same version).
- npm: `@mebular/dsh-plugin@0.3.0`.
- The Plugin is an isolated adapter in `packages/dsh-plugin`, published by its
  own npm job. It reads the pinned runtime version from its own `package.json`,
  so a release bump needs no Plugin source edit.
- Publish `@mebular/core@0.3.0` before `@mebular/dsh-plugin@0.3.0`; see
  [Release SOP](../operations/RELEASE.md).
- Listed in the `memory` category of
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/).

## Uninstall

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

Confirm the profile no longer contains the plugin:

```bash
dsh --profile web --dump-config | grep -i mebular   # expected: no output
```

Removing the Plugin leaves the Mebular App, runtime, service, data and a running
Console untouched. Do not delete the Mebular home or store.
