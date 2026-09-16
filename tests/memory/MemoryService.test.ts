// MemoryService（G6.1 / D33）：记忆能力唯一实现的直接测试
//
// 覆盖 write（五类）/ query / search / profile / skills / history / graph /
// import / status / sync；并验证 provider 委托后行为一致。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';

describe('MemoryService', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-service-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeService(deviceId = 'device-A'): Promise<{ app: Mebular; service: MemoryService }> {
    const app = new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await app.initialize();
    return { app, service: new MemoryService(app) };
  }

  it('write：五类写入可写可查，preference/skill 语义正确', async () => {
    const { app, service } = await makeService();
    const stored = await service.write([
      { type: 'fact', content: '咖啡因会提神' },
      { type: 'preference', content: '深色主题', metadata: { preferenceType: 'theme' } },
      { type: 'episode', content: '会议记录：讨论排期', metadata: { episodeType: 'conversation' } },
      { type: 'observation', content: '观察到用户常在夜间工作' },
      { type: 'skill', content: '跑测试\n先 build 再 test', metadata: { category: 'ops' } },
    ]);
    expect(stored).toHaveLength(5);
    expect(stored.map((s) => s.type)).toEqual(['fact', 'preference', 'episode', 'observation', 'skill']);

    // preference 以 Fact + preference 标签承载
    const prefs = await service.query({ types: ['preference'] });
    expect(prefs.memories).toHaveLength(1);
    expect(prefs.memories[0]!.content).toContain('深色主题');

    // skill：名称取首行、分类生效
    const skills = await service.skills({ category: 'ops' });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('跑测试');

    await app.shutdown();
  });

  it('query：关键词命中 + types/limit 过滤；search：includeRelations 出关系', async () => {
    const { app, service } = await makeService();
    const [fact, episode] = await service.write([
      { type: 'fact', content: 'Mebular 使用向量时钟' },
      { type: 'episode', content: '讨论同步协议', metadata: { episodeType: 'conversation' } },
    ]);
    await app.graph.createEdge(fact!.id, episode!.id, 'related_to');

    const q = await service.query({ query: '向量时钟' });
    expect(q.totalMatches).toBe(1);
    expect(q.memories[0]!.content).toContain('向量时钟');

    const s = await service.search({ query: '向量时钟', includeRelations: true });
    expect(s.memories).toHaveLength(1);
    expect(s.relations.length).toBeGreaterThanOrEqual(1);
    expect(s.relations[0]!.targetId).toBe(episode!.id);

    await app.shutdown();
  });

  it('profile / history：偏好画像与会话历史', async () => {
    const { app, service } = await makeService();
    await service.write([
      { type: 'preference', content: '拿铁', metadata: { preferenceType: 'drink', confidence: 0.8 } },
      { type: 'episode', content: '对话 A 内容', metadata: { episodeType: 'conversation' } },
    ]);
    const profile = await service.profile();
    expect(profile.userId).toBe('user');
    expect(profile.preferences.some((p) => p.type === 'drink' && p.value === '拿铁')).toBe(true);

    const history = await service.history({});
    expect(history.totalCount).toBe(1);
    expect(history.episodes[0]!.content.episodeType).toBe('conversation');

    await app.shutdown();
  });

  it('graph：从起点 traverse', async () => {
    const { app, service } = await makeService();
    const [a, b] = await service.write([
      { type: 'fact', content: 'A' },
      { type: 'fact', content: 'B' },
    ]);
    await app.graph.createEdge(a!.id, b!.id, 'related_to');
    const result = await service.graph(a!.id, { maxDepth: 1 });
    expect(result.visitedNodes.map((n) => n.id).sort()).toEqual([a!.id, b!.id].sort());

    await app.shutdown();
  });

  it('import：经内置适配器落图并带幂等', async () => {
    const { app, service } = await makeService();
    const first = await service.import({ kind: 'kv', data: { theme: 'dark', lang: 'zh' }, origin: 'kv-src' });
    expect(first.nodesCreated).toBe(2);
    const second = await service.import({ kind: 'kv', data: { theme: 'dark', lang: 'zh' }, origin: 'kv-src' });
    expect(second.skipped).toBe(2);

    await app.shutdown();
  });

  it('status：设备/计数/状态哈希/开关字段', async () => {
    const { app, service } = await makeService();
    await service.write([{ type: 'fact', content: 'x' }]);
    const status = await service.status();
    expect(status.deviceId).toBe('device-A');
    expect(status.nodeCount).toBe(1);
    expect(status.edgeCount).toBe(0);
    expect(status.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(status.running).toBe(false);
    expect(status.atRest).toBe(false);
    expect(status.semantic).toBe(false);
    expect(Number.isInteger(status.pendingEventCount)).toBe(true);
    await app.shutdown();
  });

  it('sync：连接对端并等待同步完成（InMemoryHub）', async () => {
    const hub = new InMemoryHub();
    const a = new Mebular({
      storagePath: join(dir, 'a.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        peerNamespacePolicy: { 'device-B': ['default'] },
      },
    });
    const b = new Mebular({
      storagePath: join(dir, 'b.jsonl'),
      deviceId: 'device-B',
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        peerNamespacePolicy: { 'device-A': ['default'] },
      },
    });
    await a.initialize();
    await b.initialize();
    const serviceA = new MemoryService(a);
    const serviceB = new MemoryService(b);
    const [written] = await serviceA.write([{ type: 'fact', content: '跨设备记忆' }]);

    const result = await serviceB.sync(a.node!.peerId.id);
    expect(result).toBeDefined();
    const found = await serviceB.query({ query: '跨设备记忆' });
    expect(found.memories.some((m) => m.id === written!.id)).toBe(true);

    await a.shutdown();
    await b.shutdown();
  });

  it('provider 薄壳：与 MemoryService 结果一致（不回退）', async () => {
    const { app, service } = await makeService();
    const provider = new HermesMemoryProvider(app);
    const stored = await provider.storeMemory({ type: 'preference', content: '深色主题', metadata: { preferenceType: 'theme' } });
    expect(await service.query({ types: ['preference'] }).then((r) => r.totalMatches)).toBe(1);
    expect(provider.getService()).toBeInstanceOf(MemoryService);
    expect(stored.type).toBe('preference');
    await app.shutdown();
  });
});
