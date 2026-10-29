// Runtime 内部对象默认排除：不改变 0.2 的 query/history/profile/skills/graph 结果。
//
// 覆盖三重判定（类型 / metadata.runtime.internal / 保留 namespace），以及
// MemoryStore 的 includeInternal 显式调试开关。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import {
  createCompactNode,
  createContextCheckpointNode,
  createSelfRecordNode,
  filterRuntimeInternalNodes,
  isRuntimeInternalNode,
  isRuntimeReservedNamespace,
  type Compact,
  type ContextCheckpoint,
  type RuntimeEnvelope,
  type SelfRecord,
} from '../../src/runtime/index.js';
import type { Node } from '../../src/types/index.js';

describe('Runtime 内部对象过滤', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-runtime-filter-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeService(): Promise<{ app: Mebular; service: MemoryService }> {
    const app = new Mebular({
      storagePath: join(dir, 'device.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await app.initialize();
    return { app, service: new MemoryService(app) };
  }

  function envelope(kind: RuntimeEnvelope['kind'], namespace = 'default'): RuntimeEnvelope {
    const at = Date.now();
    return {
      schema: 1,
      kind,
      id: 'ignored-by-node-id',
      cloudId: 'cl_test',
      userId: 'u_test',
      agentId: 'opencode',
      hostId: 'h_test',
      threadId: 'th_1',
      namespace,
      visibility: 'user',
      sync: 'cloud',
      internal: true,
      provenance: { source: 'runtime', extractor: 'heuristic', at },
      createdAt: at,
      updatedAt: at,
    };
  }

  function compact(): Compact {
    return {
      schema: 1,
      summary: '内部压缩摘要',
      sourceIds: [],
      sourceHashes: [],
      strategy: 'summary',
      model: { extractor: 'heuristic' },
      tokenCount: 12,
      stale: false,
    };
  }

  function checkpoint(): ContextCheckpoint {
    return {
      schema: 1,
      threadId: 'th_1',
      agentId: 'opencode',
      revision: 1,
      state: { cursor: 1 },
      recordIds: [],
      originHostId: 'h_test',
      lease: { hostId: 'h_test', until: Date.now() + 60_000 },
      expiresAt: Date.now() + 30 * 86_400_000,
    };
  }

  function self(): SelfRecord {
    return {
      schema: 1,
      agentId: 'opencode',
      revision: 1,
      goals: ['内部目标'],
      traits: [],
      preferences: {},
      capabilities: [],
      boundaries: [],
      updatedAt: Date.now(),
    };
  }

  it('三重判定：内部类型 / metadata.runtime.internal / 保留 namespace', () => {
    const base = { id: 'n1', type: 'fact', createdBy: 'a', signature: '', createdAt: 0, updatedAt: 0 } as Node;
    expect(isRuntimeInternalNode({ ...base, type: 'compact' })).toBe(true);
    expect(isRuntimeInternalNode({ ...base, metadata: { runtime: { internal: true } } })).toBe(true);
    expect(isRuntimeInternalNode({ ...base, namespace: '__raw__' })).toBe(true);
    expect(isRuntimeInternalNode({ ...base, namespace: '__policy__' })).toBe(false);
    expect(isRuntimeInternalNode(base)).toBe(false);
    expect(isRuntimeReservedNamespace('__self__')).toBe(true);
    expect(isRuntimeReservedNamespace('__policy__')).toBe(true);
    expect(isRuntimeReservedNamespace('notes')).toBe(false);

    const nodes = [{ ...base, type: 'compact' }, base];
    expect(filterRuntimeInternalNodes(nodes)).toHaveLength(1);
    expect(filterRuntimeInternalNodes(nodes, { includeInternal: true })).toHaveLength(2);
  });

  it('0.2 默认 query/search/history/profile/skills 不受内部对象影响', async () => {
    const { app, service } = await makeService();
    const stored = await service.write([
      { type: 'fact', content: '公开事实：项目使用 TypeScript' },
      { type: 'preference', content: '公开偏好：深色主题', metadata: { preferenceType: 'theme' } },
      { type: 'episode', content: '公开会话内容', metadata: { episodeType: 'conversation' } },
      { type: 'skill', content: '公开技能\n步骤一', metadata: { category: 'ops' } },
    ]);
    const [fact, preference, episode, skill] = stored;

    await createCompactNode(app.graph, compact(), envelope('compact'), { namespace: 'default' });
    await createContextCheckpointNode(app.graph, checkpoint(), envelope('context_checkpoint', '__checkpoint__'));
    await createSelfRecordNode(app.graph, self(), envelope('self_record', '__self__'));

    // 防御性：有人绕过 Runtime 直接写入普通 fact / episode / skill，但带内部判别键。
    const hiddenFact = await app.graph.createNode('fact', {
      subject: 'user', predicate: 'note', object: '内部事实',
    });
    await app.graph.updateNode(hiddenFact.id, {
      metadata: { runtime: { schema: 1, kind: 'memory_record', internal: true } },
    });
    await app.graph.addTag(hiddenFact.id, 'preference');

    const hiddenEpisode = await app.graph.createNode('episode', {
      episodeType: 'conversation', content: '内部会话内容',
    });
    await app.graph.updateNode(hiddenEpisode.id, {
      metadata: { runtime: { schema: 1, kind: 'memory_record', internal: true } },
    });

    const hiddenSkill = await app.graph.createNode('skill', {
      name: '内部技能', description: '内部技能描述', category: 'ops',
    });
    await app.graph.updateNode(hiddenSkill.id, {
      metadata: { runtime: { schema: 1, kind: 'memory_record', internal: true } },
    });

    const all = await service.query({});
    expect(new Set(all.memories.map((memory) => memory.id))).toEqual(new Set([
      fact!.id, preference!.id, episode!.id, skill!.id,
    ]));
    expect(all.totalMatches).toBe(4);

    expect((await service.query({ query: '内部' })).totalMatches).toBe(0);
    expect((await service.search({ query: '内部' })).memories).toHaveLength(0);

    const history = await service.history({});
    expect(history.episodes.map((entry) => entry.id)).toEqual([episode!.id]);
    expect(history.totalCount).toBe(1);

    const profile = await service.profile();
    expect(profile.preferences.map((entry) => entry.id)).toEqual([preference!.id]);

    expect((await service.skills()).map((entry) => entry.id)).toEqual([skill!.id]);

    // 内部对象确实在图里，普通查询看不到；MemoryStore 显式调试开关可见。
    expect(await app.graph.getNode(hiddenFact.id)).not.toBeNull();
    const store = new MemoryStore(app.graph);
    expect((await store.listByType('fact')).map((node) => node.id)).not.toContain(hiddenFact.id);
    expect((await store.listByType('fact', { includeInternal: true })).map((node) => node.id))
      .toContain(hiddenFact.id);
    expect(await store.getFact(hiddenFact.id)).toBeNull();

    await app.shutdown();
  });

  it('graph：从公开记录遍历不泄漏内部对象；内部起点返回 INTERNAL_OBJECT', async () => {
    const { app, service } = await makeService();
    const [fact] = await service.write([{ type: 'fact', content: '公开图起点' }]);
    const compactNode = await createCompactNode(app.graph, compact(), envelope('compact'), { namespace: 'default' });
    const selfNode = await createSelfRecordNode(app.graph, self(), envelope('self_record', '__self__'));
    await app.graph.createEdge(fact!.id, compactNode.id, 'related_to');
    await app.graph.createEdge(fact!.id, selfNode.id, 'related_to');

    const traversal = await service.graph(fact!.id, { maxDepth: 3 });
    expect(traversal.visitedNodes.map((node) => node.id)).toEqual([fact!.id]);
    expect(traversal.visitedEdges).toHaveLength(0);

    await expect(service.graph(compactNode.id)).rejects.toMatchObject({ code: 'INTERNAL_OBJECT' });

    // 普通 delete/archive 默认拒绝内部对象，但对象仍在图里。
    const deleted = await service.delete([compactNode.id, fact!.id]);
    expect(deleted.internal).toEqual([compactNode.id]);
    expect(deleted.deleted).toEqual([fact!.id]);
    expect(await app.graph.getNode(compactNode.id)).not.toBeNull();

    await app.shutdown();
  });
});
