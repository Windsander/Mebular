# Use Mebular with DeepSeek Harness (DSH)

[中文](DSH_CN.md) · [Back to docs](../README.md)

`@mebular/dsh-plugin` adds Mebular's memory and task graph to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), and embeds
the shared Mebular Console in a DSH sidebar panel. It is a zero-build DSH bundle: one
`mebular` host row discovers the running daemon at runtime, mounts the official
`@deepseek-ai/dsh-mcp-client` peer over **Streamable HTTP**, and points its iframe at the
same Console the desktop app uses.

## One Console, two shells

| Plane | Responsibility |
| --- | --- |
| **Mebular app / daemon** | Control plane: identity, storage lock, trust, sync, star-map Console. |
| **DSH** | Agent plane: reasons over the graph, calls Mebular tools, and shows the same Console in a sidebar panel. |

The plugin never replaces the app. It does not start a second Mebular console, read the
local store, or import `@mebular/*`. The only contract is the daemon's public HTTP
surface.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `/healthz` | daemon health check |
| `/app/embed/info` | Console embeddability |
| `/console/?embed=dsh` | DSH sidebar iframe |
| `/mcp` | Streamable HTTP endpoint for the official MCP client |
| `/mebular/embed-info` | read-only panel status (loopback only) |

## Before you start

1. Start the Mebular app, or run the daemon on its own:

   ```bash
   mebular serve            # default HTTP/MCP/console port 7331
   curl -sS http://127.0.0.1:7331/healthz
   ```

2. Confirm the default MCP endpoint is `http://127.0.0.1:7331/mcp`.

> **Use HTTP, not stdio.** A stdio MCP entry starts a second Mebular process, which then
> fights the app's daemon for the storage lock (`MCP_STORAGE_LOCKED`). This plugin never
> declares a stdio transport or a `command:`.

## Install

Install the plugin from npm into DSH's web profile:

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
```

For plugin development, install from the repository checkout instead:

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

Installing the plugin does not start the daemon: the default `attach` only probes. If the
Mebular app is already running, skip this; otherwise start the app or `mebular serve`, or set
`lifecycle: managed` to let the plugin start it.

`@mebular/dsh-plugin` is an independent adapter: its code stays isolated in
`packages/dsh-plugin`, and it is published by its own npm job. Its version follows the
unified Mebular release train, so all six npm packages share one version. The plugin is listed in
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) under **memory**
(PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)).

The package ships `cordis.patch.yml` with exactly one host row:

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
```

There is no static MCP row and no hard-coded `daemonUrl`. On activation the host resolves
the daemon URL, mounts the official MCP client against it, and registers the sidebar and
main panel. Restart the DSH session so the profile is reloaded.

## Verify

```bash
dsh --profile web --dump-config | grep -A6 mebular
```

The block should contain only the `mebular` host row (`name: '@mebular/dsh-plugin'`).
There should be no `@deepseek-ai/dsh-mcp-client` row and no `url:` in the patch.

In a DSH session the Mebular tools are namespaced as `mcp__mebular__*` (for example a
memory read/write or task tool). Calling one and getting Mebular data back means the graph
is connected. The sidebar Mebular panel should show the same Console; its status comes
from the loopback-only `GET /mebular/embed-info` route.

The Mebular sidebar icon carries a small status dot even while the panel is closed: green
means connected, amber means starting or degraded, red means offline, and gray means the
first check is still pending. The dot and the panel share one poll and one status source;
hovering the dot shows the current status. See the
[surface contract](../architecture/SURFACES.md) for the shared state and recovery rules.

If a call returns `NOT_INITIALIZED`, finish creating or joining a Cloud in the Console;
the same MCP session recovers without restarting the daemon.

When no daemon is running, the plugin does not mount the MCP client at all, so there are no
`mcp__mebular__*` tools to wait on or call. The panel still loads and shows guidance, the
Agent receives a short status note (see below), and the log reports `mcp bridge unavailable
(daemon_unreachable): start the Mebular app or run "mebular serve"`. Start the daemon (or run
`mebular serve`); the plugin discovers it on the next health check, mounts the tools
automatically, and the panel recovers without restarting DSH. `attach` never starts the
daemon for you.

## Common reasons

| Reason | What to do |
| --- | --- |
| `daemon_unreachable` | start the Mebular app or run `mebular serve`; check `7331` |
| `daemon_unhealthy` | check `/healthz`, the port and the daemon log |
| `embed_info_unavailable` | check the daemon version and `/app/embed/info` |
| `not_loopback` / `embed_unsupported` | the panel is loopback only; use local DSH |
| `managed_cli_missing` | install the Mebular CLI, or set `cliPath` / `MEBULAR_CLI` |
| `managed_start_failed` | read the redacted managed child stderr in the DSH log |
| `peer_missing` | make sure DSH provides the `@deepseek-ai/dsh-mcp-client` peer |

## Daemon discovery and ports

The default port is `7331`. The host resolves the daemon in this order:

