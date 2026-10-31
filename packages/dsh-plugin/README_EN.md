<div align="center">

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero-dark.svg" alt="Mebular — distributed memory network">
  </picture>
</p>

**One memory. Every assistant. Every device.**

A distributed memory network for your AI assistants. Memory and tasks stay on your devices; devices sync directly.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![Node.js >=22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?logo=deepseek&logoColor=white&style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[Start in 5 minutes](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md) · [How it works](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [Website](https://mebular.cyberfederal.io) · [中文](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README.md)

*No hosted account · No central coordinator*

The App and the DSH Plugin are two entries to the same local runtime.
The Plugin defaults to `attach`; it never starts or downloads Mebular silently.

</div>

---

<div align="center">

![Star map baseline: the device network before hovering](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-baseline-en-420.jpg) ![Task lanes and a fleet event: blue can send, gold can receive, gray unreachable](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-lanes-en-420.jpg)

*The map at rest: devices and their shared-subscription edges. · On hover: task-domain lanes plus live fleet traffic. Blue and gold show this device's two-way task-domain reachability, not peer-to-peer links.*

</div>

<table width="100%">
  <tr>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-normal.jpg" alt="The complete dark DeepSeek Harness view: Mebular sidebar entry, panel header and embedded star map" width="100%"><br><sub>Full DSH panel · entry and star map</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-collapsed.jpg" alt="Mebular Console full width after collapsing the dark DeepSeek Harness sidebar" width="100%"><br><sub>Collapsed sidebar · full Console</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-memories.jpg" alt="The Mebular shared-memory view inside dark DeepSeek Harness" width="100%"><br><sub>Shared memory view</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-settings.jpg" alt="The Mebular settings view inside dark DeepSeek Harness (demo data)" width="100%"><br><sub>Settings and keep-running</sub></td>
  </tr>
</table>

## Memory Runtime

<div align="center">

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/memory-runtime-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/memory-runtime-en.svg" alt="Memory Runtime: lightweight MCP and immersive access share one graph.">
  </picture>
</p>

*0.3 · Default off. Lightweight MCP and immersive share one graph.*

[Memory Runtime guide](https://github.com/Windsander/Mebular/blob/main/docs/guides/MEMORY_RUNTIME.md) · [DSH integration](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md)

</div>

<details>
<summary>Discovery &amp; auth</summary>

| Item | Rule |
| --- | --- |
| Sidecar base | `memoryRuntime.url` > env > `memory-runtime.json`; endpoint `/memory-runtime/v1` |
| Token | `MEBULAR_MEMORY_RUNTIME_TOKEN` > `tokenFile` > discovery; POSIX `0600` |
| Injection | `role='user'` + `source.kind='mebular-memory'`; one per human turn; silence on no hits |
| Mode | No per-host capture switch; lightweight = zero sidecar requests; immersive = auto |

DSH durable logs may retain source-tagged snapshots (platform limit), never rendered as user bubbles.
</details>

## DSH integration

<div align="center">

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en-dark.svg" alt="One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en-dark.svg" alt="What you get in DSH: a shared Console, official MCP tools, a status dot, the attach / managed / auto lifecycle and on-demand install/update; panel: false keeps MCP only.">
  </picture>
</p>

</div>

## Usage

<div align="center">

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en-dark.svg" alt="Three steps: install the plugin, restart DSH; an existing App/CLI attaches, and the panel explicitly installs the shared runtime when none exists.">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en-dark.svg" alt="DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp; shared runtime resolve selects the App/CLI/shared provider and dynamic URL.">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en-light.svg">
    <img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en-dark.svg" alt="Status dot: green up, amber starting/installing/updating, red down, gray waiting for the first check.">
  </picture>
</p>

</div>

An existing Mebular app or CLI attaches automatically; when no runtime exists, open the Mebular panel and install the shared runtime when prompted. Only the CLI-only path needs `mebular serve`.

<details>
<summary>Commands: install / development install / uninstall</summary>

```bash
# Install the plugin (it never starts or downloads Mebular silently)
dsh plugin --profile web add @mebular/dsh-plugin@0.3.0

# Development install
dsh plugin --profile web add ./packages/dsh-plugin

# Verify: call any mcp__mebular__* tool in DSH
# Uninstall
dsh plugin --profile web remove @mebular/dsh-plugin
```

</details>

## MCP tools

DSH reaches the same daemon at `/mcp` through the official MCP client; tools appear as `mcp__mebular__*`.

| Area | Tools | MCP behavior |
| --- | --- | --- |
| Memory write | `memory_write` `memory_write_batch` | Write facts, preferences, episodes and skills; signed and synced |
| Memory recall | `memory_query` `memory_search` `memory_graph` | Semantic/keyword recall and graph traversal |
| Profile and history | `memory_profile` `memory_skills` `memory_history` | Preferences, skills and session episodes |
| Memory maintenance | `memory_import` `memory_status` `memory_sync` `memory_delete` `memory_archive` | Import, status, sync, delete, archive |
| Task dispatch | `task_submit` `task_submit_batch` `task_cancel` `task_retry` `task_status` `task_list` `task_history` `task_children` `task_summarize` | Dispatch, cancel, retry, query tasks |
| Collaboration | `task_subscribe` `task_negotiate` `chatter_send` `chatter_inbox` `task_quota` `task_targets` `board_create` | Subscribe, negotiate, chatter, targets, boards |

## Docs

| Start | Learn | Run | Trust |
| --- | --- | --- | --- |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART.md">Quickstart</a></strong> <br><sub>Install &amp; pair</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md">Architecture</a></strong> <br><sub>Nodes &amp; sync</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/console/README.md">Console</a></strong> <br><sub>Local GUI</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md">Limitations</a></strong> <br><sub>Sensitive data</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/skill/SETUP.md">Agent skills</a></strong> <br><sub>Setup playbooks</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/fleet/RUNBOOK.md">Fleet ops</a></strong> <br><sub>Multi-machine</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/SHARED_RUNTIME.md">Shared runtime</a></strong> <br><sub>Install/upgrade/rollback</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SEALING.md">Sealing docs</a></strong> <br><sub>Protocol rules</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/CHANGELOG.md">Changelog</a></strong> <br><sub>Release notes</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md">Contributing</a></strong> <br><sub>Quality gates</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SECURITY.md">Security</a></strong> <br><sub>Report a vuln</sub> | <strong><a href="https://mebular.cyberfederal.io">Website</a></strong> <br><sub>Product site</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH.md">DSH integration</a></strong> <br><sub>Full reference</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md">DSH E2E</a></strong> <br><sub>CI gates</sub> | <strong><a href="https://www.npmjs.com/package/@mebular/dsh-plugin">npm</a></strong> <br><sub>Package page</sub> | <strong><a href="https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/">awesome-dsh-plugin</a></strong> <br><sub>Plugin list</sub> |

<details>
<summary>Discovery &amp; compatibility</summary>

| Case | Resolution |
| --- | --- |
| Shared runtime available | Shared runtime resolve (App / CLI / shared) |
| Legacy / no shared CLI | `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331` |
| Memory Runtime sidecar | `memoryRuntime.url > MEBULAR_MEMORY_RUNTIME_URL > <home>/memory-runtime.json` (never guesses a port) |
| `MEBULAR_HOME` | Locates daemon and sidecar discovery files |
| Mebular app | Independent; connects to the same daemon |

</details>

<div align="center">

v0.3.0 · early · MIT · © 2026 Sobert Li

</div>
