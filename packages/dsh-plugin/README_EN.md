<div align="center">

![Mebular — distributed memory network](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**One memory. Every assistant. Every device.**

A distributed memory network for your AI assistants. Memory and tasks stay on your devices; devices sync directly.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![Node.js >=22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?logo=deepseek&logoColor=white&style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[Start in 5 minutes](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) · [How it works](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [Website](https://mebular.cyberfederal.io) · [中文](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README.md)

*No hosted account · No central coordinator*

</div>

---

<div align="center">

![Star map baseline: the device network before hovering](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-baseline-en-420.jpg) ![Task lanes and a fleet event: blue can send, gold can receive, gray unreachable](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-lanes-en-420.jpg)

*The map at rest: devices and their shared-subscription edges. · On hover: task-domain lanes plus live fleet traffic. Blue and gold show this device's two-way task-domain reachability, not peer-to-peer links.*

</div>

## DSH integration

<div align="center">

![One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en.svg)

![What you get in DSH: a shared Console in the sidebar, official MCP tools, a status dot and the attach / managed lifecycle; panel: false keeps MCP only.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en.svg)

</div>

## Usage

<div align="center">

![Three steps: start the daemon, install the plugin, restart DSH; the Mebular app keeps running independently.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en.svg)

</div>

```bash
mebular serve
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
# development install: dsh plugin --profile web add ./packages/dsh-plugin
# verify: call any mcp__mebular__* tool
```

<div align="center">

![DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp; discovery daemonUrl → MEBULAR_HTTP_PORT → runtime.json → 7331.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en.svg)

![Status dot: green up, amber starting or degraded, red down, gray waiting for the first check.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en.svg)

</div>

## Docs

| Start | Learn | Run | Trust |
| --- | --- | --- | --- |
| [Quickstart](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) | [Architecture](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) | [Console](https://github.com/Windsander/Mebular/blob/main/docs/console/README.md) | [Limitations](https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md) |
| [Agent skills](https://github.com/Windsander/Mebular/blob/main/packages/skill/SETUP.md) | [Fleet ops](https://github.com/Windsander/Mebular/blob/main/packages/fleet/RUNBOOK.md) | [Release SOP](https://github.com/Windsander/Mebular/blob/main/docs/operations/RELEASE.md) | [Sealing docs](https://github.com/Windsander/Mebular/blob/main/SEALING.md) |
| [Changelog](https://github.com/Windsander/Mebular/blob/main/CHANGELOG.md) | [Contributing](https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md) | [Security](https://github.com/Windsander/Mebular/blob/main/SECURITY.md) | [Website](https://mebular.cyberfederal.io) |
| [DSH integration](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md) | [DSH E2E](https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md) | [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) | [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) |

---

v0.1.2 · MIT · Uninstall: `dsh plugin --profile web remove @mebular/dsh-plugin`