1. explicit `daemonUrl` in the plugin config (credentials are rejected);
2. `MEBULAR_HTTP_PORT`;
3. `<home>/runtime.json` (written after the daemon's HTTP listener is bound; a dead `pid`
   makes the record stale and it is skipped);
4. `http://127.0.0.1:7331`.

`<home>` follows the Mebular CLI: `MEBULAR_HOME`, defaulting to `~/.mebular`. The host
reads only the non-sensitive discovery fields (`version`, `pid`, `http.host`, `http.port`,
`consolePath`, `mcpPath`, `embedProtocol`); it never reads `config.json`, identity,
tokens, or the store.

To use a different port, keep the daemon and DSH in sync:

```bash
MEBULAR_HTTP_PORT=7332 dsh --profile web
```

The panel, `/mebular/embed-info`, and the MCP bridge all follow the same resolved origin.
There is no separate MCP URL to edit.

## Lifecycle: attach or managed

`attach` is the default: probe `/healthz` only, never start or stop a process. If no
daemon is running, the panel shows guidance, the MCP bridge stays unmounted, and the log
reports a stable `daemon_unreachable` notice. When the daemon starts, the bridge mounts
automatically; when it stops, the bridge fiber is disposed and its tools are unregistered.

`managed` reuses a healthy daemon, or starts one `mebular serve --port <port>` child when
none is running, waits for `/healthz`, and stops only that child on dispose. The MCP bridge
is not mounted while the child is `starting`, and is not mounted after
`managed_start_failed` / `managed_cli_missing`; those states are logged with their stable
reason. Once the daemon becomes healthy, the bridge mounts without a DSH restart.

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: managed
    cliPath: /absolute/path/to/mebular
    panel: true
```

`managed` is a child-process fallback, not a service install:

- a healthy daemon (service-managed, desktop app, or manual `mebular serve`) is reused, never
  preempted or stopped;
- when no daemon exists, it resolves the CLI and starts `mebular serve --port <port>`, then
  waits for `/healthz` for a bounded time (20s by default);
- on timeout, spawn error, or an early child exit, it stops only its own child and reports
  `down` with `reason: managed_start_failed`; it does not retry forever;
- shutdown is `SIGTERM` → 2s grace → `SIGKILL`; an external daemon is never stopped;
- if the CLI cannot be resolved, it degrades to `attach` with `down` and
  `reason: managed_cli_missing`;
- child stdout/stderr is redacted before it reaches the DSH logger.

No service is installed, and `MEBULAR_HOME` is never rewritten.

Set `panel: false` to keep MCP tools but hide the sidebar/main panel, for example on a
headless or TUI-only profile.

## Configuration fields and environment

| Field | Default | Description |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:7331` | only `http:` / `https:`; trailing slash removed |
| `lifecycle` | `attach` | `attach` only probes; `managed` starts a child when no daemon exists |
| `panel` | `true` | `false` hides the sidebar / main panel; MCP tools stay available |
| `cliPath` | unset | only for `managed`; `MEBULAR_CLI` is accepted, then `mebular` on `PATH` |

| Variable | Effect |
| --- | --- |
| `MEBULAR_HTTP_PORT` | overrides the daemon port; the host, panel, and MCP bridge follow it |
| `MEBULAR_HOME` | locates `runtime.json`; default `~/.mebular` |
| `MEBULAR_CLI` | CLI candidate for `managed` (`cliPath` wins) |
| `DSH_HOME` | DSH profile root; unrelated to the Mebular home |

Invalid values fall back to safe defaults and log one `warn`; they never prevent DSH from
starting.

## Agent-visible status (DSH only)

Mebular's availability is visible to the Agent too, not only to the sidebar. The host
registers one DSH system-prompt section named `mebular:status`:

- while the daemon is `up`, the section text is empty, so it adds no prompt tokens;
- when it is `down`, the Agent is told that Mebular memory is unavailable, to ask you to
  start the Mebular app or run `mebular serve`, and not to claim memory is available;
- `starting` says memory tools are temporarily unavailable; `managed_cli_missing` and
  `managed_start_failed` give their own recovery action.

The section is derived from the same lifecycle snapshot as the MCP bridge; it does not add a
poller or a second status source. DSH is notified through `system-prompt/change` only when
the text changes, not on every health tick. It is profile-level prompt text, so every agent
in that DSH profile may see it.

This is an adapter feature, not a wire field and not a general MCP capability. The host
injects the optional `systemPrompt` service with `ctx.inject(['systemPrompt'])` and silently
skips the section on older DSH versions or profiles without that service; activation, the
panel, and the MCP bridge keep working. `panel: false` does not disable it. Other MCP clients
are not promised this hint, and Mebular does not add a `mebular_status` tool.

## `/mebular/embed-info` contract

