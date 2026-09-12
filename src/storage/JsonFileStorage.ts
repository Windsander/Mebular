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
import { MemoryStorage } from './MemoryStorage.js';
import { StorageCipher } from '../crypto/StorageCipher.js';
import { ErrorCodes, StorageError } from '../errors.js';

type StorageOp =
  | { op: 'putNode'; value: Node }
  | { op: 'deleteNode'; id: string }
  | { op: 'putEdge'; value: Edge }
  | { op: 'deleteEdge'; id: string }
  | { op: 'putEvent'; value: Event }
  | { op: 'deleteEvent'; id: string };

export interface JsonFileStorageOptions {
  /**
   * 静态加密器（G1）：配置后每行落盘为 `enc:v1:` 信封，重放时解密；
   * 不配置则维持明文 JSONL（向后兼容）。
   */
  cipher?: StorageCipher | null;
}

export class JsonFileStorage extends MemoryStorage {
  private readonly filePath: string;
  /** 静态加密器；null 表示明文落盘（默认，向后兼容） */
  private readonly cipher: StorageCipher | null;
  /** 串行化追加写，保证文件行序与调用序一致 */
  private writeChain: Promise<void> = Promise.resolve();
  private fileClosed = false;

  private constructor(filePath: string, cipher: StorageCipher | null) {
    super();
    this.filePath = filePath;
    this.cipher = cipher;
  }

  /** 打开（必要时创建）一个 JSONL 存储文件 */
  static async open(
    filePath: string,
    options: JsonFileStorageOptions = {},
  ): Promise<JsonFileStorage> {
    const storage = new JsonFileStorage(filePath, options.cipher ?? null);
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

    const lines = content.split('\n').filter((line) => line.trim() !== '');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 密文行必须先解密（缺密钥/错密钥在 StorageCipher 内诚实报错，不静默吞掉）
      let jsonText = line;
      if (StorageCipher.isEnvelope(line)) {
        if (!this.cipher) {
          throw new StorageError(
            `存储文件已加密，但未提供静态加密密钥：${this.filePath}`,
            ErrorCodes.STORAGE_KEY_MISSING,
          );
        }
        jsonText = await this.cipher.decrypt(line);
      }

      let record: StorageOp;
      try {
        record = JSON.parse(jsonText) as StorageOp;
      } catch (error) {
        // 追加式日志的崩溃半行写只可能出现在末尾：容忍并截断最后一条坏行；
        // 中间行损坏说明文件已被意外破坏，诚实报错并给出行号
        if (i === lines.length - 1) {
          console.warn(
            `[JsonFileStorage] 末尾 ${lines.length - i} 行损坏（疑似崩溃半行写），已略过：${this.filePath}`,
          );
          break;
        }
        throw new StorageError(
          `存储文件第 ${i + 1} 行损坏（非末尾，无法安全恢复）：${this.filePath}`,
          ErrorCodes.STORAGE_READ_FAILED,
          error as Error,
        );
      }
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
    if (this.fileClosed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
  }

  /** 落盘序列化：配置静态加密时输出信封，否则输出明文 JSON */
  private async serialize(record: StorageOp): Promise<string> {
    const json = JSON.stringify(record);
    return this.cipher ? this.cipher.encrypt(json) : json;
  }

  private async persist(record: StorageOp): Promise<void> {
    this.assertWritable();
    const line = await this.serialize(record);
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.filePath, line + '\n', 'utf-8'),
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

    const lines: string[] = [];
    for (const op of ops) {
      lines.push(await this.serialize(op));
    }
    const body = lines.join('\n');
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
