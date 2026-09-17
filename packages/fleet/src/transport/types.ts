// Fleet 传输抽象（M2 用本地 spool；M3 换 core 记忆同步，不改 runtime）。
//
// 传输层只负责把**显式状态事件**在设备间投递；语义（幂等、收敛）由 model.ts 负责。
// 投递是**至少一次**：重复投递由 `eventId` 去重（见 PROTOCOL-INVARIANTS ①）。

import type { FleetEndpoint } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';

/** 传输消息：一次投递（可重复；`event.eventId` 为幂等键）。 */
export interface FleetMessage {
  /** 传输层消息 id（每次投递唯一，与 `event.eventId` 无关） */
  msgId: string;
  from: FleetEndpoint;
  to: FleetEndpoint;
  event: TaskEvent;
}

/** 设备间传输。`drain` 拉取并消费本端收件箱（已消费的不得再次返回；崩溃时允许重投）。 */
export interface TaskTransport {
  publish(message: FleetMessage): Promise<void>;
  /**
   * 拉取发往 `recipient` 的未消费消息（确定性顺序）；拉取后标记为已消费。
   * 至少一次：崩溃可能重投，故消费方必须按 `event.eventId` 幂等。
   */
  drain(recipient: FleetEndpoint): Promise<FleetMessage[]>;
  close(): Promise<void>;
}
