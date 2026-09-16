// SQLite 存储适配器（G4）
//
// 设计：
// - 基于 Node 内建 `node:sqlite`（DatabaseSync，Node ≥ 22.5，CI 用 Node 24），
//   **零新增运行时依赖**；运行环境无该模块时诚实抛 STORAGE_SQLITE_NOT_AVAILABLE
//   （Node 20 仍可用 Memory / JsonFile 适配器）。
// - 复用 G1 的加密落点：payload 序列化后经 `StorageCipher` 落盘为 `enc:v1:` 密文，
//   读取时解密；接缝之上（GraphStore/EventLog/SyncManager）完全不变。
// - 采用「内存索引 + 预写穿透」与 JsonFileStorage 同构：打开时载入，写时先落库
//   再更新内存，保证接口语义一致（同一套集成测试可在三种适配器上跑）。
//
// 表结构：nodes/edges/events 各一张 (id PRIMARY KEY, payload TEXT)；events 追加
// timestamp 列便于诊断。按 rowid 保序重放。

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Node, Edge, Event } from '../types/index.js';
import { MemoryStorage } from './MemoryStorage.js';
import { StorageCipher } from '../crypto/StorageCipher.js';
import { normalizeNamespace } from '../core/namespace.js';
import { ErrorCodes, StorageError } from '../errors.js';

/** node:sqlite 的最小结构表面（避免依赖特定 @types/node 版本） */
interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

type SqliteModuleLike = { DatabaseSync?: new (path: string) => SqliteDatabaseLike };
/** 同步模块提供者（可注入以便测试「不可用」路径） */
export type SqliteModuleProvider = () => SqliteModuleLike | null;

/**
 * 缺省提供者：用 `process.getBuiltinModule`（Node ≥ 22.3）同步取内建模块。
 * 同步获取避免动态 import 在测试/收尾阶段的竞态；旧 Node 返回 null，
 * 由 open() 诚实抛 STORAGE_SQLITE_NOT_AVAILABLE。
 */
const defaultModuleProvider: SqliteModuleProvider = () => {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') return null;
  try {
    return (getBuiltin('node:sqlite') as SqliteModuleLike | undefined) ?? null;
  } catch {
    return null;
  }
};

const SQLITE_UPSERT_NODE =
  'INSERT INTO nodes(id, payload, namespace) VALUES(?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, namespace=excluded.namespace';
const SQLITE_UPSERT_EDGE =
  'INSERT INTO edges(id, payload) VALUES(?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload';
const SQLITE_UPSERT_EVENT =
  'INSERT INTO events(id, payload, timestamp, namespace) VALUES(?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, timestamp=excluded.timestamp, namespace=excluded.namespace';

export interface SqliteStorageOptions {
  /** 静态加密器（G1 复用）：配置后 payload 以 enc:v1: 密文落盘 */
  cipher?: StorageCipher | null;
  /** 模块提供者（测试用；缺省 process.getBuiltinModule('node:sqlite')） */
  provider?: SqliteModuleProvider;
}

export class SqliteStorage extends MemoryStorage {
  private readonly db: SqliteDatabaseLike;
  private readonly cipher: StorageCipher | null;
  private dbClosed = false;

  private constructor(db: SqliteDatabaseLike, cipher: StorageCipher | null) {
    super();
    this.db = db;
    this.cipher = cipher;
  }

  static async open(
    filePath: string,
    options: SqliteStorageOptions = {},
  ): Promise<SqliteStorage> {
    const module = (options.provider ?? defaultModuleProvider)();
    const DatabaseSync = module?.DatabaseSync;
    if (typeof DatabaseSync !== 'function') {
      throw new StorageError(
        'SQLite 适配器不可用：当前 Node 运行时缺少 node:sqlite（需 Node ≥ 22.5，' +
          '建议 Node 24+）。可改用 storageAdapter:\'json\' 或升级 Node。',
        ErrorCodes.STORAGE_SQLITE_NOT_AVAILABLE,
      );
    }
    await mkdir(dirname(filePath), { recursive: true });
    let db: SqliteDatabaseLike;
    try {
      db = new DatabaseSync(filePath);
    } catch (error) {
      throw new StorageError(`SQLite 打开失败：${filePath}`, ErrorCodes.STORAGE_SQLITE_FAILED, error as Error);
    }
    const storage = new SqliteStorage(db, options.cipher ?? null);
    try {
      storage.initSchema();
      await storage.replay();
    } catch (error) {
      try {
        db.close();
      } catch {
        // 忽略关闭异常，保留原始错误
      }
      throw error;
    }
    return storage;
  }

