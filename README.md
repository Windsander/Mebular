<div align="center">

![Mebular](assets/banner.svg)

**A distributed memory network for your AI assistants.**

Mebular keeps memory and tasks on your devices and syncs them peer-to-peer. One memory, every assistant, every device — with no hosted account and no central coordinator.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP: stdio + HTTP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-5A67D8)](docs/getting-started/QUICKSTART.md)

[Website](https://mebular.cyberfederal.io) · [Quickstart](docs/getting-started/QUICKSTART.md) · [中文](README_CN.md)

</div>

---

## Why a distributed memory network

Assistant memory usually lives inside one tool or one process. Switch assistants and the context stops; switch machines and it is gone. A central service can connect them, but it adds an account, a dependency and a single place to trust.

| The usual setup | Mebular |
|---|---|
| Context stays inside one assistant or one machine | One shared graph every connected assistant can read and write |
| Going offline stops the work | Devices keep working and converge after reconnecting |
| Sync needs an account and a hosted service | Each machine runs its own node; devices exchange memory directly |
| You cannot verify who changed what | Signed, content-addressed writes with an auditable history |
| Notes are locked into one app | A versioned exchange format and adapters for Obsidian, logs and JSON memo |

## What it is

Mebular is a distributed memory network for AI assistants. Each machine runs a node; the nodes sync memory and tasks directly and form one shared graph.

- **A network of your machines.** Each device runs one node, and nodes exchange memory and tasks directly. A Cloud (忆云) is one shared memory space in the network, not a hosted service: create it on the first device, join it from the others.
- **Local-first by design.** Memory and task history stay in storage you own, remain usable offline, and converge when devices reconnect.
- **One node per machine.** `mebular serve` holds this machine's identity, storage, sync and MCP endpoint. The desktop app, browser console, CLI and assistants are clients of that node.
- **Memory is a graph with a history.** Entity, fact, episode, skill and meta nodes, typed edges, and facts with validity windows. Every write is Ed25519-signed and content-addressed, so you can tell who changed what.
- **Your assistants connect over MCP.** Memory and task tools work over stdio or Streamable HTTP, so existing MCP clients can use them without switching assistants.

## How to use

The desktop app is the shortest path when a build exists for your platform. The browser, CLI and agent paths use the same local node and the same console.

### Desktop app

1. **Get the app.** Download the desktop build from [GitHub Releases](https://github.com/Windsander/Mebular/releases) and open it. If there is no build for your platform yet, use the browser or CLI path below; nothing later depends on the app.
2. **Start deployment.** The app starts the local service and connects the AI assistants already installed on this machine. Nothing is uploaded to a hosted service.
3. **Create or join a Cloud.** The console opens locked. On the first device choose **Create new Cloud** and name the Cloud and the device. On later devices choose **Join existing Cloud** and paste a one-time token. After that, **Invite device** in the top bar brings in the next machine.

On a first run, the star map shows this machine and the other cards stay disabled until a Cloud exists. Create and join finish in the same process and on the same page: no daemon restart and no reload. When initialization returns, the console unlocks and the top bar switches to **Invite device** and **Join Cloud**.

### Browser, CLI and agent

These paths need Node.js 20 or newer. They all end at the same console on `http://127.0.0.1:7331/console`.

| Path | Start with | Best for |
|---|---|---|
| **Browser** | `npm install -g @mebular/core`, then `mebular serve` | the same console without the desktop app |
| **CLI** | `fleet quickstart`, then `fleet invite` or `fleet join` | scripts and headless machines |
| **Agent** | install the skill, then say “deploy Mebular” or “join with this code” | letting an assistant run setup |

**Browser**

```bash
npm install -g @mebular/core
mebular serve   # open http://127.0.0.1:7331/console
```

**CLI**

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-a
fleet invite --dir ~/.mebular
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-b
```

**Agent**

```bash
npm install -g @mebular/core
node "$(npm root -g)/@mebular/core/packages/skill/scripts/install.mjs"
```

### Connect an assistant

Print the MCP config for the client you use, paste it into that client's MCP settings, and reload the client:

```bash
mebular print-config --client opencode   # also: claude, cursor, dsh, generic
```

The desktop app writes the HTTP `/mcp` form for the assistants it connects during **Start deployment**. A manual HTTP client can point at `http://127.0.0.1:7331/mcp`.

## What you get

All of it runs on the same graph, whether the assistant runs on this machine or another one.

- **Context that survives the session.** Write a preference once with `memory_write`; later, any connected assistant can recall it with `memory_query`. You stop re-explaining your stack, your conventions or last month's decision.
- **Work that can move between assistants.** `task_submit` starts a task that another assistant can pick up, on this machine or another one. Progress, results and negotiation stay on the same chain.
- **A history you can check.** Every change is signed and content-addressed. You can see who wrote a fact, when it changed, and which validity window applied.
- **Data you keep.** Memory sits on your disks, works offline, and is yours to back up. Reconnect and devices converge.
- **Portable by design.** Canonical Memory Format and adapters let memory move to Obsidian, log journals, JSON memo and Hermes.

## How it works

### Pair once

![Pairing flow: device A starts and invites, device B joins with the QR code, then connection and the default grant happen automatically](assets/pairing-flow-en.svg)

The first device creates the Cloud. Each later device joins with a QR code or a one-time token and receives a delegated certificate; the master key stays on the root device. After that, each device syncs on its own.

### One node per machine

![Mebular architecture: one machine, one daemon, with assistants and fleet as local clients](assets/architecture-en.svg)

Every machine runs one `mebular serve` that owns identity, storage, sync and the MCP endpoint. Your assistants connect to that service. Devices exchange memory directly, with no central coordinator in the path.

## Developers and docs

Start with the [quickstart](docs/getting-started/QUICKSTART.md). It covers desktop, browser, CLI, agent and source installs, MCP connection, a second device and troubleshooting.

### Who does what

| Who | Handles | Typical commands |
|---|---|---|
| **You** | one-time pairing, Cloud choice, invites, subscriptions | `fleet invite` · `fleet subscribe` · `fleet join` |
| **Your assistant** | reading and writing memory, claiming and finishing tasks | `memory_write` · `task_submit` |
| **Mebular** | discovery, direct / relay / hole-punch, retries, certificates, service autostart | automatic |

The one networking decision left to you: when two networks have no public entry point, keep one always-on device reachable so it can act as their bridge.

### Use it from code

```ts
import { Mebular } from 'mebular';

const mebular = new Mebular({
  storagePath: './store.jsonl',
  deviceId: 'device-a',
  network: { enabled: false },
});

await mebular.initialize();
```

Runnable examples: [`examples/quickstart`](examples/quickstart/index.mjs) writes and recalls a preference; [`examples/two-devices`](examples/two-devices/index.mjs) demonstrates offline sync between two devices.

### Documentation

- **Quickstart** — [desktop, browser, CLI, agent and source](docs/getting-started/QUICKSTART.md) · [中文](docs/getting-started/QUICKSTART_CN.md)
- **Architecture** — [runtime layers and trust model](docs/architecture/ARCHITECT.md)
- **Limitations** — [known trade-offs before you store sensitive data](docs/limitations/LIMITATIONS.md) · [中文](docs/limitations/LIMITATIONS_CN.md)
- **Console** — [what the local GUI does](docs/console/README.md)
- **Changelog** — [release notes](CHANGELOG.md)
- **Contributing** — [quality gates and how to help](CONTRIBUTING.md)
- **Fleet runbook** — [two-machine operations and WAN checks](packages/fleet/RUNBOOK.md)
- **Agent skills** — [setup](packages/skill/SETUP.md) · [memory policy](packages/skill/MEMORY_POLICY.md) · [task playbook](packages/skill/tasks/SKILL.md)
- **Sealing contract** — [protocol red lines and deferrals](SEALING.md)
- **Release SOP** — [how releases are cut](docs/operations/RELEASE.md)

<div align="center">

[Website](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular)

v0.1.0 · early · MIT

</div>
