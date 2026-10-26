<div align="center">

![Mebular — distributed memory network](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**One memory. Every assistant. Every device.**

A distributed memory network for your AI assistants. Memory and tasks stay on your devices; devices sync directly.

[![npm](https://img.shields.io/npm/v/@mebular/dsh-plugin?style=flat-square)](https://www.npmjs.com/package/@mebular/dsh-plugin) [![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md) [![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-memory-4D6BFE?style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[Start in 5 minutes](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) · [How it works](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [Website](https://mebular.cyberfederal.io) · [中文](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README.md)

*No hosted account · No central coordinator*

</div>

---

<div align="center">

![Star map example: the device network at rest and task lanes on hover](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-starmap-en.jpg)

*The map at rest: devices and their shared-subscription edges. · On hover: task-domain lanes plus live fleet traffic. Blue and gold show this device's two-way task-domain reachability, not peer-to-peer links.*

</div>

## Mebular for DSH

Mebular is the memory and task interop layer between agents and devices; `@mebular/dsh-plugin` connects DSH to that same graph.

[npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [main README](https://github.com/Windsander/Mebular/blob/main/README.md) · [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md)

![One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en.svg)

*Different agents, different machines, one graph. DSH is one shell; other agents are shown for context. This README covers DSH only.*

> **Additive, not a replacement.** Local memory providers keep working; Mebular adds a cross-device, cross-agent graph above them.

## What you get in DSH

![What you get in DSH: a shared Console in the sidebar, official MCP tools, a status dot and the attach / managed lifecycle.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en.svg)

Shared Console, official MCP tools, status and lifecycle — all in one.

## 3 steps

![Three steps: start the daemon, install the plugin, restart DSH.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en.svg)

**Prerequisites**: Node `>=22.19` · DSH `>=0.2.1-rc.2 <0.3.0` · the Mebular app or Mebular CLI (`@mebular/core`) is available on this machine

```bash
mebular serve                                            # 1. start the daemon if the app is not running; default :7331
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2   # 2. install
# 3. restart DSH Web, open the Mebular panel; call any mcp__mebular__* tool to verify
```

The plugin does not install the daemon or Console: the default `attach` only probes; installing it does not start the daemon, and `managed` is the opt-in that starts it. When the daemon is running but not initialized, the panel shows the same create/join Cloud onboarding as the app. The Mebular app keeps running independently; development install: `dsh plugin --profile web add ./packages/dsh-plugin`.

## How it connects

![DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en.svg)

*One daemon. One Console. Two shells.*

`daemonUrl` → `MEBULAR_HTTP_PORT` → `runtime.json` → `7331`; the panel, `/mebular/embed-info`, and the MCP tools always use the same origin.

## Configuration

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
# panel: false keeps MCP only
# lifecycle: managed starts and owns a daemon
```

Fields, environment, managed details, and the endpoint list are in the [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md).

## Troubleshooting

![Status dot: green up, amber starting or degraded, red down, gray waiting for the first check.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en.svg)

- `daemon_unreachable` → start the Mebular app or `mebular serve`
- `managed_cli_missing` → set `cliPath` / `MEBULAR_CLI`
- `peer_missing` → make sure DSH provides the official MCP peer
- Full reason list in the [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md)

## Security and limits

- Loopback embed only; `/mebular/embed-info` accepts loopback peers only.
- The plugin never reads the store or tokens, and never writes `~/.mebular`; managed child logs are redacted.
- `attach` is the default and never starts or stops Mebular; only `lifecycle: managed` starts a child.
- `@deepseek-ai/dsh-mcp-client` is a DSH-provided peer; cross-home setups need explicit `daemonUrl` or `MEBULAR_HTTP_PORT`.

## Docs

[Main README](https://github.com/Windsander/Mebular/blob/main/README.md) · [integration notes](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md) · [DSH E2E](https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md) · [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) · [SECURITY](https://github.com/Windsander/Mebular/blob/main/SECURITY.md)

---

v0.1.2 · MIT · Uninstall: `dsh plugin --profile web remove @mebular/dsh-plugin`
