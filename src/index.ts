// Mebular 模块入口 - 统一导出

export * from './types/index.js';
export * from './errors.js';
export {
  IdentityManager,
  type DeviceIdentity,
  type UserMasterKeyPair,
} from './crypto/IdentityManager.js';
export { Mebular, type MebularConfig } from './mebular.js';
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
  ConfigNamespacePolicy,
  type NamespaceGrantPolicy,
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
// Phase 2 · D/E：授权作为记忆与身份吊销（公共面保持在最小集合；其余经 Mebular facade）
export {
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
  type NamespaceGrantRecord,
  type NamespaceRevokeRecord,
  type DeviceRevokeRecord,
  type PolicyState,
} from './sync/grantPolicy.js';
export { CompositeNamespacePolicy } from './sync/namespacePolicy.js';
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
