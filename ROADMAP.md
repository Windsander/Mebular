<!-- Canonical source for the pinned Roadmap Discussion. Keep asset and document URLs absolute so this file can be republished without rewriting. -->
# Mebular roadmap

[中文路线图](https://github.com/Windsander/Mebular/blob/main/ROADMAP_CN.md) · [Discussions](https://github.com/Windsander/Mebular/discussions) · [Live planning](https://github.com/Windsander/Mebular/projects)

> **Direction, not deadlines.** This roadmap records public product themes, not promised release dates. The text below is authoritative; the graphic is its visual summary. Issues and the public Project carry live task status.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Windsander/Mebular/main/assets/roadmap-en-light.svg">
  <img src="https://raw.githubusercontent.com/Windsander/Mebular/main/assets/roadmap-en.svg" alt="Mebular constellation roadmap: v0.2.0 released, shared-runtime hardening now, trusted desktop distribution and controlled updates next, protocol lifecycle topics under exploration">
</picture>

## Released — v0.2.0

Available now in the [v0.2.0 release](https://github.com/Windsander/Mebular/releases/tag/v0.2.0).

- **Shared Runtime Supervisor** — App, CLI and DSH share one local runtime, service, active profile and data root.
- **Equal App and DSH entries** — both entries use the same runtime ownership, provider discovery and service lifecycle.
- **Explicit bootstrap and updates** — plugin-only installation uses a pinned runtime; update prompts never install silently.

## Now — v0.2.x

The current stabilization focus. Priorities can move in response to reproducible reports and first-run feedback.

- **Shared-runtime hardening** — validate coexistence, upgrades, service ownership and recovery across real setups.
- **Cross-platform first runs** — improve installation and onboarding guidance using macOS, Windows, Linux, App, CLI and DSH feedback.
- **Diagnostics and recovery** — make failures easier to diagnose without exposing memory content, keys or tokens.

## Next — candidate themes

Known follow-up work. These themes are **not** a committed v0.3.0 scope or release schedule.

- **Trusted desktop distribution** — advance the existing desktop signing and notarization plan.
- **Controlled updates** — explore auto-update while preserving explicit consent, shared-runtime ownership and rollback.

## Exploring

Open problems only. Inclusion here does not commit to a design, version or date.

- **Key rotation and recovery** — investigate master-key rotation, re-anchoring and an in-product recovery path.
- **Domain lifecycle** — investigate safe deletion semantics for memory domains.
- **Mixed-version compatibility** — investigate upgrade windows instead of requiring every device to run the same version.

The current behavior and trade-offs behind these topics are documented in [Limitations](https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md).

## Participate

- **Report a reproducible problem:** [Issues](https://github.com/Windsander/Mebular/issues)
- **Ask about installation or usage:** [Q&A](https://github.com/Windsander/Mebular/discussions/categories/q-a)
- **Propose a use case or direction:** [Ideas](https://github.com/Windsander/Mebular/discussions/categories/ideas)
- **Inspect live task status:** [GitHub Projects](https://github.com/Windsander/Mebular/projects)

Do not use roadmap comments for vulnerability reports; use [Private Vulnerability Reporting](https://github.com/Windsander/Mebular/security/advisories/new).

This roadmap is reviewed at release boundaries and when community feedback materially changes priorities. Update it through a pull request, then refresh the pinned Discussion and public Project instead of creating competing roadmap copies.

---

<sub>Canonical source: [ROADMAP.md](https://github.com/Windsander/Mebular/blob/main/ROADMAP.md) · [Contribute](https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md)</sub>
