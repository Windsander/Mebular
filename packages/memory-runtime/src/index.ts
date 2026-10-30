// @mebular/memory-runtime 入口（0.3.0 W1 包拆分中间态）
//
// 当前仍是内嵌原型：RuntimeService 直接使用 @mebular/core 的公共 API，
// 由 MCP 的 /runtime/v1 原型路由加载。W3 会改成独立 sidecar 与 capability
// client；在此之前本包不提供进程生命周期，也不实现 /internal/memory/v1。
//
// 边界：
// - 只允许 import `@mebular/core` 包根公共 API，不得 import core 内部文件路径；
// - 不新增第二套图/事件日志/同步；持久写入仍经 core 的 MemoryService/GraphStore。

export * from './runtime/index.js';
export * from './inference/index.js';
