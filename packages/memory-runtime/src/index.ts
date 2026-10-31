// @mebular/memory-runtime 包入口。
//
// 独立 sidecar 位于 `src/sidecar/**`，通过 `@mebular/memory-runtime/sidecar`
// 子路径与 `mebular-memory-runtime` 可执行文件使用。
// 根入口只保留 sidecar 复用的本地原语（Raw/Trace 存储与类型）和推理原语；
// 不再导出 0.3 原型的服务类。
//
// 边界：
// - sidecar 只通过 `/internal/memory/v1` 访问 MCP capability API；
// - 不新增第二套图/事件日志/同步。

export * from './runtime/local-store.js';
export * from './runtime/types.js';
export * from './inference/index.js';
