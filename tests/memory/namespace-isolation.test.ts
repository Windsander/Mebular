// 记忆分区（namespace）隔离：query / search / graph 按分区过滤，互不串。
//
// 覆盖验收 1：写入不同 namespace 的记忆，指定分区下不互相串（含跨分区负例）；
// 以及旧数据（无 namespace）一律按 'default' 处理。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import {
  DEFAULT_NAMESPACE,
  matchesNamespace,
  normalizeNamespace,
} from '../../src/core/namespace.js';
import type { Node } from '../../src/types/index.js';

describe('记忆分区隔离', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-ns-isolation-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeService(): Promise<{ app: Mebular; service: MemoryService }> {
    const app = new Mebular({
      storagePath: join(dir, 'a.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await app.initialize();
    return { app, service: new MemoryService(app) };
  }

  it('query / search：指定 namespace 时不返回其他分区（含负例）', async () => {
    const { app, service } = await makeService();
    const [alpha1, alpha2, beta1] = await service.write([
      { type: 'fact', content: '共享关键词 alpha-1', metadata: { namespace: 'alpha' } },
      { type: 'fact', content: '共享关键词 alpha-2', metadata: { namespace: 'alpha' } },
      { type: 'fact', content: '共享关键词 beta-1', metadata: { namespace: 'beta' } },
    ]);

    const alpha = await service.query({ query: '共享关键词', filters: { namespace: 'alpha' } });
    expect(alpha.memories.map((m) => m.id).sort()).toEqual([alpha1!.id, alpha2!.id].sort());
    expect(alpha.memories.some((m) => m.id === beta1!.id)).toBe(false);

    const beta = await service.query({ query: '共享关键词', filters: { namespace: 'beta' } });
    expect(beta.memories.map((m) => m.id)).toEqual([beta1!.id]);

    // 数组形式的多分区
    const both = await service.query({ query: '共享关键词', filters: { namespace: ['alpha', 'beta'] } });
    expect(both.totalMatches).toBe(3);

    // 不过滤 = 全部（向后兼容）
    const all = await service.query({ query: '共享关键词' });
    expect(all.totalMatches).toBe(3);

    const searchAlpha = await service.search({ query: '共享关键词', filters: { namespace: 'alpha' } });
    expect(searchAlpha.memories.map((m) => m.id).sort()).toEqual([alpha1!.id, alpha2!.id].sort());
    expect(searchAlpha.memories.some((m) => m.id === beta1!.id)).toBe(false);

    // memory 输出带 namespace 标记
    expect(searchAlpha.memories[0]!.metadata.namespace).toBe('alpha');

    await app.shutdown();
  });

  it('graph：指定 namespace 时不跨分区遍历', async () => {
    const { app, service } = await makeService();
    const [a1, a2, b1] = await service.write([
      { type: 'fact', content: 'A 起点', metadata: { namespace: 'alpha' } },
      { type: 'fact', content: 'A 邻居', metadata: { namespace: 'alpha' } },
      { type: 'fact', content: 'B 邻居', metadata: { namespace: 'beta' } },
    ]);
    await app.graph.createEdge(a1!.id, a2!.id, 'related_to'); // 源在 alpha → 边在 alpha
    await app.graph.createEdge(a1!.id, b1!.id, 'related_to'); // 边在 alpha，但目标在 beta

    const scoped = await service.graph(a1!.id, { maxDepth: 1, namespace: 'alpha' });
    expect(scoped.visitedNodes.map((n) => n.id).sort()).toEqual([a1!.id, a2!.id].sort());
    expect(scoped.visitedNodes.some((n) => n.id === b1!.id)).toBe(false);

    // 起点不在该分区 → 诚实返回空（不报错）
    const wrongStart = await service.graph(b1!.id, { maxDepth: 1, namespace: 'alpha' });
    expect(wrongStart.visitedNodes).toHaveLength(0);

    await app.shutdown();
  });

  it('MemoryStorage：namespace 索引过滤；旧数据（无 namespace）按 default', async () => {
    const storage = new MemoryStorage();
    const legacy: Node = {
      id: 'legacy',
      type: 'fact',
      content: { text: '旧数据' },
      labels: [],
      createdBy: 'device-A',
      signature: '',
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      // 无 namespace 字段
    };
    const explicitDefault: Node = { ...legacy, id: 'default-node', namespace: 'default' };
    const alpha: Node = { ...legacy, id: 'alpha-node', namespace: 'alpha' };
    await storage.putNode(legacy);
    await storage.putNode(explicitDefault);
    await storage.putNode(alpha);

    const defaults = await storage.listNodes({ namespace: 'default' });
    expect(defaults.map((n) => n.id).sort()).toEqual(['default-node', 'legacy']);

    const alphas = await storage.listNodes({ namespace: 'alpha' });
    expect(alphas.map((n) => n.id)).toEqual(['alpha-node']);

    // 更新分区后索引随之迁移
    await storage.putNode({ ...alpha, namespace: 'beta' });
    expect((await storage.listNodes({ namespace: 'alpha' })).map((n) => n.id)).toEqual([]);
    expect((await storage.listNodes({ namespace: 'beta' })).map((n) => n.id)).toEqual(['alpha-node']);

    // 删除后索引清理
    await storage.deleteNode('alpha-node');
    expect((await storage.listNodes({ namespace: 'beta' })).map((n) => n.id)).toEqual([]);
  });

  it('归一化与匹配：缺失/空白回落到 default', () => {
    expect(normalizeNamespace(undefined)).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace('')).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace('  ')).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace(' alpha ')).toBe('alpha');
    expect(matchesNamespace(undefined, 'default')).toBe(true);
    expect(matchesNamespace(undefined, 'alpha')).toBe(false);
    expect(matchesNamespace('alpha', [])).toBe(true); // 空数组 = 不过滤
    expect(matchesNamespace('alpha', ['alpha', 'beta'])).toBe(true);
  });
});
