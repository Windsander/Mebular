// HermesMemoryProvider 测试（phase-4-plan 4.2）
//
// 七方法全覆盖：storeMemory 五型映射、retrieveMemory 过滤与分页、
// searchMemory 关系带出、getUserProfile 偏好聚合、getSkills 过滤、
// getConversationHistory 时间窗/主题/分页、extractMemory 浅抽取与深抽取合并。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';

describe('HermesMemoryProvider', () => {
  let dir: string;
  let mebular: Mebular;
  let provider: HermesMemoryProvider;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-hermes-'));
    const master = await new IdentityManager().generateUserMasterKey();
    mebular = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await mebular.initialize();
    provider = new HermesMemoryProvider(mebular, { userId: 'windsander' });
  });

  afterEach(async () => {
    await mebular.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('storeMemory：五型映射与元数据落位', async () => {
    const fact = await provider.storeMemory({ type: 'fact', content: '喜欢浅烘焙咖啡' });
    const storedFact = await mebular.graph.getNode(fact.id);
    expect(storedFact?.type).toBe('fact');
    expect((storedFact?.content as { object: string }).object).toBe('喜欢浅烘焙咖啡');

    const pref = await provider.storeMemory({
      type: 'preference',
      content: '浅烘焙',
      metadata: { preferenceType: 'coffee-roast' },
    });
    const prefNode = await mebular.graph.getNode(pref.id);
    expect(prefNode?.tags).toContain('preference');

    const episode = await provider.storeMemory({
      type: 'episode',
      content: '讨论了部署方案',
      metadata: { episodeType: 'decision' },
    });
    expect(((await mebular.graph.getNode(episode.id))?.content as { episodeType: string }).episodeType)
      .toBe('decision');

    const observation = await provider.storeMemory({ type: 'observation', content: '这周会议变多' });
    expect(((await mebular.graph.getNode(observation.id))?.content as { episodeType: string }).episodeType)
      .toBe('observation');

    const skill = await provider.storeMemory({
      type: 'skill',
      content: '三步部署法\n先构建再发布',
      metadata: { category: 'ops' },
    });
    const skillNode = await mebular.graph.getNode(skill.id);
    expect((skillNode?.content as { name: string }).name).toBe('三步部署法');
    expect((skillNode?.content as { category: string }).category).toBe('ops');
  });

  it('storeMemory：expiresAt 映射 validTo，relatedTo 只链接已存在节点', async () => {
    const a = await provider.storeMemory({ type: 'fact', content: 'A' });
    const b = await provider.storeMemory({
      type: 'fact',
      content: 'B',
      metadata: { expiresAt: 2000, relatedTo: [a.id, 'ghost-node'] },
    });
    const nodeB = await mebular.graph.getNode(b.id);
    expect(nodeB?.validTo).toBe(2000);

    const edges = await mebular.graph.getNeighbors(b.id, 'outgoing');
    expect(edges).toHaveLength(1); // ghost-node 被跳过
    expect(edges[0]!.target).toBe(a.id);
    expect(edges[0]!.relation).toBe('related_to');
  });

  it('retrieveMemory：类型/关键词/过滤器/分页', async () => {
    await provider.storeMemory({ type: 'fact', content: '喜欢浅烘焙咖啡', metadata: { tags: ['coffee'], confidence: 0.9 } });
    await provider.storeMemory({ type: 'fact', content: '讨厌加班', metadata: { confidence: 0.3 } });
    await provider.storeMemory({ type: 'episode', content: '咖啡闲聊', metadata: { episodeType: 'conversation' } });

    // 类型过滤
    const episodesOnly = await provider.retrieveMemory({ types: ['episode'] });
    expect(episodesOnly.memories).toHaveLength(1);

    // 关键词
    const coffee = await provider.retrieveMemory({ query: '咖啡' });
    expect(coffee.totalMatches).toBeGreaterThanOrEqual(2);

    // 置信度过滤
    const confident = await provider.retrieveMemory({
      types: ['fact'],
      filters: { minConfidence: 0.5 },
    });
    expect(confident.memories).toHaveLength(1);
    expect(confident.memories[0]!.metadata.confidence).toBe(0.9);

    // 分页
    const page = await provider.retrieveMemory({ types: ['fact'], limit: 1, offset: 1 });
    expect(page.memories).toHaveLength(1);
    expect(page.totalMatches).toBe(2);

    // 未启用向量索引 → 不携带 relevance
    expect(coffee.memories[0]!.relevance).toBeUndefined();
  });

  it('retrieveMemory：preference 虚拟类型只命中带标签的事实', async () => {
    await provider.storeMemory({ type: 'preference', content: '浅烘焙' });
    await provider.storeMemory({ type: 'fact', content: '普通事实' });

    const result = await provider.retrieveMemory({ types: ['preference'] });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.content).toContain('浅烘焙');
  });

  it('searchMemory：关键词命中并带出一跳关系', async () => {
    const a = await provider.storeMemory({ type: 'fact', content: '喜欢咖啡' });
    const b = await provider.storeMemory({
      type: 'fact',
      content: '咖啡机选型',
      metadata: { relatedTo: [a.id] },
    });

    const result = await provider.searchMemory({ query: '咖啡', includeRelations: true });
    expect(result.memories.length).toBe(2);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.sourceId).toBe(b.id);
    expect(result.relations[0]!.targetId).toBe(a.id);

    const noRelations = await provider.searchMemory({ query: '咖啡' });
    expect(noRelations.relations).toHaveLength(0);
  });

  it('getUserProfile：聚合用户实体属性与活跃偏好', async () => {
    await mebular.graph.createNode('entity', {
      entityType: 'user', name: 'windsander', properties: { timezone: 'Asia/Shanghai' },
    });
    await provider.storeMemory({ type: 'preference', content: '浅烘焙', metadata: { preferenceType: 'coffee-roast' } });
    // 过期偏好不进入画像
    await provider.storeMemory({
      type: 'preference',
      content: '旧偏好',
      metadata: { preferenceType: 'old', expiresAt: Date.now() - 1000 },
    });

    const profile = await provider.getUserProfile();
    expect(profile.userId).toBe('windsander');
    expect(profile.properties).toEqual({ timezone: 'Asia/Shanghai' });
    expect(profile.preferences).toHaveLength(1);
    expect(profile.preferences[0]!.type).toBe('coffee-roast');
    expect(profile.preferences[0]!.value).toBe('浅烘焙');
  });

  it('getSkills：分类/关键词/标签过滤', async () => {
    await provider.storeMemory({ type: 'skill', content: '部署流程', metadata: { category: 'ops' } });
    await provider.storeMemory({ type: 'skill', content: '写作技巧', metadata: { category: 'writing' } });

    expect(await provider.getSkills()).toHaveLength(2);
    expect(await provider.getSkills({ category: 'ops' })).toHaveLength(1);
    expect((await provider.getSkills({ search: '写作' }))[0]!.category).toBe('writing');
  });

  it('getConversationHistory：会话类型/时间窗/主题/分页', async () => {
    const now = Date.now();
    await provider.storeExtraction({
      facts: [],
      skills: [],
      preferences: [],
      observations: [],
      episodes: [
        { episodeType: 'conversation', content: '讨论咖啡', startTime: now - 2000, endTime: now - 1000, context: 's1' },
        { episodeType: 'conversation', content: '讨论部署', startTime: now - 500, context: 's2' },
        { episodeType: 'task', content: '不是会话', startTime: now },
      ],
    });

    const all = await provider.getConversationHistory({});
    expect(all.totalCount).toBe(2); // task 被排除

    const bySession = await provider.getConversationHistory({ sessionIds: ['s1'] });
    expect(bySession.totalCount).toBe(1);

    const byTopic = await provider.getConversationHistory({ topic: '部署' });
    expect(byTopic.totalCount).toBe(1);

    const byTime = await provider.getConversationHistory({ endTime: now - 800 });
    expect(byTime.totalCount).toBe(1);

    const page = await provider.getConversationHistory({ limit: 1, offset: 1 });
    expect(page.episodes).toHaveLength(1);
    expect(page.totalCount).toBe(2);
  });

  it('extractMemory：缺省浅抽取会话原文，注入 extractor 合并深抽取', async () => {
    const session = {
      sessionId: 's1',
      userId: 'windsander',
      messages: [
        { role: 'user' as const, content: '我喜欢浅烘焙', timestamp: 1 },
        { role: 'assistant' as const, content: '已记住', timestamp: 2 },
      ],
      startTime: 1,
      endTime: 2,
    };

    const shallow = await provider.extractMemory(session);
    expect(shallow.episodes).toHaveLength(1);
    expect(shallow.episodes[0]!.content).toContain('我喜欢浅烘焙');
    expect(shallow.facts).toHaveLength(0); // 无 LLM，不伪造事实

    const deep = new HermesMemoryProvider(mebular, {
      userId: 'windsander',
      extractor: async () => ({
        facts: [{ subject: 'windsander', predicate: 'likes', object: '浅烘焙咖啡', confidence: 0.95 }],
      }),
    });
    const merged = await deep.extractMemory(session);
    expect(merged.episodes).toHaveLength(1); // 浅抽取仍在
    expect(merged.facts).toHaveLength(1);    // 深抽取并入

    // 落图回路
    const stored = await deep.storeExtraction(merged);
    expect(stored).toHaveLength(2);
    const retrieved = await provider.retrieveMemory({ query: '浅烘焙' });
    expect(retrieved.totalMatches).toBeGreaterThanOrEqual(2);
  });
});
