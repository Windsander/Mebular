# Mebular Sealing (SEALING)

> Chinese version: [`SEALING_CN.md`](SEALING_CN.md). The Chinese original is authoritative; if the two versions differ, the Chinese original prevails.

> **Sealing baseline**: `main = 0d78486` (PR #34 merged; includes Phase 2 D/E (A), real-time sync (B), multi-issuer policy authority (C)).
> Root tree = `d1eb7d2c5ffa87eed6c64d70ce8aed3a6ceeb333`. Acceptance baseline: **67 test suites / 542 cases all green**;
> coverage **lines 92.4% / branches ~79.3–79.5%** (jitter between runs), thresholds lines 85 / branches 65.
>
> This document is a **contract**: the red lines, stance and protocol semantics pinned below **must be updated here
> and accompanied by regression tests before any change**, otherwise no merge.
> The policy-derivation invariant matrix and admission conditions are in [`src/sync/POLICY-INVARIANTS.md`](src/sync/POLICY-INVARIANTS.md).

---

## 1. Decentralization red lines (never cross)

1. **No central service / coordinator**: sync is device-to-device; the transport layer is replaceable (libp2p / InMemoryHub / custom Provider); the core layer is pure TS, network-independent, and runs offline in library/embedded form. We do not build a cloud memory SaaS.
2. **No global clock**: ordering **does not look at the wall clock**. Within one issuer, by **monotonic sequence** (`event.vectorClock[author]`); across issuers by **logical time** `sum(vectorClock)`; concurrent (mutually non-causal) ties broken by `(author, content-addressed id)` → fully deterministic, both ends converge identically (including mutual A/B revocation: the earlier logical order wins).
3. **Authority comes from a certificate chain to the user master key**: policy records are accepted only if issued by a device whose chain reaches the user master key; self-issued, other users', or uncertified forgeries are ignored. Authorized parties **cannot self-authorize**.
   **Delegation (T2, trust model v2)**: **any** device holding a valid certificate chain may issue a **delegation certificate** for a **new device** using **its device key** (no specific device/CA required online; the master-key private key may be fully offline). The chain is ordered **leaf→root**, verified hop by hop with the issuer's device public key, with the last hop verified by the user master key; **delegation hop bound N=4** (longer chains rejected). **There is no "designated master device" concept.**
4. **Authorization is transmissible; no single master device must be online**: besides bootstrap issuers (**graph-signed declaration `policy_issuer_declare` ∪ local config `sync.policyIssuers`**, multiple allowed; see §3 C1), already-authorized devices may **re-delegate** the namespaces they held at the time ("you cannot give what you do not have").
5. **Data is held locally; default deny**: writes are locally signed + content-addressed first, no phone-home; the supply side only sends memory to **explicitly authorized** peers (`sync.peerNamespacePolicy`; not listed = give no namespace).
6. **Transport/integration confers no authority**: P2P, relay, MCP, OAuth, etc. only handle **byte channels and access control**; they do not participate in policy decisions or change authorization outcomes.
7. **Reserved namespace `__policy__` is readable by all authenticated devices (including revoked ones)**: an intentional trade-off required to bootstrap "default deny + policy on the graph" and to support recovery; the cost is that the authorization graph (who can read what, who is revoked) is visible to enrolled devices.

## 2. Consistency stance

1. **Eventual convergence, not strong consistency**: within the set of namespaces both sides **commonly authorize (and actually transmit)**, any two ends eventually converge to the same graph state (content-addressed events + vector clocks + deterministic conflict resolution). Partitions only change "who receives which bytes, and when" and how recall is organized; they **do not change the consistency model itself**.
2. **Watermarks are `per-(peer, namespace, author)`**: compare author counts only **within the same namespace**; never treat a peer's cumulative global clock as "have". Local reporting (hello) and snapshot watermarks likewise use only the author's own count. If a namespace is skipped due to no authorization, **granting access backfills history**.
3. **Watermarks advance only by two local facts**: peer **ack** and a **confirmed snapshot** (`snapshotApplied`). A peer's hello-reported watermark does **not** raise the local record (discrepancies surface via `sync-completed.reportedAhead`). **2c exception — self-report may only correct downward**: when a peer self-reports an author count **lower** than the local record, the local watermark is **lowered** to the reported value (missing author = 0), used for **resubscribe recovery** (after the unsubscriber cleans up and reports an empty clock, the peer resends from 0); **never corrected upward**.
4. **Cross-session duplicate sends are expected** (safe direction: send-more-never-less): events the peer already got elsewhere but for which the local side has no ack may be sent again; the receiver dedupes by content-addressed id, **skips signature verification and replay for duplicates but still acks**, and won't resend them next time (self-healing). Non-zero `duplicates` is usually not a bug.
5. **Cross-end consistency self-checks compare only the commonly authorized domain**: `status().stateHash` is a **global** hash; two devices legitimately holding different namespace sets will necessarily have different global hashes (not a bug); compare `status().stateHashByNamespace`, namespace by namespace, only over the domains **both hold**.
6. **Snapshot preconditions and fallback protection**: the initial snapshot is **sent only to peers reporting an empty namespace watermark**; the accepting side still guards against regression — it writes only when the data is locally missing or the snapshot version clock is **strictly newer**. Before relaxing "empty peers only", snapshot conflict/merge semantics must be completed first.
7. **Connection ≠ continuous sync**: one connection guarantees only one convergence (`autoSync`). Real-time comes from **push-on-write**, long-connection fallback from **periodic anti-entropy**; real-time depends on a resident process — library/embedded forms do not push or fall back by default.

## 3. Protocol semantics list (a change = breaking protocol change; all ends must run the same version)

> Any change below requires a **consistent upgrade of all ends**; ends on different versions may reach different conclusions from the same set of records/events.
>
> **⚠️ Breaking protocol change · C1 (bootstrap issuers on-graph)**: adds the event type `policy_issuer_declare` and changes R-a's
> "bootstrap allow-list" from **local config** to **effective bootstrap set = on-graph declarations ∪ local config**. **Old nodes** (without C1)
> treat `policy_issuer_declare` as an unknown type and ignore it: if old and new run mixed and the old node does **not** have that issuer in local config,
> the old node will not recognize that issuer's grants and **may under-authorize / not converge** (safe direction: under-authorize, not fail-open). **A single cluster must
> be fully upgraded to a C1-containing version**; cross-version interop holds only when "the old end still uses `sync.policyIssuers` local config".
>
> **⚠️ Breaking protocol change · M1–M3 (subscription = membership)**: adds the event type `namespace_membership`, upgrading "subscription"
> from a **transient hello declaration** to a **persistent, signed on-graph membership**; the pruning chain becomes
> `peer authorization ∩ peer membership ∩ local subscription declaration`, and hello subscription declarations are downgraded to **liveness/consistency checks** (mismatch →
> **explicit rejection/warning**, not silent). **Compatibility rule (legacy-empty)**: when a namespace has **no adopted membership records** it is treated as
> membership not enabled, and the existing hello-subscription pruning stands (**default deny is not relaxed**); once membership records appear for that namespace, it becomes
> a mandatory gate. **Old nodes** ignore `namespace_membership`: for old ends the namespace is always "membership not enabled" → behavior is
> unchanged or **receives less** (safe direction, not fail-open); **unsubscribe data cleanup / successor ack gating belongs to 2b, not this round**.

> **⚠️ Breaking protocol change · T2 (delegation cert chain + join token, trust model v2)**: the handshake certificate gains an optional `issuer` field and a
> `chain` (leaf→root) payload; events gain an optional `authorCertificateChain`. **Old nodes** do only **one level** of master-key verification:
> when receiving a **delegation certificate** (`issuer` present / chain length > 1) they **reject** it (safe direction, not fail-open) → when old and new run mixed, delegated devices
> **cannot onboard**, and a **full upgrade is required**; the old "shared master key + master-key-signed certificate" deployment **remains valid** (`issuer` absent = byte-compatible with the old format).
> Also adds a **join token** (signed by the inviter device's key, with TTL / one-time nonce / tearable; **does not contain the master key**) and an optional libp2p
> `/mebular/join/1.0.0` request-issue protocol: **any enrolled device** can act as inviter and issue delegation certificates.

- **Policy event types and namespaces**: reserved namespace `__policy__`; event types `namespace_grant` / `namespace_revoke` / `device_revoke` / `policy_issuer_declare` / `namespace_membership` / `namespace_handoff`.
- **Address broadcast (C5, `net_endpoints`, namespace `__net__`, **opt-in**)**: adds an **informational** record type
  `net_endpoints` (namespace `__net__`), payload `{subject, endpoints[{addr,kind:lan|public|relay}], relayCapable, issuedAt, expiry, sig?}`.
  Semantics (8 items, red lines):
  1. **Issued by subject only**: the read side requires `event.author === payload.subject`, otherwise it is ignored (no error thrown);
  2. **Hints only, never part of authorization**: the record is written only to the candidate address book (`source=learned`),
     and **never** changes `getEffectiveNamespaces` / membership / revocation determination, nor writes any `__policy__` record;
  3. **Default tier `full`**: publishes actually-present lan/public/relay addresses, tagged; `relay-only` / `off` are optional privacy tiers (`off` publishes nothing);
  4. **Visible only to `__net__` members**: the record lands only in `__net__` (the transport side reuses the existing "authorization ∩ membership ∩ subscription" pruning; same-shaped records in namespaces other than `__net__` are always ignored);
  5. **`expiry` is local policy**: expired records are ignored only locally; **the wall clock never enters consistency**, and does not affect `stateHash` or conflict resolution;
  6. **Revocation cascade filtering**: records of a revoked subject are always ignored (including its historical records);
  7. **Candidate ordering `public > lan > relay`** (consistent with `EndpointBook.KIND_PRIORITY`);
  8. **`relayCapable` carries no obligation and no permission**: it is information only (it does not make the local node a bridge and buys no authorization; the bridge decision still rests with C6's
     `relayService` + address-book allow-list).
  **Compatibility (safe direction)**: old nodes ignore the unknown `net_endpoints` type → they merely receive fewer hints (not fail-open); a cluster may run mixed.
  This record **does not change the sync protocol skeleton** (adds no handshake/watermark semantics, produces no tombstone).
- **Invite-on-scan (C7, optional join-token fields + auto-grant on redemption)**: the join token gains **optional** fields
  `grantOnJoin` (written only when explicitly `false`) and `grantTtlMs` (written only when explicitly set); **absent by default** → a default token is
  **byte-compatible** with older versions (an old inviter can still verify it, it just does not auto-grant). On successful redemption the inviter signs an **ordinary
  `namespace_grant`** under its own identity (scope = the token's namespace; it **does not change any authorization determination semantics**). Expiry of the grant is ensured by an
  **off-graph ledger + scheduled `revokeGrant`** (`ttlMs=0` = permanent) — TTL is **local policy**, does not enter consistency, and does not affect `stateHash`.
  The QR content = **the inline token text itself** (no custom scheme); rendering depends on the optional `qrcode` dependency (missing package → text only, no error).
- **2c resubscribe recovery (reset)**: after unsubscribe cleanup, rejoining must satisfy both ① the local node has an **effective authorization** for the namespace (`getEffectiveNamespaces(self)` includes it; default deny unchanged) and ② the member is **re-enrolled**; otherwise it **fails explicitly**. Rejoin writes an **off-graph** `<storagePath>.rejoin.<ns>.json` marker (**not synced / no tombstone**) and clears the local namespace watermark; the local hello reports explicitly subscribed namespaces with an **empty clock** → the peer resends from 0 per "self-reported watermark **may only correct downward**" (or sends an initial snapshot under the existing "empty watermark" gate, **the gate is not relaxed**). It **adds no sync protocol, produces no tombstone, does not change `__policy__`** (oracle-free). **Breaking/forward difference**: old nodes lack the "correct downward" semantics → for old ends a rejoin can only **receive less** (safe direction); same-version interop is required.
- **2b unsubscribe handoff (`namespace_handoff`)**: unsubscribe = membership exit (`namespace_membership(active:false)`) + **full local cleanup** of that namespace's events/nodes/edges and the local watermark. It **never produces a tombstone** (no "deleted" event of any kind). **Before cleanup**, a successor must fully ack (reusing per-event ack `getPendingEvents`, including the unsubscriber's author count; **adds no sync protocol, does not relax the snapshot gate**); if the gate fails → **leave everything as is**. **`__policy__` is never cleaned** (policy/membership/handoff records are retained → cleanup does not change policy derivation, and legacy-empty does not degrade). `force` is **local CLI only** (not via MCP/remote), and still **faithfully** records `forced:true` and the missing details. The intent record lands **off-graph** (`<storagePath>.handoff.json`) so that it can **resume idempotently** after a crash.
- **M1–M3 membership (`namespace_membership`)**: `{ member, namespace, active, issuedAt, note? }`; only records chaining to the master key whose issuer/member is not revoked by `device_revoke` are adopted (**unconditional adoption, no R-a**); `(namespace, member)` takes the `active` of the **R-c latest** record (enrolled/unenrolled). **Effective membership = active members ∩ that device's effective authorization for the namespace**; membership records **must not** relax authorization (default deny unchanged). **Pruning chain**: peer authorization ∩ peer membership ∩ local subscription declaration; the hello subscription declaration only serves as a liveness/consistency check, and a mismatch is **explicitly rejected/warned** (`sync-completed.membershipRejected`). **legacy-empty**: when a namespace has no membership records, prune by the hello subscription (compatible).
- **Rules R-a/R-b/R-c/R-d**:
  - **R-a cannot grant beyond one's rights**: the issuer must belong to the **effective bootstrap set** (subjects of adopted on-graph `policy_issuer_declare` ∪ local config `sync.policyIssuers`), or **at that time** already be authorized for **all** the namespaces it declares.
  - **C1 bootstrap-issuer declaration (`policy_issuer_declare`)**: when both the issuer and the subject are not revoked by `device_revoke`, it is **unconditionally adopted** (does not do R-a, hence no cyclic dependency with the fixed point); a revoked issuer (R-b, including historical) or a revoked subject → **not adopted**. Forged records / records not chaining to this user's master key are ignored during verification.
  - **R-b revocation contagion (including history)**: records of a revoked issuer are **never adopted** — its historical `grant`, and the `device_revoke` / `namespace_revoke` it issued. **Self-revocation (`subject === author`) is not adopted** (semantics undefined; revocation must be initiated by another device).
  - **R-c logical-time ordering** (see red line 2), not looking at the wall clock.
  - **R-d exact grantId revocation**: a grantId revoked by `namespace_revoke` **permanently lapses**; recovery must use a **brand-new grantId** (a "pseudo-recovery" reusing the old grantId is void). Revocation is **not terminal**.
- **`derivePolicyState` iteration bound = a deterministic pure function of the input** `iterationBound(entries) = 2·|entries| + 2`. **This is protocol semantics**: it uses only the input size, independent of config/environment/clock → the same input yields the same bound on any end.
- **Non-convergence = fail-closed two-axis conservative fallback**: `revokedGrantIds = ∅` (adopt no revoke) and `revokedIn = closure of the union of all rounds' revocations`, iterating until the output satisfies **`revoked ⊆ excluded`** (R-b **literally holds** on the fallback path); never fail-open. `PolicyState.converged = false` is observable (with `iterations`).
- **`maxIterations` cannot be injected by production**: the `GraphNamespacePolicy` constructor has **no** such option, and production always uses `iterationBound`; `DerivePolicyOptions.maxIterations` is marked `@internal`, **test-only**.
- **Watermark persistence format v2**: `.sync-state.json` (`namespaceClocks` namespace watermarks + per-event ack set + `snapshotApplied`).
- **Default deny and pruning chain**: `sync.peerNamespacePolicy` not listed = denied (an empty array = explicitly disallowed); the pruning chain = **peer authorization ∩ peer membership ∩ local subscription declaration** (M1–M3; degrades to the peer subscription declaration when membership is not enabled), applied to **both offer and initial snapshot**. Denial is not silent (`sync-completed.denied`; membership mismatch → `sync-completed.membershipRejected`).
- **Subscription declaration**: `sync.namespaces` declares the local subscription; unconfigured/empty = participate in all. The declaration is sent with `sync-hello` as `subscribeAll` + `namespaces` **mandatory**; **a missing field / wrong type is a protocol violation and aborts the session**; `subscribeAll=false` + empty list = explicitly subscribe to no namespace.
- **The `sync-nudge` frame has no payload**; carrying a business payload is a protocol violation.
- **Push/fallback defaults**: `pushOnWrite` and `antiEntropy` — library/embedded **off**, resident (`serve` / MCP) **on**. anti-entropy defaults to `intervalMs = 10min`, `jitterRatio = 0.2` (±20%); short-circuits and skips when there is no pending, skips while a session is in flight, exponential backoff on failure, jitter prevents lockstep. push-on-write throttles with 50ms coalescing.
- **Effective bootstrap set = on-graph declarations ∪ local config** (C1): `sync.policyIssuers` is a **compatibility fallback/bootstrap**, empty by default;
  **ends are no longer required to agree** — on-graph `policy_issuer_declare` syncs to every end with `__policy__`, so any end can adopt the same issuer without local config.
  When running mixed with old nodes, the old nodes still need local config (see the C1 note at the top of this section).

## 4. Deferrals (explicitly out of scope for this sealing round)

- **[Not done · retained] Full snapshot conflict/merge semantics (formerly G)**: must be completed before relaxing "the initial snapshot is only sent to peers reporting an empty watermark" (§2.6) — materialized snapshots currently do only accepting-side **fallback protection** and a "strictly newer" gate, **without per-event conflict resolution/merge**.
- **[Retired] Application protocol layer (formerly F)**: cross-device communication **now all goes through the memory (data) channel**; the conditions to revisit it (any one appearing triggers a new project):
  **streaming/interactive multi-turn sessions** · **large-object/media transfer** · **non-Mebular apps reusing the same identity and authorization** · **low-latency RPC that must not be persisted**;
  at that point, define together: protocol registration and version negotiation / how authorization and quota bind to the application protocol.
  Boundary: **cross-device communication all goes through the memory channel; no general remote query/RPC is provided**.
- **Session multiplexing**.
- **quorum / threshold signatures** (multi-issuer exists, but no threshold).
- **`expiresAt` enforcement** (the field is reserved; no cross-end clock dependency is introduced; moved into the fleet MVP scope).
- **fleet (`@mebular/fleet`) has landed M0–M4** (**without changing core/SEALING semantics**): M0 skeleton/boundary, M1 protocol model (events/state machine/local quota + invariant harness), M2 single-machine two-process (spool), M3 real libp2p + memory sync, M4 **agent routing** (registry + Command/Hermes adapters) and the **three collaboration-shape models** (review DAG / bounded negotiation / quota-based chatter + matrix + randomized harness).
  Entry points: `packages/fleet/DESIGN.md`, `PROTOCOL-INVARIANTS.md`, `RUNBOOK.md`. **OpenChamber session seam: resolved** (provider #1 = bridge daemon `POST /agent/run-once`; provider #2 = the Node version of Self-Skills `skills/oc-node-provider`, reusing `oc-bridge.js`, no Python/Hermes needed on Windows; the fleet-side `HttpOpenChamberSeam` stays neutral — replacing the provider does not change fleet code, see `packages/fleet/OPENCHAMBER-SEAM.md`). **Remaining deferral**: executor productization/ops details (optional). **Collaboration-shape live-channel wiring (1d) is complete**.
- **Automatic event pruning**: this round only fixes the constraint and tests — **any pruning must exclude events not yet acked by all authorized peers**; no pruning is implemented.
- **Trust model v2 (delegation cert chain + join token) has landed** (T2; contract in §1.3, §3; acceptance in the S2 report). **Remaining**: revocation's **network-wide propagation delay** (the `device_revoke` cascade is immediate at the policy layer, but takes effect only once the event syncs to each end) and **cross-NAT measured backfill**.

## 5. Known boundaries (deliberate trade-offs / needs human attention)

- **Fallback residual ≤2% (not a security defect)**: on the harness's non-convergent fallback path, the perturbed-check residual is measured to be entirely "original world falls back (`converged=false`), perturbed world converges (`true`)" — **different worlds**, not adopted revoked records residing in the fallback result; the fallback itself is guaranteed by the closure invariant `revoked ⊆ excluded`, making R-b literally hold. The harness prints each `[residual] …` for review.
- **The device-revocation axis is conservative**: the fallback excludes more issuers → it may **under-authorize** (safe direction, not a relaxation).
- **Fixed-point cost**: the main loop is worst-case `O(iterations · |entries|)`, `iterations ≤ 2·|entries|+2` → worst-case approximately `O(n²)` in the input size; policy events are usually few.
- **Revocation is domain shrinkage**: it does not retract **already-graphed** data, nor can it force a remote to stop; what it blocks is **future ingestion** (read side `[]` + inbound event isolation + snapshot filtering). A revoked device **can still open sessions** (otherwise it could never learn about recovery).
- **Cost of reserved-namespace visibility**: `__policy__` is readable by authenticated devices (including revoked ones), and the authorization graph is visible (see §1.7).
- **Cross-session duplicate sends** are by design (see §2.4); when `duplicates` approaches `sentEvents` and is very large, it is most likely that the local sync state was reset/lost — repair with `mebular.resetPeerWatermarks(peerDeviceId?)` (clears watermarks only, leaves per-event acks untouched, safe direction).
- **Service logs are not auto-rotated**: the resident log read by `fleet service logs` **is not automatically truncated/rotated**; long-running deployments need manual `logrotate`/scheduled cleanup (built-in rotation may be added later; see `packages/fleet/ONBOARDING.md` §10).
- **Doc consistency**: README's test/coverage numbers (currently **94 suites / 734 cases**, lines ~93% / branches ~81%), the anti-entropy stance (code default `10min ±20%`, i.e. `intervalMs 600000`) and the deferral references (formerly "not-done items") are all aligned; Agent (skill + MCP) onboarding usage is in README "30-second start · path one".

## 6. Reproduce the sealing baseline (verifiable)

```bash
git rev-parse origin/main^{tree}        # d1eb7d2c5ffa87eed6c64d70ce8aed3a6ceeb333
npm run build && npm run lint           # no output
npm test                                # 67 suites / 542 tests all green
npm run test:coverage                   # All files lines ~92.4% / branches ~79.3–79.5% (thresholds 85/65)
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/sync/policy-invariants.test.ts
# [policy-invariants] scenarios=300 nonConverged=6 residualA=4 residualB=0
```

**Red→green spot check (R-b historical contagion)**: temporarily delete
`revokedIn.has(entry.author) || ` in `src/sync/grantPolicy.ts` → `jest tests/sync/grant-policy.test.ts -t "R-b 历史连坐"` should be **✕**;
after `git checkout -- src/sync/grantPolicy.ts` restores it, it should be **✓**. The working tree must be clean afterwards.
