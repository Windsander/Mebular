# Use Mebular with DeepSeek Harness (DSH)

[中文](DSH_CN.md) · [Back to docs](../README.md)

`@mebular/dsh-plugin` adds Mebular's memory and task graph to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It is a thin
DSH bundle: it registers the official `@deepseek-ai/dsh-mcp-client` plugin against the
Mebular daemon that is already running, over **Streamable HTTP**.

## Two planes, one graph

| Plane | Responsibility |
| --- | --- |
| **Mebular app / daemon** | Control plane: identity, storage lock, trust, sync, star-map console. |
| **DSH** | Agent plane: reasons over the graph and calls Mebular tools from a chat session. |

The plugin never replaces the app. It does not start a second Mebular process, read the
local store, or import `@mebular/*`; the daemon's public HTTP `/mcp` endpoint is the only
contract. The console entry in the DSH panel opens
`http://127.0.0.1:7331/console` in a **new browser tab**, not in an iframe — the console
stays owned by the app (auth, storage, star map, invites).

## Before you start

1. Start the Mebular app, or run the daemon on its own:

   ```bash
   mebular serve            # default MCP + console port 7331
   curl -sS http://127.0.0.1:7331/healthz
   ```

2. Confirm the default endpoint is `http://127.0.0.1:7331/mcp`.

> **Use HTTP, not stdio.** A stdio MCP entry starts a second Mebular process, which then
> fights the app's daemon for the storage lock (`MCP_STORAGE_LOCKED`). The plugin's
> `cordis.patch.yml` pins `transport: streamable-http`; do not switch it to `stdio` or add
> a `command:` to the entry.

## Install

```bash
dsh plugin --profile web add @mebular/dsh-plugin
```

The package ships `cordis.patch.yml`; installing it inserts one
`@deepseek-ai/dsh-mcp-client` instance into the web profile with
`serverName: mebular`, `transport: streamable-http` and the default `/mcp` URL.
Restart the DSH session so the profile is reloaded.

## Verify

```bash
dsh web --dump-config | grep -A3 mebular
```

The block should contain `serverName: mebular`, `transport: streamable-http` and
`url: http://127.0.0.1:7331/mcp`. In a DSH session the Mebular tools are namespaced as
`mcp__mebular__*` (for example a memory read/write or task tool). Calling one and getting
Mebular data back means the graph is connected.

If a call returns `NOT_INITIALIZED`, finish creating or joining a Cloud in the locked
console; the same MCP session recovers without restarting the daemon. If the app is not
running at all, start it first — the plugin does not start it for you.

## Custom port

The default port is `7331`. If Mebular runs elsewhere, keep the daemon port and the
plugin URL in sync:

- App/daemon: set `mcp.http.port` in `~/.mebular/config.json` (or start with
  `mebular serve --port <port>`; `0` means auto-assign).
- Plugin: edit the installed profile patch (or the package's `cordis.patch.yml`, then
  reinstall) so `url` matches, for example:

  ```yaml
  - insert:
      - id: mebular
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: mebular
          transport: streamable-http
          url: http://127.0.0.1:12345/mcp
  ```

The console URL follows the same daemon port:
`http://127.0.0.1:<port>/console`.

## Where the plugin lives

The package is developed in `packages/dsh-plugin` inside this repository and published as
`@mebular/dsh-plugin`. GitHub topics are **repository-level**:
keywords such as `dsh-plugin`, `deepseek-harness` and `agent-memory` describe the Mebular
repository as a whole, not a separate package repo, so discovery points back here.

## Release and versioning

- The plugin has its own version, `0.1.0`, and its own npm lifecycle.
- It ships on the **same release train** as Mebular v0.1.0, so the first public plugin and
  the first public Mebular release land together.
- It is **not** part of the five-package lockstep (`core`, `service`, `skill`, `mcp`,
  `fleet`). Those five always share one version; the plugin can move independently.
- Publish is idempotent: the `publish-dsh` workflow job reads the version from
  `packages/dsh-plugin/package.json`, skips it if `npm view` already sees that version, and
  otherwise publishes the package. See [the release SOP](../operations/RELEASE.md).

## Uninstall

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

This removes only the DSH-side MCP client. The Mebular app, its data and the console keep
running untouched.
