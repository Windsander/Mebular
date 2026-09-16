// core 模块入口

export { GraphStore } from './GraphStore.js';
export type { GraphStoreConfig } from './GraphStore.js';
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
} from './namespace.js';
