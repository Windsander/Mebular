// StorageAdapter 通用集成测试（G4）
//
// 同一套用例在 Memory / JsonFile / SQLite 三种适配器上运行，保证接缝语义一致。
// SQLite 依赖 Node 内建 node:sqlite（Node ≥ 22.5）；不可用时该组用例 skip。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { JsonFileStorage } from '../../src/storage/JsonFileStorage.js';
import { SqliteStorage } from '../../src/storage/SqliteStorage.js';
import type { StorageAdapter } from '../../src/storage/StorageAdapter.js';
import type { Node, Edge, Event } from '../../src/types/index.js';

function sqliteAvailable(): boolean {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') return false;
  try {
    return getBuiltin('node:sqlite') != null;
  } catch {
    return false;
  }
}
const SQLITE = sqliteAvailable();

function makeNode(id: string, text: string, updatedAt = 1000): Node {
  return {
    id,
    type: 'fact',
    content: { text },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: updatedAt,
    updatedAt,
    validFrom: updatedAt,
    validTo: 9999999999999,
    tags: [],
  };
}

function makeEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    type: 'edge',
    source,
    target,
    relation: 'related',
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    labels: [],
  };
}

function makeEvent(id: string, author = 'device-A'): Event {
  return {
    id,
    type: 'node_created',
    timestamp: 1000,
    vectorClock: { [author]: 1 },
    data: { nodeId: id },
    author,
    signature: '',
  };
}

interface AdapterHarness {
  name: string;
  /** 打开适配器（dir 为该用例的临时目录） */
  open: (dir: string) => Promise<StorageAdapter>;
  /** 是否具备「关闭后重开恢复状态」的持久化语义 */
  persistent: boolean;
  /** true：整组跳过（如 node:sqlite 不可用） */
  skip?: boolean;
}

function runSuite(harness: AdapterHarness): void {
  const describeFn = harness.skip ? describe.skip : describe;
  describeFn(`${harness.name} StorageAdapter`, () => {
    let dir: string;
    let storage: StorageAdapter;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'mebular-adapter-'));
      storage = await harness.open(dir);
    });

    afterEach(async () => {
      await storage.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    });

    it('节点 put/get/list/delete 语义一致', async () => {
      await storage.putNode(makeNode('n1', 'alpha'));
      await storage.putNode(makeNode('n2', 'beta', 2000));
      expect((await storage.getNode('n1'))?.content).toEqual({ text: 'alpha' });
      expect(await storage.listNodes()).toHaveLength(2);
      expect((await storage.listNodes({ type: 'fact' })).length).toBe(2);
      expect((await storage.listNodes({ id: 'n2' }))[0]?.updatedAt).toBe(2000);

      await storage.deleteNode('n1');
      expect(await storage.getNode('n1')).toBeNull();
      expect(await storage.listNodes()).toHaveLength(1);
    });

    it('同 ID 覆盖写保留最新版本（节点）', async () => {
      await storage.putNode(makeNode('n1', 'old', 1000));
      await storage.putNode(makeNode('n1', 'new', 5000));
      expect((await storage.getNode('n1'))?.content).toEqual({ text: 'new' });
      expect((await storage.getNode('n1'))?.updatedAt).toBe(5000);
    });

    it('边 put/get/list/delete 语义一致', async () => {
      await storage.putEdge(makeEdge('e1', 'n1', 'n2'));
      expect((await storage.getEdge('e1'))?.relation).toBe('related');
      expect((await storage.listEdges({ source: 'n1' })).length).toBe(1);
      await storage.deleteEdge('e1');
      expect(await storage.getEdge('e1')).toBeNull();
    });

    it('事件同 ID 幂等（列表只一条）', async () => {
      await storage.putEvent(makeEvent('ev1'));
      await storage.putEvent(makeEvent('ev1'));
      expect(await storage.listEvents()).toHaveLength(1);
      expect((await storage.getEvent('ev1'))?.type).toBe('node_created');
    });

    if (harness.persistent) {
      it('关闭后重开恢复完整状态', async () => {
        await storage.putNode(makeNode('n1', 'persisted'));
        await storage.putEdge(makeEdge('e1', 'n1', 'n2'));
        await storage.putEvent(makeEvent('ev1'));
        await storage.close();

        storage = await harness.open(dir);
        expect((await storage.getNode('n1'))?.content).toEqual({ text: 'persisted' });
        expect(await storage.getEdge('e1')).not.toBeNull();
        expect(await storage.listEvents()).toHaveLength(1);
      });
    }
  });
}

runSuite({ name: 'Memory', open: async () => new MemoryStorage(), persistent: false });
runSuite({
  name: 'JsonFile',
  open: async (dir) => JsonFileStorage.open(join(dir, 'store.jsonl')),
  persistent: true,
});
runSuite({
  name: 'SQLite',
  open: async (dir) => SqliteStorage.open(join(dir, 'store.sqlite')),
  persistent: true,
  skip: !SQLITE,
});

describe('SqliteStorage 可用性', () => {
  it(`node:sqlite ${SQLITE ? '可用（用例已执行）' : '不可用（SQLite 用例已跳过）'}`, () => {
    expect(typeof SQLITE).toBe('boolean');
  });
});
