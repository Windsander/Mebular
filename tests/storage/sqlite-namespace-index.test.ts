// SQLite namespace 列与索引（PLAN 1.1 存储层 / 验收 5）
//
// 验证 SqliteStorage 从 payload 抽出 namespace 列并建索引，且与
// MemoryStorage 的按分区过滤行为一致。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteStorage } from '../../src/storage/SqliteStorage.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { Node, Event } from '../../src/types/index.js';

interface SqliteRow {
  id: string;
  namespace: string | null;
}
interface SqliteColumn {
  name: string;
}
interface SqliteIndex {
  name: string;
}

function sqliteAvailable(): boolean {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') return false;
  try {
    return getBuiltin('node:sqlite') != null;
  } catch {
    return false;
  }
}
const itIfSqlite = sqliteAvailable() ? it : it.skip;

function makeNode(id: string, namespace?: string): Node {
  return {
    id,
    type: 'fact',
    content: { text: id },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: 1,
    updatedAt: 1,
    tags: [],
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

describe('SQLite namespace 索引', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-sqlite-ns-'));
    file = join(dir, 'store.sqlite');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  itIfSqlite('nodes/events 有 namespace 列与索引；缺失列的值回落 default', async () => {
    const storage = await SqliteStorage.open(file);
    await storage.putNode(makeNode('legacy'));
    await storage.putNode(makeNode('a', 'nsA'));
    await storage.putNode(makeNode('b', 'nsB'));
    const event: Event = {
      id: 'e1',
      type: 'node_created',
      timestamp: 1,
      vectorClock: { 'device-A': 1 },
      data: {},
      author: 'device-A',
      signature: '',
      namespace: 'nsA',
    };
    await storage.putEvent(event);
    await storage.close();

    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule!;
    const { DatabaseSync } = getBuiltin('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(file);
    try {
      const nodeColumns = (db.prepare('PRAGMA table_info(nodes)').all() as SqliteColumn[]).map((c) => c.name);
      expect(nodeColumns).toContain('namespace');
      const eventColumns = (db.prepare('PRAGMA table_info(events)').all() as SqliteColumn[]).map((c) => c.name);
      expect(eventColumns).toContain('namespace');

      const nodeIndexes = (db.prepare('PRAGMA index_list(nodes)').all() as SqliteIndex[]).map((i) => i.name);
      expect(nodeIndexes.some((name) => name.includes('namespace'))).toBe(true);
      const eventIndexes = (db.prepare('PRAGMA index_list(events)').all() as SqliteIndex[]).map((i) => i.name);
      expect(eventIndexes.some((name) => name.includes('namespace'))).toBe(true);

      const rows = db.prepare('SELECT id, namespace FROM nodes ORDER BY id').all() as SqliteRow[];
      expect(rows).toEqual([
        { id: 'a', namespace: 'nsA' },
        { id: 'b', namespace: 'nsB' },
        { id: 'legacy', namespace: 'default' },
      ]);
      const eventRows = db.prepare('SELECT id, namespace FROM events').all() as SqliteRow[];
      expect(eventRows).toEqual([{ id: 'e1', namespace: 'nsA' }]);
    } finally {
      db.close();
    }
  });

  itIfSqlite('两种后端按分区过滤行为一致', async () => {
    const sqlite = await SqliteStorage.open(join(dir, 'consistency.sqlite'));
    const memory = new MemoryStorage();
    const nodes = [makeNode('legacy'), makeNode('a', 'nsA'), makeNode('b', 'nsB')];
    for (const node of nodes) {
      await sqlite.putNode(node);
      await memory.putNode(node);
    }
    for (const filter of ['nsA', 'nsB', 'default'] as const) {
      const fromSqlite = (await sqlite.listNodes({ namespace: filter })).map((n) => n.id).sort();
      const fromMemory = (await memory.listNodes({ namespace: filter })).map((n) => n.id).sort();
      expect(fromSqlite).toEqual(fromMemory);
    }
    await sqlite.close();
  });
});
