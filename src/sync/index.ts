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
  ConfigNamespacePolicy,
  type NamespaceGrantPolicy,
} from './namespacePolicy.js';
