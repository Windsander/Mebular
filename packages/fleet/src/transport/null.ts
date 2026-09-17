// 空传输（M3）：当任务事件直接落在**会被同步复制的记忆**里时，无需额外投递通道。
//
// 语义：`publish` 为 no-op（事件已由 core 记忆同步传播）；`drain` 恒空（消费方直接读本地存储，
// 该存储会随同步收敛）。用于 `MebularTaskEventStore`。

import type { FleetMessage, TaskTransport } from './types.js';

export class NullTransport implements TaskTransport {
  async publish(): Promise<void> {
    // no-op：投递由记忆同步负责。
  }

  async drain(): Promise<FleetMessage[]> {
    return [];
  }

  async close(): Promise<void> {
    // 无资源。
  }
}
