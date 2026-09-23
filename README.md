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
- **Domains (namespaces) are data channels.** Joining a domain is a data obligation (receive + promptly sync your
  new local memory). There is no read-only membership and no dispatch semantics in a domain.
- **Tasks are trees.** A task is a DAG: the root is the dispatching agent, children are derived by executors
  (`causedBy`/`chain`, cycle-free). The only remote surface is the memory channel — no general remote query/RPC.
- **Trust is a certificate chain to the user master key.** Any enrolled device may delegate a certificate to a new
  device (bounded chain length); a short-lived, single-use join token lets a new device enroll without copying the
  master key. Revocation cascades to delegated certificates.

![Mebular architecture](assets/architecture-en.svg)

## How to use
![Pairing flow: device A starts and invites, device B joins with the QR code, connection and the default grant then happen automatically](assets/pairing-flow-en.svg)

### Start it
| Path | Get started | Best for |
|---|---|---|
| **Agent** (recommended) | install the skill, then say “deploy Mebular” / “join with this code” | hands-off |
| **GUI** | `mebular serve` → console → first run: **Create new / Join existing**; later: ＋ Invite a device | want to watch it happen |
| **CLI** | `fleet quickstart` → `fleet invite`; new device `fleet join --qr` | scripts / bulk |

**Agent** — install the skill, then say “deploy Mebular” / “join with this code”; it follows [`packages/skill/SETUP.md`](packages/skill/SETUP.md) and self-checks with `mebular doctor --net`:

```bash
node packages/skill/scripts/install.mjs
```

**GUI** — the console is at `http://127.0.0.1:7331/console`. On an empty home directory it opens the first-run page with two entries — **Create new Mebular** (root identity + config, then auto-restart) or **Join existing Mebular** (paste the invite token; the delegated certificate is fetched, no master key is copied). After onboarding, use ＋ Invite a device to onboard the next machine the same way:

```bash
mebular serve
```

**CLI** — the three commands to start, invite and join:

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A   # identity + daemon + join service
fleet invite --dir ~/.mebular                                  # QR code + token for the new device
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B   # or --token
```

First run is fully GUI (**Create new** / **Join existing** — paste the token; no CLI needed) · the CLI stays available for scripts (`fleet join`) · no `fleet approve` is needed by default · grants last 24h and are revocable · try the UI first with `seed-demo.mjs`

### Who does what
| Who | Manages | Typical commands |
|---|---|---|
| **Your agent** (you never touch it) | memory read/write/search, executing tasks and returning results | `memory_write` … (full list: skill docs) |
| **You** (rarely) | one-time pairing; grants / revoke / leave / rejoin; watching; optional dispatch | `fleet invite` · `fleet revoke` · `fleet task_submit` |
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

- **Limits & trade-offs** — [`LIMITATIONS.md`](LIMITATIONS.md)
- **Sealing contract** (red lines, protocol semantics, deferrals) — [`SEALING.md`](SEALING.md)
- **Fleet runbook** (two-machine ops, WAN commands, acceptance) — [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **Memory policy for agents** — [`packages/skill/MEMORY_POLICY.md`](packages/skill/MEMORY_POLICY.md)
- **Daemon / MCP** — [`packages/mcp`](packages/mcp)
- **Fleet** — [`packages/fleet`](packages/fleet)
- **Console GUI** — [`packages/console`](packages/console)
- **Contributing & quality gates** — [`CONTRIBUTING.md`](CONTRIBUTING.md)

<div align="center">

[Website](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular) · © 2026 Windsander · MIT License

</div>
