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

## Mixed versions

This is a greenfield model. There is no compatibility layer and no mixed-version window. Run the same version on every device. Old authorization event types are ignored.
