# Release

The release operations for this repository live under `docs/operations/`:

- [Release SOP](docs/operations/RELEASE.md) — npm eight packages, the `verify → preflight →
  desktop matrix → publish → publish-dsh → visibility → release` pipeline, the
  `release-prep → dry-run → release → back-merge` branch flow, checksums and rollback.
- [Desktop release](docs/operations/DESKTOP_RELEASE.md) — runtime packaging from release
  tarballs, installer asset names, unsigned install steps, and the signing/notarization plan.
- [Changelog](CHANGELOG.md) — release notes; the `## [vX.Y.Z]` section is the source of the
  GitHub Release body.

The current **published** release line is **v0.3.5**: a single-version umbrella with eight
npm packages at `0.3.5` (`core`, `service`, `skill`, `mcp`, `fleet`, `memory-runtime`,
`opencode-plugin`, `dsh-plugin`), and unsigned desktop installers for macOS, Windows and
Linux. The DSH plugin is an isolated adapter published by its own npm job, but it follows
the unified release train; no release ships the DSH plugin alone. `bump_version.sh` updates
all eight packages, and `verify:release-version` / the publish workflow enforce the same
version. Signing, notarization, and auto-update are not part of this release.

v0.4.0 is only in release preparation on `feat/0.4-w8-release-prep`: package manifests,
locks and version sources are at `0.4.0`, but there is no tag, push, publish or `main`
merge. W8 Go/No-Go remains blocked on real API, DSH, Hermes, OpenChamber Desktop and
host-model evidence; see the
[0.4.0 release-readiness report](docs/quality/0.4.0-intervention/0.4.0-release-readiness.md).
