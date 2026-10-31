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

<table width="100%">
  <tr>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-normal.jpg" alt="The complete dark DeepSeek Harness view: Mebular sidebar entry, panel header and embedded star map" width="100%"><br><sub>Full DSH panel · entry and star map</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-collapsed.jpg" alt="Mebular Console full width after collapsing the dark DeepSeek Harness sidebar" width="100%"><br><sub>Collapsed sidebar · full Console</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-memories.jpg" alt="The Mebular shared-memory view inside dark DeepSeek Harness" width="100%"><br><sub>Shared memory view</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-en-settings.jpg" alt="The Mebular settings view inside dark DeepSeek Harness (demo data)" width="100%"><br><sub>Settings and keep-running</sub></td>
  </tr>
</table>

## DSH integration

<div align="center">

![One memory graph: two machines, each running a Mebular node. Machine A connects DSH, Hermes and Codex; machine B connects Pi, OpenCode and Cursor. Both nodes sync the same graph directly.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-en.svg)

![What you get in DSH: a shared Console, official MCP tools, a status dot, the attach / managed / auto lifecycle and on-demand install/update; panel: false keeps MCP only.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-en.svg)

</div>

## Usage

<div align="center">

![Three steps: install the plugin, restart DSH; an existing App/CLI attaches, and the panel explicitly installs the shared runtime when none exists.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-en.svg)

![DSH integration: DSH Web loads /console/?embed=dsh in an iframe, and the official MCP client reaches the same daemon at /mcp; shared runtime resolve selects the App/CLI/shared provider and dynamic URL.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-en.svg)

![Status dot: green up, amber starting/installing/updating, red down, gray waiting for the first check.](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-en.svg)

</div>

An existing Mebular app or CLI attaches automatically; when no runtime exists, open the Mebular panel and install the shared runtime when prompted. Only the CLI-only path needs `mebular serve`.

<details>
<summary>Commands: install / development install / uninstall</summary>

```bash
# Install the plugin (it never starts or downloads Mebular silently)
dsh plugin --profile web add @mebular/dsh-plugin@0.2.4

# Development install
dsh plugin --profile web add ./packages/dsh-plugin

# Verify: call any mcp__mebular__* tool in DSH
# Uninstall
dsh plugin --profile web remove @mebular/dsh-plugin
```

</details>

## Memory Runtime (opt-in)

Starting with 0.3.0 the host plugin can bridge an independent Memory Runtime sidecar (`/memory-runtime/v1`) alongside the existing MCP bridge. It is **off by default**: when disabled it registers no listeners, reads no discovery file, starts no timer and performs no request, so attach/managed/panel/MCP behaviour is unchanged. The sidecar is a separate process: the plugin never treats the MCP `daemonUrl` as the sidecar URL and never guesses a port.

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
    memoryRuntime:
      enabled: true
      # Optional: explicit sidecar base; otherwise env / <home>/memory-runtime.json.
      # url: 'http://127.0.0.1:7341/memory-runtime/v1'
      # Optional: host token; otherwise tokenFile / env / discovery tokenFile.
      # tokenFile: '~/.mebular/memory-runtime/host-token'
      # Optional: these default to true; maintenance defaults to false.
      recall: true
      ingest: true
      checkpoints: true
      hideMemoryTools: true
      maintenance: false
      # Domain hints (the sidecar decides the final domain when omitted).
      domains: ['user', 'agent:dsh', 'default']
      # Governance allowlist (these memory_* tools stay visible); task_* is always kept.
      governanceTools: []
      # Memory-butler presets/session ids are exempt from tool masking.
      memoryAgentPresets: ['mebular-memory']
      # Sidecar Host API auth: auto (default, bearer when a token exists) / bearer / none.
      auth: auto
      # Host token env var (default MEBULAR_MEMORY_RUNTIME_TOKEN).
      tokenEnv: MEBULAR_MEMORY_RUNTIME_TOKEN
      # token: '...'
