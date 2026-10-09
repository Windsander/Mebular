// G-ML-1：记忆生命周期（删除=墓碑传播 / 归档=标记默认不召回、可逆）
//
// 覆盖：
//  1) 删除后默认不参与任何召回（query / search / profile / skills / history / graph），墓碑随事件同步；
//  2) 归档默认不召回 + 显式 includeArchived 可查 + 可解除（可逆、无损）；
//  3) 删除跨端一致（墓碑传播）；
//  4) 归档标记跨端一致（node_updated 传播）。
//
// 复用 MemoryService.test.ts 的两节点基建（共享 InMemoryHub + Per-peer 域策略）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { type EmbeddingProvider } from '../../src/memory/embedding.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';

jest.setTimeout(60000);

// G-ML-1r：确定性「语义」embedding（不依赖真实模型）——命中也走向量路径。
const SEM_CONCEPTS: string[][] = [['lifecycle', '生命周期']];
const fakeEmbedding: EmbeddingProvider = {
  id: 'fake-lifecycle',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return SEM_CONCEPTS.map((syns) => (syns.some((s) => lower.includes(s.toLowerCase())) ? 1 : 0));
    });
  },
};

describe('G-ML-1 生命周期：删除（墓碑）与归档（标记）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-lifecycle-'));
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

  /** G-ML-1r：启用假 embedding 的向量索引，令召回走向量路径。 */
  async function makeSemanticService(deviceId = 'device-A'): Promise<{ app: Mebular; service: MemoryService }> {
    const app = new Mebular({
      storagePath: join(dir, `${deviceId}-sem.jsonl`),
      deviceId,
      encryption: masterKeys,
      semantic: { enabled: true, provider: fakeEmbedding },
      sync: { autoSync: false },
    });
    await app.initialize();
    return { app, service: new MemoryService(app) };
  }

  it('删除：墓碑 + 默认不参与任何召回（query/search/profile/skills/history/graph）', async () => {
    const { app, service } = await makeService();
    const [fact] = await service.write([
      { type: 'fact', content: '删除候选事实' },
      { type: 'preference', content: '删除候选偏好', metadata: { preferenceType: 'theme' } },
      { type: 'skill', content: '删除候选技能\n步骤一', metadata: { category: 'ops' } },
      { type: 'episode', content: '删除候选会话', metadata: { episodeType: 'conversation' } },
    ]);
    // 删除前：四类都可召回
    expect((await service.query({ query: '删除候选' })).totalMatches).toBeGreaterThanOrEqual(4);
    expect((await service.profile()).preferences).toHaveLength(1);
    expect(await service.skills()).toHaveLength(1);
    expect((await service.history({})).totalCount).toBe(1);

    const all = await app.graph.listNodes({});
    const result = await service.delete(all.map((n) => n.id));
    expect(result.deleted).toHaveLength(all.length);
    expect(result.notFound).toHaveLength(0);

    // 删除后：全部不可召回
    expect((await service.query({ query: '删除候选' })).totalMatches).toBe(0);
    expect((await service.search({ query: '删除候选' })).memories).toHaveLength(0);
    expect((await service.query({ types: ['preference'] })).totalMatches).toBe(0);
    expect((await service.profile()).preferences).toHaveLength(0);
    expect(await service.skills()).toHaveLength(0);
    expect((await service.history({})).totalCount).toBe(0);
    // graph：起点仍可定位（core 语义），但已删节点不再作为可见节点返回
    const traversal = await service.graph(fact!.id, { maxDepth: 1 });
    expect(traversal.visitedNodes.filter((n) => n.deletedAt === undefined)).toHaveLength(0);
    // 墓碑落盘且不可再取（getTyped 口径）
    const tomb = await app.graph.getNode(fact!.id);
    expect(typeof tomb?.deletedAt).toBe('number');

    await app.shutdown();
  });

  it('归档：默认不召回 + includeArchived 可查 + 解除归档可逆', async () => {
    const { app, service } = await makeService();
    const [fact, skill] = await service.write([
      { type: 'fact', content: '归档候选事实' },
      { type: 'skill', content: '归档候选技能\n步骤一', metadata: { category: 'ops' } },
    ]);
    expect((await service.query({ query: '归档候选' })).totalMatches).toBe(2);

    const archived = await service.archive([fact!.id, skill!.id], true);
    expect(archived.archived).toEqual([fact!.id, skill!.id]);
    expect(archived.unarchived).toHaveLength(0);

    // 默认：归档不参与召回（keyword / 列表 / 技能）
    expect((await service.query({ query: '归档候选事实' })).totalMatches).toBe(0);
    expect((await service.search({ query: '归档候选事实' })).memories).toHaveLength(0);
    expect((await service.query({ types: ['fact'] })).totalMatches).toBe(0);
    expect((await service.skills()).map((s) => s.name)).not.toContain('归档候选技能');
    // 显式 includeArchived：可查（无损，仍在图里）
    const visible = await service.query({ query: '归档候选事实', includeArchived: true });
    expect(visible.totalMatches).toBe(1);
    expect(visible.memories[0]!.id).toBe(fact!.id);
    expect((await service.skills({ includeArchived: true })).map((s) => s.name)).toContain('归档候选技能');
    // 归档标记随节点落盘（metadata.archivedAt）
    const stored = await app.graph.getNode(fact!.id);
    expect(typeof (stored?.metadata as { archivedAt?: number })?.archivedAt).toBe('number');

    // 解除归档：可逆（默认召回恢复；archivedAt 被清除）
    const unarchived = await service.archive([fact!.id], false);
    expect(unarchived.unarchived).toEqual([fact!.id]);
    expect((await service.query({ query: '归档候选事实' })).totalMatches).toBe(1);
    const cleared = await app.graph.getNode(fact!.id);
    expect((cleared?.metadata as { archivedAt?: number })?.archivedAt).toBeUndefined();

    await app.shutdown();
  });

  it('归档不覆盖墓碑：已删除节点归档被跳过（skipped）', async () => {
    const { app, service } = await makeService();
    const [fact] = await service.write([{ type: 'fact', content: '先删后归档' }]);
    await service.delete([fact!.id]);
    const result = await service.archive([fact!.id], true);
    expect(result.archived).toHaveLength(0);
    expect(result.skipped).toEqual([fact!.id]);
    await app.shutdown();
  });

  it('向量路径：归档默认不召回、includeArchived 可查；索引条目保留（G-ML-1r）', async () => {
    const { app, service } = await makeSemanticService();
    expect(app.semanticVectorIndex).not.toBeNull();
    const [fact] = await service.write([{ type: 'fact', content: 'lifecycle vector object' }]);
    // 建索引 + 默认向量召回命中
    expect((await service.query({ query: 'lifecycle' })).totalMatches).toBe(1);

    await service.archive([fact!.id], true);
    // 归档期间用**新实例**触发一次索引对账（等价于同步完成 / 重启后的 stale 重建）：
    // 修复前 listAllNodes 默认过滤会把归档节点当缺失剪除。
    const observer = new MemoryStore(app.graph, app.semanticVectorIndex ?? undefined);
    await observer.vectorQuery('lifecycle');
    expect(app.semanticVectorIndex?.has?.(fact!.id)).toBe(true);
    // 默认不召回；includeArchived 仍含，且 relevance>0 证明是**向量命中**而非关键词回退
    expect((await service.query({ query: 'lifecycle' })).totalMatches).toBe(0);
    const withArchived = await service.query({ query: 'lifecycle', includeArchived: true });
    expect(withArchived.totalMatches).toBe(1);
    expect(withArchived.memories[0]!.relevance).toBeGreaterThan(0);

    await app.shutdown();
  });

  it('向量路径：归档期间索引对账后，解除归档仍恢复默认召回（无永久缺失，G-ML-1r）', async () => {
    const { app, service } = await makeSemanticService();
    const [fact] = await service.write([{ type: 'fact', content: 'lifecycle vector object' }]);
    await service.query({ query: 'lifecycle' }); // 建索引
    await service.archive([fact!.id], true);
    // 归档期间对账（剪枝路径）
    const observer = new MemoryStore(app.graph, app.semanticVectorIndex ?? undefined);
    await observer.vectorQuery('lifecycle');

    await service.archive([fact!.id], false); // 解除归档
    // 1b 判据：解除归档后索引必须仍含该节点（否则永久缺失）
    expect(app.semanticVectorIndex?.has?.(fact!.id)).toBe(true);
    expect((await service.query({ query: 'lifecycle' })).totalMatches).toBe(1);

    await app.shutdown();
  });

  it('向量路径：reindexVectorIndex 后归档节点仍可 includeArchived 查到（G-ML-1r）', async () => {
    const { app, service } = await makeSemanticService();
    const [fact] = await service.write([{ type: 'fact', content: 'lifecycle vector object' }]);
    await service.query({ query: 'lifecycle' }); // 建索引
    await service.archive([fact!.id], true);
    await service.query({ query: 'lifecycle' }); // 触发剪枝路径（修复前会把归档节点从索引移除）

    const store = new MemoryStore(app.graph, app.semanticVectorIndex ?? undefined);
    expect(await store.reindexVectorIndex()).toBeGreaterThanOrEqual(1);
    expect(app.semanticVectorIndex?.has?.(fact!.id)).toBe(true);
    expect((await service.query({ query: 'lifecycle', includeArchived: true })).totalMatches).toBe(1);

    await app.shutdown();
  });

  it('graph：归档节点不得经 visitedEdges 端点泄漏（两端都在可见集才保留边，G-ML-1r）', async () => {
    const { app, service } = await makeService();
    const [src] = await service.write([{ type: 'fact', content: '图源节点' }]);
    const [tgt] = await service.write([{ type: 'fact', content: '图目标节点' }]);
    await app.graph.createEdge(src!.id, tgt!.id, 'related_to');

    await service.archive([tgt!.id], true);
    const t = await service.graph(src!.id, { maxDepth: 1 });
    const exposed = new Set<string>();
    for (const e of t.visitedEdges) { exposed.add(e.source); exposed.add(e.target); }
    expect(t.visitedNodes.some((n) => n.id === tgt!.id)).toBe(false);
    expect(exposed.has(tgt!.id)).toBe(false);

    // 显式 includeArchived：归档端点可见（边保留）
    const withArchived = await service.graph(src!.id, { maxDepth: 1, includeArchived: true });
    const exposed2 = new Set<string>();
    for (const e of withArchived.visitedEdges) { exposed2.add(e.source); exposed2.add(e.target); }
    expect(withArchived.visitedNodes.some((n) => n.id === tgt!.id)).toBe(true);
    expect(exposed2.has(tgt!.id)).toBe(true);

    await app.shutdown();
  });

  /** 轮询直到条件成立（禁 sleep 碰运气；超时=失败）。 */
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15000, pollMs = 100): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** 建两节点（pushOnWrite 开：写入/删除/归档自动推送），首次握手双端 settle。 */
  async function makePair(suffix = ''): Promise<{ a: Mebular; b: Mebular; sa: MemoryService; sb: MemoryService }> {
    const hub = new InMemoryHub();
    const common = { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20 };
    const a = new Mebular({
      storagePath: join(dir, `a${suffix}.jsonl`),
      deviceId: 'device-A',
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { ...common, peerNamespacePolicy: { 'device-B': ['default'] } },
    });
    const b = new Mebular({
      storagePath: join(dir, `b${suffix}.jsonl`),
      deviceId: 'device-B',
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { ...common, peerNamespacePolicy: { 'device-A': ['default'] } },
    });
    await a.initialize();
    await b.initialize();
    const both = new Promise<void>((resolve) => {
      let count = 0;
      const done = (): void => { count += 1; if (count === 2) resolve(); };
      a.sync.on('sync-completed', done);
      b.sync.on('sync-completed', done);
    });
    await b.node!.connectToPeer(a.node!.peerId);
    await both;
    return { a, b, sa: new MemoryService(a), sb: new MemoryService(b) };
  }

  it('删除跨端一致：墓碑随事件传播，对端默认不召回（两端墓碑一致）', async () => {
    const { a, b, sa, sb } = await makePair();
    const [written] = await sa.write([{ type: 'fact', content: '跨端删除对象' }]);
    expect(await waitFor(async () => (await sb.query({ query: '跨端删除对象' })).totalMatches === 1)).toBe(true);

    await sa.delete([written!.id]);
    const converged = await waitFor(async () =>
      (await sb.query({ query: '跨端删除对象' })).totalMatches === 0
      && typeof (await b.graph.getNode(written!.id))?.deletedAt === 'number');
    expect(converged).toBe(true);
    expect((await b.graph.getNode(written!.id))?.deletedAt).toBe((await a.graph.getNode(written!.id))?.deletedAt);

    await a.shutdown();
    await b.shutdown();
  });

  it('归档跨端一致：archivedAt 随 node_updated 传播，对端默认不召回、显式可查', async () => {
    const { a, b, sa, sb } = await makePair('-arch');
    const [written] = await sa.write([{ type: 'fact', content: '跨端归档对象' }]);
    expect(await waitFor(async () => (await sb.query({ query: '跨端归档对象' })).totalMatches === 1)).toBe(true);

    await sa.archive([written!.id], true);
    const converged = await waitFor(async () =>
      (await sb.query({ query: '跨端归档对象' })).totalMatches === 0
      && (await sb.query({ query: '跨端归档对象', includeArchived: true })).totalMatches === 1);
    expect(converged).toBe(true);
    const aArchivedAt = (await a.graph.getNode(written!.id))?.metadata?.archivedAt;
    const bArchivedAt = (await b.graph.getNode(written!.id))?.metadata?.archivedAt;
    expect(typeof bArchivedAt).toBe('number');
    // G-ML-1r：两端 archivedAt 值必须相等（node_updated 传播的是同一节点版本）
    expect(bArchivedAt).toBe(aArchivedAt);

    await a.shutdown();
    await b.shutdown();
  });
});
