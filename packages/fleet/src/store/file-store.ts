// 任务事件本地存储（M2）：JSONL 追加 + `eventId` 去重（幂等落库）。
//
// 每个进程用自己的存储路径（验收要求：两进程 storage 独立）。重启后从文件恢复，
// 支撑「重启韧性/不丢不重」。

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskEvent } from '../protocol/events.js';

export interface TaskEventStore {
  /** 追加事件；`eventId` 已存在则返回 `false`（幂等，不重复落库）。 */
  append(event: TaskEvent): Promise<boolean>;
  all(): Promise<TaskEvent[]>;
  byTask(taskId: string): Promise<TaskEvent[]>;
  close(): Promise<void>;
}

export class FileTaskEventStore implements TaskEventStore {
  private readonly path: string;
  private readonly events: TaskEvent[] = [];
  private readonly seen = new Set<string>();

  private constructor(path: string) {
    this.path = path;
  }

  /** 打开（或创建）存储并恢复既有事件。 */
  static async open(path: string): Promise<FileTaskEventStore> {
    const store = new FileTaskEventStore(path);
    await mkdir(dirname(path), { recursive: true });
    let raw = '';
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      raw = '';
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      try {
        store.push(JSON.parse(line) as TaskEvent);
      } catch {
        // 末尾半行（崩溃）跳过；中间行损坏说明文件被破坏，跳过该行但仍继续（不静默重置）。
        continue;
      }
    }
    return store;
  }

  private push(event: TaskEvent): void {
    if (this.seen.has(event.eventId)) return;
    this.seen.add(event.eventId);
    this.events.push(event);
  }

  async append(event: TaskEvent): Promise<boolean> {
    if (this.seen.has(event.eventId)) return false;
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf-8');
    this.push(event);
    return true;
  }

  async all(): Promise<TaskEvent[]> {
    return [...this.events];
  }

  async byTask(taskId: string): Promise<TaskEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }

  async close(): Promise<void> {
    // 无长连接；追加即时落盘。
  }
}
