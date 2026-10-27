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
dsh plugin --profile web add @mebular/dsh-plugin@0.2.0
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
  "version": "0.2.0",
  "profile": { "id": "default", "name": "My Cloud" },
  "provider": { "kind": "app", "source": "registry", "version": "0.2.0" },
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
- the Plugin panel displays service status and links to Console; the Plugin does
  not install services itself;
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

- Version: `0.2.0`, on the unified Mebular v0.2.0 release train (all six npm
  packages share the same version).
- npm: `@mebular/dsh-plugin@0.2.0`.
- The Plugin is an isolated adapter in `packages/dsh-plugin`, published by its
  own npm job. It reads the pinned runtime version from its own `package.json`,
  so a release bump needs no Plugin source edit.
- Publish `@mebular/core@0.2.0` before `@mebular/dsh-plugin@0.2.0`; see
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