  private initSchema(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL, namespace TEXT);' +
        'CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, payload TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, timestamp INTEGER, namespace TEXT);',
    );
    // 旧库迁移：既有表没有 namespace 列时补列（不重写 payload，重放时回填）
    this.addColumnIfMissing('nodes', 'namespace', 'TEXT');
    this.addColumnIfMissing('events', 'namespace', 'TEXT');
    // namespace 二级索引：从 payload 抽出的列上建索引，支持按分区检索
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace);' +
        'CREATE INDEX IF NOT EXISTS idx_events_namespace ON events(namespace);',
    );
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }

  private async serialize(value: unknown): Promise<string> {
    const json = JSON.stringify(value);
    return this.cipher ? this.cipher.encrypt(json) : json;
  }

  private async deserialize(payload: string): Promise<unknown> {
    let json = payload;
    if (StorageCipher.isEnvelope(payload)) {
      if (!this.cipher) {
        throw new StorageError(
          'SQLite 存储已加密，但未提供静态加密密钥',
          ErrorCodes.STORAGE_KEY_MISSING,
        );
      }
      json = await this.cipher.decrypt(payload);
    }
    return JSON.parse(json) as unknown;
  }

  private async replay(): Promise<void> {
    for (const row of this.db.prepare('SELECT payload FROM nodes ORDER BY rowid').all()) {
      await super.putNode((await this.deserialize((row as { payload: string }).payload)) as Node);
    }
    for (const row of this.db.prepare('SELECT payload FROM edges ORDER BY rowid').all()) {
      await super.putEdge((await this.deserialize((row as { payload: string }).payload)) as Edge);
    }
    for (const row of this.db.prepare('SELECT payload FROM events ORDER BY rowid').all()) {
      await super.putEvent((await this.deserialize((row as { payload: string }).payload)) as Event);
    }
  }

  private assertOpen(): void {
    if (this.dbClosed) {
      throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    }
  }

  private exec(sql: string, ...params: unknown[]): void {
    try {
      this.db.prepare(sql).run(...params);
    } catch (error) {
      throw new StorageError('SQLite 写入失败', ErrorCodes.STORAGE_SQLITE_FAILED, error as Error);
    }
  }

  // ---------- 覆写：先落库再入内存 ----------

  override async putNode(node: Node): Promise<void> {
    this.assertOpen();
    const payload = await this.serialize(node);
    this.exec(SQLITE_UPSERT_NODE, node.id, payload, normalizeNamespace(node.namespace));
    await super.putNode(node);
  }

  override async deleteNode(id: string): Promise<void> {
    this.assertOpen();
    this.exec('DELETE FROM nodes WHERE id=?', id);
    await super.deleteNode(id);
  }

  override async putEdge(edge: Edge): Promise<void> {
    this.assertOpen();
    const payload = await this.serialize(edge);
    this.exec(SQLITE_UPSERT_EDGE, edge.id, payload);
    await super.putEdge(edge);
  }

  override async deleteEdge(id: string): Promise<void> {
    this.assertOpen();
    this.exec('DELETE FROM edges WHERE id=?', id);
    await super.deleteEdge(id);
  }

  override async putEvent(event: Event): Promise<void> {
    this.assertOpen();
    const payload = await this.serialize(event);
    this.exec(
      SQLITE_UPSERT_EVENT,
      event.id,
      payload,
      event.timestamp ?? null,
      normalizeNamespace(event.namespace),
    );
    await super.putEvent(event);
  }

  override async deleteEvent(id: string): Promise<void> {
    this.assertOpen();
    this.exec('DELETE FROM events WHERE id=?', id);
    await super.deleteEvent(id);
  }

  override async close(): Promise<void> {
    if (this.dbClosed) return;
    this.dbClosed = true;
    try {
      this.db.close();
    } catch (error) {
      throw new StorageError('SQLite 关闭失败', ErrorCodes.STORAGE_SQLITE_FAILED, error as Error);
    }
    await super.close();
  }
}