```json
{
  "ok": true,
  "status": "up",
  "mode": "attach",
  "managed": false,
  "panel": true,
  "version": "0.1.2",
  "embedProtocol": 1,
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

| Field | Meaning |
| --- | --- |
| `status` | `up` (healthy), `down` (unreachable / unhealthy), `starting` (managed is starting and waiting for healthz). While `starting`, `embedUrl` is `null` and the panel does not load the iframe. |
| `mode` | the effective lifecycle. A missing CLI degrades `managed` to `attach`. |
| `managed` | `true` only when this plugin started the current daemon and its child is still running; reusing an external daemon always reports `false`. |
| `reason` | a stable diagnostic code; `null` on success. |

The other fields are `ok`, `panel`, `version`, `embedProtocol`, `consoleUrl`, `embedUrl`,
`mcpUrl`, and `loopback`. `embedUrl` is returned only when the daemon, `/app/embed/info`'s
`loopback`, `embedProtocol`, and `capabilities.embedConsole` all agree; otherwise the panel
shows a placeholder and does not load the iframe.

## Architecture boundary

```text
DSH host                         Mebular daemon
  ├─ cordis.patch.yml            ├─ /healthz
  │   └─ mebular (index.js)      ├─ /app/embed/info
  │       ├─ GET /mebular/embed-info
  │       └─ mounts official mcp-client ──┼─ /mcp
  └─ client.js
      └─ iframe ─────────────────┼─ /console/?embed=dsh
```

- This package imports **no** `@mebular/core`, `@mebular/console` or `@mebular/desktop`, and
  copies none of the Console UI or static assets.
- There is one Console implementation, served by the Mebular daemon; DSH only provides the
  iframe container.
- The plugin never opens `store.jsonl`, reads tokens, or writes `~/.mebular`.
- The plugin dynamically imports only the official `@deepseek-ai/dsh-mcp-client` peer. MCP
  connection, reconnection, discovery and registration stay with that official package. The
  host mounts it with the discovered origin while the lifecycle is `up`, and disposes the child
  fiber when the daemon goes away; the host does not implement an MCP client.
- The panel and the MCP bridge share one daemon resolution; the panel and the tools never
  disagree about the port.

## Security

- `GET /mebular/embed-info` accepts loopback peers only; other sources get `404`.
- The response contains no tokens, secrets, home paths, CLI paths, or process env.
- The iframe is only created when the daemon, its loopback flag, embed protocol `1`, and
  `capabilities.embedConsole` all agree; otherwise the panel shows a placeholder.
- Iframe sandbox is `allow-scripts allow-same-origin allow-forms`; no top navigation.
- The Console removes `X-Frame-Options` only for `?embed=dsh` on a loopback daemon and
  limits `frame-ancestors` to loopback HTTP origins.
- Managed child logs are redacted before they reach the DSH logger.

## Development and tests

```sh
# host pure functions + HTTP handler + lifecycle + client contract
npm test -- --runInBand tests/dsh

# related regressions (Console embed / MCP / runtime / shutdown)
npm test -- --runInBand tests/dsh tests/console tests/mcp

# plugin packaging contract (no network, writes no files)
npm run verify:dsh-plugin
```

`index.js` is a plain ESM host plugin; `client.js` is a hand-written
`window.__ModuleLoader__.load({ id: '@mebular/dsh-plugin', factory })` wrapper that only
`require('react')`. Neither has a build step.

## Where the plugin lives

The package is developed in `packages/dsh-plugin` inside this repository and published as
`@mebular/dsh-plugin` on npm. GitHub topics are **repository-level**: keywords such as
`dsh-plugin`, `deepseek-harness` and `agent-memory` describe the Mebular repository as a
whole, not a separate package repo, so discovery points back here. See the
[plugin README](../../packages/dsh-plugin/README_EN.md) for the quick start and capability
overview; this document is the full configuration and lifecycle reference.

## Release and versioning

- Version: `0.1.2`, on the unified Mebular v0.1.2 release train (all six npm packages share
  one version)
- npm: [`@mebular/dsh-plugin@0.1.2`](https://www.npmjs.com/package/@mebular/dsh-plugin)
- The plugin is an independent adapter: its code is isolated in `packages/dsh-plugin`, and its
  npm publish runs in its own `publish-dsh` job.
- Listed on
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)
  under `memory` (PR [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167)).
- All six npm packages (`core`, `service`, `skill`, `mcp`, `fleet`, `dsh-plugin`) share one
  version from the unified Mebular release train. The plugin is included in every release;
  no release ships the DSH plugin alone.
- Publish is idempotent: the `publish-dsh` workflow job reads the version from
  `packages/dsh-plugin/package.json`, skips it if `npm view` already sees that version, and
  otherwise publishes the package. See [the release SOP](../operations/RELEASE.md).

## Uninstall

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

Confirm the profile no longer lists the plugin:

```bash
dsh --profile web --dump-config | grep -i mebular   # should print nothing
```

This removes only the DSH plugin. The Mebular app, its data, and the running Console are
untouched; `/healthz` and `/console/` remain available. Do not delete the Mebular home or
store. After `dsh plugin remove`, pnpm may keep a `node_modules/@mebular/dsh-plugin` symlink;
it is not in the profile bundles and is not loaded.
