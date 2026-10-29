# Release

The release operations for this repository live under `docs/operations/`:

- [Release SOP](docs/operations/RELEASE.md) — npm six packages, the `verify → preflight →
  desktop matrix → publish → publish-dsh → visibility → release` pipeline, the
  `release-prep → dry-run → release → back-merge` branch flow, checksums and rollback.
- [Desktop release](docs/operations/DESKTOP_RELEASE.md) — runtime packaging from release
  tarballs, installer asset names, unsigned install steps, and the signing/notarization plan.
- [Changelog](CHANGELOG.md) — release notes; the `## [vX.Y.Z]` section is the source of the
  GitHub Release body.

The current release line is **v0.2.4**: a single-version umbrella with six npm packages at
`0.2.4` (`core`, `service`, `skill`, `mcp`, `fleet`, `dsh-plugin`), and unsigned desktop
installers for macOS, Windows and Linux. The DSH plugin is an isolated adapter published by
its own npm job, but it follows the unified release train; no release ships the DSH plugin
alone. `bump_version.sh` updates all six packages, and `verify:release-version` / the publish
workflow enforce the same version. Signing, notarization, and auto-update are not part of
this release.
