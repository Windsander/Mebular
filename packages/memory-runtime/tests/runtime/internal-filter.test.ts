// 内部对象默认排除：不改变 0.2 的 query/history/profile/skills/graph 结果。
//
// 只使用 core 通用判定（metadata.internal=true / 保留 namespace），不再依赖
// 已删除的原型服务类型或 graph 构造器。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, IdentityManager, MemoryService, MemoryStore } from '@mebular/core';

describe('内部对象过滤（通用标记）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-internal-filter-'));
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

  async function markInternal(app: Mebular, id: string): Promise<void> {
    await app.graph.updateNode(id, {
      metadata: { internal: true },
    });
  }

  it('0.2 默认 query/search/history/profile/skills 不受内部对象影响', async () => {
    const { app, service } = await makeService();
    const stored = await service.write([
      { type: 'fact', content: '公开事实：项目使用 TypeScript' },
      { type: 'preference', content: '公开偏好：深色主题', metadata: { preferenceType: 'theme' } },
      { type: 'episode', content: '公开会话内容', metadata: { episodeType: 'conversation' } },
      { type: 'skill', content: '公开技能\n步骤一', metadata: { category: 'ops' } },
    ]);
    const [fact, preference, episode, skill] = stored;

    // 防御性：有人绕过 sidecar 直接写入普通 fact / episode / skill，但带通用内部判别键。
    const hiddenFact = await app.graph.createNode('fact', {
      subject: 'user', predicate: 'note', object: '内部事实',
    });
    await app.graph.updateNode(hiddenFact.id, {
      metadata: { internal: true, runtime: { schema: 1, kind: 'memory_record', internal: true } },
    });
    await app.graph.addTag(hiddenFact.id, 'preference');

    const hiddenEpisode = await app.graph.createNode('episode', {
      episodeType: 'conversation', content: '内部会话内容',
    });
    await markInternal(app, hiddenEpisode.id);

    const hiddenSkill = await app.graph.createNode('skill', {
      name: '内部技能', description: '内部技能描述', category: 'ops',
    });
    await markInternal(app, hiddenSkill.id);

    const reservedNamespace = await app.graph.createNode('fact', {
      subject: 'user', predicate: 'note', object: '保留域内的对象',
    }, undefined, { namespace: '__raw__' });

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
    expect(await app.graph.getNode(reservedNamespace.id)).not.toBeNull();
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
    const compactNode = await app.graph.createNode('compact', { summary: '内部压缩摘要' }, undefined, {
      namespace: 'task:th_1',
    });
    await markInternal(app, compactNode.id);
    const selfNode = await app.graph.createNode('self_record', {
      agentId: 'opencode', revision: 1,
    }, undefined, { namespace: 'agent:opencode' });
    await markInternal(app, selfNode.id);
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
