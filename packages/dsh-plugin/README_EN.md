<div align="center">

![Mebular — distributed memory network](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**One memory. Every assistant. Every device.**

A distributed memory network for your AI assistants. Memory and tasks stay on your devices; devices sync directly.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![Node.js >=22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?logo=deepseek&logoColor=white&style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[Start in 5 minutes](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) · [How it works](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [Website](https://mebular.cyberfederal.io) · [中文](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README.md)

*No hosted account · No central coordinator*

The App and the DSH Plugin are two entries to the same local Mebular runtime.
The Plugin defaults to `attach`; installing it never starts or downloads Mebular
silently. It attaches to an existing App/CLI; when no runtime exists, the panel
asks before installing a pinned shared runtime.

</div>

---

<div align="center">

![Star map baseline: the device network before hovering](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-baseline-en-420.jpg) ![Task lanes and a fleet event: blue can send, gold can receive, gray unreachable](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-lanes-en-420.jpg)

*The map at rest: devices and their shared-subscription edges. · On hover: task-domain lanes plus live fleet traffic. Blue and gold show this device's two-way task-domain reachability, not peer-to-peer links.*

</div>

## DSH integration

<div align="center">

![One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en.svg)

![What you get in DSH: a shared Console, official MCP tools, a status dot, the attach / managed / auto lifecycle and on-demand install/update; panel: false keeps MCP only.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en.svg)

</div>

## Usage

<div align="center">

![Three steps: install the plugin, restart DSH; an existing App/CLI attaches, and the panel explicitly installs the shared runtime when none exists.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en.svg)

</div>

```bash
# Install the plugin only; it does not start or download Mebular.
dsh plugin --profile web add @mebular/dsh-plugin@0.2.0

# App/CLI running: the plugin attaches automatically; no manual mebular serve.
# No runtime: open the Mebular panel and explicitly install the shared runtime.
# CLI-only fallback: mebular serve

# development install: dsh plugin --profile web add ./packages/dsh-plugin
# verify: call any mcp__mebular__* tool
# uninstall: dsh plugin --profile web remove @mebular/dsh-plugin
```

<div align="center">

![DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp; shared runtime resolve selects the App/CLI/shared provider and dynamic URL.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en.svg)

![Status dot: green up, amber starting/installing/updating, red down, gray waiting for the first check.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en.svg)

</div>

## Legacy discovery

Shared runtime resolve is preferred when a shared CLI is available. Without it,
legacy discovery remains `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331`;
`MEBULAR_HOME` only locates `runtime.json`. The Mebular app keeps running
independently; the plugin connects to the same daemon.

## Docs

| Start | Learn | Run | Trust |
| --- | --- | --- | --- |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md">Quickstart</a></strong> <br><sub>Install &amp; pair</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md">Architecture</a></strong> <br><sub>Nodes &amp; sync</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/console/README.md">Console</a></strong> <br><sub>Local GUI</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md">Limitations</a></strong> <br><sub>Sensitive data</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/skill/SETUP.md">Agent skills</a></strong> <br><sub>Setup playbooks</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/fleet/RUNBOOK.md">Fleet ops</a></strong> <br><sub>Multi-machine</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/SHARED_RUNTIME.md">Shared runtime</a></strong> <br><sub>Install/upgrade/rollback</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SEALING.md">Sealing docs</a></strong> <br><sub>Protocol rules</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/CHANGELOG.md">Changelog</a></strong> <br><sub>Release notes</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md">Contributing</a></strong> <br><sub>Quality gates</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SECURITY.md">Security</a></strong> <br><sub>Report a vuln</sub> | <strong><a href="https://mebular.cyberfederal.io">Website</a></strong> <br><sub>Product site</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md">DSH integration</a></strong> <br><sub>Full reference</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md">DSH E2E</a></strong> <br><sub>CI gates</sub> | <strong><a href="https://www.npmjs.com/package/@mebular/dsh-plugin">npm</a></strong> <br><sub>Package page</sub> | <strong><a href="https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/">awesome-dsh-plugin</a></strong> <br><sub>Plugin list</sub> |

<div align="center">

v0.2.0 · early · MIT · © 2026 Sobert Li

</div>
