// 本地模型后端入口（0.3.0）
//
// 该模块只提供原语；sidecar / MCP / Console 的接入在各自层完成。
// 这里不自动启动引擎、不自动下载模型、不读取任何宿主凭据。

export * from './types.js';
export * from './catalog.js';
export * from './engine-assets.js';
export * from './detect.js';
export * from './store.js';
export * from './engine.js';
export * from './gateway.js';
export * from './url.js';
