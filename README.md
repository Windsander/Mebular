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

### For agent users

Point an MCP-capable agent (Claude / Cursor / OpenCode / DeepSeek Harness) at the daemon and use the memory tools
(`memory_write`, `memory_query`, `memory_search`, `memory_status`, …). Every MCP tool has a **verbatim same-named**
`mebular` CLI command (`mebular memory_write`), so scripts and agents share one surface.

```bash
npm install && npm run build
node packages/skill/scripts/install.mjs        # install the skill (opt-in)
mebular mcp                                    # or connect over HTTP: mebular serve
```

### For device owners

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

### What you can do — and what you never have to manage

- **Memory** — `memory_write`, `memory_query`, `memory_search`, `memory_profile`, `memory_skills`,
  `memory_history`, `memory_graph`, `memory_import`, `memory_status`, `memory_sync`: agents use them over MCP,
  humans use the same-named `mebular` command.
- **Tasks** — `fleet task_submit` dispatches work to agents on other devices; `task_status`, `task_children`
  and `task_summarize` follow it.
- **People and access** — `fleet invite`, `fleet grant`, `fleet revoke`, `fleet leave`, `fleet rejoin`.
- **Observability** — `mebular status`, `mebular doctor --net`, and a local console: `mebular serve`, then open
  `http://127.0.0.1:7331/console` (star map, About this device, settings, diagnostics, invite QR code).

Mebular handles the rest: LAN discovery and the address book, choosing and switching between direct / relay /
hole-punched paths, reachable devices becoming bridges automatically, keeping endpoints fresh; always-on sync
with automatic retry; delegated certificates, token expiry and grant expiry; service autostart and restart.

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
