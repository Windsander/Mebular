# Release

The release operations for this repository live under `docs/operations/`:

- [Release SOP](docs/operations/RELEASE.md) — npm six packages, the `verify → preflight →
  desktop matrix → publish → publish-dsh → release` pipeline, dry-run, checksums and rollback.
- [Desktop release](docs/operations/DESKTOP_RELEASE.md) — runtime packaging from release
  tarballs, installer asset names, unsigned install steps, and the signing/notarization plan.
- [Changelog](CHANGELOG.md) — release notes; the `## [vX.Y.Z]` section is the source of the
  GitHub Release body.

The current release line is **v0.1.1**: five lockstep npm packages plus the independently
versioned `@mebular/dsh-plugin@0.1.1`, and unsigned desktop installers for macOS, Windows
and Linux. Signing, notarization, and auto-update are not part of this release.
