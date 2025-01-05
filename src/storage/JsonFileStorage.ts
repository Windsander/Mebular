// JSON 追加式文件存储适配器
//
// 设计（对应 phase-3-plan 3.0 的选项 B）：
// - 每次写操作追加一行 JSON（操作日志），读查询走内存索引；
// - 打开时重放操作日志重建内存索引；
// - 事件日志与离线队列因此天然持久化——重启后未同步的事件仍在。
// - compact() 可把日志压缩为当前全量状态，防止文件无限增长。
//
// 零依赖路线下的持久化方案；数据量超过舒适区时可平滑替换为 SQLite 适配器。

import { appendFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { Node, Edge, Event } from '../types/index.js';
import type { NodeFilter, EdgeFilter, EventFilter } from './StorageAdapter.js';
import { MemoryStorage } from './MemoryStorage.js';

type StorageOp =
  | { op: 'putNode'; value: Node }
  | { op: 'deleteNode'; id: string }
  | { op: 'putEdge'; value: Edge }
  | { op: 'deleteEdge'; id: string }
  | { op: 'putEvent'; value: Event }
  | { op: 'deleteEvent'; id: string };

export class JsonFileStorage extends MemoryStorage {
  private readonly filePath: string;
  /** 串行化追加写，保证文件行序与调用序一致 */
  private writeChain: Promise<void> = Promise.resolve();
  private fileClosed = false;

  private constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /** 打开（必要时创建）一个 JSONL 存储文件 */
  static async open(filePath: string): Promise<JsonFileStorage> {
    const storage = new JsonFileStorage(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await storage.replay();
    return storage;
  }

  private async replay(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = JSON.parse(trimmed) as StorageOp;
      await this.applyOp(record);
    }
  }

  private async applyOp(record: StorageOp): Promise<void> {
    switch (record.op) {
      case 'putNode':
        return super.putNode(record.value);
      case 'deleteNode':
        return super.deleteNode(record.id);
      case 'putEdge':
        return super.putEdge(record.value);
      case 'deleteEdge':
        return super.deleteEdge(record.id);
      case 'putEvent':
        return super.putEvent(record.value);
      case 'deleteEvent':
        return super.deleteEvent(record.id);
    }
  }

  private assertWritable(): void {
    if (this.fileClosed) throw new Error('Storage closed');
  }

  private async persist(record: StorageOp): Promise<void> {
    this.assertWritable();
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8'),
    );
    await this.writeChain;
  }

  // ---------- 覆写：先持久化再入内存 ----------

  override async putNode(node: Node): Promise<void> {
    await this.persist({ op: 'putNode', value: node });
    await super.putNode(node);
  }

  override async deleteNode(id: string): Promise<void> {
    await this.persist({ op: 'deleteNode', id });
    await super.deleteNode(id);
  }

  override async putEdge(edge: Edge): Promise<void> {
    await this.persist({ op: 'putEdge', value: edge });
    await super.putEdge(edge);
  }

  override async deleteEdge(id: string): Promise<void> {
    await this.persist({ op: 'deleteEdge', id });
    await super.deleteEdge(id);
  }

  override async putEvent(event: Event): Promise<void> {
    await this.persist({ op: 'putEvent', value: event });
    await super.putEvent(event);
  }

  override async deleteEvent(id: string): Promise<void> {
    await this.persist({ op: 'deleteEvent', id });
    await super.deleteEvent(id);
  }

  /** 把日志压缩为当前全量状态（原子替换） */
  async compact(): Promise<void> {
    this.assertWritable();
    const ops: StorageOp[] = [];
    for (const node of await super.listNodes()) {
      ops.push({ op: 'putNode', value: node });
    }
    for (const edge of await super.listEdges()) {
      ops.push({ op: 'putEdge', value: edge });
    }
    for (const event of await super.listEvents()) {
      ops.push({ op: 'putEvent', value: event });
    }

    const body = ops.map((o) => JSON.stringify(o)).join('\n');
    const tmpPath = this.filePath + '.tmp';
    await this.writeChain; // 先排干待写
    await writeFile(tmpPath, body ? body + '\n' : '', 'utf-8');
    await rename(tmpPath, this.filePath);
  }

  override async close(): Promise<void> {
    if (this.fileClosed) return;
    await this.writeChain;
    this.fileClosed = true;
    await super.close();
  }
}
