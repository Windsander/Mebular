// Runtime 模块入口（0.3.0）
//
// 图内对象复用 MemoryRecord；本地 Raw/Trace 独立存储。
// RuntimeService 是服务层，不替代 MemoryService。

export * from './types.js';
export {
  isRuntimeInternalNode,
  isRuntimeInternalNodeType,
  isRuntimeReservedNamespace,
  readRuntimeMetadata,
  filterRuntimeInternalNodes,
} from './internal.js';
export {
  createCompactNode,
  createContextCheckpointNode,
  createRuntimeObjectNode,
  createSelfRecordNode,
  runtimeNodeTags,
  toRuntimeNodeMetadata,
  toRuntimeObjectView,
  type CreateRuntimeObjectInput,
  type RuntimeObjectView,
} from './graph.js';
export {
  RuntimeLocalStore,
  RuntimeLocalStoreError,
  sha256Hex,
  newRawChunkId,
  newRecallTraceId,
  type RawChunkFilter,
  type RawChunkWriteResult,
  type RecallTraceFilter,
  type RuntimeLocalCleanupResult,
  type RuntimeLocalStoreErrorCode,
  type RuntimeLocalStoreOptions,
  type RuntimeLocalStoreStats,
} from './local-store.js';
export {
  defaultRuntimeSettings,
  normalizeRuntimeSettings,
  type RuntimeLimitsSettings,
  type RuntimeModelSettings,
  type RuntimeRetentionSettings,
  type RuntimeSettings,
} from './config.js';
export {
  RuntimeModeError,
  RuntimeNotImplementedError,
  RuntimeService,
  RuntimeServiceError,
  estimateTokens,
  requireAgentId,
  requireThreadId,
  type RuntimeCapabilitiesStatus,
  type RuntimeCheckpointDeleteResult,
  type RuntimeCheckpointPutRequest,
  type RuntimeCheckpointResult,
  type RuntimeCheckpointView,
  type RuntimeChunkInput,
  type RuntimeCompactRequest,
  type RuntimeCompactResult,
  type RuntimeCompactView,
  type RuntimeContextBlock,
  type RuntimeContextRequest,
  type RuntimeContextResult,
  type RuntimeCounts,
  type RuntimeExtractionView,
  type RuntimeIdentityStatus,
  type RuntimeIngestRecord,
  type RuntimeIngestRequest,
  type RuntimeIngestResult,
  type RuntimeModeChange,
  type RuntimeModelStatus,
  type RuntimeObjectResult,
  type RuntimeRecallRequest,
  type RuntimeRecallResult,
  type RuntimeSelfResult,
  type RuntimeServiceHost,
  type RuntimeServiceOptions,
  type RuntimeStatus,
  type RuntimeSyncStatus,
} from './RuntimeService.js';
export {
  RuntimeCheckpointStore,
  RuntimeStateStore,
  readJsonFile,
  writeJsonAtomic,
  type RuntimeCheckpointStoreOptions,
  type StoredLocalCheckpoint,
} from './state-store.js';
