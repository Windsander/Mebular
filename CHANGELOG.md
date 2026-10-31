# Changelog

All notable changes to Mebular are documented here.
Mebular uses a single-version umbrella: the seven npm packages (`core`, `service`, `skill`, `mcp`,
`fleet`, `memory-runtime`, `dsh-plugin`) share one release version. `@mebular/dsh-plugin` is an
isolated adapter published by its own npm job, and it follows the same unified release train.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Version headings carry the `v` prefix (`## [vX.Y.Z]`) because it is the release SSOT:
> the branch name (`release/vX.Y.Z`), the seven `package.json` versions, the locks, the MCP
> and sidecar version sources, and the Git tag must all agree with this section.

The GitHub Release body is extracted from this file: everything between the release's
`## [vX.Y.Z]` heading and the next `## [` heading. Keep that section self-contained.

## [v0.3.0] - 2026-10-30

Memory Runtime release. Mebular can now run recall, extraction, compaction and task
checkpoints for a host while keeping the same graph, signed events, sync and cloud.
The MCP surface stays compatible at 29 tools; every runtime capability is opt-in.

### Added

- **Memory Runtime sidecar** — a separate `@mebular/memory-runtime` process exposes `/memory-runtime/v1` (status, ingest, recall, context, checkpoints, compaction, self records, trace feedback and model orchestration). All durable writes go through the internal MCP capability API (`/internal/memory/v1`) into the existing graph and event log; no new event type or sync wire protocol is introduced.
- **Two access modes** — lightweight `mcp` (default) and immersive `immersive` (opt-in). Mode is device-local. Switching changes processing only: it does not migrate, copy, rewrite or delete nodes. Lightweight mode starts no sidecar, opens no sidecar port and creates no sidecar files.
- **Runtime object model** — `MemoryRecord` reuses existing entity/fact/episode/skill nodes; `Compact` is a derived graph summary with source IDs and stale detection; `ContextCheckpoint` has revisions and leases and always goes through capability; `SelfRecord` is shared per logical agent and hidden from ordinary queries. `RawChunk` and `RecallTrace` live only under `<home>/memory-runtime/`, never in the graph, events or sync.
- **Four model sources** — built-in `heuristic` rules (default, offline), curated local Qwen packs, host-provided `CandidateRecord`s, and one explicitly allowed OpenAI-compatible API. The runtime never reads host credentials, calls a host model or switches providers on its own; failures fall back to heuristic with `degraded` status and warnings.
- **Curated local Qwen** — Qwen 9B as the default pack, 27B for high quality and 4B for low-memory devices. Packs are downloaded and selected explicitly, verified by manifest/checksum, run through a loopback `llama-server`, and are never installed or updated silently. `mebular models list|status|install|import|select|remove|start|stop|test` manage them from the CLI.
- **Model credentials and API safety** — API keys are stored only as `env:`, `keychain:` or `file:` references; plaintext keys never enter config, graph metadata, events, logs, Console or status. URLs reject non-HTTPS endpoints (loopback HTTP excepted), userinfo and cloud-metadata addresses; file keys must be private.
- **Console Memory Runtime settings** — sidecar lifecycle, model source, curated pack download/selection, API configuration, raw capture, trace retention and local model status are available in Settings → 记忆运行时. Sidecar status, active model, degraded reasons and counts are exposed without secrets.
- **Internal-object governance** — `compact`, `context_checkpoint`, `self_record` and defensive `raw_chunk`/`recall_trace` are hidden from default `memory_*` results, graph traversal and the Console memory list; `includeInternal=1` is admin-only. `memory_delete`/`memory_archive` reject internal objects and leave them to capability admin endpoints.
- **DSH Memory Runtime bridge** — opt-in `memoryRuntime` with recall on the first step of a new human turn, batched event ingest with retries and idempotency, compaction checkpoints, optional tool hiding with a governance allowlist, and optional idle maintenance using the current DSH session model. When disabled it registers no listener, timer or request.
- **Hermes MemoryProvider and companion** — `integrations/hermes/mebular-memory` adds automatic recall and turn/compaction ingest to Hermes while leaving built-in `MEMORY.md`/`USER.md` active and untouched. The optional `mebular-companion` uses Hermes `ctx.llm` to submit host candidates, separately from the single external-provider slot.
- **OpenChamber / OpenCode integration** — Mebular's MCP path writes only the shared OpenCode `mcp.servers.mebular` entry and never OpenChamber's managed config. The opt-in `@mebular/opencode-plugin` adds request-only `<mebular_memory trust="untrusted">` recall, event ingest and compaction checkpoints for OpenCode >= 2.2; OpenChamber native memory is detected read-only and is never imported, replaced or dual-written.
- **Documentation** — new English/Chinese [Memory Runtime guide](docs/guides/MEMORY_RUNTIME.md) covering modes, model sources, sidecar discovery, local data, privacy, troubleshooting and the 0.2 upgrade path; Hermes and OpenChamber integration guides, and an updated DSH guide covering modes, model sources, tool surface and boundaries.

### Changed

- **Default behaviour is unchanged** — a fresh or upgraded install stays in lightweight MCP, uses heuristic rules, captures no raw conversation and calls no model. Existing MCP/CLI/Console read paths keep their 0.2 results.
- **MCP surface is frozen** — the 29 `memory_*` / `task_*` tools keep their names and semantics; no `runtime_*` MCP tools are added. Runtime capability is HTTP-only, and CLI `mebular tools` still reports the same surface.
- **Memory Runtime configuration is device-local** — MCP only owns `memoryRuntime.*` lifecycle keys; sidecar settings (model packs, API credentials, raw/trace retention) live in `<home>/memory-runtime/config.json` and do not enter shared memory or sync. SelfRecord and Checkpoint always go through capability with logical `agentId` filtering.
- **Internal objects are filtered by default** — default queries, graph traversal and the Console memory list skip `metadata.internal=true` and reserved `__*` namespaces. Older clients see ordinary 0.2 data.
- **OpenChamber reuse** — OpenChamber is treated as an OpenCode host: one global MCP entry, read-only native-memory detection, and no writes to `opencode.managed.json` or per-instance copies.
- **Release train** — all seven npm packages, the desktop app and the isolated DSH plugin are aligned at `0.3.0`.

