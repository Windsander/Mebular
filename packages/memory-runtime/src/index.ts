// @mebular/memory-runtime 包入口。
//
// 0.3.0 W3a 起，独立 sidecar 位于 `src/sidecar/**`，通过
// `@mebular/memory-runtime/sidecar` 子路径与 `mebular-memory-runtime` 可执行文件使用。
// 本文件暂时保留原型 RuntimeService / inference 导出（W4 迁移到 capability client）；
// 新 sidecar 代码不 import @mebular/core，也不打开图/事件日志。
//
// 边界：
// - sidecar 只通过 `/internal/memory/v1` 访问 MCP capability API；
// - 不新增第二套图/事件日志/同步。

export * from './runtime/index.js';
export * from './inference/index.js';
