// Sidecar 内置 inference（0.3.0 / C8a-C8c）。
//
// 只导出 sidecar 自身使用的模块；MCP/Console/CLI 不 import 这里，
// 必须走 `/memory-runtime/v1/models` host API。

export * from './types.js';
export * from './manifest.js';
export * from './engine-installer.js';
export * from './model-installer.js';
export * from './engine.js';
export * from './service.js';
