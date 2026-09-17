// @mebular/fleet —— 跨设备多 Agent 协作（任务=记忆）的公共入口。
//
// 边界（红线，见 DESIGN.md 与仓库 SEALING.md）：
// - 只消费 `@mebular/core` 的**公共 API**（`import { ... } from '@mebular/core'`），
//   不得 `import` core 的内部路径（`src/**`）；
// - core 不得反向依赖本包（`tests/fleet/boundary.test.ts` 强制）；
// - 墙钟（`expiresAt`）不进一致性判定。
export * from './protocol/envelope.js';
export * from './protocol/events.js';
export * from './model.js';
export * from './quota.js';
export * from './transport/types.js';
export * from './transport/spool.js';
export * from './store/file-store.js';
export * from './runtime/executor.js';
export * from './runtime/node.js';
export * from './runtime/worker.js';
