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
});