### Fixed

- **OpenCode JSON-encoded content** — message text arrived as a JSON string (for example `"\"Remember ...\""`), so recall and heuristic extraction could miss ordinary memories. The plugin now unwraps the encoded content before building queries and ingest chunks.
- **Runtime credential and URL handling** — model base URLs are normalized and unsafe forms rejected before a request; key files with group/other read permission are refused; status reports only `configured`/`source`, never key material or model response bodies.
- **DSH runtime auth and delivery** — bearer 401/403 and retryable ingest failures are surfaced as warning/status instead of being silently dropped; retries reuse one `requestId`/`Idempotency-Key`, and dispose cancels pending backoff.
- **Internal-object leakage** — runtime nodes are defensively excluded from default memory queries, history, profile, skills, graph and Console lists even if they are written directly to the graph.

### Verification

- **Acceptance report** — [0.3.0 Memory Runtime acceptance report](docs/quality/0.3.0-memory-runtime-acceptance.md) records recall quality, security and performance for a real sidecar with a fake capability: heuristic only, no model, no external network. The matrix covers gist-only broad recall, detail expansion, conflicts, cross-device raw degradation, silence, budgets, security boundaries and bounded resources.
- **Three-host E2E** — real DSH, Hermes and OpenChamber/OpenCode adapters run against a real `/memory-runtime/v1`, real capability API and real graph with temporary homes, heuristic extraction and no real LLM. The recorded run is 113/113 DSH, 35/35 Hermes and 38/38 OpenCode checks; see [`tests/integration/host-e2e/README.md`](tests/integration/host-e2e/README.md) for covered paths and explicit boundaries.
- **Sidecar and host suites** — sidecar, inference, Console, DSH, Hermes and OpenChamber coverage lives in `packages/memory-runtime/tests`, `tests/mcp`, `tests/console`, `tests/dsh`, `tests/opencode-plugin` and `tests/integration/host-e2e`.
- **Seven-package release train** — six lockstep packages (`core`, `service`, `skill`, `mcp`, `fleet`, `memory-runtime`) plus the isolated `dsh-plugin` job share `0.3.0`; verify produces seven tarballs, and the visibility gate checks all seven packages and `dist-tags.latest`.
- **Docs** — `npm run check:docs`, `npm run check:i18n` and `npm run check:cleanliness` pass.

### Notes

- **No migration** — 0.2 nodes, events, namespaces, tags and IDs are read as legacy data and are not rewritten. Runtime nodes are ordinary nodes; older peers can store them but do not show them in default queries.
- **Rollback** — returning to 0.2 keeps the graph and data intact. Internal nodes remain stored but hidden, and local `<home>/memory-runtime/` files are ignored by older code.
- **Scope limits** — 0.3 remains one cloud and one user. `agentId` is an assertion, not authentication; SelfRecord/Checkpoint isolation is logical, not cryptographic; `memory.read` is cloud-wide and namespace ACLs are not included. Deletion remains cooperative, so an already-synced copy on an offline peer may survive until reconnect.
- **No bundled model** — local Qwen packs are explicit downloads with their own licenses. No model, API key or cloud raw data is shipped or enabled by default.

## [v0.2.4] - 2026-10-29

Agent adoption and Skill deployment release. All six npm packages and the desktop app
ship as `0.2.4`; no runtime protocol or data-format changes are included.

### Added

- **Skill as a deployment artifact** — `connectClient`, App initialization, daemon startup, `mebular init`, and the `fleet --daemon` service path now ensure `mebular-memory` and `mebular-tasks` for detected clients. Installs include the `mcp/` fragments and a managed manifest.
- **Settings · Common “Auto repair”** — one-click, confirmed repair of detected assistant MCP entries and Skills. Failures are reported per client with redacted, expandable details.
- **All folder-based Agent targets** — OpenChamber/OpenCode, Hermes, Claude Code, Cursor and DeepSeek Harness each get their own detected global Skill directory; Claude Desktop remains a zip/UI upload flow.
- **Agent routing hints** — all 29 MCP tools now start their descriptions with “何时用”, and the MCP server publishes global `instructions` for routing and memory/task discipline.
- **SETUP runtime detection** — the agent playbook recognizes `runtime.json` + `/healthz` first, so an App runtime without a PATH CLI is not treated as uninstalled.

### Changed

- User-modified or unmarked Skills are preserved by default; only an explicit “Auto repair” force-overwrites the managed client assets.
- The locked settings page no longer duplicates “New cloud / Join cloud”; those actions stay in the top bar, while the settings page keeps diagnostics and guidance.
- Dependency maintenance: electron-builder and `@modelcontextprotocol/server` bumps.

### Fixed

- Managed-Skill cleanup now rejects absolute paths, drive letters, backslashes, empty segments, and `.`/`..` segments, preventing force repair from deleting files outside the Skill directory.
- `repair-api` Windows CI uses a real `.cmd` test double; `runtime.json` parsing no longer depends on Node being on PATH.

### Verified

