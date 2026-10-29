// Runtime 跨设备 / 跨 Agent 验收（真实 Mebular + SyncManager + EventLog + GraphStore）。
//
// 两个临时 home、同一用户主密钥、不同 deviceId/hostKey。同步走真实 SecureChannel
// + SyncManager.syncWithDevice/acceptSync，不使用纯函数或内存假图。
//
// 覆盖：
// - MemoryRecord / Compact / SelfRecord / 云 Checkpoint 跨设备；
// - RawChunk / RecallTrace / 本地 Checkpoint 不跨设备；
// - 删除墓碑、归档、compact stale；
// - 同云共享记录跨 Agent 可见，Self/Checkpoint 按 agentId 隔离；
// - 普通 query/history/graph 不返回内部对象；
// - 模式切换不迁移、离线恢复、重复同步/重复 ingest 幂等、同步后索引重建。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import type { VectorIndex, VectorIndexHit } from '../../src/memory/VectorIndex.js';
import { RuntimeService } from '../../src/runtime/index.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import type { SyncPeer, SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';
import type { Node } from '../../src/types/index.js';

interface MasterKeys {
  userMasterKey: Uint8Array;
  userMasterPrivateKey: CryptoKey;
}

interface Device {
  app: Mebular;
  memory: MemoryService;
  runtime: RuntimeService;
  home: string;
  runtimeDir: string;
}

interface DeviceOptions {
  mode?: 'mcp' | 'immersive';
  runtime?: Record<string, unknown>;
  vectorIndex?: VectorIndex;
  now?: () => number;
}

const SECRET_RAW = 'RAW-SECRET-MARKER-9f3a-不要跨设备';

class KeywordVectorIndex implements VectorIndex {
  private readonly entries = new Map<string, Node>();

  get size(): number {
    return this.entries.size;
  }

  async index(node: Node): Promise<void> {
    this.entries.set(node.id, node);
  }

  async remove(nodeId: string): Promise<void> {
    this.entries.delete(nodeId);
  }

  async query(text: string, k: number): Promise<VectorIndexHit[]> {
    const needle = text.toLowerCase();
    return [...this.entries.values()]
      .filter((node) => JSON.stringify(node.content).toLowerCase().includes(needle))
      .slice(0, k)
      .map((node) => ({ nodeId: node.id, score: 1 }));
  }

  has(nodeId: string): boolean {
    return this.entries.has(nodeId);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }
}

