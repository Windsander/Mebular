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
surface: `/healthz`, `/app/embed/info`, `/mcp` and `/console/?embed=dsh`.

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
dsh plugin --profile web add @mebular/dsh-plugin@0.1.1
```

For plugin development, install from the repository checkout instead:

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

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

If a call returns `NOT_INITIALIZED`, finish creating or joining a Cloud in the Console;
the same MCP session recovers without restarting the daemon.

When no daemon is running, the plugin does not mount the MCP client at all, so there are no
`mcp__mebular__*` tools to wait on or call. The panel still loads and shows guidance, and the
log reports `mcp bridge unavailable (daemon_unreachable): start the Mebular app or run
"mebular serve"`. Start the daemon (or run `mebular serve`); the plugin discovers it on the
next health check, mounts the tools automatically, and the panel recovers without restarting
DSH. `attach` never starts the daemon for you.

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

No service is installed, `MEBULAR_HOME` is inherited rather than rewritten, and an
external daemon (desktop app, system service, manual `mebular serve`) is never stopped.
If the CLI cannot be resolved, the plugin degrades to `attach` with
`reason: managed_cli_missing`.

Set `panel: false` to keep MCP tools but hide the sidebar/main panel, for example on a
headless or TUI-only profile.

## Security

- `GET /mebular/embed-info` accepts loopback peers only; other sources get `404`.
- The response contains no tokens, secrets, home paths, CLI paths, or process env.
- The iframe is only created when the daemon, its loopback flag, embed protocol `1`, and
  `capabilities.embedConsole` all agree; otherwise the panel shows a placeholder.
- Iframe sandbox is `allow-scripts allow-same-origin allow-forms`; no top navigation.
- The Console removes `X-Frame-Options` only for `?embed=dsh` on a loopback daemon and
  limits `frame-ancestors` to loopback HTTP origins.
- Managed child logs are redacted before they reach the DSH logger.

## Where the plugin lives

The package is developed in `packages/dsh-plugin` inside this repository and published as
`@mebular/dsh-plugin` on npm. GitHub topics are **repository-level**: keywords such as
`dsh-plugin`, `deepseek-harness` and `agent-memory` describe the Mebular repository as a
whole, not a separate package repo, so discovery points back here. See the
[plugin README](../../packages/dsh-plugin/README.md) for the full configuration reference.

## Release and versioning

- The plugin is an independent adapter: its code is isolated in `packages/dsh-plugin`, and its
  npm publish runs in its own `publish-dsh` job.
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

This removes only the DSH plugin. The Mebular app, its data, and the Console keep running
untouched.
