// Memory Runtime sidecar 公共入口（独立进程/独立包内部使用）。
//
// 宿主与 MCP 不 import 本模块；它们只通过 `/memory-runtime/v1` HTTP、
// discovery 与 token 文件交互。这里导出给 sidecar 自身、测试与后续 W4 使用。

export * from './config.js';
export * from './discovery.js';
export * from './token.js';
export * from './capability-client.js';
export * from './server.js';
export * from './local-layer.js';
export * from './main.js';
