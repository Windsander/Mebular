// 任务事件存储（M3）：以 `@mebular/core` 的**图示记忆**为载体，任务事件即一类记忆节点。
//
// 于是「任务经记忆同步传递」——由 core 的同步（写入即推 + anti-entropy + 变更订阅）负责复制，
// fleet 只消费 `Mebular.graph` 的**公共 API**（createNode/listNodes），不碰 core 内部。

import type { Mebular } from '@mebular/core';
import type { TaskEvent } from '../protocol/events.js';
import { validateTaskEvent } from '../protocol/events.js';
import { dedupeEvents } from '../model.js';
import type { TaskEventStore } from './file-store.js';

export interface MebularTaskEventStoreOptions {
  /** 任务分区（默认 `tasks`） */
  namespace?: string;
  /** 任务事件节点类型（默认 `task_event`） */
  type?: string;
}

/** 用 Mebular 图示记忆承载任务事件；幂等由 `eventId` 去重保证。 */
export class MebularTaskEventStore implements TaskEventStore {
  private readonly mebular: Mebular;
  private readonly namespace: string;
  private readonly type: string;

  constructor(mebular: Mebular, options: MebularTaskEventStoreOptions = {}) {
    this.mebular = mebular;
    this.namespace = options.namespace ?? 'tasks';
    this.type = options.type ?? 'task_event';
  }

  private async events(): Promise<TaskEvent[]> {
    // NodeFilter 无 namespace 字段：按 type 取回后在本层过滤 namespace。
    const nodes = await this.mebular.graph.listNodes({ type: this.type });
    const valid: TaskEvent[] = [];
    for (const node of nodes) {
      if (node.namespace !== this.namespace) continue;
      const candidate = node.content;
      if (typeof candidate !== 'object' || candidate === null) continue;
      if (!validateTaskEvent(candidate).ok) continue; // 忽略非任务事件节点
      valid.push(candidate as unknown as TaskEvent);
    }
    // 与 reducer 同一去重语义（同 id 冲突的确定性裁决），避免 store/reducer 漂移
    return dedupeEvents(valid);
  }

  async append(event: TaskEvent): Promise<boolean> {
    const existing = await this.events();
    if (existing.some((e) => e.eventId === event.eventId)) return false;
    await this.mebular.graph.createNode(this.type, event as unknown as Record<string, unknown>, [], {
      namespace: this.namespace,
    });
    return true;
  }

  async all(): Promise<TaskEvent[]> {
    return this.events();
  }

  async byTask(taskId: string): Promise<TaskEvent[]> {
    return (await this.events()).filter((e) => e.taskId === taskId);
  }

  async close(): Promise<void> {
    // 存储生命周期由 Mebular 实例管理。
  }
}
