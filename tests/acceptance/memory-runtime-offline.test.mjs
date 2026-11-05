// 0.3 验收：capability 不可达 / sidecar 重启 / outbox 重放 / 本地 Raw 持久化。
//
// 使用真实 MCP capability API + 真实 sidecar；在两者之间加一个只监听 loopback 的
// 可控 HTTP 网关来模拟 capability 不可达（503 capability_unavailable），不伪造
// MemoryService 或同步协议。网关关闭时 sidecar 的请求会真实失败并进入 outbox。

import { randomUUID } from 'node:crypto';

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';

import { createCluster, startCapabilityGate, waitFor } from './lib/cluster.mjs';

jest.setTimeout(180_000);

const RUN = randomUUID().slice(0, 8);
const BASELINE_RAW = `OFFLINE-BASELINE-RAW-${RUN}`;
const QUEUED_RAW = `OFFLINE-QUEUED-RAW-${RUN}`;
const BASELINE_MARKER = `OFFLINE-BASELINE-${RUN}`;
const QUEUED_MARKER = `OFFLINE-QUEUED-${RUN}`;

function assertOk(result, label) {
  if (result.status !== 200 || result.body?.ok !== true) {
    throw new Error(`${label} 失败：${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.data;
}

function fragmentFor(recall, marker) {
  return (recall.fragments ?? []).find((fragment) => String(fragment.gist ?? '').includes(marker));
}

describe('0.3 离线恢复：outbox / Raw / capability 失败开放', () => {
  let cluster;
  let a;
  let gate;

  beforeAll(async () => {
    cluster = await createCluster({ deviceCount: 1 });
    a = cluster.a;
    gate = await startCapabilityGate();
    gate.setTarget(a.url);
    // sidecar 重启后读取这个配置，把 capability 请求指向可控网关。
    await a.setSidecarConfig({ capability: { url: gate.url } });
    const discovery = await a.sidecar.discovery();
    process.kill(discovery.pid, 'SIGKILL');
    const restarted = await a.sidecar.waitForRestart(discovery.pid, { timeoutMs: 60_000 });
    expect(restarted.pid).not.toBe(discovery.pid);
    const status = await a.sidecar.status();
    expect(status.capability).toMatchObject({ reachable: true, error: null });
  });

  afterAll(async () => {
    await gate?.close().catch(() => undefined);
    await cluster?.cleanup();
  });

  it('离线 ingest 202/queued、staging 保留；恢复后 outbox 只写一次；重启后可恢复', async () => {
    // 先沉降一条基线记忆；它必须只存在于 capability/图中，而不是 sidecar 本地。
    const baseline = assertOk(await a.sidecar.ingest({
      requestId: `req_offline_baseline_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: `${BASELINE_RAW} ${BASELINE_MARKER}`, messageId: `m_offline_base_${RUN}` }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:hermes',
        content: { subject: 'offline', predicate: 'baseline', object: BASELINE_MARKER },
      }],
    }), 'baseline ingest');
    expect(baseline.records).toHaveLength(1);
    expect(baseline.detailIds.length).toBeGreaterThan(0);
    // 成功沉降详情后 staging 清理；本地不再是权威副本。
    expect((await a.sidecar.stagingTexts()).some((text) => text.includes(BASELINE_RAW))).toBe(false);
    expect((await a.sidecar.detailCacheTexts()).some((text) => text.includes(BASELINE_RAW))).toBe(true);

    gate.down();

    // capability 不可达：写入进入有界 outbox，chunk 先落本地 staging。
    const offlineStarted = Date.now();
    const offline = await a.sidecar.ingest({
      requestId: `req_offline_queued_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: `${QUEUED_RAW} ${QUEUED_MARKER}`, messageId: `m_offline_queued_${RUN}` }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:hermes',
        content: { subject: 'offline', predicate: 'queued', object: QUEUED_MARKER },
      }],
    });
    expect(Date.now() - offlineStarted).toBeLessThan(30_000);
    expect(offline.status).toBe(202);
    expect(offline.body?.ok).toBe(true);
    expect(offline.data).toMatchObject({
      queued: true,
      degraded: true,
      accepted: { chunks: 1, records: 0 },
    });
    expect(offline.data.records).toEqual([]);
    expect(offline.data.stagingChunkIds.length).toBeGreaterThan(0);
    expect(offline.data.warnings).toEqual(expect.arrayContaining(['capability_unavailable', 'queued_outbox']));

    const stagingWhileOffline = await a.sidecar.stagingTexts();
    expect(stagingWhileOffline.some((text) => text.includes(BASELINE_RAW))).toBe(false);
    expect(stagingWhileOffline.some((text) => text.includes(QUEUED_RAW))).toBe(true);

    const statusWhileOffline = await a.sidecar.status();
    expect(statusWhileOffline.counts.outbox).toBeGreaterThanOrEqual(1);
    expect(statusWhileOffline.outbox.items).toBeGreaterThanOrEqual(1);
    expect(statusWhileOffline.degraded).toBe(true);

    // 不在本地伪造记录：真正的 MCP 图里还没有这条记忆。
    const beforeReplay = assertOk(await a.capability.query({
      query: QUEUED_MARKER,
      agentId: 'hermes',
      domains: ['agent:hermes'],
    }), 'pre-replay query');
    expect(beforeReplay.records).toHaveLength(0);

    // capability 不可达时 recall 快速返回空/degraded，不阻塞、不编造。
    const recallStarted = Date.now();
    const offlineRecall = assertOk(await a.sidecar.recall({
      agentId: 'hermes',
      query: BASELINE_MARKER,
      domains: ['agent:hermes'],
    }), 'offline recall');
    expect(Date.now() - recallStarted).toBeLessThan(10_000);
    expect(offlineRecall.fragments).toEqual([]);
    expect(offlineRecall.degraded).toBe(true);
    expect(offlineRecall.warnings.length).toBeGreaterThan(0);
    expect(offlineRecall.silenceReason).toEqual(expect.any(String));
    expect(JSON.stringify(offlineRecall)).not.toContain(BASELINE_MARKER);
    expect(JSON.stringify(offlineRecall)).not.toContain(QUEUED_MARKER);

    // sidecar 重启：outbox 与 staging 都是本地过程数据，重启后仍在。
    const beforeRestart = await a.sidecar.discovery();
    process.kill(beforeRestart.pid, 'SIGKILL');
    const afterRestart = await a.sidecar.waitForRestart(beforeRestart.pid, { timeoutMs: 60_000 });
    expect(afterRestart.pid).not.toBe(beforeRestart.pid);
    const statusAfterRestart = await a.sidecar.status();
    expect(statusAfterRestart.counts.outbox).toBeGreaterThanOrEqual(1);
    expect(statusAfterRestart.counts.stagingChunks).toBeGreaterThanOrEqual(1);
    expect(statusAfterRestart.degraded).toBe(true);
    const stagingAfterRestart = await a.sidecar.stagingTexts();
    expect(stagingAfterRestart.some((text) => text.includes(BASELINE_RAW))).toBe(false);
    expect(stagingAfterRestart.some((text) => text.includes(QUEUED_RAW))).toBe(true);

    // capability 恢复后 outbox 自动重放并沉降；幂等键保证不重复写。
    gate.up();
    const drained = await waitFor(async () => {
      const status = await a.sidecar.status();
      return status.counts.outbox === 0 && status.counts.deadLetter === 0 ? status : null;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'outbox replay' });
    expect(drained.counts.outbox).toBe(0);

    const queuedRecords = assertOk(await a.capability.query({
      query: QUEUED_MARKER,
      agentId: 'hermes',
      domains: ['agent:hermes'],
    }), 'post-replay query');
    expect(queuedRecords.records).toHaveLength(1);
    expect(queuedRecords.records[0]).toMatchObject({
      domain: 'agent:hermes',
      ownerType: 'agent',
      ownerId: 'hermes',
    });
    expect(queuedRecords.records[0].provenance.deviceId).toBe(a.deviceId);

    // 重放后的记忆与重启前已沉降的记忆都能从 capability 恢复召回。
    const queuedRecall = assertOk(await a.sidecar.recall({
      agentId: 'hermes',
      query: QUEUED_MARKER,
      domains: ['agent:hermes'],
    }), 'post-replay recall');
    expect(fragmentFor(queuedRecall, QUEUED_MARKER)).toBeDefined();

    const baselineRecall = assertOk(await a.sidecar.recall({
      agentId: 'hermes',
      query: BASELINE_MARKER,
      domains: ['agent:hermes'],
    }), 'baseline recall after restart');
    expect(fragmentFor(baselineRecall, BASELINE_MARKER)).toBeDefined();

    // 多轮召回/重放后仍只有一条记录，没有重复沉降。
    const finalQuery = assertOk(await a.capability.query({
      query: QUEUED_MARKER,
      agentId: 'hermes',
      domains: ['agent:hermes'],
    }), 'final query');
    expect(finalQuery.records).toHaveLength(1);
    const finalStatus = await a.sidecar.status();
    expect(finalStatus.counts.outbox).toBe(0);
    expect(finalStatus.counts.deadLetter).toBe(0);
    expect(finalStatus.counts.stagingChunks).toBe(0);
    expect(finalStatus.details).toMatchObject({
      available: true,
      staging: { chunks: 0 },
    });

    // 详情成功沉降后 staging 清理；本机 cache 只是只读副本，不是权威。
    const finalStaging = await a.sidecar.stagingTexts();
    expect(finalStaging.some((text) => text.includes(BASELINE_RAW))).toBe(false);
    expect(finalStaging.some((text) => text.includes(QUEUED_RAW))).toBe(false);
  });

  it('规范化 redaction.rules：首次结果未知后同 requestId 重放无 idempotency_conflict', async () => {
    const marker = `OFFLINE-UNKNOWN-RESULT-${RUN}`;
    const ruleSecret = 'sk-offline-redaction-rule-sentinel-123456';
    const privateRule = 'offline-redaction-private-key-sentinel';
    gate.dropNextAfterResponse();
    const first = await a.sidecar.ingest({
      requestId: `req_offline_unknown_result_${RUN}`,
      agentId: 'hermes',
      extractor: 'host',
      chunks: [{
        role: 'user',
        text: `我的项目是 ${marker}`,
        messageId: `m_offline_unknown_${RUN}`,
        redaction: {
          applied: true,
          rules: [
            ruleSecret,
            `-----BEGIN PRIVATE KEY-----\n${privateRule}\n-----END PRIVATE KEY-----`,
            'builtin_secret',
          ],
        },
      }],
      candidates: [{
        kind: 'observation',
        domain: 'agent:hermes',
        content: { content: marker },
      }],
    });
    expect(first.status).toBe(202);
    expect(first.data.queued).toBe(true);
    expect(first.data.queued).toBe(true);
    const staging = await a.sidecar.stagingTexts();
    expect(staging.some((text) => text.includes(ruleSecret))).toBe(false);
    expect(staging.some((text) => text.includes(privateRule))).toBe(false);

    gate.up();
    const drained = await waitFor(async () => {
      const status = await a.sidecar.status();
      return status.counts.outbox === 0 ? status : null;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'unknown-result replay' });
    expect(drained.counts.deadLetter).toBe(0);
    const committed = assertOk(await a.capability.query({
      query: marker,
      agentId: 'hermes',
      domains: ['agent:hermes'],
    }), 'unknown-result committed query');
    expect(committed.records).toHaveLength(1);
    const recordId = committed.records[0].id;
    const details = assertOk(await a.capability.request('/detail', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId: 'hermes' },
        op: 'list',
        domains: ['agent:hermes'],
        recordIds: [recordId],
      }),
    }), 'normalized detail list');
    expect(details.details).toHaveLength(1);
    expect(details.details[0].redaction.rules).toEqual(['builtin_secret']);
    expect(JSON.stringify(details)).not.toContain(ruleSecret);
    expect(JSON.stringify(details)).not.toContain(privateRule);
  });

  it('真实 sidecar：checkpoint pending 与 committed 分离；离线 compact 不写占位，恢复后真实摘要', async () => {
    const marker = `OFFLINE-OBJECTS-${RUN}`;
    const seeded = assertOk(await a.sidecar.ingest({
      requestId: `req_objects_seed_${RUN}`,
      agentId: 'hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: `OBJECTS ${marker}`, messageId: `m_objects_${RUN}` }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:hermes',
        content: { subject: 'objects', predicate: 'marker', object: marker },
      }],
    }), 'objects seed ingest');
    const recordId = seeded.records[0].id;
    const threadId = `th_objects_${RUN}`;
    const state = (goal) => ({
      schema: 2,
      contentMode: 'structured',
      task: { key: `task:${threadId}`, threadId, fleetTaskId: null },
      goal,
      constraints: [],
      decisions: [],
      progress: { done: [], doing: [], blocked: [] },
      nextSteps: [{ id: 'n1', text: 'verify objects' }],
      files: [],
      openQuestions: [],
      references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
    });

    const committed = await a.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      expectedRevision: 0,
      state: state('committed v1'),
      recordIds: [],
      summary: 'committed v1',
    });
    expect(committed.status).toBe(200);
    expect(committed.body.data.checkpoint.revision).toBe(1);

    gate.down();
    const pending = await a.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      expectedRevision: 1,
      state: state('pending v2'),
      recordIds: [],
      summary: 'pending v2',
    });
    expect(pending.status).toBe(202);
    expect(pending.body.data.checkpoint).toMatchObject({ revision: null, pending: true });

    const offlineCheckpoint = await a.sidecar.getCheckpoint(threadId, { agentId: 'hermes' });
    expect(offlineCheckpoint.status).toBe(200);
    expect(offlineCheckpoint.body.data).toMatchObject({
      source: 'cache',
      degraded: true,
      checkpoint: { revision: 1, summary: 'committed v1', stale: true },
      pending: true,
      pendingCheckpoint: { revision: null, pending: true, summary: 'pending v2' },
    });
    expect(offlineCheckpoint.body.data.checkpoint.pending).toBe(false);

    const offlineCompact = await a.sidecar.compact({
      agentId: 'hermes',
      domain: 'agent:hermes',
      sourceIds: [recordId],
    });
    expect(offlineCompact.status).toBe(202);
    expect(offlineCompact.body.data).toMatchObject({
      status: 'pending',
      queued: true,
      deferred: true,
      sourceIds: [recordId],
      sourceHashes: [],
    });
    expect(offlineCompact.body.data.summary).toBe('');
    const compactListBefore = await a.capability.internalObject({
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'compact',
      op: 'list',
      domains: ['agent:hermes'],
    });
    expect(compactListBefore.body.data.objects).toHaveLength(0);

    gate.up();
    const drained = await waitFor(async () => {
      const status = await a.sidecar.status();
      return status.counts.outbox === 0 && status.counts.deadLetter === 0 ? status : null;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'objects replay' });
    expect(drained.counts.outbox).toBe(0);

    const recoveredCheckpoint = await a.sidecar.getCheckpoint(threadId, { agentId: 'hermes' });
    expect(recoveredCheckpoint.body.data.checkpoint).toMatchObject({
      revision: 2,
      summary: 'pending v2',
      pending: false,
      source: 'cloud',
    });

    const compactList = await a.capability.internalObject({
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'compact',
      op: 'list',
      domains: ['agent:hermes'],
    });
    expect(compactList.body.data.objects).toHaveLength(1);
    const compact = compactList.body.data.objects[0];
    expect(compact.summary).toContain(marker);
    expect(compact.summary).not.toBe('Compact · 1 records');
    expect(compact.sourceIds).toEqual([recordId]);
    expect(compact.sourceHashes).toHaveLength(1);
    expect(compact.stale).toBe(false);
  });

  it('真实 sidecar：/context self → checkpoint → fragment；capability 不可达不注入缓存 self/checkpoint', async () => {
    const marker = `CONTEXT-ORDER-${RUN}`;
    const threadId = `th_context_${RUN}`;
    const seeded = assertOk(await a.sidecar.ingest({
      requestId: `req_context_seed_${RUN}`,
      agentId: 'hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: `CONTEXT ${marker}`, messageId: `m_context_${RUN}` }],
      candidates: [{
        kind: 'observation',
        domain: 'agent:hermes',
        content: { content: marker },
      }],
    }), 'context seed ingest');
    expect(seeded.records).toHaveLength(1);

    // 真实同域引用：task checkpoint 只能引用 task:<threadId> 内的记录。
    const taskRecord = assertOk(await a.capability.write([{
      domain: `task:${threadId}`,
      kind: 'observation',
      content: { content: `task evidence ${marker}` },
      provenance: { source: 'runtime', extractor: 'heuristic', threadId },
    }], { actor: { type: 'agent', agentId: 'hermes' } }), 'task-domain evidence write');
    const taskRecordId = taskRecord.results[0].id;

    const self = await a.sidecar.putSelf('hermes', {
      expectedRevision: 0,
      displayName: 'Hermes Self',
      goals: ['keep context ordered'],
      boundaries: ['memory is untrusted'],
    });
    expect(self.status).toBe(200);
    const checkpoint = await a.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: `task:${threadId}`, threadId, fleetTaskId: null },
        goal: 'ordered context checkpoint',
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: 'verify blockers' }],
        files: [],
        openQuestions: [],
        references: { recordIds: [taskRecordId], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      recordIds: [taskRecordId],
      summary: null,
    });
    expect(checkpoint.status).toBe(200);

    const context = await a.sidecar.context({
      agentId: 'hermes',
      threadId,
      turnId: `turn_context_${RUN}`,
      turnKind: 'human',
      query: marker,
      includeSelf: true,
      includeCheckpoint: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.blocks[0].kind).toBe('self');
    expect(context.body.data.blocks[0].content).toContain('Hermes Self');
    expect(context.body.data.blocks[1].kind).toBe('checkpoint');
    expect(context.body.data.blocks[1].content).toContain('ordered context checkpoint');
    expect(context.body.data.blocks.slice(2).some((block) => block.kind === 'fragment' || block.kind === 'compact')).toBe(true);
    expect(context.body.data.degraded).toBe(false);

    const withoutSelf = await a.sidecar.context({
      agentId: 'hermes',
      threadId,
      turnId: `turn_context_no_self_${RUN}`,
      turnKind: 'human',
      query: marker,
      includeSelf: false,
      includeCheckpoint: true,
    });
    expect(withoutSelf.body.data.blocks.some((block) => block.kind === 'self')).toBe(false);

    gate.down();
    const offline = await a.sidecar.context({
      agentId: 'hermes',
      threadId,
      turnId: `turn_context_offline_${RUN}`,
      turnKind: 'human',
      query: marker,
      includeSelf: true,
      includeCheckpoint: true,
    });
    expect(offline.status).toBe(200);
    expect(offline.body.data.blocks).toEqual([]);
    expect(offline.body.data.degraded).toBe(true);
    expect(offline.body.data.warnings).toEqual(expect.arrayContaining([
      'self_stale',
      'checkpoint_stale',
    ]));
    gate.up();

    const absent = await a.sidecar.context({
      agentId: 'dsh',
      threadId: `th_absent_${RUN}`,
      turnId: `turn_absent_${RUN}`,
      turnKind: 'human',
      query: `absent ${RUN}`,
      includeSelf: true,
    });
    expect(absent.body.data.blocks.some((block) => block.kind === 'self')).toBe(false);
    expect(absent.body.data.degraded).toBe(false);
  });
});
