<div align="center">

![Mebular](assets/banner.svg)

**One memory, every agent, every device — decentralized, offline-first.**

Mebular is a decentralized memory network for your agents: the data stays on your devices — no cloud, no coordinator, nothing central to breach. Every fact knows **when it is true and who wrote it**; devices work offline and converge on their own.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript strict ESM](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Website](https://mebular.cyberfederal.io) · [Why](#why) · [What it is](#what-it-is) · [How to use](#how-to-use) · [What you get](#what-you-get) · [Docs](#links--docs) · [中文](README_CN.md)

</div>

---

<p align="center">
  <img src="assets/console-starmap-about.jpg" width="400" alt="Star map with the About panel: identity, paths and bridge status at a glance">
  <img src="assets/console-settings-common.jpg" width="400" alt="Settings, common: four task cards for the six everyday options">
</p>
<p align="center"><sub>Star map &amp; About · Settings — the real UI</sub></p>

## Why

Agent memory usually lives inside one process: a list or a key-value store. Change machines and it is gone;
you cannot tell who wrote what; go offline and it stops working.

| Problem today | Mebular |
|---|---|
| Flat queues, no entities or relations | Graph memory: entity / fact / episode / skill / meta nodes, facts with validity windows |
| Writes cannot be verified | You can always tell who changed what — every write is Ed25519-signed and content-addressed |
| Sync needs a central service | No central service needed — vector-clock incremental sync; offline devices converge on reconnect |
| Isolated ecosystems | Your memory is portable — a versioned exchange format plus adapters (Obsidian, log journals, json-memo, …) |

## What it is

- **Pair once, then it runs itself.** A QR code (or token) enrolls a device — no master-key copying, no addresses to configure. Your agent manages memory; transport, sync and trust run in the background.
- **One machine = one node = one daemon.** `mebular serve` is the sole holder of identity, network and trust;
  fleet and agents are local clients sharing that daemon's identity and storage.
- **Domains (namespaces) are data channels.** Subscribing to a domain is a data obligation (receive + promptly sync
  your new local memory). Each device declares its own subscriptions; there is no per-device domain permission layer.
- **Tasks are trees.** A task is a DAG: the root is the dispatching agent, children are derived by executors
  (`causedBy`/`chain`, cycle-free). The only remote surface is the memory channel — no general remote query/RPC.
- **Trust is a certificate chain to the user master key.** Any enrolled device may delegate a certificate to a new
  device (bounded chain length); a short-lived, single-use join token lets a new device enroll without copying the
  master key. Removal (`device_revoke`) applies to that device itself (author-level); it does not cascade to delegated
  certificates, so descendants and newly enrolled devices remain unaffected.

![Mebular architecture](assets/architecture-en.svg)

## How to use
![Pairing flow: device A starts and invites, device B joins with the QR code, connection then happen automatically; each device subscribes on its own](assets/pairing-flow-en.svg)

### Install

With Node.js >= 20, install the published CLI from npm:

```bash
npm install -g @mebular/core   # root bundle: provides both `mebular` and `fleet`
command -v mebular && command -v fleet
```

`@mebular/core` is the root bundle and the install that provides both CLIs: `mebular` covers the daemon,
MCP server and console; `fleet` covers setup, invite and join. Installing `@mebular/mcp` alone provides
only `mebular` — it does not bring `fleet`. To install the memory / task skills from the npm tree:

```bash
node "$(npm root -g)/@mebular/core/packages/skill/scripts/install.mjs"
```

Prefer a source checkout? Use the GitHub-pinned or local install in [`QUICKSTART.md`](docs/getting-started/QUICKSTART.md).

### First run: create or join a Cloud

A **Cloud** (忆云) is one shared memory space. It is not a hosted service: its data lives on the devices
that belong to it. The **first device** creates the Cloud; **later devices** join it.

The desktop app's **Start deployment** is the one-click path: it starts the local daemon, connects the AI
assistants already installed on this machine, and then opens the **locked main console** — the star map is
visible, the other cards are disabled, and the top bar shows **Create new Cloud** and **Join existing
Cloud**. It does **not** create a Cloud for you.

- **First device** — top bar → **Create new Cloud**; enter a Cloud name and a device name. This machine
  becomes the root.
- **Later devices** — on a device already in the Cloud, top bar → **Invite device** for a QR code /
  one-time token; on the new device, top bar → **Join existing Cloud**, paste the token and enter a device
  name. The new device receives a delegated certificate; the master key is never copied.

Create and join complete in the same daemon process and on the same page: there is no daemon restart and no
page reload, and the console unlocks as soon as initialization returns. Once a Cloud is current, the top bar
switches to **Invite device** + **Join Cloud**.

The browser path is the same console: run `mebular serve` and open `http://127.0.0.1:7331/console`.
Before a Cloud exists, the MCP facade at `/mcp` already accepts `initialize` and `tools/list`; `tools/call`
returns a stable `NOT_INITIALIZED` error. That is expected — the same session recovers after create/join,
with no restart or config rewrite.

### Start it
| Path | Get started | Best for |
|---|---|---|
| **Agent** (recommended) | install the skill, then say “deploy Mebular” / “join with this code” | hands-off |
| **Desktop app** | **Start deployment** → locked main console → **Create new Cloud** / **Join existing Cloud** | one-click first run |
| **GUI (browser)** | `mebular serve` → console → the same two entries; later: ＋ Invite device | want to watch it happen |
| **CLI** | `fleet quickstart` → `fleet invite`; new device `fleet join --qr` | scripts / bulk |

**Agent** — install the skills (two: **memory** + **tasks**), then say “deploy Mebular” / “join with this code”; it follows [`packages/skill/SETUP.md`](packages/skill/SETUP.md) and self-checks with `mebular doctor --net`:

```bash
node packages/skill/scripts/install.mjs
```

**GUI** — the desktop app's **Start deployment** is the one-click path above. In the browser, `mebular serve` serves the same locked main console at `http://127.0.0.1:7331/console`: the first device uses **Create new Cloud**, later devices use **Join existing Cloud** (paste the invite token; the delegated certificate is fetched, no master key is copied). Both unlock the same page without a restart. After onboarding, use ＋ Invite a device to onboard the next machine the same way:

```bash
mebular serve
```

**CLI** — the three commands to start, invite and join:

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A   # identity + daemon + join service
fleet invite --dir ~/.mebular                                  # QR code + token for the new device
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B   # or --token
```

First run is fully GUI (desktop app or browser: **Create new Cloud** / **Join existing Cloud** — paste the token; no CLI needed) · after a Cloud is current, invite the next machine from the top bar · the CLI stays available for scripts (`fleet quickstart` / `fleet join`), and the GUI never chooses a Cloud for you · no extra step is needed — each device subscribes on its own, zero friction · try the UI first with `seed-demo.mjs`

### Who does what
| Who | Manages | Typical commands |
|---|---|---|
| **Your agent** (you never touch it) | memory read/write/search, executing tasks and returning results | `memory_write` … (full list: skill docs) |
| **You** (rarely) | one-time pairing; subscribe / unsubscribe / leave / rejoin; watching; optional dispatch | `fleet invite` · `fleet subscribe` · `fleet task_submit` |
| **The framework** (automatic) | discovery & addressing, direct/relay/hole-punch switching, auto bridges, sync retries, certificates & token TTLs, service autostart | — |

The one thing only you decide: when two networks both lack a public entry point, pair one always-on device they can reach — it becomes their bridge automatically.
### Extend it (developers)

```ts
import { Mebular, HermesMemoryProvider } from 'mebular';
const mebular = new Mebular({
  storagePath: './store.jsonl', deviceId: 'device-A', network: { enabled: false },
});
await mebular.initialize();
```

Runnable example: [`examples/quickstart`](examples/quickstart/index.mjs) — it submits a root task with `task_submit`.

## What you get

- **Local-first and offline-capable** — your data stays on your devices; reconnect and it converges.
- **Verifiable, tamper-evident history** — signed, content-addressed events; who changed what is auditable.
- **Graph structure with validity** — relations and time windows, not just a flat store.
- **A real node per machine** — one daemon owns identity/network/trust; agents and fleet share it, split by domain.
- **Decentralized expansion** — any enrolled device can invite; the master key may stay offline.

## Links & docs

- **Quickstart (5 minutes)** — [`QUICKSTART.md`](docs/getting-started/QUICKSTART.md) · [中文](docs/getting-started/QUICKSTART_CN.md)
- **Changelog / release notes** — [`CHANGELOG.md`](CHANGELOG.md)
- **Release SOP** — [`RELEASE.md`](docs/operations/RELEASE.md)
- **Limits & trade-offs** — [`LIMITATIONS.md`](docs/limitations/LIMITATIONS.md)
- **Sealing contract** (red lines, protocol semantics, deferrals) — [`SEALING.md`](SEALING.md)
- **Fleet runbook** (two-machine ops, WAN commands, acceptance) — [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **Memory policy for agents** — [`packages/skill/MEMORY_POLICY.md`](packages/skill/MEMORY_POLICY.md)
- **Task playbook for agents** — [`packages/skill/tasks/SKILL.md`](packages/skill/tasks/SKILL.md) (when to delegate, tracking, negotiation, red lines)
- **Daemon / MCP** — [`packages/mcp`](packages/mcp)
- **Fleet** — [`packages/fleet`](packages/fleet)
- **Console GUI** — [`packages/console`](packages/console)
- **Contributing & quality gates** — [`CONTRIBUTING.md`](CONTRIBUTING.md)

<div align="center">

[Website](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular) · © 2026 Windsander · MIT License

</div>
