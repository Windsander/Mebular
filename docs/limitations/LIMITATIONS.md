# Limitations

## Subscription autonomy does not provide per-domain confidentiality

Any device inside the trust boundary that has not been removed may subscribe to any memory domain and read its data. There is no "A can read X, B cannot read X" ACL. Structural mitigations are timely removal (`device_revoke`) and, for high tier, a cosign on a device's first subscription. Do not keep participating in sensitive domains on a device you believe is compromised.

## Removal is per device, not per subtree

`device_revoke` is author-level. Removing a device does **not** invalidate devices it invited or its descendants. To cut off another device, remove it explicitly. There is no certificate-chain cascade.

## Restoration is a trust reset

`device_restore` restores the same identity, but records authored before the restore (subscriptions, removals, tier, approvals, recovery registrations) do not revive (epoch E-1). The restored device must subscribe again. A restore does not restore removals that device issued in its previous epoch.

## Domain deletion is not implemented

Namespaces are shared announcements with no owner. There is no "delete domain" operation; a local "leave and hand off" only clears local data and watermarks after the successor acknowledges.

## Root compromise

Master-key rotation / re-anchoring is not implemented. Back up the user master key offline. If it is lost or stolen, this build has no in-product recovery path.

## Security tiers

- low/medium do not stop a compromised admitted device from subscribing to new domains.
- high tier only gates the first admission (`join`) of a device; later subscriptions are autonomous by design.
- TOTP is a local human-presence gate, not a second cryptographic factor.

## Logical agent identity, not authentication

`agentId`, `actor.type` and claimed task participation are logical assertions used for
partitioning and filtering. They are not authenticated principals, namespace ACLs,
multi-user accounts or cryptographic agent isolation. A holder of the host token or the
capability token can read the local store within that trust boundary; changing an asserted
`agentId` does not create a new authenticated identity.

## Checkpoint evidence must be same-domain

Checkpoint `recordIds`, `detailIds` and `state.references` graph IDs are validated for
existence, expected type, live state, same domain and (for details) non-expiry. A
cross-domain, dangling or wrong-type reference fails the operation instead of committing
dangling evidence. External message IDs remain host references and are not graph proof.
This strictness is intentional; do not weaken it to make an offline replay appear
committed.

## v0.3.2 scale and model evidence

- The 10k full benchmark passed on merged SHA `c37e74b` (includes `ca2193e`): 10,000
  records + 10,000 details, 0 non-seed extras, 200/200 reads and clean cleanup. The 1k/2k
  count audits also passed with 0 extras, and 6/6 failure-injection scenarios passed.
  Timings are from one non-idle host and are not an SLA. The original 10,023/10,000
  failure remains in the scale report as historical evidence.
- No real-model canary was run for v0.3.2. The historical Qwen3-4B/llama.cpp smoke covers
  one pack, one platform and one old SHA; it is not a general model-quality or
  model-support claim.
- Recall quality metrics (recall@k, omission rate, false-recall turn rate, multi-seed
  answer quality) and a real-host + real-model prompt-injection test are not part of the
  v0.3.2 evidence set.

## Mixed versions

This is a greenfield model. There is no compatibility layer and no mixed-version window.
Run the same version on every device. Old authorization event types are ignored.

The v0.3.2 upgrade/rollback drill covers a sequential single-home v0.3.0 → v0.3.2 →
v0.3.0 path only. It does not verify mixed-version concurrency, bidirectional protocol
compatibility, or a direct 0.2.4 upgrade/rollback path. Keeping old graph data readable is
a data-retention statement, not acceptance of those paths.
