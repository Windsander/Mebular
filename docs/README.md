# Mebular documentation

`docs/` is the **public, tracked** documentation tree: everything here ships with the
repository. Local design drafts belong in `design-notes/` or `docs.design/` (both are
gitignored) — please do not add drafts here.

Status, release notes and version numbers live in [`CHANGELOG.md`](../CHANGELOG.md) and the
main [`README.md`](../README.md); this index only describes document structure.

## Start here

- [README](../README.md) · [中文 README](../README_CN.md)
- [Quickstart](getting-started/QUICKSTART.md) · [快速上手](getting-started/QUICKSTART_CN.md)
- [Memory Runtime guide (0.3.2)](guides/MEMORY_RUNTIME.md) · [Memory Runtime 用户指南（0.3.2）](guides/MEMORY_RUNTIME_CN.md)
- [Roadmap](../ROADMAP.md) · [路线图](../ROADMAP_CN.md) — public themes, current focus and exploration
- [Contributing & quality gates](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Developer Certificate of Origin](DCO.md)

## Integrations

- [DSH](integrations/DSH.md) · [DSH 集成](integrations/DSH_CN.md)
- [Hermes](integrations/HERMES.md) · [Hermes 集成](integrations/HERMES_CN.md)
- [OpenChamber / OpenCode](integrations/OPENCHAMBER.md) · [OpenChamber / OpenCode 集成](integrations/OPENCHAMBER_CN.md)

## Architecture

- [ARCHITECT.md](architecture/ARCHITECT.md) — runtime layers, trust/sync model, code map
- [SURFACES.md](architecture/SURFACES.md) — shared status/capability/recovery contract across surfaces
- [RUNTIME-COEXISTENCE.md](architecture/RUNTIME-COEXISTENCE.md) — shared runtime/provider/ensure contract for App and DSH
- [SEALING.md](../SEALING.md) · [SEALING_CN.md](../SEALING_CN.md) — sealing contract (repository root)

## Operations

- [Shared runtime operations](operations/SHARED_RUNTIME.md) — status, install/upgrade, service, rollout and rollback
- [Release SOP](operations/RELEASE.md) — npm packages, desktop matrix, release assets
- [DSH real E2E](operations/DSH_E2E.md) — nightly matrix, CI artifacts, release gate
- [Desktop release](operations/DESKTOP_RELEASE.md) — runtime packaging, asset names, unsigned installs
- [Dependency overrides](operations/DEPENDENCY_OVERRIDES.md) — transitive advisories and when to remove each override
- [Changelog](../CHANGELOG.md)
- [Third-party notices](../THIRD-PARTY.md)

## Limitations

- [LIMITATIONS.md](limitations/LIMITATIONS.md) — known limits and trade-offs
- [LIMITATIONS_CN.md](limitations/LIMITATIONS_CN.md) — 限制与取舍

## Console

- [Console overview](console/README.md) — what the local GUI does, how to open it
- [Page map](console/page-map.md) — which setting lives in which tab
- Screen evidence: [E1](console/screens/e1/README.md) ·
  [E2a2](console/screens/e2a2/README.md) ·
  [security tiers](console/screens/security-tiers/README.md) ·
  [U1](console/screens/u1/README.md) ·
  [U3](console/screens/u3/README.md)

## Design

- [Memory Runtime 0.3.2 stability contract](design/0.3.2-stability-contract.md) · [中文](design/0.3.2-stability-contract_CN.md) — data, failure, lifecycle and acceptance target
- [Memory Runtime 0.3.0 contract](design/0.3.0-memory-runtime-contract-v2.md) — historical sidecar and capability contract (Chinese)
- [Memory Runtime sidecar lifecycle](design/0.3.0-memory-runtime-sidecar.md) — historical process, discovery, token and local-data design (Chinese)
- [DSH plugin v1](design/dsh-plugin-v1.md) — historical v0.1 design; current guide is [DSH integration](integrations/DSH.md)
- [Configuration journey v1](design/config-journey-v1.md) — historical record of the v1 setup flow
- [HTML prototype](design/prototype/README.md) — historical record of the early prototype

## Quality and release evidence

- [v0.3.2 verification matrix](quality/0.3.2-verification.md) — final test counts, host boundaries, scale/model evidence and explicit pending items
- [v0.3.2 scale benchmark](quality/0.3.2-scale-benchmark.md) — 1k/2k/10k count audits, performance, resources, failure injection and preserved 10k failure history
- [v0.3.2 real-model canary](quality/0.3.2-model-smoke.md) — Qwen3-4B Q4_K_M on macOS x64 with a test-only mirror; records the default-HF failure and exact boundary
- [v0.3.2 upgrade/rollback](quality/0.3.2-upgrade-rollback.md) — sequential v0.3.0 → v0.3.2 → v0.3.0 data-safety drill
- [v0.3.2 Fleet orchestration evidence](quality/0.3.2-fleet-orchestration.md) — executor/adapters, executable routing, checks and real/fake boundaries
- [v0.3.2 Fleet black-box demo](quality/0.3.2-fleet-blackbox-demo.md) — runnable demo/evidence for the public orchestration path
- [0.3.0 Memory Runtime acceptance](quality/0.3.0-memory-runtime-acceptance.md) — historical recall/security/performance evidence
- [0.3.0 real-model smoke](quality/0.3.0-model-smoke.md) — historical Qwen3-4B + llama.cpp evidence
- [0.3.0 Fleet P6 E2E](quality/0.3.0-fleet-orchestration-e2e.md) · [0.3.0 P7 review](quality/0.3.0-fleet-p7-review.md) — historical Fleet evidence

## Package docs

- [MCP daemon](../packages/mcp) — `mebular serve`, MCP surface, console hosting
- [Fleet (0.3.2)](../packages/fleet) — task DAG, plans, routing, join tokens, security, CLI
  - [Runbook](../packages/fleet/RUNBOOK.md)
  - [Design](../packages/fleet/DESIGN.md) — includes the dispatcher vs executor and agent support matrix
  - [OpenChamber public runner](../packages/fleet/OPENCHAMBER-RUNNER.md)
  - [Protocol invariants](../packages/fleet/PROTOCOL-INVARIANTS.md)
  - [Orchestration contract](design/fleet-orchestration-contract.md)
- [Console package](../packages/console) — console SPA and UI checks
- [Skill](../packages/skill/SETUP.md) · [memory policy](../packages/skill/MEMORY_POLICY.md) ·
  [task playbook](../packages/skill/tasks/SKILL.md)
- [Desktop app](../apps/desktop/README.md)
- [Runnable library example](../examples/quickstart/index.mjs)

## Historical

These documents are kept for traceability and are **not** current guidance. Their paths are
unchanged; they were not moved into `docs/archive/`.

- [Console interaction draft](console/interaction-draft.md) — Historical: early interaction notes
- [E2 manual acceptance](console/e2-manual-acceptance.md) — Historical: E2 acceptance runbook
