// 本地 spool 传输（M2）：单机两进程用一个目录做收件箱，文件级投递。
//
// 目录布局：`<spool>/<device>/<msgId>.json`；消费后移入 `<spool>/<device>/.processed/`。
// 崩溃可能重投（至少一次），消费方按 `eventId` 幂等。

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FleetEndpoint } from '../protocol/envelope.js';
import type { FleetMessage, TaskTransport } from './types.js';

export class SpoolTransport implements TaskTransport {
  private readonly root: string;

  constructor(spoolDir: string) {
    this.root = spoolDir;
  }

  private inbox(device: string): string {
    return join(this.root, device);
  }

  private processed(device: string): string {
    return join(this.inbox(device), '.processed');
  }

  async publish(message: FleetMessage): Promise<void> {
    const dir = this.inbox(message.to.device);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${message.msgId}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(message), 'utf-8');
  }

  async drain(recipient: FleetEndpoint): Promise<FleetMessage[]> {
    const dir = this.inbox(recipient.device);
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    if (names.length === 0) return [];
    const processed = this.processed(recipient.device);
    await mkdir(processed, { recursive: true });

    const messages: FleetMessage[] = [];
    for (const name of names) {
      const from = join(dir, name);
      let parsed: FleetMessage;
      try {
        parsed = JSON.parse(await readFile(from, 'utf-8')) as FleetMessage;
      } catch {
        // 半写/损坏：移走避免反复失败（诚实跳过；至少一次语义下不静默丢失语义事件）
        await rename(from, join(processed, `${name}.corrupt`));
        continue;
      }
      await rename(from, join(processed, name));
      messages.push(parsed);
    }
    return messages;
  }

  async close(): Promise<void> {
    // 无长连接；无需清理。
  }
}
