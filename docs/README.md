# Mebular documentation

`docs/` is the **public, tracked** documentation tree: everything here ships with the
repository. Local design drafts belong in `design-notes/` or `docs.design/` (both are
gitignored) — please do not add drafts here.

Status, release notes and version numbers live in [`CHANGELOG.md`](../CHANGELOG.md) and the
main [`README.md`](../README.md); this index only describes document structure.

## Start here

- [README](../README.md) · [中文 README](../README_CN.md)
- [Quickstart](getting-started/QUICKSTART.md) · [快速上手](getting-started/QUICKSTART_CN.md)
- [DSH integration](integrations/DSH.md) · [DSH 集成](integrations/DSH_CN.md)
- [Contributing & quality gates](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Developer Certificate of Origin](DCO.md)

## Architecture

- [ARCHITECT.md](architecture/ARCHITECT.md) — runtime layers, trust/sync model, code map
- [SURFACES.md](architecture/SURFACES.md) — shared status/capability/recovery contract across surfaces
- [SEALING.md](../SEALING.md) · [SEALING_CN.md](../SEALING_CN.md) — sealing contract (repository root)

## Operations

- [Release SOP](operations/RELEASE.md) — npm packages, desktop matrix, release assets
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

- [DSH plugin v1](design/dsh-plugin-v1.md) — shared Console, runtime discovery, attach/managed
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
