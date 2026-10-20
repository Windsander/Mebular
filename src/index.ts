// Mebular 模块入口 - 统一导出

export * from './types/index.js';
export * from './errors.js';
export {
  IdentityManager,
  type DeviceIdentity,
  type UserMasterKeyPair,
} from './crypto/IdentityManager.js';
export {
  Mebular,
  type MebularConfig,
  type NamespaceHandoffPlan,
  type NamespaceHandoffResult,
  type NamespaceRejoinResult,
  type SetSecurityTierInput,
} from './mebular.js';
export {
  EventLog,
  canonicalize,
  canonicalEventData,
  computeEventId,
  type EventSigner,
  type EventLogOptions,
} from './eventlog/index.js';
export {
  SyncManager,
  VectorClock,
  SecureChannelSyncTransport,
  applyRemoteEvent,
  EmptySubscriptionPolicy,
  type NamespaceSubscriptionPolicy,
  type SyncPeer,
  type SyncOptions,
  type SyncResult,
  type SyncStatus,
  type SyncManagerOptions,
  type SyncDirection,
  type SyncMessage,
  type SyncTransport,
  type ApplyResult,
  type SyncConflict,
} from './sync/index.js';
// P3 · 收敛健康度（监控 + 会话尾状态指纹；只读诊断，绝不参与授权/水位判定）
export {
  ConvergenceMonitor,
  compareStateFingerprints,
  hashPolicyState,
  type ConvergenceConfig,
  type PeerConvergenceStatus,
  type ConvergenceStatus,
  type ConvergenceSummary,
  type ConvergenceState,
  type ConvergenceReason,
  type ConvergenceTransition,
  type SyncFingerprintEvent,
  type SyncStateFingerprints,
} from './sync/index.js';
// 订阅自主：订阅/域公告/移出/恢复（公共面保持在最小集合；其余经 Mebular facade）
export {
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
  NAMESPACE_SUBSCRIPTION_EVENT,
  NAMESPACE_DECLARE_EVENT,
  DEVICE_REVOKE_EVENT,
  DEVICE_RESTORE_EVENT,
  NAMESPACE_HANDOFF_EVENT,
  CLOUD_NAME_EVENT,
  DEVICE_NAME_EVENT,
  SECURITY_TIER_EVENT,
  SECURITY_APPROVAL_EVENT,
  SECURITY_RECOVERY_EVENT,
  securityActionDigest,
  pairingCodeForDigest,
  canonicalCosignProofData,
  canonicalBreakGlassProofData,
  verifyCosignProof,
  verifyBreakGlassProof,
  type NamespaceSubscriptionRecord,
  type NamespaceDeclareRecord,
  type DeviceRevokeRecord,
  type DeviceRestoreRecord,
  type NamespaceHandoffRecord,
  type CloudNameRecord,
  type DeviceNameRecord,
  type CloudNameState,
  type DeviceNameState,
  type PolicyState,
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
} from './sync/grantPolicy.js';
export { normalizeDisplayName, isValidDisplayName } from './core/displayName.js';
export {
  DEFAULT_NAMESPACE,
  normalizeNamespace,
  normalizeNamespaceList,
  matchesNamespace,
  intersectNamespaceAllowLists,
  subscriptionToAllowList,
  declarationToAllowList,
  isNamespaceAllowed,
  mergeClockInto,
  mergeNamespaceClocks,
  namespaceClockOf,
  type NamespaceFilter,
  type NamespaceAllowList,
  type NamespaceClocks,
} from './core/namespace.js';
export { MemoryStorage } from './storage/MemoryStorage.js';
export { JsonFileStorage, type JsonFileStorageOptions } from './storage/JsonFileStorage.js';
export { SqliteStorage, type SqliteStorageOptions } from './storage/SqliteStorage.js';
export * from './memory/index.js';
export {
  MemoryService,
  type MemoryServiceOptions,
  type MemoryStatus,
  type ImportInput,
  type ImportResult,
} from './memory/MemoryService.js';
export { computeStateHash, computeStateHashByNamespace, isEvidenceNode } from './core/stateHash.js';
export * from './hermes/index.js';
export * from './exchange/index.js';
export {
  encryptPrivateKeyPkcs8,
  decryptPrivateKeyPkcs8,
  DEFAULT_PBKDF2_ITERATIONS,
  type EncryptedKeyMaterial,
} from './crypto/KeyProtector.js';
export { StorageCipher, AT_REST_PREFIX } from './crypto/StorageCipher.js';
export { GraphStore } from './core/GraphStore.js';
export type { GraphStoreConfig } from './core/GraphStore.js';
export * from './p2p/index.js';
