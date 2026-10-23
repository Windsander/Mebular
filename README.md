<div align="center">

![Mebular](assets/banner.svg)

**A distributed memory network for your AI assistants.**

Memory and tasks stay on your devices.<br>Devices sync directly. One shared graph.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node.js >=20](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](docs/getting-started/QUICKSTART.md) [![MCP](https://img.shields.io/badge/MCP-5A67D8)](docs/getting-started/QUICKSTART.md)

[Website](https://mebular.cyberfederal.io) · [Quickstart](docs/getting-started/QUICKSTART.md) · [中文](README_CN.md)

</div>

---

![Mebular network overview: two machines, each running a local node, syncing one graph for the assistants connected to them](assets/network-overview-en.svg)

<p align="center"><sub>One node per machine. One graph across them.</sub></p>

## What it is

| Local-first | Direct sync | Auditable | MCP |
|---|---|---|---|
| Memory and tasks stay on your devices and keep working offline. | Devices sync directly. No hosted account, no central coordinator. | Every write is signed and content-addressed, so history can be checked. | Your existing assistants connect over stdio or HTTP. |

A Cloud (忆云) is one shared memory space in the network — not a hosted service.

## Why Mebular

| The usual setup | Mebular |
|---|---|
| Context stays inside one assistant or one machine. | Every connected assistant reads and writes the same graph. |
| Sync needs an account and a hosted service. | Each machine runs a node; devices exchange memory directly. |
| You cannot tell who changed what. | Signed writes with an auditable history. |

## Get started

### Desktop app

![Desktop app setup: 1 Start deployment, 2 Create or join a Cloud, 3 Invite the next device](assets/desktop-steps-en.svg)

**Start deployment** → **Create new Cloud** / **Join existing Cloud** → **Invite device**.

The app runs on 64-bit macOS, Windows and Linux. If there is no build for your platform yet, use the browser or CLI path below.

### Other paths

| Path | Start with |
|---|---|
| **Browser** | `npm install -g @mebular/core` → `mebular serve` |
| **CLI** | `fleet quickstart` → `fleet invite` / `fleet join` |
| **Agent** | [Install the skill](packages/skill/SETUP.md), then say “deploy Mebular” |

Browser, CLI and agent paths need Node.js 20 or newer.

```bash
npm install -g @mebular/core
mebular serve                                  # browser console
fleet quickstart --daemon                      # CLI start
mebular print-config --client opencode         # MCP config
```

## What you get

| You get | In practice |
|---|---|
| **Context that follows you** | Write once with `memory_write`; any connected assistant recalls it with `memory_query`. |
| **Work that moves** | `task_submit` hands a task to another assistant; progress stays on one chain. |
| **History you can check** | See who wrote a fact, when it changed, and what was true then. |
| **Memory you can take** | Canonical Memory Format and adapters for Obsidian, logs and JSON memo. |

## How it works

![Pairing flow: device A starts and invites, device B joins with the QR code, then connection and the default grant happen automatically](assets/pairing-flow-en.svg)

One QR code or token enrolls a device. The master key stays on the root machine; each device then syncs on its own, with no central coordinator in the path.

## Docs

| Start | Go deeper |
|---|---|
| [Quickstart](docs/getting-started/QUICKSTART.md) | [Architecture](docs/architecture/ARCHITECT.md) |
| [Console](docs/console/README.md) | [Limitations](docs/limitations/LIMITATIONS.md) |
| [Changelog](CHANGELOG.md) | [Fleet runbook](packages/fleet/RUNBOOK.md) |
| [Contributing](CONTRIBUTING.md) | [Agent skills](packages/skill/SETUP.md) |
| [Release SOP](docs/operations/RELEASE.md) | [Sealing contract](SEALING.md) |

<details>
<summary>Who does what</summary>

| Who | Handles |
|---|---|
| **You** | One-time pairing, Cloud choice, invites, subscriptions. |
| **Your assistant** | Memory reads and writes, task claim and completion. |
| **Mebular** | Discovery, direct / relay / hole-punch, retries, certificates, service autostart. |

</details>

<details>
<summary>Use it from code</summary>

```ts
import { Mebular } from 'mebular';

const mebular = new Mebular({
  storagePath: './store.jsonl',
  deviceId: 'device-a',
  network: { enabled: false },
});

await mebular.initialize();
```

Runnable examples: [`examples/quickstart`](examples/quickstart/index.mjs) writes and recalls a preference; [`examples/two-devices`](examples/two-devices/index.mjs) demonstrates offline sync.

</details>

<div align="center">

[Website](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular)

v0.1.0 · early · MIT

</div>
