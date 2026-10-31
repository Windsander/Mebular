// Memory Runtime sidecar 公共入口（独立进程/独立包内部使用）。
//
// 宿主与 MCP 不 import 本模块；它们只通过 `/memory-runtime/v1` HTTP、
// discovery 与 token 文件交互。这里导出给 sidecar 自身、测试与后续 W4 使用。

export * from './config.js';
export * from './discovery.js';
export * from './start-lock.js';
export * from './token.js';
export * from './capability-client.js';
export * from './domains.js';
export * from './heuristic.js';
export * from './inference-provider.js';
export * from './inference/index.js';
export * from './cue.js';
export * from './text.js';
export * from './recall.js';
export * from './candidates.js';
export * from './errors.js';
export * from './ingest.js';
export * from './internal-objects.js';
export * from './outbox-replayer.js';
export * from './settlement.js';
export * from './server.js';
export * from './local-layer.js';
export * from './main.js';
