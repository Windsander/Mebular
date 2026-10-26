# Mebular for DSH

**One memory graph for every agent, on every machine.**

Mebular is the memory and task interop layer between agents and devices; `@mebular/dsh-plugin` connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to that same graph: the sidebar reuses the shared Console, and the official MCP client reaches the same daemon.

[![npm](https://img.shields.io/npm/v/@mebular/dsh-plugin?style=flat-square)](https://www.npmjs.com/package/@mebular/dsh-plugin) [![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org) [![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-memory-4D6BFE?style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[中文](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README.md) · [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [main README](https://github.com/Windsander/Mebular/blob/main/README.md) · [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md)

![One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en.svg)

*Different agents, different machines, one graph. DSH is one shell; other agents are shown for context. This README covers DSH only.*

> **Additive, not a replacement.** Your local memory provider (for example Mem0) keeps handling single-machine context; Mebular adds a cross-device, cross-agent graph above it.

## What this plugin adds to DSH

| Capability | What you get |
| --- | --- |
| Shared Console | The sidebar loads the same Mebular Console through `?embed=dsh` (loopback only), not a second UI. |
| Official MCP tools | The official `@deepseek-ai/dsh-mcp-client` connects to `/mcp`; tools appear as `mcp__mebular__*`. |
| Status dot | Green / amber / red / gray; when the daemon is not `up`, a `mebular:status` note tells the Agent how to recover. |
| `attach` / `managed` | The default only probes an existing daemon; `managed` can start a plugin-owned `mebular serve` child. |
| Zero build, zero deps | Imports no `@mebular/*`, reads no store, token, or `~/.mebular/config.json`. |

## Quick start

**Prerequisites**: Node `>=22.19` · DSH `>=0.2.1-rc.2 <0.3.0` · a running Mebular daemon

**1. Start the daemon**

```bash
mebular serve
curl -sS http://127.0.0.1:7331/healthz
```

**2. Install the plugin**

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
```

Development install: `dsh plugin --profile web add ./packages/dsh-plugin`

**3. Restart DSH Web**: the Mebular icon appears in the sidebar. Open the panel to confirm the Console; call any `mcp__mebular__*` tool and a Mebular result means the graph is connected.

> The Mebular app keeps running independently; the plugin only attaches and never stops or replaces it.

## How it connects

![DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en.svg)

*One daemon. One Console. Two shells.*

The plugin mounts the peer only while the daemon is healthy and points the iframe at the same origin; the panel, `/mebular/embed-info`, and MCP tools share one resolution, so the port never disagrees.

| Endpoint | Purpose |
| --- | --- |
| `/healthz` | daemon health check |
| `/app/embed/info` | Console embeddability |
| `/console/?embed=dsh` | DSH sidebar iframe |
| `/mcp` | Streamable HTTP endpoint for the official MCP client |
| `/mebular/embed-info` | read-only panel status (loopback only) |

## Configuration

```yaml
# default: one host row
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
# keep MCP, hide the panel: panel: false
# managed daemon:
# lifecycle: managed
# cliPath: /absolute/path/to/mebular
```

**Daemon discovery order**

| Order | Source |
| --- | --- |
| 1 | explicit `daemonUrl` (credentials in the URL are rejected) |
| 2 | `MEBULAR_HTTP_PORT` (a valid port, 1–65535) |
| 3 | `<home>/runtime.json` (a dead `pid` makes the record stale and it is skipped) |
| 4 | `http://127.0.0.1:7331` |

`<home>` = `MEBULAR_HOME`, defaulting to `~/.mebular`. The host reads only `version`, `pid`, `http.*`, `consolePath`, `mcpPath`, and `embedProtocol` from `runtime.json`.

**Fields**

| Field | Default | Description |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:7331` | only `http:` / `https:`; trailing slash removed |
| `lifecycle` | `attach` | `attach` only probes; `managed` starts a child when no daemon exists |
| `panel` | `true` | `false` hides the sidebar / main panel; MCP tools stay available |
| `cliPath` | unset | only for `managed`; `MEBULAR_CLI` is accepted, then `mebular` on `PATH` |

Invalid values fall back to safe defaults and log one `warn`; `panel: false` keeps `/mebular/embed-info` and the MCP bridge running. See the [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md#lifecycle-attach-or-managed) for the full `managed` lifecycle, signals, and log redaction.

**Environment**

| Variable | Effect |
| --- | --- |
| `MEBULAR_HTTP_PORT` | overrides the daemon port; the host, panel, and MCP bridge follow it |
| `MEBULAR_HOME` | locates `runtime.json`; default `~/.mebular` |
| `MEBULAR_CLI` | CLI candidate for `managed` (`cliPath` wins) |
| `DSH_HOME` | DSH profile root; unrelated to the Mebular home |

## Verify and troubleshoot

**Check the profile**

```bash
dsh --profile web --dump-config | grep -A6 mebular   # only the mebular host row, no static MCP row or hard-coded URL
```

**Status dot**

| Color | Meaning |
| --- | --- |
| Green | daemon connected; memory and task tools are available |
| Amber | daemon starting, or degraded |
| Red | daemon not running / unreachable |
| Gray | the first check has not returned yet |

**Read-only status**

```bash
curl -sS http://127.0.0.1:7331/app/embed/info
curl -sS http://127.0.0.1:<dsh-port>/mebular/embed-info
```

Returns `status`, `mode`, `managed`, `panel`, `version`, `embedProtocol`, `consoleUrl`, `embedUrl`, `mcpUrl`, `loopback`, and `reason`; see the [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md#mebularembed-info-contract) for the full JSON contract.

**Common reasons**

| Reason | What to do |
| --- | --- |
| `daemon_unreachable` | start the Mebular app or `mebular serve`; check port `7331` |
| `daemon_unhealthy` | check `/healthz`, the port, and the daemon log |
| `embed_info_unavailable` | check the daemon version and `/app/embed/info` |
| `not_loopback` / `embed_unsupported` | the panel is loopback only; use local DSH |
| `managed_cli_missing` | install the Mebular CLI, or set `cliPath` / `MEBULAR_CLI` |
| `managed_start_failed` | read the redacted managed child stderr in the DSH log |
| `peer_missing` | make sure DSH provides the `@deepseek-ai/dsh-mcp-client` peer |

**Uninstall**: `dsh plugin --profile web remove @mebular/dsh-plugin`; this removes only the plugin, and the daemon and Console stay running.

## Security and limits

- **Loopback only**: `/mebular/embed-info` accepts loopback peers only; other sources get `404`. The response contains no tokens, secrets, home/CLI paths, or process environment.
- **Iframe gate**: sandbox is `allow-scripts allow-same-origin allow-forms`, with no top navigation; the iframe exists only when the daemon, loopback, embed protocol, and `capabilities.embedConsole` all agree.
- **No data access**: the plugin never opens `store.jsonl`, reads tokens, or writes `~/.mebular`; managed child stdout/stderr is redacted before it reaches the DSH log.
- **Attach by default**: `attach` never starts or stops Mebular; only explicit `lifecycle: managed` starts a child.
- **The MCP peer comes from DSH**: `@deepseek-ai/dsh-mcp-client` is a peerDependency; without it the tools are unavailable, but the panel still works.
- **Cross-home setups need explicit config**: if DSH and the daemon use different `MEBULAR_HOME` values, auto-discovery misses; set `daemonUrl` or `MEBULAR_HTTP_PORT`.
- **DSH preview API**: the `panel` switch depends on `webServer.tapIndex`; re-verify `sidebar.panellist` and the `main` keyed slot after upgrading DSH.
- **Uninstall residue**: pnpm may keep a `node_modules/@mebular/dsh-plugin` symlink, but it is not in the profile bundles and is not loaded.

See [SECURITY.md](https://github.com/Windsander/Mebular/blob/main/SECURITY.md) for the full security policy.

## Docs

| Doc | Contents |
| --- | --- |
| [Main README](https://github.com/Windsander/Mebular/blob/main/README.md) | product overview, app, CLI, pairing |
| [DSH integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md) | full integration, JSON contract, architecture, dev and release |
| [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) | package and versions |
| [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) | list, `memory` category |
| [Release SOP](https://github.com/Windsander/Mebular/blob/main/docs/operations/RELEASE.md) | release process and versions |
| [SECURITY.md](https://github.com/Windsander/Mebular/blob/main/SECURITY.md) | security reports |

---

v0.1.2 · MIT · © 2026 Sobert Li
