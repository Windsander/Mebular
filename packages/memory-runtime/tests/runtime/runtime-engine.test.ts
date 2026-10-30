// Runtime 完整引擎：ingest / recall / context / checkpoint / compact / self / trace / mode。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { IdentityManager } from '@mebular/core';
import { MemoryService } from '@mebular/core';
import { RuntimeService } from '../../src/index.js';
import type { CandidateRecord } from '../../src/index.js';

describe('RuntimeService 完整引擎', () => {
  let dir: string;
  let app: Mebular;
  let memory: MemoryService;
  let runtime: RuntimeService;
  let now: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-runtime-engine-'));
    now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const master = await new IdentityManager().generateUserMasterKey();
    app = new Mebular({
      storagePath: join(dir, 'device.jsonl'),
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      sync: { autoSync: false },
    });
    await app.initialize();
    memory = new MemoryService(app);
    runtime = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-A',
      agentId: 'opencode',
      runtime: { capture: 'local' },
      now: () => now,
    });
  });

  afterEach(async () => {
    await app.shutdown().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('ingest：requestId 幂等、capture=local 落本地、capture=off 不落 Raw', async () => {
    const first = await runtime.ingest({
      requestId: 'req_01',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题', messageId: 'm1' }],
    });
    expect(first.duplicate).toBe(false);
    expect(first.rawChunkIds).toHaveLength(1);
    expect(first.accepted.chunks).toBe(1);
    expect(first.extraction.status).toBe('completed');
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ type: 'fact', kind: 'preference', namespace: 'notes' });

    const replay = await runtime.ingest({
      requestId: 'req_01',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.rawChunkIds).toEqual(first.rawChunkIds);
    expect(replay.records).toEqual(first.records);

    // 幂等状态持久化：新实例（模拟重启）仍返回首次结果。
    const restarted = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-A',
      agentId: 'opencode',
      now: () => now,
    });
    const replayAfterRestart = await restarted.ingest({
      requestId: 'req_01',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });
    expect(replayAfterRestart.duplicate).toBe(true);
    expect(replayAfterRestart.records).toEqual(first.records);

    const second = await runtime.ingest({
      requestId: 'req_02',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'off',
      chunks: [{ role: 'user', text: '记住：项目使用 TypeScript' }],
    });
    expect(second.rawChunkIds).toEqual([]);
    expect(second.records).toHaveLength(1);

    const status = await runtime.status();
    expect(status.counts.localRawChunks).toBe(1);
    expect(status.counts.memoryRecords).toBe(2);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'runtime', 'raw', 'chunks.jsonl'))).mode & 0o777).toBe(0o600);
    }

    const recalled = await runtime.recall({ query: '深色', agentId: 'opencode', namespaces: ['notes'] });
    expect(recalled.records).toHaveLength(1);
    expect(recalled.records[0]).toMatchObject({ kind: 'preference', namespace: 'notes' });
    expect(recalled.records[0]!.provenance).toMatchObject({ extractor: 'heuristic' });
    expect(recalled.traceId).toMatch(/^tr_/);
  });

  it('host candidates：五类直接经 MemoryService 落库、部分非法只警告、全非法 422', async () => {
    const candidates: CandidateRecord[] = [
      { kind: 'fact', data: { subject: 'user', predicate: 'editor', object: 'Neovim' }, namespace: 'notes' },
      { kind: 'preference', data: { entity: 'user', preferenceType: 'theme', value: 'dark' }, namespace: 'notes', tags: ['ui'] },
      { kind: 'episode', data: { episodeType: 'conversation', content: '讨论了 runtime 架构' }, namespace: 'notes' },
      { kind: 'skill', data: { name: 'release', description: '发布流程', category: 'ops' }, namespace: 'notes' },
      { kind: 'observation', data: { content: '用户偏好深色主题' }, namespace: 'notes' },
    ];

    const result = await runtime.ingest({
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates,
    });
    expect(result.extraction).toMatchObject({ status: 'completed', extractor: 'host', model: 'host-provided' });
    expect(result.records).toHaveLength(5);
    expect(result.warnings).toEqual([]);

    const factNode = await app.graph.getNode(result.records[0]!.id);
    expect(factNode?.content).toMatchObject({ subject: 'user', predicate: 'editor', object: 'Neovim' });
    expect((factNode?.metadata as Record<string, unknown>).runtime).toMatchObject({
      kind: 'memory_record',
      internal: false,
      provenance: { source: 'host', extractor: 'host', model: 'host-provided' },
    });
    const preferenceNode = await app.graph.getNode(result.records[1]!.id);
    expect(preferenceNode?.tags).toEqual(expect.arrayContaining(['preference', 'ui']));

    const replay = await runtime.ingest({
      requestId: 'req_host_2',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates,
    });
    expect(replay.records.map((record) => record.id)).toEqual(result.records.map((record) => record.id));
    expect(replay.warnings).toContain('duplicate_record');
    expect((await memory.query({})).totalMatches).toBe(5);

    const partial = await runtime.ingest({
      requestId: 'req_host_3',
      agentId: 'opencode',
      threadId: 'th_1',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates: [
        { kind: 'fact', data: { subject: 'user', predicate: 'language', object: 'Rust' } },
        { kind: 'fact', data: { subject: '', predicate: 'x', object: 'y' } },
      ],
    });
    expect(partial.records).toHaveLength(1);
    expect(partial.warnings.some((warning) => warning.startsWith('invalid_candidate'))).toBe(true);

    await expect(runtime.ingest({
      requestId: 'req_host_4',
      agentId: 'opencode',
      capture: 'off',
      extractor: 'host',
      candidates: [{ kind: 'fact', data: { subject: '', predicate: '', object: '' } }],
    })).rejects.toMatchObject({ code: 'extraction_invalid', status: 422 });

    await expect(runtime.ingest({
      requestId: 'req_host_reserved',
      agentId: 'opencode',
      capture: 'off',
      extractor: 'host',
      candidates: [{
        kind: 'fact',
        data: { subject: 'user', predicate: 'x', object: 'y' },
        namespace: '__self__',
      }],
    })).rejects.toMatchObject({ code: 'namespace_reserved', status: 400 });
  });

  it('host 无候选：202 pending，可回填；heuristic 只提取明确内容，不臆造', async () => {
    const pending = await runtime.ingest({
      requestId: 'req_pending',
      agentId: 'opencode',
      threadId: 'th_2',
      namespace: 'notes',
      capture: 'local',
      extractor: 'host',
      chunks: [{ role: 'user', text: '候选由宿主稍后提交' }],
    });
    expect(pending.extraction.status).toBe('pending');
    expect(pending.records).toEqual([]);
    expect((await runtime.getExtraction(pending.extraction.id))?.status).toBe('pending');
    const restarted = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-A',
      agentId: 'opencode',
      now: () => now,
    });
    expect((await restarted.getExtraction(pending.extraction.id))?.status).toBe('pending');

    const completed = await runtime.completeExtraction(pending.extraction.id, [
      { kind: 'fact', data: { subject: 'user', predicate: 'editor', object: 'Zed' }, namespace: 'notes' },
    ]);
    expect(completed.status).toBe('completed');
    expect(completed.records).toHaveLength(1);

    const noMemory = await runtime.ingest({
      requestId: 'req_heuristic_empty',
      agentId: 'opencode',
      threadId: 'th_3',
      namespace: 'notes',
      capture: 'off',
      chunks: [{ role: 'user', text: '今天天气不错' }],
    });
    expect(noMemory.records).toEqual([]);
    expect(noMemory.warnings).toContain('no_extractable_memory');

    const heuristic = await runtime.ingest({
      requestId: 'req_heuristic',
      agentId: 'opencode',
      threadId: 'th_3',
      namespace: 'notes',
      capture: 'off',
      chunks: [
        { role: 'user', text: '我的编辑器是 Neovim' },
        { role: 'user', text: '任务：完成 runtime 引擎' },
        { role: 'assistant', text: '以后默认用紫色主题' },
      ],
    });
    expect(heuristic.records).toHaveLength(2);
    expect(heuristic.records.some((record) => record.kind === 'episode')).toBe(true);
    const recalled = await runtime.recall({ query: 'Neovim', agentId: 'opencode', namespaces: ['notes'] });
    expect(recalled.records[0]).toMatchObject({ type: 'fact', content: expect.stringContaining('Neovim') });
  });

  it('recall / context：空命中不编造、固定顺序、citations/预算/不可信标记', async () => {
    const empty = await runtime.recall({ query: '不存在的词zzz', agentId: 'opencode' });
    expect(empty.records).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.traceId).toMatch(/^tr_/);

    await memory.write([
      { type: 'preference', content: '深色主题', metadata: { preferenceType: 'theme', namespace: 'notes' } },
      { type: 'fact', content: '项目使用 TypeScript', metadata: { namespace: 'notes' } },
    ]);
    await runtime.putCheckpoint('th_ctx', {
      agentId: 'opencode',
      state: { cursor: 2 },
      summary: '已完成第二步',
    });
    await runtime.putSelf('opencode', { displayName: 'OpenCode', goals: ['帮助用户'] });
    const compact = await runtime.compact({ namespace: 'notes' });
    expect(compact.compactId).toMatch(/^[0-9A-Z]{26}$/);

    const context = await runtime.context({
      agentId: 'opencode',
      threadId: 'th_ctx',
      query: '主题',
      namespaces: ['notes'],
      tokenBudget: 2000,
      includeCheckpoint: true,
      includeSelf: true,
    });
    expect(context.blocks.map((block) => block.kind)).toEqual(['self', 'checkpoint', 'compact', 'memory']);
    expect(context.truncated).toBe(false);
    expect(context.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(context.notice).toContain('不可信');
    for (const block of context.blocks) {
      expect(block.trusted).toBe(false);
      expect(block.untrusted).toBe(true);
    }
    const memoryBlock = context.blocks.find((block) => block.kind === 'memory')!;
    expect(memoryBlock.citations.length).toBeGreaterThan(0);
    expect(memoryBlock.citations[0]!.id).toBeTruthy();
    expect(context.traceId).toMatch(/^tr_/);

    const tiny = await runtime.context({
      agentId: 'opencode',
      threadId: 'th_ctx',
      query: '主题',
      namespaces: ['notes'],
      tokenBudget: 30,
      includeCheckpoint: true,
      includeSelf: true,
    });
    expect(tiny.truncated).toBe(true);
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(30);

    const noOptional = await runtime.context({ agentId: 'opencode', query: '主题', namespaces: ['notes'] });
    expect(noOptional.blocks.some((block) => block.kind === 'self')).toBe(false);
    expect(noOptional.blocks.some((block) => block.kind === 'checkpoint')).toBe(false);
  });

  it('checkpoint：本地 revision/lease/TTL、云节点与删除', async () => {
    const first = await runtime.putCheckpoint('th_1', {
      agentId: 'opencode',
      state: { cursor: 1 },
      summary: '第一步',
    });
    expect(first.checkpoint).toMatchObject({ threadId: 'th_1', agentId: 'opencode', revision: 1, sync: 'local' });
    expect(first.checkpoint!.lease.hostId).toMatch(/^h_/);
    expect(first.checkpoint!.lease.until).toBe(now + 60_000);

    await expect(runtime.putCheckpoint('th_1', {
      agentId: 'opencode',
      expectedRevision: 0,
      state: { cursor: 2 },
    })).rejects.toMatchObject({ code: 'revision_mismatch', status: 409 });

    const second = await runtime.putCheckpoint('th_1', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { cursor: 2 },
    });
    expect(second.checkpoint?.revision).toBe(2);

    const cloudId = (await runtime.status()).identity.cloudId!;
    const checkpointPath = join(dir, 'runtime', 'checkpoints', cloudId, 'opencode', 'th_1.json');
    if (process.platform !== 'win32') {
      expect((await stat(checkpointPath)).mode & 0o777).toBe(0o600);
    }

    // 另一个 host 租约未过期时不能写；force 可抢。
    const other = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-B',
      agentId: 'opencode',
      now: () => now,
    });
    await expect(other.putCheckpoint('th_1', {
      agentId: 'opencode',
      state: { cursor: 3 },
    })).rejects.toMatchObject({ code: 'checkpoint_lease_held', status: 409 });
    const forced = await other.putCheckpoint('th_1', {
      agentId: 'opencode',
      state: { cursor: 3 },
      force: true,
    });
    expect(forced.checkpoint?.revision).toBe(3);
    expect(forced.checkpoint!.lease.hostId).not.toBe(first.checkpoint!.lease.hostId);

    // TTL：过期读取返回 null 并清理。
    await runtime.putCheckpoint('th_expire', {
      agentId: 'opencode',
      state: {},
      expiresAt: now + 1000,
    });
    now += 2000;
    expect(await runtime.getCheckpoint('th_expire', 'opencode')).toEqual({ checkpoint: null });

    // 未启用云 checkpoint 时显式 cloud 403。
    await expect(runtime.putCheckpoint('th_cloud', {
      agentId: 'opencode',
      state: {},
      sync: 'cloud',
    })).rejects.toMatchObject({ code: 'cloud_checkpoint_disabled', status: 403 });

    const cloudRuntime = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime-cloud'),
      hostKey: 'home-A',
      agentId: 'opencode',
      runtime: { checkpoint: { sync: 'cloud' } },
      now: () => now,
    });
    const cloud = await cloudRuntime.putCheckpoint('th_cloud', {
      agentId: 'opencode',
      state: { plan: ['a'] },
      sync: 'cloud',
    });
    expect(cloud.checkpoint).toMatchObject({ revision: 1, sync: 'cloud' });
    const cloudNodes = await app.graph.listNodes({ type: 'context_checkpoint', namespace: '__checkpoint__' });
    expect(cloudNodes).toHaveLength(1);
    expect(cloudNodes[0]!.metadata?.runtime).toMatchObject({ internal: true, kind: 'context_checkpoint' });
    expect((await cloudRuntime.getCheckpoint('th_cloud', 'opencode')).checkpoint)
      .toMatchObject({ revision: 1, sync: 'cloud' });
    await cloudRuntime.deleteCheckpoint('th_cloud', 'opencode');
    expect(await cloudRuntime.getCheckpoint('th_cloud', 'opencode')).toEqual({ checkpoint: null });

    expect((await runtime.deleteCheckpoint('th_1', 'opencode')).deleted).toBe(true);
    expect(await runtime.getCheckpoint('th_1', 'opencode')).toEqual({ checkpoint: null });
  });

  it('compact：同 namespace、源记录不被修改、stale 计算、dryRun 与幂等', async () => {
    const [factA, factB] = await memory.write([
      { type: 'fact', content: '项目使用 TypeScript', metadata: { namespace: 'notes' } },
      { type: 'fact', content: '项目使用 Node.js', metadata: { namespace: 'notes' } },
      { type: 'fact', content: '其他域事实', metadata: { namespace: 'other' } },
    ]);
    const beforeA = JSON.stringify(await app.graph.getNode(factA!.id));

    const dry = await runtime.compact({ namespace: 'notes', dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(dry.sourceIds.sort()).toEqual([factA!.id, factB!.id].sort());

    const compact = await runtime.compact({ namespace: 'notes', strategy: 'summary' });
    expect(compact.status).toBe('completed');
    expect(compact.tokenCount).toBeGreaterThan(0);
    expect(compact.stale).toBe(false);
    expect(JSON.stringify(await app.graph.getNode(factA!.id))).toBe(beforeA);

    const view = await runtime.getCompact(compact.compactId!);
    expect(view).toMatchObject({ namespace: 'notes', stale: false });
    expect(view!.sourceIds.sort()).toEqual([factA!.id, factB!.id].sort());

    const again = await runtime.compact({ namespace: 'notes', strategy: 'summary' });
    expect(again.compactId).toBe(compact.compactId);
    expect(again.duplicate).toBe(true);

    await memory.delete([factA!.id]);
    const stale = await runtime.getCompact(compact.compactId!);
    expect(stale?.stale).toBe(true);
    // 不自动删除 compact。
    expect(await app.graph.getNode(compact.compactId!)).not.toBeNull();

    await expect(runtime.compact({ namespace: '__self__' })).rejects.toMatchObject({
      code: 'namespace_reserved',
    });
  });

  it('self：云节点按 revision 取最大、409 冲突、不进入普通查询', async () => {
    const first = await runtime.putSelf('opencode', {
      displayName: 'OpenCode',
      goals: ['帮助用户'],
      traits: ['谨慎'],
      preferences: { theme: 'dark' },
      capabilities: ['coding'],
      boundaries: ['不执行危险命令'],
    });
    expect(first.self).toMatchObject({ agentId: 'opencode', revision: 1, sync: 'cloud' });

    await expect(runtime.putSelf('opencode', { expectedRevision: 0, goals: [] }))
      .rejects.toMatchObject({ code: 'revision_mismatch', status: 409 });
    const second = await runtime.putSelf('opencode', {
      expectedRevision: 1,
      displayName: 'OpenCode 2',
      goals: ['帮助用户', '保持可靠'],
    });
    expect(second.self).toMatchObject({ revision: 2, displayName: 'OpenCode 2' });

    const fetched = await runtime.getSelf('opencode');
    expect(fetched.self).toMatchObject({ revision: 2, agentId: 'opencode' });
    expect((await runtime.status()).counts.selfRecords).toBe(1);
    expect(await memory.query({})).toMatchObject({ totalMatches: 0 });
    expect((await memory.profile()).preferences).toEqual([]);

    const nodes = await app.graph.listNodes({ type: 'self_record' });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.namespace).toBe('__self__');
    expect(nodes[0]!.metadata?.runtime).toMatchObject({ internal: true, kind: 'self_record' });
  });

  it('trace：本地 JSONL、feedback、关闭 trace 时不生成', async () => {
    await memory.write([{ type: 'fact', content: '可被召回的轨迹事实', metadata: { namespace: 'default' } }]);
    const recalled = await runtime.recall({
      query: '轨迹',
      agentId: 'opencode',
      threadId: 'th_trace',
    });
    expect(recalled.traceId).toMatch(/^tr_/);

    const trace = await runtime.getTrace(recalled.traceId!);
    expect(trace).toMatchObject({ agentId: 'opencode', threadId: 'th_trace', degraded: false });
    expect(trace!.hits).toHaveLength(1);
    expect(trace!.queryPreview).toBe('轨迹');

    const feedback = await runtime.traceFeedback(recalled.traceId!, { useful: true, reason: '命中' });
    expect(feedback).toEqual({ recorded: true });
    expect((await runtime.getTrace(recalled.traceId!))?.feedback).toMatchObject({ useful: true });

    const traces = await runtime.listTraces();
    expect(traces.map((entry) => entry.id)).toContain(recalled.traceId);

    const secret = await runtime.recall({
      query: 'api_key=sk-secret-value 主题',
      agentId: 'opencode',
    });
    const secretTrace = await runtime.getTrace(secret.traceId!);
    expect(secretTrace!.queryPreview).not.toContain('sk-secret-value');
    expect(secretTrace!.queryPreview).toContain('[redacted]');

    const noTrace = new RuntimeService(app, {
      mode: 'immersive',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-A',
      agentId: 'opencode',
      runtime: { trace: 'off' },
      now: () => now,
    });
    const quiet = await noTrace.recall({ query: '轨迹', agentId: 'opencode' });
    expect(quiet.traceId).toBeUndefined();

    const tracesPath = join(dir, 'runtime', 'traces.jsonl');
    if (process.platform !== 'win32') {
      expect((await stat(tracesPath)).mode & 0o777).toBe(0o600);
    }
    expect((await readFile(tracesPath, 'utf8')).trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('status：能力/计数/warnings 与内部对象隔离', async () => {
    await runtime.ingest({
      requestId: 'req_status',
      agentId: 'opencode',
      threadId: 'th_status',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '记住：状态事实' }],
    });
    await runtime.compact({ namespace: 'notes' });
    await runtime.putSelf('opencode', { goals: ['状态'] });
    await runtime.putCheckpoint('th_status', { agentId: 'opencode', state: {} });
    await runtime.recall({ query: '状态', agentId: 'opencode' });

    const status = await runtime.status();
    expect(status.initialized).toBe(true);
    expect(status.mode).toBe('immersive');
    expect(status.capabilities).toMatchObject({
      ingest: true,
      recall: true,
      context: true,
      checkpoint: true,
      compact: true,
      rawCapture: 'local',
      trace: 'local',
    });
    expect(status.counts).toMatchObject({
      memoryRecords: 1,
      compacts: 1,
      checkpoints: 1,
      selfRecords: 1,
      localRawChunks: 1,
      localTraces: 1,
    });
    const memoryStatus = await memory.status();
    // core 不再暴露 runtime 专用计数；图内/本地计数由 RuntimeService.status()
    // （原型 /runtime/v1/status）提供。
    expect(memoryStatus).not.toHaveProperty('runtime');
    expect(status.counts).toMatchObject({
      memoryRecords: 1,
      compacts: 1,
      checkpoints: 1,
      selfRecords: 1,
    });
    expect(status.warnings).toContain('rawCaptureUnencrypted');
    expect(JSON.stringify(status)).not.toContain('sk-secret');

    const all = await memory.query({});
    expect(all.memories.map((entry) => entry.id)).toHaveLength(1);
    await expect(runtime.recall({
      query: 'state',
      agentId: 'opencode',
      types: ['compact' as never],
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
