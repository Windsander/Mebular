# Release

The release operations for this repository live under `docs/operations/`:

- [Release SOP](docs/operations/RELEASE.md) — npm six packages, the `verify → preflight →
  desktop matrix → publish → publish-dsh → visibility → release` pipeline, the
  `release-prep → dry-run → release → back-merge` branch flow, checksums and rollback.
- [Desktop release](docs/operations/DESKTOP_RELEASE.md) — runtime packaging from release
  tarballs, installer asset names, unsigned install steps, and the signing/notarization plan.
- [Changelog](CHANGELOG.md) — release notes; the `## [vX.Y.Z]` section is the source of the
  GitHub Release body.

The current release line is **v0.1.1**: six npm packages at `0.1.1` (five lockstep packages
plus `@mebular/dsh-plugin`), and unsigned desktop installers for macOS, Windows and Linux.
From the next release on, `bump_version.sh` updates all six packages and
`verify:release-version` / the publish workflow enforce the same version. Signing,
notarization, and auto-update are not part of this release.
