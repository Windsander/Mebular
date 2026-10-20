// sync 模块入口

export { VectorClock } from './vectorclock/VectorClock.js';
export {
  SecureChannelSyncTransport,
  nextSyncMessage,
  type SyncDirection,
  type SyncMessage,
  type SyncTransport,
} from './protocol.js';
export {
  applyRemoteEvent,
  isApplyableEventType,
  type ApplyResult,
  type SyncConflict,
} from './apply.js';
export {
  SyncManager,
  type SyncPeer,
  type SyncOptions,
  type SyncResult,
  type SyncStatus,
  type SyncManagerOptions,
} from './syncmgr/SyncManager.js';
// P3 · 收敛健康度（监控 + 会话尾状态指纹）
export {
  ConvergenceMonitor,
  CONVERGENCE_DEFAULTS,
  normalizeConvergenceConfig,
  compareStateFingerprints,
  hashPolicyState,
  type ConvergenceConfig,
  type ConvergenceMonitorOptions,
  type NormalizedConvergenceConfig,
  type ConvergenceState,
  type ConvergenceReason,
  type ConvergenceReasonCode,
  type PeerConvergenceStatus,
  type ConvergenceSummary,
  type ConvergenceStatus,
  type ConvergenceTransition,
  type FingerprintComparison,
  type SyncFingerprintEvent,
} from './convergence.js';
export {
  parseStateFingerprints,
  type SyncStateFingerprints,
} from './protocol.js';
export {
  EmptySubscriptionPolicy,
  type NamespaceSubscriptionPolicy,
} from './namespacePolicy.js';
// S1 · 安全三档（core 公共面：记录形状 + 摘要/配对号/证明预检辅助）
export {
  derivePolicyState,
  POLICY_NAMESPACE,
  NAMESPACE_SUBSCRIPTION_EVENT,
  NAMESPACE_DECLARE_EVENT,
  DEVICE_REVOKE_EVENT,
  DEVICE_RESTORE_EVENT,
  NAMESPACE_HANDOFF_EVENT,
  CLOUD_NAME_EVENT,
  DEVICE_NAME_EVENT,
  type PolicyState,
  type CloudNameRecord,
  type DeviceNameRecord,
  type CloudNameState,
  type DeviceNameState,
  type NamespaceSubscriptionRecord,
  type NamespaceDeclareRecord,
  type DeviceRevokeRecord,
  type DeviceRestoreRecord,
  SECURITY_TIER_EVENT,
  SECURITY_APPROVAL_EVENT,
  SECURITY_RECOVERY_EVENT,
  securityActionDigest,
  pairingCodeForDigest,
  canonicalCosignProofData,
  canonicalBreakGlassProofData,
  verifyCosignProof,
  verifyBreakGlassProof,
  type SecurityLevel,
  type SecurityOp,
  type CosignProof,
  type BreakGlassProof,
  type SecurityTierRecord,
  type SecurityApprovalRecord,
  type SecurityRecoveryRecord,
  type SecurityRejectionReason,
  type SecurityRejection,
  type SecurityPolicyState,
  type SecurityAction,
} from './grantPolicy.js';
