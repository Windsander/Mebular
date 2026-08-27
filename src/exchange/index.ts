// exchange 模块入口（Phase 5：CMF + 适配器框架）

export {
  CMF_FORMAT,
  CMF_VERSION,
  KNOWN_NODE_TYPES,
  parseCmfDocument,
  serializeCmfDocument,
  stringifyCmfDocument,
  canonicalCmfNode,
  exportGraphToCmf,
  importCmfToMemory,
  type CmfDocument,
  type CmfNode,
  type CmfEdge,
  type CmfSource,
  type CmfExportOptions,
  type CmfImportReport,
  type CmfImportError,
  type KnownNodeType,
} from './cmf.js';
export {
  AdapterRegistry,
  adapterDedupKey,
  importWithAdapter,
  type MemoryAdapter,
  type AdapterSource,
  type AdapterContext,
  type AdapterImportReport,
  type AdapterRoute,
} from './adapter.js';
export {
  KvJsonAdapter,
  MarkdownDocAdapter,
  createBuiltinAdapterRegistry,
} from './builtin-adapters.js';
export { HermesAdapter } from './hermes-adapter.js';
export {
  JsonMemoAdapter,
  parseJsonMemo,
  type JsonMemoEntry,
  type JsonMemoFile,
} from './json-memo-adapter.js';