- PR #288 required checks: 8/8 passed, including Windows, build/test/lint, desktop smoke, WAN NAT, semantic recall, and real DSH E2E minimum/latest/Node 22.
- PR #290 required checks: 8/8 passed; target matrix covers OpenChamber/OpenCode, Hermes, Claude Code, Cursor and DSH.
- Local gates for the target matrix: `verify:mcp:skill`, `check:docs`, `check:i18n`, and the target-matrix Jest suites.
- Packaging dry-run [run 40829880252](https://github.com/Windsander/Mebular/actions/runs/40829880252) passed: verify + 6 tarballs, macOS/Windows/Linux installers, and real DSH E2E minimum/latest/Node 22.
- Real Agent E2E: OpenCode 2.0.29 with DeepSeek Flash loaded `mebular-memory`, called `memory_write` and stored a preference; a new session then called `memory_query`/`memory_profile` and recalled it. Temporary HOME only; real user data untouched.
- App 0.2.4 packaged runtime boots and reports `0.2.4`; auto-install requires an initialized cloud and was validated through the packaged runtime + OpenCode path.

## [v0.2.3] - 2026-10-28

Identity-focused maintenance release. All six npm packages and the desktop app
ship as `0.2.3`; no runtime protocol or data-format changes are included.

### Changed

- **Identity contract** — `<storagePath>.identity.json` is now the sole authority for `deviceId` / `deviceName`. New configs write neither field, and all CLI, App, DSH and fleet read paths resolve the device identity from the identity file.
- **Transparent legacy recovery** — a valid identity with legacy `config.deviceId` / `deviceName` values is backed up to `config.json.identity-legacy.bak`, the stale fields are removed atomically, and startup continues without user interaction.
- **Shared preflight** — `init`, provision create/restore/join, and runtime startup use the same `home-identity` contract. Invalid or inconsistent identity is reported as `identity_invalid` / `identity_store_occupied` instead of an opaque `unreachable`.
- **No new App/DSH UI** — the common repair path is automatic; only an invalid identity fails closed.

### Fixed

- **`mebular init` identity handling** — an existing identity wins; conflicting `--device-id` is rejected; a root identity with a missing or invalid user master key now fails with `IDENTITY_TRUST_ROOT_MISSING` / `MASTER_KEY_INVALID` before touching config. Delegated identities do not require a root key.
- **No silent rekey** — a missing identity over a non-empty store fails with `IDENTITY_STORE_OCCUPIED`; an existing identity with a missing trust root fails closed and never generates a new master key.
- **Join safety** — `provisionJoinInto` and `fleet.joinWithToken` refuse to issue a new identity over existing store data.
- **Fleet and status consistency** — profile, fleet, admin and CLI status paths derive device identity from the identity file instead of legacy config fields.

### Verified

- Full Jest — **210 suites / 2153 tests passed**.
- Runtime coexistence — **13 scenarios / 153 checks passed**.
- Real DSH E2E — minimum, latest and Node 22 minimum passed.
- `verify:console` / `verify:onboarding` / `verify:daemon` / `verify:config` passed.
- Packaging dry-run — [run 40649283781](https://github.com/Windsander/Mebular/actions/runs/40649283781) passed: verify + 6 tarballs, macOS/Windows/Linux installers, and real DSH E2E minimum/latest/Node 22 minimum.

## [v0.2.2] - 2026-10-27

Patch release focused on DeepSeek Harness Desktop integration. All six npm
packages and the desktop app ship as `0.2.2`; no runtime protocol or data format
changes are included.

### Changed

- **DSH panel header** — the header now matches the DSH 52px top strip, keeps a safe left inset, uses compact icon actions for Open Console/Refresh, and is a draggable window region with no-drag action buttons.
- **DSH cloud actions** — the embedded Console now exposes its cloud actions in a compact upper-right bar: New Cloud/Join Cloud while locked, then Join Cloud/Invite Device after initialization. The duplicated onboarding card is hidden in the embed.
- **DSH runtime hint** — the repeated keep-running row is removed from the plugin panel; shared-runtime service configuration remains in Console settings.

### Fixed

- **DSH Desktop Console white panel** — `?embed=dsh` now allows the exact `dsh-app://app` Desktop ancestor in addition to loopback HTTP ancestors; ordinary Console requests keep `frame-ancestors 'none'`.
- **DSH locked-state navigation overlap** — the redundant locked banner no longer covers the right-side Console navigation.
- **DSH collapsed-sidebar overlap** — the panel header reserves DSH's floating sidebar controls.
- **DSH action wrapping** — compact cloud-action buttons keep their normal height and never wrap at narrow panel widths.
- **DSH status alignment** — the status dot and header actions share the DSH top-strip vertical center.

### Verified

- PR #275 required checks: 8/8 passed, including build/test/lint, real DSH E2E minimum + latest, desktop smoke, Windows CI, and WAN NAT isolation.
- Relevant local Jest suites: 82/82 passed.
- `npm run check:docs`: 7/7 passed.
- `verify-dsh-plugin`: 176/176 passed.
- **Packaging dry-run** — [run 40526024891](https://github.com/Windsander/Mebular/actions/runs/40526024891) passed: verify + 6 tarballs, macOS Universal DMG, Windows NSIS, Linux AppImage/deb, and real DSH E2E minimum/latest/node22 all green.

## [v0.2.1] - 2026-10-27

### Fixed

- **First-run wizard module resolution** — the packaged desktop renderer now resolves the shared assistant-status module from `Resources/node_modules/@mebular/core` with a development fallback. This restores **Start deployment** and **Skip wizard** on macOS, Windows, and Linux (#270).
- **Windows service loading and provider startup** — desktop service loaders now use `file:` URLs, and `.cmd`/`.bat` runtime providers launch through the Windows shell (#272).
- **Custom-home service execution** — service descriptors now carry `ELECTRON_RUN_AS_NODE=1`, so custom-home service installation starts a Node daemon instead of another App instance (#272).
- **Standalone MCP asset resolution** — Console and locale assets now resolve correctly for both core-internal and standalone `@mebular/mcp` layouts, including the `fleet quickstart --daemon` path (#272).

### Verified

- **Full Jest** — 207 suites / 2113 tests passed.
- **Runtime coexistence** — 13 scenarios / 153 checks passed.
- **Real DSH E2E** — 9/9 scenarios, 210 checks passed on both DSH `0.2.1-rc.2` and npm `latest`; real Chrome, Console, and MCP calls included, including the daemon-down offline panel and the separate missing-runtime install guide.
- **Packaged and standalone smoke** — published runtime smoke (7 checks) and standalone MCP health/Console/locale/embed-info all passed.

## [v0.2.0] - 2026-10-27

v0.2.0 is the shared-runtime release. The Mebular App and the DSH Plugin are now
two equal entry points to **one local Mebular runtime**: one daemon, one
`mebular-serve`, one active profile/home and one data root. Runtime ownership,
provider discovery, current-version selection, service lifecycle, update checks
and upgrades live outside both entry points instead of being duplicated by the
desktop app and the DSH plugin.

All six npm packages and the desktop app ship as `0.2.0`. `@mebular/dsh-plugin`
still has its own npm publish job, but follows the same release train and reads
the pinned shared-runtime version from its own package version at runtime.

### Added

- **Shared Runtime Supervisor** — `@mebular/mcp` now owns one supervisor for
  profile/cloudRoot/home resolution, health and instance checks, `active.lock`,
  cross-entry start locks, provider discovery, service precedence, child
  ownership, `runtime resolve|ensure|status|supervise` and a stable JSON result
  contract. App and Plugin no longer start private daemons.
- **Provider registry** — non-sensitive App/CLI/shared runtime providers are
  recorded in `runtime-providers.json` with atomic writes and locking. App
  registration is exclusive for `kind:app`, so moving the App cannot leave a
  stale provider path.
- **Shared current pointer** — `runtime/current.json` records the installed
  shared runtime version/path/provider/owner. Provider discovery and service
  ownership prefer current; a missing/corrupt current falls back safely.
- **Shared service lifecycle** — one `mebular-serve` per home/cloudRoot, with
  runtime path/version/provider/owner metadata in the manifest. New CLI commands
  cover service install/status/restart/uninstall and shared current operations.
  Entry uninstall never removes the shared runtime, service, provider records or
  data.
- **Plugin-only bootstrap** — users can install a pinned shared runtime from the
  DSH panel with one explicit action: download → verify → atomic install →
  provider registration → init → start → Console onboarding. Retry, reinstall,
  copyable manual command and “check again” are available after failures; old
  runtimes are retained for rollback.
- **Update check and controlled upgrade** — fixed official npm stable source,
  24h check throttle, shared update/upgrade state and locks, prompted/skipped
  version sharing and user-visible `Update / Later / Skip` prompts in the App
  and DSH Plugin. No silent install or upgrade.
- **Coexistence E2E and docs** — `scripts/verify-runtime-coexistence.mjs`, the
  shared runtime ADR and the operator guide cover cold starts, single-daemon
  behaviour, install/current/provider atomicity, service ownership, update and
  upgrade locks, rollback and entry-uninstall preservation.

### Changed

- **DSH Plugin default remains attach** — installing the plugin still does not
  start or download Mebular. `managed`/`auto` are explicit opt-ins; managed
  startup now goes through `runtime supervise` instead of spawning
  `mebular serve` directly. The effective daemon URL is resolved from the
  shared runtime and used consistently by the Console iframe, MCP bridge and
  panel.
- **App runtime integration** — App daemon/service/quit/profile-switch paths
  route through the shared supervisor/service layer. The App main flow, wizard
  and tray are unchanged; the only new App interaction is the incremental
  runtime update prompt. App child and service upgrades stop/restart only what
  the App owns.
- **Service ownership** — cloud-switch, legacy service migration, Console
  service actions and update/upgrade use shared current/service descriptors
  instead of writing App descriptors over a shared service.
- **Plugin configuration** — `lifecycle: attach|managed|auto`,
  `runtime: auto|external`, `persistence: child|service` and
  `bootstrap: prompt|never` are supported. Explicit `daemonUrl` remains
  attach-only, and plugin-only installs are explicit.
- **Release engineering** — the Plugin derives its pinned runtime version from
  its own `package.json` at runtime; release bumps no longer require editing
  plugin source. Publish `@mebular/core` before `@mebular/dsh-plugin`.

### Fixed

- **Installed-core service resolution** — the installed `@mebular/core` now
  resolves its bundled `@mebular/service` when the separate npm package is not
  present, so plugin-only runtime service status is not misreported as
  `service_unknown`.
- **Provider path replacement** — App path changes atomically replace the old
  `kind:app` record instead of leaving a stale provider that could start an old
  runtime.
- **Supervise cleanup** — plugin disposal uses a full cleanup window covering
  the supervisor's child SIGTERM/SIGKILL budget and waits for cleanup; a failed
  reinstall restores the old runtime/provider and restarts the old owned daemon.
- **Update prompt semantics** — `/mebular/embed-info` is read-only; prompted is
  persisted only after the plugin panel actually renders the banner, so sidebar
  polling cannot suppress another entry's prompt.
- **Cross-platform CI contracts** — Windows test paths and file-mode
  expectations, plus DSH E2E contracts for the new `download_required` and
  update fields, are aligned.

### Breaking / migration notes

- DSH Plugin `managed` with an explicit `daemonUrl` is now attach-only; use the
  shared runtime configuration instead of mixing a pinned URL with managed
  startup.
- The old `managed_cli_missing` reason is replaced by `download_required`; the
  panel now offers the pinned shared-runtime install flow.
- Existing legacy `mebular-serve` manifests without runtime metadata are
  migrated only when safe; ambiguous legacy labels fail safe instead of being
  overwritten.
- App/CLI/service daemons that are already running are attached; the Plugin
  does not stop or upgrade an external daemon.

### Verified

- **All tests** — 206 Jest suites / 2105 tests.
- **Runtime coexistence E2E** — 13 scenarios / 153 checks, using real
  `mebular runtime` CLI processes, a real supervisor/service installer and fake
  HTTP daemons/npm.
- **DSH gates** — `verify:dsh-plugin` 175 checks; real DSH Web E2E minimum and
  latest rows in CI; docs and i18n checks.
- **CI** — macOS build/test/lint, Windows build/test/lint, desktop smoke, DSH
  E2E minimum/latest, WAN NAT isolation and semantic recall all pass on the
  feature PR CI; release packaging is checked again on the release branch.

### Desktop installers (unsigned)

- Rebuilt installers for macOS (Universal DMG), Windows (NSIS x64) and Linux
  (AppImage + deb x64). `SHA256SUMS.txt` is published with them; verify it before
  installing.
- v0.2.0 is **unsigned and not notarized**. On macOS, right-click the app and
  choose **Open** (or **System Settings → Privacy & Security → Open Anyway**).
  On Windows, choose **More info → Run anyway**.
- **No auto-update** in this release. Signing, notarization and auto-update
  remain follow-up work.

### Install

- Desktop: download from [GitHub Releases v0.2.0](https://github.com/Windsander/Mebular/releases/tag/v0.2.0).
- CLI and server: `npm install -g @mebular/core@0.2.0`.
- DSH plugin: `dsh plugin --profile web add @mebular/dsh-plugin@0.2.0`
  (attach if the App/CLI is running; otherwise use the panel's explicit
  shared-runtime install).

### 中文摘要

- **共享 runtime** —— App 与 DSH Plugin 现在是同一套本机 Mebular runtime 的两个入口：
  一个 daemon、一个 `mebular-serve`、一个当前 profile/home、一份数据。Supervisor、provider、
  current、启动锁、service、更新与升级都不再由两个入口各自维护。
- **Plugin-only 安装** —— DSH 面板可按需安装固定版本共享 runtime：下载 → 校验 → 原子安装 →
  provider → init → 启动 → Console onboarding，一次点击完成；失败可重试、重装、复制手动命令、
  重新检测，旧 runtime 保留。
- **更新** —— App 与 Plugin 启动时共享 24h 节流检查；只提示，不静默安装；`更新 / 稍后 /
  跳过此版本` 通过共享 update/upgrade 锁与状态去重。
- **服务所有权** —— `mebular-serve` 指向共享 current，manifest 记录 runtime/version/owner；
  卸载入口不删除 runtime、service、provider 或数据。
- **兼容性** —— Plugin 默认仍是 `attach`；`managed`/`auto` 才启动；显式 `daemonUrl` 只
  attach；旧 `managed_cli_missing` 改为 `download_required`；legacy service 迁移采取
  fail-safe。
- **验证** —— 206 suites / 2105 tests；runtime coexistence 153 checks；DSH E2E、Windows CI、
  WAN NAT、semantic recall 全部通过。桌面安装包仍为 unsigned，不含自动更新。

## [v0.1.2] - 2026-10-25

v0.1.2 is a DSH usability release on the v0.1.x line. It makes Mebular's availability
visible in the DSH sidebar and to the Agent, and documents the state contract shared by the
desktop app, Console, CLI, MCP clients and DSH. All six npm packages and the desktop app
ship as `0.1.2`; the DSH adapter stays code-isolated but follows the same release train, so
there is no DSH-only release. Desktop installers remain **unsigned**, and auto-update is
not part of this release.

### Added

- **DSH sidebar status dot** — the Mebular sidebar icon now carries a status dot even while
  the panel is closed: green when the daemon is connected, amber while starting or degraded,
  red when offline, and gray before the first check returns. Hover text states the current
  status; color is never the only signal.
- **Agent-visible daemon status in DSH** — the host registers one DSH system-prompt section,
  `mebular:status`. While the daemon is `up` its text is empty, so it adds no prompt tokens.
  When the daemon is `down`, the Agent is told that Mebular memory is unavailable, asked to
  start the Mebular app or run `mebular serve`, and told not to claim memory is available.
  `starting`, `managed_cli_missing` and `managed_start_failed` carry their own short recovery
  text. The hint is derived from the same lifecycle snapshot as the MCP bridge, not a second
  poller, and DSH is notified only when the text changes.
- **Shared surface state contract** — `docs/architecture/SURFACES.md` defines the shared
  status vocabulary, capabilities, stable reason codes and recovery paths, with a surface
  matrix for the Desktop App, Console, CLI, MCP clients and DSH. It records known gaps
  instead of adding new wire fields.

### Changed

- **One poll for the DSH icon and panel** — the DSH client keeps a module-level embed-info
  store; the sidebar icon and the panel read the same status and share one polling loop.
  The panel remains the detailed view, and both recover automatically when the daemon comes
  back.
- **Release engineering** — `scripts/bump_version.sh` now bumps all six release packages,
  both lockfiles, the desktop `APP_VERSION` and the single MCP version source in
  `packages/mcp/src/version.mjs`. `npm run verify:release-version` checks the same SSOT
  locally and in the publish workflow. The npm visibility gate polls all six packages and
  `dist-tags.latest` before creating a GitHub Release, and the release SOP is now
  `release-prep/vX.Y.Z` → packaging dry-run → `release/vX.Y.Z` → back-merge `main` →
  branch cleanup.
- **Single-version umbrella** — all six npm packages share one release version.
  `@mebular/dsh-plugin` keeps its code isolated in `packages/dsh-plugin` and is published by
  its own npm job, but it follows the unified release train; no release ships the DSH plugin
  alone.

### Verified

- **Real DSH Web session** — with the daemon up, the sidebar dot is green and the shared
  Console loads in the panel. Stopping the daemon turns the dot red and shows the offline
  panel guidance; starting it again returns the dot to green and remounts the MCP tools
  without restarting DSH. The `mebular:status` prompt is empty while the daemon is `up`,
  switches to the down guidance when it stops, and clears again after recovery.

### Desktop installers (unsigned)

- Rebuilt installers for macOS (Universal DMG), Windows (NSIS x64) and Linux (AppImage + deb
  x64). `SHA256SUMS.txt` is published with them; verify it before installing.
- v0.1.2 is **unsigned and not notarized**. On macOS, right-click the app and choose
  **Open** (or **System Settings → Privacy & Security → Open Anyway**). On Windows, choose
  **More info → Run anyway**.
- **No auto-update** in this release. Signing, notarization and auto-update remain follow-up
  work.

### Install

- Desktop: download from [GitHub Releases v0.1.2](https://github.com/Windsander/Mebular/releases/tag/v0.1.2).
- CLI and server: `npm install -g @mebular/core@0.1.2`.
- DSH plugin: `dsh plugin --profile web add @mebular/dsh-plugin@0.1.2` (keep the Mebular app
  or `mebular serve` running; the plugin uses HTTP MCP).

### 中文摘要

- **DSH 侧边栏状态点** —— 面板关闭时图标也带状态点：绿=已连接，琥珀=启动中/降级，
  红=未运行，灰=首次检查尚未返回；悬停显示当前状态，颜色不是唯一信息。
- **Agent 可见状态** —— DSH 注册唯一的 system prompt section `mebular:status`。daemon
  `up` 时文本为空，不增加 token；`down` 时明确告诉 Agent 记忆不可用、请用户启动 Mebular
  App 或运行 `mebular serve`，且不得声称记忆可用；`starting`、`managed_cli_missing`、
  `managed_start_failed` 各有简短恢复提示。提示复用 MCP bridge 的同一份生命周期快照，
  不新增轮询，只在文本变化时通知 DSH。
- **共享状态契约** —— 新增 `docs/architecture/SURFACES.md`，统一状态词汇、能力、稳定
  reason 码与恢复路径，并给出 Desktop App / Console / CLI / MCP / DSH 的 surface matrix；
  只记录已知缺口，不新增 wire 字段。
- **图标与面板共用一次轮询** —— DSH client 使用模块级 embed-info store，侧边栏图标与面板
  读取同一状态、共用同一个轮询；daemon 恢复后两者自动恢复。
- **真实 DSH Web 验证** —— daemon 运行时为绿点并加载共享 Console；停止 daemon 后变红点并
  显示离线引导；重新启动后恢复绿点，MCP 工具自动重挂，无需重启 DSH。system prompt 在
  `up` 时为空，掉线时切换为恢复提示，恢复后再次清空。
- **版本统一** —— 六个 npm 包与桌面 App 全部为 `0.1.2`。DSH 适配器代码隔离在
  `packages/dsh-plugin`、由独立 npm job 发布，但版本随统一 release train；不存在
  DSH-only release。
- **桌面安装包** —— 三平台 unsigned 安装包，附 `SHA256SUMS.txt`；未签名、未公证，也不包含
  自动更新。签名、公证与自动更新留待后续版本。


## [v0.1.1] - 2026-10-25

v0.1.1 is a maintenance release for the v0.1.0 line. It fixes the DSH attach MCP bridge
lifecycle, aligns the six published npm packages at `0.1.1`, and refreshes the install
documentation. The desktop installers are rebuilt and remain **unsigned**; code signing,
notarization and auto-update are not part of this release.

### Fixed

- **DSH attach MCP bridge** — the bridge now mounts only while the daemon health is `up`.
  When the daemon is down, no `mcp__mebular__*` tools are registered, so calls no longer
  wait silently or fail after a 60-second timeout. A daemon disconnect disposes the client
  fiber and unregisters its tools; when the daemon recovers, the bridge remounts
  automatically without restarting DSH. `managed` mode does not mount while the child is
  `starting`, and does not mount after `managed_start_failed` / `managed_cli_missing`.
  The panel and logs now state that MCP tools are temporarily unavailable and why.
- **CI `verify:daemon`** — removed a `JOIN_READY` race in the daemon verification, so the
  gate is deterministic. This is an internal test fix, not a user-facing feature.

### Changed

- **Six npm packages at `0.1.1`** — `@mebular/core`, `@mebular/service`, `@mebular/fleet`,
  `@mebular/mcp`, `@mebular/skill`, and `@mebular/dsh-plugin`. The five lockstep packages
  remain lockstep; the DSH plugin keeps its own version line and is aligned at `0.1.1` for
  this release.
- **Install documentation** — README, quickstart, DSH integration guide, desktop release
  guide and release SOP now point at `0.1.1` and the v0.1.1 installers.

### Desktop installers (unsigned)

- Rebuilt installers for macOS (Universal DMG), Windows (NSIS x64) and Linux (AppImage + deb
  x64). `SHA256SUMS.txt` is published with them; verify it before installing.
- v0.1.1 is **unsigned and not notarized**. On macOS, right-click the app and choose
  **Open** (or **System Settings → Privacy & Security → Open Anyway**). On Windows, choose
  **More info → Run anyway**.
- **No auto-update** in this release. Signing, notarization and auto-update remain follow-up
  work.

### Install

- Desktop: download from [GitHub Releases v0.1.1](https://github.com/Windsander/Mebular/releases/tag/v0.1.1).
- CLI and server: `npm install -g @mebular/core@0.1.1`.
- DSH plugin: `dsh plugin --profile web add @mebular/dsh-plugin@0.1.1` (keep the Mebular app
  or `mebular serve` running; the plugin uses HTTP MCP).

### 中文摘要

- **DSH attach MCP bridge 修复** —— 仅在 daemon 健康状态为 `up` 时挂载；daemon down 时不注册
  任何 `mcp__mebular__*` 工具，不会静默等待或 60s 超时。掉线时 dispose 并注销工具，daemon
  恢复后自动重挂，无需重启 DSH。`managed` 在 `starting`、`managed_start_failed`、
  `managed_cli_missing` 时不提前挂载；面板和日志会明确说明 MCP 工具暂不可用及原因。
- **六个 npm 包统一 `0.1.1`** —— 五个 lockstep 包加 `@mebular/dsh-plugin`；插件仍保留独立
  版本线。
- **安装文档已更新** —— README、快速上手、DSH 集成说明、桌面发布指南与发布 SOP 均指向
  `0.1.1`。
- **CI `verify:daemon`** —— 修复 `JOIN_READY` 竞态，仅为内部测试稳定性，不是用户功能。
- **桌面安装包** —— 三平台 unsigned 安装包重建，附 `SHA256SUMS.txt`；未签名、未公证，也不
  包含自动更新。

## [v0.1.0] - 2026-10-24

Initial release. Five lockstep packages at `0.1.0`: `@mebular/core`, `@mebular/service`,
`@mebular/fleet`, `@mebular/mcp`, `@mebular/skill`; the root bundle `@mebular/core`
provides both the `mebular` and `fleet` CLIs. `@mebular/dsh-plugin@0.1.0` ships on its own
version line. The release also includes unsigned desktop installers for macOS (Universal
DMG), Windows (NSIS x64) and Linux (AppImage + deb x64). Each installer bundles Electron and
a Mebular runtime installed from the same verified release tarballs, so it needs neither a
local Node.js install nor a repository checkout. `SHA256SUMS.txt` is published with the
installers.

### Highlights (EN)

- **Onboarding v2: one-click to a locked console** — in the desktop app, **Start deployment** starts the local daemon and connects the AI assistants already installed on the machine, then opens the locked main console. The first device creates a Cloud with a Cloud name + device name; later devices join an existing Cloud with a one-time token + device name. Initialization runs in the same daemon process and on the same page: no restart, no reload, and the console unlocks immediately. Once a Cloud is current, the top bar switches from **Create new Cloud / Join existing Cloud** to **Invite device / Join Cloud**.
- **MCP is reachable before setup** — the HTTP `/mcp` facade accepts `initialize`, `tools/list` and `prompts/list` while the instance is UNINITIALIZED. `tools/call` returns the stable `NOT_INITIALIZED` business error, and the same MCP session recovers after create/join without restarting the daemon or rewriting assistant configuration.
- **Graph memory with validity windows** — entity / fact / episode / skill / meta nodes, typed edges, and facts that know when they are true (`validFrom` / `validTo`), so recall can be filtered by time instead of returning a flat queue.
- **Verifiable, tamper-evident history** — every write is an Ed25519-signed, content-addressed event; who changed what is always auditable, and deletes are tombstones rather than silent erasure.
- **Offline-first incremental sync** — vector clocks exchange only what the peer is missing; devices converge on reconnect with no central service, and direct / relay / hole-punch transitions plus automatic bridges are handled for you.
- **One machine, one node, one daemon** — `mebular serve` is the sole holder of identity, network and trust; fleet and agents are local clients. Device enrollment uses a QR code or a short-lived single-use token, and trust is a bounded certificate chain to the user master key, so the master key can stay offline.
- **Back up the root key** — the user master key is the trust root and never leaves the device. Back up `~/.mebular/user-master-key.json` offline after the first setup. v0.1.0 has no master-key rotation or re-anchoring; if the key is lost or stolen, there is no in-product recovery path (see [`LIMITATIONS.md`](https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md)).
- **Cloud and device names** — give the current Cloud and your own device readable names; changes sync as signed policy metadata to every admitted device, with blocked-author filtering and local duplicate-name warnings.
- **Compact invite panel** — QR, token, TTL and expiry in one small panel; regenerating invalidates the old token, and the panel closes with a top-right X.
- **In-app desktop confirmations** — regenerate, rollback and remove use the console's own confirmation dialog; quitting uses a CRT-styled window instead of a native dialog. Tray navigation switches the loaded console in place instead of reloading it.
- **MCP SDK 2.3.1 security upgrade** — the vulnerable 2.0.0 production dependency is replaced; `npm audit --omit=dev` is clean, and the real MCP client handshake is covered by tests.
- **One MCP surface for any assistant** — 29 tools (13 memory + 16 task) over stdio and Streamable HTTP, with OAuth / bearer hardening, per-tool scopes and the same registry behind the CLI and the console.
- **Fleet task collaboration across devices** — tasks are a DAG inside shared memory (`causedBy`, cycle-free): dispatch, claim, progress, result and negotiation (clarify / counter / accept / reject), with the memory channel as the only remote surface — no general remote RPC.
- **Distributed star-map console** — the main console shows every device in the Cloud, with shared-subscription base edges, hover task-domain lanes (blue = can send, gold = can receive, gray = unreachable), and live fleet traffic driven by real task events. Offline or no-shared-subscription devices stay gray dashed; online shared edges are subdued and emit a low-frequency sound-wave pulse that fades back into the base edge, so the stars remain the visual focus.
- **Assistant onboarding in one pass** — 7 built-in descriptors (OpenChamber, Hermes, OpenCode, Claude Code, Claude Desktop, Cursor, DSH) plus a custom snippet path; each goes through detect → apply → verify, and the desktop one-click flow can connect installed assistants before a Cloud exists.
- **DSH plugin on its own version line** — `@mebular/dsh-plugin` brings the same memory and task graph into DeepSeek Harness over HTTP MCP. Its sidebar Mebular panel loads the existing console in place through `?embed=dsh` (loopback only); it is not a second console. The host discovers the daemon by `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331`, and mounts the official MCP client against the same origin. The app stays the control plane; the plugin ships 0.1.0 alongside this release but outside the five-package lockstep.
- **Portable by design** — Canonical Memory Format (CMF) v1 with adapters for Obsidian, log journals, json-memo and Hermes, plus installable memory / task skills so the behaviour layer travels with the data.

### Desktop installers (unsigned)

- **Download** — from [GitHub Releases v0.1.0](https://github.com/Windsander/Mebular/releases/tag/v0.1.0):
  `Mebular-0.1.0-universal.dmg` (macOS), `Mebular-Setup-0.1.0.exe` (Windows x64),
  `Mebular-0.1.0-x86_64.AppImage` and `Mebular-0.1.0-amd64.deb` (Linux x64).
- **Verify first** — compare every file with `SHA256SUMS.txt` before installing
  (`shasum -a 256 -c SHA256SUMS.txt` on macOS, `sha256sum -c SHA256SUMS.txt` on Linux).
- **macOS Gatekeeper** — the DMG is unsigned. On first launch, right-click the app and choose
  **Open**, or use **System Settings → Privacy & Security → Open Anyway**.
- **Windows SmartScreen** — the NSIS installer is unsigned. Choose **More info → Run anyway**.
- **Self-contained runtime** — Electron and the Mebular runtime are inside the package; no
  Node.js or repository checkout is required. The five `@mebular/*` packages come from the
  same verified tarballs used for the npm release.
- **Scope** — signing, notarization and auto-update are not part of v0.1.0; they are planned
  for follow-up releases.

### 亮点（中文）

- **Onboarding v2：一键进入锁定控制台** —— 桌面 App 点「开始部署」后，启动本机守护、自动接入本机已装的 AI 助手，然后进入锁定主控制台。第一台设备填忆云名 + 设备名新建忆云；后续设备用一次性令牌 + 设备名加入已有忆云。初始化在同一个守护进程、同一个页面内完成：不重启、不刷新，控制台立即解锁。有当前忆云后，顶栏从「新建忆云 / 加入忆云」恢复为「邀请设备 / 加入忆云」。
- **未初始化也能连上 MCP** —— HTTP `/mcp` 在 UNINITIALIZED 阶段即可完成 `initialize`、`tools/list` 与 `prompts/list`；`tools/call` 返回稳定的 `NOT_INITIALIZED` 业务错误。建新 / 加入忆云后，同一个 MCP 会话自动恢复，不需要重启守护或重写助手配置。
- **带有效期窗口的图记忆** —— 实体 / 事实 / 情节 / 技能 / 元数据五类节点与带类型的边；事实自带生效区间（`validFrom` / `validTo`），召回可按时间过滤，而不是返回一个扁平队列。
- **可验证、抗篡改的历史** —— 每次写入都是 Ed25519 签名、内容寻址的事件；谁改了什么随时可审计，删除落墓碑而非静默抹除。
- **离线优先的增量同步** —— 向量时钟只交换对端缺失的部分；重连即收敛，不依赖中心服务；直连 / 中继 / 打洞的切换与自动当桥都由框架完成。
- **一机一节点一守护** —— `mebular serve` 是身份、网络与信任的唯一持有者，fleet 与 Agent 都是本机客户端；设备凭二维码或短时效一次性令牌入网，信任是链到用户主密钥的有界证书链，主密钥可以一直离线。
- **备份根密钥** —— 用户主密钥是信任根，且永不离开本机。首次 setup 后请离线备份 `~/.mebular/user-master-key.json`。v0.1.0 未实现主密钥轮换 / 换锚；丢失或被盗没有产品内恢复路径（见 [`LIMITATIONS.md`](https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS.md)）。
- **忆云与设备名同步** —— 当前忆云和本人设备名可改为易读名称；名称作为签名策略元数据同步到所有已准入设备，过滤被移出作者，并在本机重名时给出提示。
- **精简邀请面板** —— 二维码、令牌、有效期和到期时间收进一个小面板；重新生成会作废旧令牌，右上角 X 关闭。
- **应用内桌面确认** —— 重新生成、回滚、移除使用控制台自己的确认弹框；退出改为 CRT 风格确认窗口，不再使用原生对话框。托盘导航在已加载的控制台内原地切换，不再刷新页面。
- **MCP SDK 2.3.1 安全升级** —— 替换存在漏洞的 2.0.0 生产依赖；`npm audit --omit=dev` 清零，真实 MCP client 握手纳入测试。
- **面向任意助手的统一 MCP 工具面** —— stdio 与 Streamable HTTP 两种接入，29 个工具（13 记忆 + 16 任务），带 OAuth / bearer 加固与逐工具 scope；CLI 与控制台共用同一份注册表。
- **跨设备 fleet 任务协作** —— 任务是共享记忆里的 DAG（`causedBy`，禁环）：派发、认领、进度、结果与协商（clarify / counter / accept / reject），唯一远程面就是记忆通道，不提供通用远程调用。
- **分布式星图控制台** —— 主控制台显示忆云内所有设备、共同订阅的基础边、悬停任务域航道（蓝 = 可发出、金 = 可接收、灰 = 不可达），以及真实任务事件驱动的实时 fleet 流量。离线或无共同订阅设备保持灰色虚线；在线共同订阅边压暗，并以低频声波脉冲提示，两端渐隐回基础线，让星体保持主视觉。
- **助手一键接入** —— 7 个内置描述符（OpenChamber、Hermes、OpenCode、Claude Code、Claude Desktop、Cursor、DSH）加自定义片段；统一走探测 → 写入 → 验证三步；桌面一键流程可以在忆云存在之前先接好已装助手。
- **DSH 插件，独立版本线** —— `@mebular/dsh-plugin` 通过 HTTP MCP 把同一张记忆与任务图接入 DeepSeek Harness。侧边栏 Mebular 面板用 `?embed=dsh`（仅 loopback）就地加载现有控制台，不是第二套 Console。host 按 `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331` 发现 daemon，并在同一个 origin 挂载官方 MCP client。App 仍是控制面；插件随本版发布 0.1.0，但不进入五包 lockstep。
- **可带走的设计** —— Canonical Memory Format（CMF）v1，配 Obsidian、日志型端、json-memo、Hermes 适配器；记忆 / 任务两个 Skill 可安装，行为层随数据一起迁移。

### 桌面安装包（unsigned）

- **下载** —— 从 [GitHub Releases v0.1.0](https://github.com/Windsander/Mebular/releases/tag/v0.1.0) 获取：
  `Mebular-0.1.0-universal.dmg`（macOS）、`Mebular-Setup-0.1.0.exe`（Windows x64）、
  `Mebular-0.1.0-x86_64.AppImage` 与 `Mebular-0.1.0-amd64.deb`（Linux x64）。
- **先校验** —— 安装前用 `SHA256SUMS.txt` 核对每个文件（macOS 用
  `shasum -a 256 -c SHA256SUMS.txt`，Linux 用 `sha256sum -c SHA256SUMS.txt`）。
- **macOS Gatekeeper** —— DMG 未签名。首次打开请右键 App 选择「打开」，或在
  「系统设置 → 隐私与安全性」中选「仍要打开」。
- **Windows SmartScreen** —— NSIS 安装包未签名。请选择「更多信息 → 仍要运行」。
- **自带运行时** —— Electron 与 Mebular runtime 都在安装包内，不需要本机 Node.js，也不依赖
  仓库源码；五个 `@mebular/*` 包来自与 npm 发布相同的已验证 tarball。
- **范围** —— v0.1.0 不做签名、公证与自动更新，留到后续版本。

[Unreleased]: https://github.com/Windsander/Mebular/compare/v0.2.0...HEAD
[v0.2.0]: https://github.com/Windsander/Mebular/releases/tag/v0.2.0
[v0.1.2]: https://github.com/Windsander/Mebular/releases/tag/v0.1.2
[v0.1.1]: https://github.com/Windsander/Mebular/releases/tag/v0.1.1
[v0.1.0]: https://github.com/Windsander/Mebular/releases/tag/v0.1.0
