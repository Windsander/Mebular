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