```

- Discovery: `memoryRuntime.url` > `MEBULAR_MEMORY_RUNTIME_URL` > `<home>/memory-runtime.json` (`state=ready|degraded`, heartbeat ≤15s, `apiVersion=1`). Without a usable discovery the immersive path stays disabled and failure-open; it never blindly connects to 7341/7331.
- Token: `memoryRuntime.token` > `MEBULAR_MEMORY_RUNTIME_TOKEN` > `memoryRuntime.tokenFile` > discovery `tokenFile` > `<home>/memory-runtime/host-token`. POSIX token files must be `0600`; the value never enters URLs, logs, errors or `getState()`.
- `recall`: calls `POST /memory-runtime/v1/context` only on the first step of a new human turn (explicitly falls back to `/recall` when an older sidecar has no `/context`). No hits, timeout or failure passes through unchanged; a hit injects one `role='user'` + `source.kind='mebular-memory'` context injection (DSH does not render it as a user bubble; `source.kind='user'` is never used), deduped by surface + session query + turn. The block is capped at 8 KiB and escaped as untrusted background data.
- `ingest`: batches user/assistant/tool events to `POST /memory-runtime/v1/ingest`, skips the fork/resume inherited prefix and the plugin's own recall injection, dedupes by `(sessionId, seq)`, uses a bounded queue and never blocks the loop. Network errors, timeouts, 429 and 5xx retry at most twice by default (exponential backoff; `ingestRetries` / `ingestRetryBaseMs`); dispose cancels the backoff. Retries reuse one `requestId` and `Idempotency-Key`, failures surface as warning/status, and events are not re-enqueued.
- `auth`: `auto` (default) sends `Authorization: Bearer` when a token exists; `bearer` forces bearer, `none` never sends. A 401 refreshes the cached token once and retries once; if it still fails the request is failure-open and recorded as warning/status.
- `checkpoints`: folds `compaction/start → summary → replacement → end` into a ContextCheckpoint and `PUT /memory-runtime/v1/checkpoints/:threadId` (`domain=task:<threadId>`, no legacy `sync`); a failure or interruption is never reported as committed.
- `hideMemoryTools`: dynamically hides currently visible `mcp__mebular__memory_*` from ordinary agents, keeps `task_*` and `governanceTools`, and replays through `agent.ctx.tools.restrict` + `tools/change` without hardcoding unknown names.
- `maintenance`: off by default; when enabled, on idle it asks the current session model for candidates and submits them to `POST /memory-runtime/v1/ingest` (`extractor='host'`); no tools, capped maxTokens, timeout, silent failure and no direct graph write.

## MCP tools

DSH reaches the same daemon at `/mcp` through the official MCP client; tools appear as `mcp__mebular__*`.

| Area | Tools | MCP behavior |
| --- | --- | --- |
| Memory write | `memory_write` `memory_write_batch` | Write one or many facts, preferences, episodes and skills; every write is signed and synced |
| Memory recall | `memory_query` `memory_search` `memory_graph` | Semantic/keyword recall and graph traversal; filter by time and relation |
| Profile and history | `memory_profile` `memory_skills` `memory_history` | Read user preferences, skill inventory and session episodes |
| Memory maintenance | `memory_import` `memory_status` `memory_sync` `memory_delete` `memory_archive` | Import, status, sync, tombstone delete, archive/unarchive |
| Task dispatch | `task_submit` `task_submit_batch` `task_cancel` `task_retry` `task_status` `task_list` `task_history` `task_children` `task_summarize` | Dispatch, cancel, retry and query the task DAG |
| Collaboration | `task_subscribe` `task_negotiate` `chatter_send` `chatter_inbox` `task_quota` `task_targets` `board_create` | Change subscription, negotiate, quota chatter, targets and task boards |

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
| Shared runtime available | Prefer shared runtime resolve (App / CLI / shared provider + dynamic URL) |
| Legacy environment without a shared CLI | `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331` |
| Memory Runtime sidecar | `memoryRuntime.url > MEBULAR_MEMORY_RUNTIME_URL > <home>/memory-runtime.json` (never guesses a port) |
| `MEBULAR_HOME` | Locates the MCP daemon `runtime.json` and the sidecar `memory-runtime.json` |
| Mebular app | Keeps running independently; the plugin connects to the same daemon |

</details>

<div align="center">

v0.2.4 · early · MIT · © 2026 Sobert Li

</div>
