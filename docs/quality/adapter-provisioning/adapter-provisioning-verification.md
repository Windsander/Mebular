# Adapter provisioning verification

[Design](../../design/adapter-provisioning.md) · [Memory Runtime guide](../../guides/MEMORY_RUNTIME.md) · [Documentation index](../../README.md)

- Branch: `feat/adapter-provisioning-verification`
- Base: `feat/adapter-provisioning-integration@a1feea8`
- Date: 2026-11-26
- Environment: macOS Darwin x86_64, Node v26.8.1, opencode **v2.4.1**
- Raw machine-readable evidence: [`evidence.json`](evidence.json)

Scope: verification and documentation only. No production code changes, no Console/locale
changes, no Memory Runtime semantic changes, no new public MCP tool.

## 1. Real OpenCode adapter E2E

Script: [`tests/integration/host-e2e/adapter-provision-opencode.mjs`](../../../tests/integration/host-e2e/adapter-provision-opencode.mjs)

```bash
node tests/integration/host-e2e/adapter-provision-opencode.mjs
# ✓ Adapter provisioning E2E：24 passed, 0 failed
```

Setup: temporary `HOME`, Mebular home, project and real Memory Runtime sidecar; real
`opencode v2.4.1`; only the config *directory* is created before the test. The test then
runs the real CLI:

```bash
node packages/mcp/bin/mebular.mjs adapter ensure --host opencode --json
```

and starts a real `opencode serve` plus one real turn. The model/provider half of the
OpenCode config is supplied through `OPENCODE_CONFIG_CONTENT`, so the adapter remains the
only writer of `opencode.json`.

What passed:

- **Detection:** `~/.config/opencode` detected without a pre-existing config file.
- **Package:** repository `packages/opencode-plugin` (version 0.3.5, lockstep) resolved;
  no npm access, no managed-directory write in this dev run (`source=manual`).
- **Config:** exactly one `plugins` entry with the plugin's absolute path and
  `{ agentId: "opencode", recall: true, ingest: true }`; user/other keys untouched.
- **Readback:** `config-exists`, `plugins-array`, `entry-unique`, `options`,
  `package-exists`, `version-lockstep` all `ok:true`.
- **Activation:** `next-start`; no process was killed or reloaded.
- **State:** `<home>/adapters.json` records `opencode` as `installed`, version 0.3.5,
  `configPath=~/.config/opencode/opencode.json`, `activation=next-start`, `lastError=null`;
  no token or fact text appears in the file.
- **Idempotency:** a second real `adapter ensure` returns `changed:false` and leaves the
  config bytes unchanged.
- **Sole writer:** `opencode.json` did not exist before `ensure`; its SHA-256 and mtime stay
  identical through `serve` and the turn.
- **Plugin loaded:** sidecar `counts.contexts=1`.
- **Ingest:** sidecar `counts.ingested=1` (`>0`); `counts.settled` may lag and was 0 at
  assertion time.
- **Trace attribution:** `/traces` contains an `agentId=opencode` entry whose `threadId`
  equals the real OpenCode `sessionID`.
- **Privacy:** no host token, prompt body or fact text is printed or persisted in adapter
  state; failure diagnostics are redacted and truncated.

Known limit: this harness resolves the repository package rather than the App bundle.
Bundle staging into `<home>/adapters/...` is covered by
[`tests/mcp/adapter-provision.test.mjs`](../../../tests/mcp/adapter-provision.test.mjs) and
the desktop bundle check below.

## 2. Desktop adapter bundles

```bash
node apps/desktop/scripts/prepare-build.mjs
# [desktop] adapter bundles 已就绪（3 个）
```

| Bundle | Source | Version |
|---|---|---|
| `apps/desktop/build/adapters/opencode-plugin` | `packages/opencode-plugin` | 0.3.5 |
| `apps/desktop/build/adapters/dsh-plugin` | `packages/dsh-plugin` | 0.3.5 |
| `apps/desktop/build/adapters/hermes` | `integrations/hermes/mebular-memory` | 0.3.5 (plugin.yaml) |

## 3. DSH boundary

- Real `dsh` CLI on this machine: **absent** (`command -v dsh` empty). The evidence
  boundary is therefore hermetic, not a real DSH process.
- `tests/mcp/adapter-dsh.test.mjs`: **16 passed, 0 failed**.
- Hermetic tests assert that injected environments without a `PATH`/CLI never discover a
  real CLI (`findDshCli({env:{}}) === null`), and that the repository plugin package is
  version-locked.
- Real `~/.dsh/profiles` (`web`: `cordis.patch.yml`, `cordis.yml`, `package.json`,
  `pnpm-workspace.yaml`) kept identical size/mtime across the suite; the adapter tests use
  temporary `DSH_HOME` roots only.
- Configuration must go through the official CLI; there is no hand-written YAML path. On a
  machine with no CLI the provisioning boundary is `DSH_CLI_NOT_FOUND` with no write.

## 4. Hermes boundary

- Real CLI present: `/Users/sobertli/.local/bin/hermes`; real home `~/.hermes`.
- `tests/mcp/adapter-hermes.test.mjs`: **17 passed, 0 failed**.
- Focused real-host run: **2 passed, 15 skipped**, boundary:
  `HERMES_CLI_ENV_UNSUPPORTED` — `hermes: no dependency environment is committed for this
  install; run 'hermes pm repair'`.
- The isolated `HERMES_HOME` attempt was rolled back; the real `~/.hermes/config.yaml`
  stayed byte-identical (SHA-256 `b5e4714b…e99b28`, size 6518, same mtime) across the test
  window.
