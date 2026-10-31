# Mebular documentation

`docs/` is the **public, tracked** documentation tree: everything here ships with the
repository. Local design drafts belong in `design-notes/` or `docs.design/` (both are
gitignored) — please do not add drafts here.

Status, release notes and version numbers live in [`CHANGELOG.md`](../CHANGELOG.md) and the
main [`README.md`](../README.md); this index only describes document structure.

## Start here

- [README](../README.md) · [中文 README](../README_CN.md)
- [Quickstart](getting-started/QUICKSTART.md) · [快速上手](getting-started/QUICKSTART_CN.md)
- [Memory Runtime guide (0.3.0)](guides/MEMORY_RUNTIME.md) · [Memory Runtime 用户指南（0.3.0）](guides/MEMORY_RUNTIME_CN.md)
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

- [Memory Runtime guide (0.3.0)](guides/MEMORY_RUNTIME.md) · [中文](guides/MEMORY_RUNTIME_CN.md) — user-facing guide to modes, models, host boundaries and privacy
- [Memory Runtime 0.3.0 contract](design/0.3.0-memory-runtime-contract-v2.md) — frozen sidecar and capability contract (Chinese)
- [Memory Runtime sidecar lifecycle](design/0.3.0-memory-runtime-sidecar.md) — process, discovery, tokens, local data and failure behaviour (Chinese)
- [0.3.0 acceptance report](quality/0.3.0-memory-runtime-acceptance.md) — recall quality, security and performance evidence
- [DSH plugin v1](design/dsh-plugin-v1.md) — historical v0.1 design; current guide is [DSH integration](integrations/DSH.md)
- [Configuration journey v1](design/config-journey-v1.md) — Historical record of the v1 setup flow
- [HTML prototype](design/prototype/README.md) — Historical record of the early prototype

## Package docs

- [MCP daemon](../packages/mcp) — `mebular serve`, MCP surface, console hosting
- [Fleet](../packages/fleet) — task DAG, join tokens, security, CLI
  - [Runbook](../packages/fleet/RUNBOOK.md)
  - [Design](../packages/fleet/DESIGN.md)
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