describe('Runtime 跨设备与跨 Agent（真实同步）', () => {
  let dir: string;
  let hub: InMemoryHub;
  let master: MasterKeys;
  let devices: Device[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-runtime-cross-'));
    hub = new InMemoryHub();
    const key = await new IdentityManager().generateUserMasterKey();
    master = { userMasterKey: key.publicKey, userMasterPrivateKey: key.privateKey };
    devices = [];
  });

  afterEach(async () => {
    for (const device of devices.slice().reverse()) {
      await device.runtime.dispose().catch(() => undefined);
      await device.app.shutdown().catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function makeDevice(deviceId: string, options: DeviceOptions = {}): Promise<Device> {
    const home = join(dir, deviceId);
    const runtimeDir = join(home, 'runtime');
    const app = new Mebular({
      storagePath: join(home, 'device.jsonl'),
      deviceId,
      encryption: master,
      sync: {
        autoSync: false,
        syncStatePath: join(home, 'sync-state.json'),
      },
    });
    await app.initialize();
    const memory = new MemoryService(app, options.vectorIndex ? { vectorIndex: options.vectorIndex } : {});
    const runtime = new RuntimeService(app, {
      mode: options.mode ?? 'immersive',
      memoryService: memory,
      runtimeDir,
      hostKey: home,
      profileId: deviceId,
      agentId: 'opencode',
      runtime: options.runtime ?? {},
      ...(options.now ? { now: options.now } : {}),
    });
    await runtime.init();
    const device: Device = { app, memory, runtime, home, runtimeDir };
    devices.push(device);
    return device;
  }

  function peerIdOf(device: Device): PeerId {
    const identity = device.app.identity.getDeviceKey(device.app.deviceId);
    if (!identity) throw new Error(`missing device identity: ${device.app.deviceId}`);
    return {
      id: device.app.deviceId,
      multihash: identity.publicKey,
      pubKey: identity.publicKey,
    };
  }

  function syncPeerOf(device: Device): SyncPeer {
    return { deviceId: device.app.deviceId, publicKey: peerIdOf(device).pubKey };
  }

  async function syncDevices(
    a: Device,
    b: Device,
    direction: 'push' | 'pull' | 'bidirectional' = 'bidirectional',
  ): Promise<[SyncResult, SyncResult]> {
    const [connA, connB] = hub.createLinkedPair(peerIdOf(a), peerIdOf(b));
    const channelA = new SecureChannelImpl(connA);
    const channelB = new SecureChannelImpl(connB);
    await Promise.all([channelA.start(), channelB.start()]);
    const transportA = new SecureChannelSyncTransport(channelA);
    const transportB = new SecureChannelSyncTransport(channelB);
    try {
      return await Promise.all([
        a.app.sync.syncWithDevice(transportA, syncPeerOf(b), { direction }),
        b.app.sync.acceptSync(transportB, syncPeerOf(a)),
      ]);
    } finally {
      await Promise.allSettled([transportA.close(), transportB.close()]);
    }
  }

  async function allNodes(device: Device): Promise<Node[]> {
    return device.app.graph.listNodes({});
  }

  it('记录/compact/self/云 checkpoint 跨设备；raw/trace/本地 checkpoint 不跨设备', async () => {
    const a = await makeDevice('device-A', {
      runtime: { capture: 'local', checkpoint: { sync: 'cloud' } },
    });
    const b = await makeDevice('device-B', {
      runtime: { capture: 'off' },
    });

    const [projectFact] = await a.memory.write([
      { type: 'fact', content: '项目使用 TypeScript', metadata: { namespace: 'notes' } },
    ]);
    const [episode] = await a.memory.write([
      {
        type: 'episode',
        content: '讨论了 runtime 跨设备同步',
        metadata: { episodeType: 'conversation', namespace: 'notes' },
      },
    ]);
    const [otherFact] = await a.memory.write([
      { type: 'fact', content: '其他域事实', metadata: { namespace: 'other' } },
    ]);

    const ingest = await a.runtime.ingest({
      requestId: 'req_shared_1',
      agentId: 'opencode',
      threadId: 'th_shared',
      namespace: 'notes',
      capture: 'local',
      extractor: 'host',
      chunks: [{ role: 'user', text: SECRET_RAW }],
      candidates: [
        {
          kind: 'preference',
          data: { entity: 'user', preferenceType: 'theme', value: 'dark' },
          namespace: 'notes',
        },
        {
          kind: 'fact',
          data: { subject: 'user', predicate: 'editor', object: 'Neovim' },
          namespace: 'notes',
          relatedTo: [projectFact!.id],
        },
      ],
    });
    expect(ingest.records).toHaveLength(2);
    expect(ingest.rawChunkIds).toHaveLength(1);
    const [preferenceRecord, editorRecord] = ingest.records;

    // 关系记忆：同一 namespace 内的实体/事实关系仍属于共享 MemoryRecord。
    const preferenceNode = await a.app.graph.getNode(preferenceRecord!.id);
    const runtimeMetadata = (preferenceNode?.metadata as Record<string, unknown> | undefined)?.runtime;
    await a.app.graph.updateNode(preferenceRecord!.id, {
      metadata: {
        ...(preferenceNode?.metadata ?? {}),
        runtime: { ...(runtimeMetadata as Record<string, unknown>), visibility: 'relationship' },
      },
    });

    const compact = await a.runtime.compact({ namespace: 'notes' });
    expect(compact.compactId).toBeTruthy();
    const self = await a.runtime.putSelf('opencode', {
      displayName: 'OpenCode',
      goals: ['帮助用户'],
    });
    expect(self.self).toMatchObject({ revision: 1, sync: 'cloud' });

    const cloud = await a.runtime.putCheckpoint('th_shared', {
      agentId: 'opencode',
      state: { cursor: 2, plan: ['sync'] },
      summary: '第二步',
      sync: 'cloud',
    });
    expect(cloud.checkpoint).toMatchObject({ revision: 1, sync: 'cloud' });
    const local = await a.runtime.putCheckpoint('th_local_only', {
      agentId: 'opencode',
      state: { cursor: 9 },
      sync: 'local',
    });
    expect(local.checkpoint).toMatchObject({ revision: 1, sync: 'local' });

    const recallA = await a.runtime.recall({
      query: 'Neovim',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(recallA.records.map((record) => record.id)).toContain(editorRecord!.id);
    expect(recallA.traceId).toMatch(/^tr_/);
    expect((await a.runtime.status()).counts.localRawChunks).toBe(1);

    const [resultA, resultB] = await syncDevices(a, b);
    expect(resultA.receivedEvents + resultB.receivedEvents).toBeGreaterThan(0);

    // 共享记录/compact/self/云 checkpoint 到达 B。
    expect(await b.app.graph.getNode(editorRecord!.id)).not.toBeNull();
    expect(await b.app.graph.getNode(projectFact!.id)).not.toBeNull();
    expect(await b.app.graph.getNode(otherFact!.id)).not.toBeNull();
    expect(await b.app.graph.getNode(compact.compactId!)).not.toBeNull();

    const recallB = await b.runtime.recall({
      query: 'Neovim',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(recallB.records.map((record) => record.id)).toContain(editorRecord!.id);
    expect(recallB.records.map((record) => record.id)).not.toContain(compact.compactId);

    const compactB = await b.runtime.getCompact(compact.compactId!);
    expect(compactB).toMatchObject({
      id: compact.compactId,
      namespace: 'notes',
      stale: false,
    });
    expect(compactB!.sourceIds.sort()).toEqual(compact.sourceIds.slice().sort());

    expect((await b.runtime.getSelf('opencode')).self).toMatchObject({
      displayName: 'OpenCode',
      revision: 1,
      sync: 'cloud',
    });
    expect((await b.runtime.getCheckpoint('th_shared', 'opencode')).checkpoint).toMatchObject({
      revision: 1,
      state: { cursor: 2, plan: ['sync'] },
      sync: 'cloud',
    });

    // 本地 checkpoint 只在 A 的本机文件中，B 没有图节点也没有本地文件。
    expect(await b.runtime.getCheckpoint('th_local_only', 'opencode', { sync: 'local' }))
      .toEqual({ checkpoint: null });
    expect(await b.runtime.getCheckpoint('th_local_only', 'opencode'))
      .toEqual({ checkpoint: null });
    expect(await a.runtime.getCheckpoint('th_local_only', 'opencode', { sync: 'local' }))
      .toMatchObject({ checkpoint: { state: { cursor: 9 }, sync: 'local' } });
    const bCheckpointNodes = await b.app.graph.listNodes({ type: 'context_checkpoint' });
    expect(bCheckpointNodes.map((node) => (node.content as { threadId?: string }).threadId))
      .not.toContain('th_local_only');

    // Raw/Trace 不跨设备：B 没收到 A 的 raw/trace；B 自己的 recall 只生成本机 trace。
    const statusB = await b.runtime.status();
    expect(statusB.counts.localRawChunks).toBe(0);
    expect(await b.runtime.getTrace(recallA.traceId!)).toBeNull();
    const tracesB = await b.runtime.listTraces();
    expect(tracesB.every((trace) => trace.hostId === statusB.identity.hostId)).toBe(true);
    expect(tracesB.map((trace) => trace.id)).not.toContain(recallA.traceId);
    expect(await b.app.graph.listNodes({ type: 'raw_chunk' })).toHaveLength(0);
    expect(await b.app.graph.listNodes({ type: 'recall_trace' })).toHaveLength(0);
    // Raw 文本既不进事件日志，也不出现在对端任何节点内容里。
    expect(JSON.stringify(await a.app.eventLog.listEvents())).not.toContain(SECRET_RAW);
    expect(JSON.stringify(await b.app.eventLog.listEvents())).not.toContain(SECRET_RAW);
    expect(JSON.stringify(await b.app.graph.listNodes({}))).not.toContain(SECRET_RAW);

    // 普通 memory_query/history/graph 不返回内部对象。
    const publicQuery = await b.memory.query({});
    const publicIds = publicQuery.memories.map((memory) => memory.id);
    expect(publicIds).toEqual(expect.arrayContaining([projectFact!.id, episode!.id, otherFact!.id]));
    expect(publicIds).not.toContain(compact.compactId);
    expect(publicIds.some((id) => bCheckpointNodes.some((node) => node.id === id))).toBe(false);
    const selfNodes = await b.app.graph.listNodes({ type: 'self_record' });
    expect(publicIds.some((id) => selfNodes.some((node) => node.id === id))).toBe(false);

    const history = await b.memory.history({});
    expect(history.episodes.map((entry) => entry.id)).toEqual([episode!.id]);
    expect(history.totalCount).toBe(1);

    const traversal = await b.memory.graph(editorRecord!.id, { maxDepth: 3 });
    expect(traversal.visitedNodes.map((node) => node.id)).not.toContain(compact.compactId);
    expect(traversal.visitedNodes.map((node) => node.id))
      .not.toContain(selfNodes[0]!.id);
    await expect(b.memory.graph(compact.compactId!)).rejects.toMatchObject({ code: 'INTERNAL_OBJECT' });

    // 共享/关系记录对所有 Agent 可见（agentId 只做 provenance，不做读隔离）。
    const helperRecall = await b.runtime.recall({
      query: 'dark',
      agentId: 'helper',
      namespaces: ['notes'],
    });
    expect(helperRecall.records.map((record) => record.id)).toContain(preferenceRecord!.id);
  });

  it('删除墓碑、归档跨设备生效；compact 标记 stale；本地 checkpoint 不泄漏', async () => {
    const a = await makeDevice('device-A', {
      runtime: { checkpoint: { sync: 'cloud' } },
    });
    const b = await makeDevice('device-B');

    const [alpha, beta, gamma] = await a.memory.write([
      { type: 'fact', content: 'alpha 事实：发布前跑测试', metadata: { namespace: 'notes' } },
      { type: 'fact', content: 'beta 事实：旧构建缓存', metadata: { namespace: 'notes' } },
      { type: 'fact', content: 'gamma 事实：保留记录', metadata: { namespace: 'notes' } },
    ]);
    const compact = await a.runtime.compact({ namespace: 'notes' });
    expect(compact.compactId).toBeTruthy();

    await syncDevices(a, b);
    expect((await b.runtime.recall({
      query: 'alpha',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records.map((record) => record.id)).toEqual([alpha!.id]);
    expect((await b.runtime.recall({
      query: 'gamma',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records.map((record) => record.id)).toEqual([gamma!.id]);

    // A：墓碑 + 归档；本地 checkpoint 只写本机。
    const deleted = await a.memory.delete([alpha!.id]);
    expect(deleted.deleted).toEqual([alpha!.id]);
    const archived = await a.memory.archive([beta!.id]);
    expect(archived.archived).toEqual([beta!.id]);
    await a.runtime.putCheckpoint('th_local_deleted', {
      agentId: 'opencode',
      state: { secret: 'local-only-state' },
      sync: 'local',
    });

    await syncDevices(a, b);

    // B：墓碑与 archivedAt 都随事件到达。
    const alphaB = await b.app.graph.getNode(alpha!.id);
    expect(alphaB?.deletedAt).toEqual(expect.any(Number));
    const betaB = await b.app.graph.getNode(beta!.id);
    expect((betaB?.metadata as Record<string, unknown> | undefined)?.archivedAt)
      .toEqual(expect.any(Number));

    expect((await b.runtime.recall({
      query: 'alpha',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records).toEqual([]);
    expect((await b.runtime.recall({
      query: 'beta',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records).toEqual([]);
    // 未删除/未归档的 gamma 仍可召回。
    expect((await b.runtime.recall({
      query: 'gamma',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records.map((record) => record.id)).toEqual([gamma!.id]);

    // compact 不自动删除；源记录墓碑/更新后对端读取为 stale。
    const compactB = await b.runtime.getCompact(compact.compactId!);
    expect(compactB).not.toBeNull();
    expect(compactB!.stale).toBe(true);
    expect(await b.app.graph.getNode(compact.compactId!)).not.toBeNull();

    // 本地 checkpoint 不跨设备。
    expect(await b.runtime.getCheckpoint('th_local_deleted', 'opencode', { sync: 'local' }))
      .toEqual({ checkpoint: null });
    expect(await b.runtime.getCheckpoint('th_local_deleted', 'opencode'))
      .toEqual({ checkpoint: null });
    expect((await b.runtime.status()).counts.checkpoints).toBe(0);
  });

  it('跨 Agent：共享记录可见，Self/Checkpoint 按 agentId 隔离，内部对象不进入普通查询', async () => {
    const a = await makeDevice('device-A', {
      runtime: { checkpoint: { sync: 'cloud' } },
    });
    const b = await makeDevice('device-B', {
      mode: 'mcp',
      runtime: { checkpoint: { sync: 'local' } },
    });

    const [shared] = await a.memory.write([
      { type: 'fact', content: '共享约定：发布前跑测试', metadata: { namespace: 'notes' } },
    ]);
    const ingested = await a.runtime.ingest({
      requestId: 'req_boundary',
      agentId: 'opencode',
      threadId: 'th_task',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates: [{
        kind: 'fact',
        data: { subject: 'user', predicate: 'timezone', object: 'UTC' },
        namespace: 'notes',
      }],
    });
    const boundaryRecord = ingested.records[0]!;

    await a.runtime.putSelf('opencode', {
      displayName: 'OpenCode',
      goals: ['A 的目标'],
    });
    await a.runtime.putSelf('helper', {
      displayName: 'Helper',
      goals: ['B 的目标'],
    });
    await a.runtime.putCheckpoint('th_task', {
      agentId: 'opencode',
      state: { owner: 'opencode' },
      summary: 'opencode task',
      sync: 'cloud',
    });
    await a.runtime.putCheckpoint('th_task', {
      agentId: 'helper',
      state: { owner: 'helper' },
      summary: 'helper task',
      sync: 'cloud',
    });
    const compact = await a.runtime.compact({ namespace: 'notes' });

    await syncDevices(a, b);

    // B 处于轻量模式：写端点拒绝，读端点仍可用。
    expect(b.runtime.getMode()).toBe('mcp');
    await expect(b.runtime.ingest({
      agentId: 'opencode',
      capture: 'off',
      chunks: [{ role: 'user', text: 'mcp 模式不应写入' }],
    })).rejects.toMatchObject({ code: 'mode_mismatch', status: 409 });

    // 同云共享记录对两个 Agent 都可见。
    for (const agentId of ['opencode', 'helper']) {
      const recalled = await b.runtime.recall({
        query: 'UTC',
        agentId,
        namespaces: ['notes'],
      });
      expect(recalled.records.map((record) => record.id)).toContain(boundaryRecord.id);
      const generic = await b.runtime.recall({
        query: '共享约定',
        agentId,
        namespaces: ['notes'],
      });
      expect(generic.records.map((record) => record.id)).toContain(shared!.id);
    }

    // SelfRecord 按 agentId 隔离。
    expect((await b.runtime.getSelf('opencode')).self).toMatchObject({
      displayName: 'OpenCode',
      goals: ['A 的目标'],
      agentId: 'opencode',
    });
    expect((await b.runtime.getSelf('helper')).self).toMatchObject({
      displayName: 'Helper',
      goals: ['B 的目标'],
      agentId: 'helper',
    });
    expect((await b.runtime.getSelf('other-agent')).self).toBeNull();

    // 相同 threadId、不同 Agent 的 checkpoint 不串线。
    expect((await b.runtime.getCheckpoint('th_task', 'opencode')).checkpoint).toMatchObject({
      state: { owner: 'opencode' },
      summary: 'opencode task',
    });
    expect((await b.runtime.getCheckpoint('th_task', 'helper')).checkpoint).toMatchObject({
      state: { owner: 'helper' },
      summary: 'helper task',
    });
    expect((await b.runtime.getCheckpoint('th_task', 'other-agent')).checkpoint).toBeNull();

    const context = await b.runtime.context({
      agentId: 'opencode',
      threadId: 'th_task',
      query: 'UTC',
      namespaces: ['notes'],
      includeSelf: true,
      includeCheckpoint: true,
    });
    const selfBlock = context.blocks.find((block) => block.kind === 'self')!;
    const checkpointBlock = context.blocks.find((block) => block.kind === 'checkpoint')!;
    expect(selfBlock.content).toContain('displayName: OpenCode');
    expect(selfBlock.content).not.toContain('displayName: Helper');
    expect(checkpointBlock.content).toContain('"owner":"opencode"');
    expect(checkpointBlock.content).not.toContain('"owner":"helper"');

    // 内部对象不进入普通 query/history/graph。
    const selfNodes = await b.app.graph.listNodes({ type: 'self_record' });
    const checkpointNodes = await b.app.graph.listNodes({ type: 'context_checkpoint' });
    expect(selfNodes.length).toBeGreaterThanOrEqual(2);
    expect(checkpointNodes.length).toBeGreaterThanOrEqual(2);
    const internalIds = new Set([
      ...selfNodes.map((node) => node.id),
      ...checkpointNodes.map((node) => node.id),
      compact.compactId!,
    ]);
    const publicIds = (await b.memory.query({})).memories.map((memory) => memory.id);
    expect(publicIds.some((id) => internalIds.has(id))).toBe(false);
    const history = await b.memory.history({});
    expect(history.episodes.some((entry) => internalIds.has(entry.id))).toBe(false);
    await expect(b.memory.graph(compact.compactId!)).rejects.toMatchObject({ code: 'INTERNAL_OBJECT' });
  });

  it('云 checkpoint 跨设备 revision/lease：租约未过期拒绝接管，过期后可接管并同步新 revision', async () => {
    let now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const a = await makeDevice('device-A', {
      runtime: { checkpoint: { sync: 'cloud' } },
      now: () => now,
    });
    const b = await makeDevice('device-B', {
      runtime: { checkpoint: { sync: 'cloud' } },
      now: () => now,
    });

    const first = await a.runtime.putCheckpoint('th_lease', {
      agentId: 'opencode',
      state: { version: 1 },
      sync: 'cloud',
    });
    expect(first.checkpoint).toMatchObject({ revision: 1, sync: 'cloud' });

    await syncDevices(a, b);
    expect((await b.runtime.getCheckpoint('th_lease', 'opencode')).checkpoint).toMatchObject({
      revision: 1,
      state: { version: 1 },
    });

    // A 的 60s 租约仍在：B 不能直接接管。
    await expect(b.runtime.putCheckpoint('th_lease', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { version: 2 },
      sync: 'cloud',
    })).rejects.toMatchObject({ code: 'checkpoint_lease_held', status: 409 });

    // 租约过期后 B 以 expectedRevision=1 接管，revision 单调递增。
    now += 61_000;
    const second = await b.runtime.putCheckpoint('th_lease', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { version: 2 },
      sync: 'cloud',
    });
    expect(second.checkpoint).toMatchObject({ revision: 2, sync: 'cloud' });

    await syncDevices(a, b);
    expect((await a.runtime.getCheckpoint('th_lease', 'opencode')).checkpoint).toMatchObject({
      revision: 2,
      state: { version: 2 },
    });
  });

  it('模式切换不迁移；离线恢复、重复同步/ingest 幂等；同步后可重建索引', async () => {
    const a = await makeDevice('device-A');
    let b = await makeDevice('device-B');

    const [alpha] = await a.memory.write([
      { type: 'fact', content: 'alpha 离线前事实', metadata: { namespace: 'notes' } },
    ]);
    await syncDevices(a, b);
    expect((await b.runtime.recall({
      query: 'alpha',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records.map((record) => record.id)).toEqual([alpha!.id]);

    const beforeNode = await a.app.graph.getNode(alpha!.id);
    const beforeCount = (await allNodes(a)).length;
    const beforeIds = (await a.memory.query({})).memories.map((memory) => memory.id).sort();

    // immersive → mcp：写端点 409，读端点可用，既有节点不变。
    const change = await a.runtime.setMode('mcp');
    expect(change).toMatchObject({ mode: 'mcp', changed: true, requiresRestart: false });
    await expect(a.runtime.ingest({
      agentId: 'opencode',
      capture: 'off',
      chunks: [{ role: 'user', text: 'mcp 模式写入应被拒绝' }],
    })).rejects.toMatchObject({ code: 'mode_mismatch' });
    await expect(a.runtime.compact({ namespace: 'notes' }))
      .rejects.toMatchObject({ code: 'mode_mismatch' });
    await expect(a.runtime.putCheckpoint('th_mode', {
      agentId: 'opencode',
      state: {},
    })).rejects.toMatchObject({ code: 'mode_mismatch' });

    expect((await a.runtime.recall({
      query: 'alpha',
      agentId: 'opencode',
      namespaces: ['notes'],
    })).records.map((record) => record.id)).toEqual([alpha!.id]);
    const afterNode = await a.app.graph.getNode(alpha!.id);
    expect(afterNode).toMatchObject({
      id: beforeNode!.id,
      createdAt: beforeNode!.createdAt,
      namespace: beforeNode!.namespace,
      tags: beforeNode!.tags,
    });
    expect((await allNodes(a)).length).toBe(beforeCount);
    expect((await a.memory.query({})).memories.map((memory) => memory.id).sort())
      .toEqual(beforeIds);

    // 切回 immersive：恢复写入；B 在此期间保持自己的模式。
    await a.runtime.setMode('immersive');
    const [beta] = await a.memory.write([
      { type: 'fact', content: 'beta 恢复后事实', metadata: { namespace: 'notes' } },
    ]);

    // B 离线：关闭实例，A 与 B 各自继续写入。
    await b.runtime.dispose();
    await b.app.shutdown();
    const [gamma] = await a.memory.write([
      { type: 'fact', content: 'gamma 离线期间事实', metadata: { namespace: 'notes' } },
    ]);

    b = await makeDevice('device-B', { mode: 'immersive' });
    const [delta] = await b.memory.write([
      { type: 'fact', content: 'delta 对端离线期间事实', metadata: { namespace: 'notes' } },
    ]);
    await syncDevices(a, b);

    for (const [query, id] of [
      ['alpha', alpha!.id],
      ['beta', beta!.id],
      ['gamma', gamma!.id],
      ['delta', delta!.id],
    ] as const) {
      expect((await b.runtime.recall({
        query,
        agentId: 'opencode',
        namespaces: ['notes'],
      })).records.map((record) => record.id)).toContain(id);
      expect((await a.runtime.recall({
        query,
        agentId: 'opencode',
        namespaces: ['notes'],
      })).records.map((record) => record.id)).toContain(id);
    }

    // 重复同步幂等：节点数、事件数、可见 id 集合不变。
    const nodesA = (await allNodes(a)).length;
    const nodesB = (await allNodes(b)).length;
    const eventsA = (await a.app.eventLog.listEvents()).length;
    const eventsB = (await b.app.eventLog.listEvents()).length;
    await syncDevices(a, b);
    await syncDevices(a, b);
    expect((await allNodes(a)).length).toBe(nodesA);
    expect((await allNodes(b)).length).toBe(nodesB);
    expect((await a.app.eventLog.listEvents()).length).toBe(eventsA);
    expect((await b.app.eventLog.listEvents()).length).toBe(eventsB);

    // 重复 ingest：同 requestId 返回首次结果，不重复写图；再同步仍只有一条。
    const ingestRequest = {
      requestId: 'req_idem_offline',
      agentId: 'opencode',
      threadId: 'th_idem',
      namespace: 'notes' as const,
      capture: 'off' as const,
      extractor: 'host' as const,
      candidates: [{
        kind: 'fact' as const,
        data: { subject: 'user', predicate: 'epsilon', object: 'one' },
        namespace: 'notes',
      }],
    };
    const first = await a.runtime.ingest(ingestRequest);
    const replay = await a.runtime.ingest(ingestRequest);
    expect(replay.duplicate).toBe(true);
    expect(replay.records).toEqual(first.records);
    await syncDevices(a, b);
    const epsilonNodes = (await b.app.graph.listNodes({ type: 'fact' }))
      .filter((node) => (node.content as { predicate?: string }).predicate === 'epsilon');
    expect(epsilonNodes).toHaveLength(1);

    // 同步后重建索引：用真实 B 图重建，再经向量查询命中。
    const index = new KeywordVectorIndex();
    const store = new MemoryStore(b.app.graph, index);
    const indexed = await store.reindexVectorIndex();
    expect(indexed).toBeGreaterThanOrEqual(5);
    const indexedIds = index.ids();
    for (const id of [alpha!.id, beta!.id, gamma!.id, delta!.id]) {
      expect(indexedIds).toContain(id);
    }
    const hits = await store.vectorQuery('gamma 离线期间', 10);
    expect(hits.map((hit) => hit.node.id)).toContain(gamma!.id);
  });
});
