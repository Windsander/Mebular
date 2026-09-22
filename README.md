<div align="center">

![Mebular](assets/banner.svg)

**A distributed, verifiable memory network for agents.**

Mebular stores memory as a signed knowledge graph: every fact remembers when it is valid and who wrote it.
Devices sync incrementally with vector clocks — offline-friendly, self-converging on reconnect, fully auditable.

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript strict ESM](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Website](https://mebular.cyberfederal.io) · [Why](#why) · [What it is](#what-it-is) · [How to use](#how-to-use) · [What you get](#what-you-get) · [Docs](#links--docs) · [中文](README_CN.md)

</div>

---

## Why

Agent memory usually lives inside one process: a list or a key-value store. Change machines and it is gone;
you cannot tell who wrote what; go offline and it stops working.

| Problem today | Mebular |
|---|---|
| Flat queues, no entities or relations | Graph memory: entity / fact / episode / skill / meta nodes, facts with validity windows |
| Writes cannot be verified | Every write is an Ed25519-signed, content-addressed event — auditable |
| Sync needs a central service | Vector-clock incremental sync, deterministic conflict resolution, offline-capable |
| Isolated ecosystems | A versioned exchange format plus adapters (Obsidian, log journals, json-memo, …) |

## What it is

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

### Let an agent deploy it for you (recommended)

Install the skill, then just tell your agent what you want:

```bash
node packages/skill/scripts/install.mjs        # installs the skill (MCP snippets in packages/skill/mcp/)
mebular mcp                                    # or connect over HTTP: mebular serve
```

Say “deploy Mebular on this machine”, or “join Mebular with this code”. The agent follows
[`packages/skill/SETUP.md`](packages/skill/SETUP.md) — pinned install, `fleet quickstart` or `fleet join --qr`,
self-check with `mebular doctor --net` — and reports back. Agents also drive memory over MCP
(`memory_write`, `memory_query`, `memory_search`, `memory_status`, …); every MCP tool has a **verbatim same-named**
`mebular` CLI command (`mebular memory_write`), so scripts and agents share one surface.

### Do it yourself in the GUI

```bash
mebular serve
```

Open `http://127.0.0.1:7331/console`, turn on the join service under the common settings, and click
**＋ Invite a device** to get a QR code and a token. Invites, grants, settings and diagnostics all live in the
console. To be honest: **joining a brand-new device still needs one `fleet join` command** (or hand the code to
an agent) — the console cannot paste a token yet.

### Do it yourself with the CLI

Start your own Mebular — this machine becomes the trust root:

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A   # identity + daemon + join service
fleet invite --dir ~/.mebular                                  # prints a QR code and a token
```

Join an existing Mebular from a new device:

```bash
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B   # or --token
```

That one step gives the device a delegated identity (the master key is **never copied**), connects it
automatically, and authorizes it on the token's domain — revocable, valid for 24h by default.
**No `fleet approve` is needed**; only invites created with `--no-grant` still ask for an explicit approval.

### Roles: your agent, you, and the framework

**Your agent does this — you don't touch it.** Memory in all its forms: `memory_write`, `memory_write_batch`,
`memory_query`, `memory_search`, `memory_profile`, `memory_skills`, `memory_history`, `memory_graph`,
`memory_import`, `memory_status`, `memory_sync`, plus semantic recall when enabled; and executing tasks and
returning results. (The same handlers are also exposed as same-named `mebular` commands — handy for scripts,
not a human chore.)

**You do this — rarely, and only about trust and boundaries.** One-time pairing: start with `fleet quickstart`,
join with `fleet join --qr` / `--token`. People and access: `fleet invite`, `fleet grant`, `fleet revoke`,
`fleet leave`, `fleet rejoin`. Watching and running it: `mebular status`, `mebular doctor --net`, the console at
`http://127.0.0.1:7331/console`. Optionally dispatch work: `fleet task_submit` hands a job to agents on other
devices (`task_status`, `task_children`, `task_summarize` follow it) — your agents also dispatch to each other.

**Nobody manages this — the framework does.** LAN discovery and the address book, choosing and switching between
direct / relay / hole-punched paths, reachable devices becoming bridges automatically, keeping endpoints fresh;
always-on sync with automatic retry; delegated certificates, token expiry and grant expiry; service autostart
and restart.

The one thing only you decide: when two networks both lack a public entry point, pair one always-on device the
others can reach — it becomes their bridge automatically. Try the console with seeded demo data via `seed-demo.mjs`.

### For developers

```ts
import { Mebular, HermesMemoryProvider } from 'mebular';
const mebular = new Mebular({ storagePath: './store.jsonl', deviceId: 'device-A', network: { enabled: false } });
await mebular.initialize();
```

See [`examples/quickstart`](examples/quickstart/index.mjs) to run it. For a fleet task tree, `fleet task_submit`
submits a root and `task_children` / `task_summarize` walk the tree.

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
- **Daemon / MCP** — [`packages/mcp`](packages/mcp) · **Fleet** — [`packages/fleet`](packages/fleet)
- **Console GUI** — [`packages/console`](packages/console) · **Contributing & quality gates** — [`CONTRIBUTING.md`](CONTRIBUTING.md)

<div align="center">

[Website](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular) · © 2026 Windsander · MIT License

</div>
