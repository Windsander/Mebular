// MemoryStore 类型化记忆层测试（phase-4-plan 4.1）

import { describe, it, expect, beforeEach } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { EdgeTypes } from '../../src/memory/types.js';
import { ValidationError } from '../../src/errors.js';

describe('MemoryStore', () => {
  let storage: MemoryStorage;
  let eventLog: EventLog;
  let graph: GraphStore;
  let memory: MemoryStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    eventLog = new EventLog(storage, 'device-A');
    graph = new GraphStore({ storage, author: 'device-A', eventLog });
    memory = new MemoryStore(graph);
  });

  it('五类节点写入与类型化读取', async () => {
    const entity = await memory.addEntity({ entityType: 'user', name: 'windsander' });
    expect(entity.type).toBe('entity');
    expect(entity.content.entityType).toBe('user');

    const fact = await memory.addFact({ subject: 'windsander', predicate: 'likes', object: 'coffee' });
    expect(fact.content.predicate).toBe('likes');

    const episode = await memory.addEpisode({ episodeType: 'conversation', content: '一次对话' });
    expect(episode.content.episodeType).toBe('conversation');

    const skill = await memory.addSkill({ name: '部署', description: '如何部署', category: 'ops' });
    expect(skill.content.category).toBe('ops');

    const meta = await memory.addMeta({ metaType: 'category', name: '偏好' });
    expect(meta.content.metaType).toBe('category');

    // 类型化读取（类型不匹配返回 null）
    expect(await memory.getEntity(entity.id)).not.toBeNull();
    expect(await memory.getFact(entity.id)).toBeNull();
  });

  it('字段校验：必填缺失、枚举越界、置信度越界、时间窗倒挂均被拒', async () => {
    await expect(memory.addEntity({ entityType: 'user', name: '' })).rejects.toThrow(ValidationError);
    await expect(
      memory.addEntity({ entityType: 'alien' as never, name: 'x' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      memory.addFact({ subject: '', predicate: 'p', object: 'o' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      memory.addFact({ subject: 's', predicate: 'p', object: 'o', confidence: 1.5 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      memory.addFact({ subject: 's', predicate: 'p', object: 'o', validFrom: 2000, validTo: 1000 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      memory.addEpisode({ episodeType: 'alien' as never, content: 'x' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      memory.addSkill({ name: 'n', description: '', category: 'c' }),
    ).rejects.toThrow(ValidationError);
  });

  it('Fact 的时间有效性写入并在查询中生效', async () => {
    const past = await memory.addFact({
      subject: 'a', predicate: 'was', object: 'b', validFrom: 1000, validTo: 2000,
    });
    expect(past.validFrom).toBe(1000);
    expect(past.validTo).toBe(2000);

    const current = await memory.addFact({ subject: 'a', predicate: 'is', object: 'c' });

    const active = await memory.listActiveFacts();
    expect(active.map((f) => f.id)).toEqual([current.id]); // 过期事实被排除
  });

  it('标签经 GraphStore.addTag 写入且可过滤', async () => {
    const entity = await memory.addEntity({
      entityType: 'project', name: 'mebular', tags: ['active', 'p0'],
    });
    expect((await graph.getNode(entity.id))?.tags).toEqual(['active', 'p0']);

    const byTag = await memory.listByType('entity', { tags: ['p0'] });
    expect(byTag.map((n) => n.id)).toEqual([entity.id]);
  });

  it('listByType 支持时间窗与删除过滤', async () => {
    const a = await memory.addEntity({ entityType: 'concept', name: 'A' });
    const b = await memory.addEntity({ entityType: 'concept', name: 'B' });
    await graph.deleteNode(b.id);

    expect(await memory.listByType('entity')).toHaveLength(1); // 默认滤掉已删
    expect(await memory.listByType('entity', { includeDeleted: true })).toHaveLength(2);
    expect(
      await memory.listByType('entity', { createdAfter: a.createdAt + 1 }),
    ).toHaveLength(0);
  });

  it('每次写入都进入事件日志（同步前提）', async () => {
    await memory.addEntity({ entityType: 'user', name: 'u', tags: ['t1'] });
    await memory.addFact({ subject: 's', predicate: 'p', object: 'o' });

    const types = (await eventLog.listEvents()).map((e) => e.type).sort();
    expect(types).toEqual(['node_created', 'node_created', 'tag_added']);
  });

  it('EdgeTypes 常量可用于关系接线', async () => {
    const user = await memory.addEntity({ entityType: 'user', name: 'w' });
    const tool = await memory.addEntity({ entityType: 'tool', name: 'kimi' });
    const edge = await graph.createEdge(user.id, tool.id, EdgeTypes.USES);
    expect(edge.relation).toBe('uses');
  });
});