- Real `~/.hermes/plugins` remained empty; no `plugins/mebular` and no
  `memory.provider=mebular` were written. `MEMORY.md` / `USER.md`, DB, session storage and
  the provider spool were not touched.
- No dependency install or network access was attempted.

Concurrent-host note: a live Hermes desktop app/gateway rewrote its own
`~/.hermes/config.yaml` (added an `mcp_servers.mebular` entry) outside the test window. The
adapter tests assert hash/size/mtime immutability inside their own window and passed; the
change is host-owned, not adapter-owned.

## 5. Gates

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Docs | `npm run check:docs` | 7/7 pass |
| Adapter + clients + repair + desktop Jest | `jest tests/mcp/adapter-provision.test.mjs tests/mcp/adapter-dsh.test.mjs tests/mcp/adapter-hermes.test.mjs tests/mcp/adapter-cli.test.mjs tests/mcp/clients.test.mjs tests/mcp/repair-api.test.mjs tests/desktop/adapter-repair.test.mjs` | 7 suites, 86 tests pass |
| Desktop packaging | `jest tests/desktop/release-packaging.test.mjs` | 20 tests pass |
| New adapter E2E | `node tests/integration/host-e2e/adapter-provision-opencode.mjs` | 24 pass, 0 fail |
| Existing OpenCode host E2E | `PATH=<opencode-bin>:$PATH node tests/integration/host-e2e/opencode-real-runtime.mjs` | 41 pass, 0 fail, 0 skipped |
| Existing intervention outcome E2E | `PATH=<opencode-bin>:$PATH node tests/integration/host-e2e/opencode-intervention-outcome.mjs` | 46 pass, 0 fail |

No-UI-diff / no-new-tool gate:

```bash
git diff --name-only a1feea8...HEAD
```

Expected and observed: only `tests/**`, `docs/**` and `CHANGELOG.md`. The diff contains no
`packages/console/**`, `locales/**` or `packages/memory-runtime/**`, and no change to
`packages/mcp/src/tools.mjs` or tool registration (29 public tools unchanged).

### Full-suite stability (routing-e2e)

`npm test -- --runInBand` also runs `tests/fleet/routing-e2e.test.ts` after the adapter
suites. Its P2P sync helper used a 30 s inner `waitFor` while the Jest case budget was
60 s; under full-suite heap/GC pressure the `cHasUi` sync could exhaust the inner budget
and be reported as a routing failure even though the isolated case passed.

Diagnosis: no adapter suite leaks global state. The adapter suites do not mutate
`process.env`, create timers or leave child processes; a before/after `ps` snapshot around
`adapter-cli` + `adapter-dsh` + `adapter-hermes` showed no new host/CLI processes, and Jest
reported no open handles. The fix is test-only: `routing-e2e`'s `waitFor` default budget is
now 60 s, matching the outer `useHeavyTimeout(60_000)`, with a comment recording the
full-suite load boundary. A real hang still fails within the bounded case lifetime; no
case was skipped.

Full run after the fix: **320 suites passed / 1 skipped, 3578 tests passed / 1 skipped**
(472.7 s), including the adapter suites and `routing-e2e.test.ts`.


## 5.1 Blocker follow-up (`feat/adapter-blockers`)

- **Real health:** `packages/mcp/src/adapter-health.mjs` reads
  `<home>/memory-runtime.json` + its `tokenFile` (JSON `{token}`) and probes the sidecar
  `/status` + `/traces?limit=…`. `ensureAdapter` now records `installedAt`,
  `lastIngestedAt` and one of `active` / `installed` / `degraded`; an unavailable sidecar
  is deferred (`HEALTH_UNAVAILABLE`) and never falsely degraded. A version change resets
  `installedAt`, so a 0.3.4 trace cannot make the 0.3.5 adapter healthy before new evidence.
- **OpenCode upgrade identity:** `mergePlugins` treats every
  `<current home>/adapters/opencode-plugin/<version>` (`file:`/`~` included) as
  Mebular-owned, so a 0.3.4 managed entry is replaced by 0.3.5. The managed identity is
  scoped to the current home: unrelated user paths containing `adapters/opencode-plugin`
  are preserved. `verify` counts all Mebular entries (`VERIFY_ENTRY_DUPLICATE` when >1) and
  rollback removes all of them for that home.
- **Build lockstep:** `apps/desktop/scripts/prepare-build.mjs` exits 1 unless the
  opencode-plugin/dsh-plugin `package.json` and Hermes `plugin.yaml` versions equal
  `apps/desktop/package.json`.
- Evidence: `tests/mcp/adapter-health.test.mjs` (fake sidecar HTTP: healthy, degraded,
  unavailable, single degraded repair) and the upgrade/verify/rollback cases in
  `tests/mcp/adapter-provision.test.mjs`.

## 6. Known limitations (explicit)

1. OpenCode E2E uses the repository plugin path (`source=manual`), not the packaged App
   bundle. Bundle presence is verified separately; unit tests cover `managed-dir` staging.
2. DSH has no real CLI on this machine; only hermetic tests and the missing-CLI boundary
   are evidenced.
3. Hermes real CLI cannot commit a dependency environment for a fresh `HERMES_HOME`
   (`HERMES_CLI_ENV_UNSUPPORTED`), so a real provider install/ingest on a fresh data root
   is not evidenced here.
4. No screenshot-level UI test was run; the no-UI-diff gate is a source diff check.
5. `counts.settled` was 0 when asserted; the acceptance signal is `counts.ingested > 0` plus
   an `agentId=opencode` trace.
