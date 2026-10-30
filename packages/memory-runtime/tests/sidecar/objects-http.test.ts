// W4c host API：compact / self / checkpoint 全部经 capability /internal-object。
// 使用 fake capability server；不启动真实 MCP/core。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  server: SidecarServer;
}

const harnesses: Harness[] = [];

function memoryRecord(
  id: string,
  domain: string,
  kind: string,
  content: Record<string, unknown>,
  updatedAt = NOW,
): FakeMemoryRecord {
  return {
    id,
    type: kind === 'preference' || kind === 'observation' ? 'fact' : kind,
    kind,
    domain,
    namespace: domain,
    ownerType: domain.startsWith('agent:') ? 'agent' : 'other',
    ownerId: domain.startsWith('agent:') ? domain.slice('agent:'.length) : domain,
    content,
    text: typeof content.content === 'string' ? content.content : undefined,
    tags: [],
    provenance: { source: 'runtime', writerType: 'agent', version: '0.3.0' },
    createdAt: updatedAt,
    updatedAt,
    detailAvailable: true,
    legacy: false,
  };
}

function compactRecords(): FakeMemoryRecord[] {
  return [
    memoryRecord('01JSRC1', 'agent:opencode', 'fact', {
      subject: 'Mebular',
      predicate: 'uses',
      object: 'sidecar',
    }, NOW - 3000),
    memoryRecord('01JSRC2', 'agent:opencode', 'observation', {
      content: 'pnpm workspace build 已通过',
    }, NOW - 2000),
    memoryRecord('01JSRC3', 'agent:opencode', 'preference', {
      entity: 'user',
      preferenceType: 'theme',
      value: 'dark',
    }, NOW - 1000),
  ];
}

async function setup(records: FakeMemoryRecord[] = compactRecords()): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-objects-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  fake.setRecords(records);
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config = defaultSidecarConfig();
  config.http.port = 0;
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    policy: defaultSidecarPolicy(),
    autoStartReplayer: false,
    now: () => NOW,
  });
  await runtime.init();
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity,
    getStatus: () => runtime.statusSnapshot({
      mode: 'immersive',
      identity,
      capability: { reachable: true, version: 1, lastOkAt: NOW, error: null },
      model: { configured: 'heuristic', active: 'heuristic', degraded: false, reason: null },
      limits: {
        maxChunkBytes: config.limits.maxChunkBytes,
        maxContextTokens: config.limits.maxContextTokens,
        maxRecall: config.limits.maxRecall,
      },
      warnings: [],
    }),
    ingest: runtime,
    namespaces: runtime,
    recall: runtime,
    objects: runtime,
    getDegraded: () => runtime.degraded,
    now: () => NOW,
  });
  await server.listen();
  const harness = { home, fake, runtime, server };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.stop();
    await harness.server.close();
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

async function request(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method,
    headers: {
      ...auth(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

describe('sidecar compact / self / checkpoint HTTP', () => {
  it('compact：确定性摘要、sourceIds/sourceHashes/tokenCount/stale、幂等且不改源记录', async () => {
    const { server, fake } = await setup();
    const before = JSON.parse(JSON.stringify(fake.records));

    const first = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      limit: 3,
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      status: 'completed',
      domain: 'agent:opencode',
      stale: false,
      dryRun: false,
      queued: false,
    });
    expect(first.body.data.compactId).toMatch(/^01FAKEC/);
    expect(first.body.data.sourceIds).toHaveLength(3);
    expect(first.body.data.sourceHashes).toHaveLength(3);
    expect(first.body.data.tokenCount).toBeGreaterThan(0);
    expect(first.body.data.summary).toContain('pnpm workspace build 已通过');
    expect(first.body.data.summary).toContain('theme=dark');
    expect(fake.compacts).toHaveLength(1);
    expect(fake.records).toEqual(before);

    const second = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      limit: 3,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.compactId).toBe(first.body.data.compactId);
    expect(second.body.data.summary).toBe(first.body.data.summary);
    expect(second.body.data.tokenCount).toBe(first.body.data.tokenCount);
    expect(fake.compacts).toHaveLength(1);

    const fetched = await request(`${server.url}/compacts/${first.body.data.compactId}`, 'GET');
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.compact).toMatchObject({
      id: first.body.data.compactId,
      type: 'compact',
      kind: 'compact',
      domain: 'agent:opencode',
      stale: false,
      sourceIds: first.body.data.sourceIds,
    });
    expect(JSON.stringify(fetched.body)).not.toContain('cap-token');
    expect(JSON.stringify(fetched.body)).not.toContain('host-token');

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const cached = await request(`${server.url}/compacts/${first.body.data.compactId}`, 'GET');
    expect(cached.status).toBe(200);
    expect(cached.body.data).toMatchObject({
      source: 'cache',
      degraded: true,
      compact: { stale: true },
    });
    fake.setFailure(null);

    const changed = fake.records.map((record) => record.id === '01JSRC2'
      ? { ...record, content: { content: '源记录已更新' }, updatedAt: NOW + 1 }
      : record);
    fake.setRecords(changed);
    const stale = await request(`${server.url}/compacts/${first.body.data.compactId}`, 'GET');
    expect(stale.status).toBe(200);
    expect(stale.body.data.compact.stale).toBe(true);
    expect(fake.records).toHaveLength(3);
  });

  it('compact：dryRun 不写入；跨 Agent/任务域拒绝且错误不含正文', async () => {
    const { server, fake } = await setup();
    const dry = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      namespace: 'agent:opencode',
      sourceIds: ['01JSRC1', '01JSRC3'],
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({
      status: 'dry_run',
      dryRun: true,
      compactId: null,
      queued: false,
      sourceIds: ['01JSRC1', '01JSRC3'],
    });
    expect(dry.body.data.summary).toContain('Mebular uses sidecar');
    expect(fake.compacts).toHaveLength(0);

    fake.setRecords([
      ...compactRecords(),
      memoryRecord('01JHERMES', 'agent:hermes', 'observation', { content: 'secret-hermes-content' }),
    ]);
    const forbidden = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:hermes',
      sourceIds: ['01JHERMES'],
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('domain_write_forbidden');
    expect(JSON.stringify(forbidden.body)).not.toContain('secret-hermes-content');
    expect(JSON.stringify(forbidden.body)).not.toContain('cap-token');

    const mismatch = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      sourceIds: ['01JHERMES'],
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('domain_mismatch');
    expect(JSON.stringify(mismatch.body)).not.toContain('secret-hermes-content');

    const taskMismatch = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'task:th_other',
      threadId: 'th_self',
    });
    expect(taskMismatch.status).toBe(400);
    expect(taskMismatch.body.error.code).toBe('domain_mismatch');
  });

  it('checkpoint：upsert/get/delete、revision 冲突、无 sync、缓存降级', async () => {
    const { server, fake } = await setup();
    const url = `${server.url}/checkpoints/th_alpha?agentId=opencode`;

    const conflict = await request(url, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 0,
      state: { secretState: 'do-not-leak', cursor: 1 },
      sync: 'local',
    });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.code).toBe('legacy_sync_unsupported');
    expect(fake.checkpoints).toHaveLength(0);

    const first = await request(url, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 0,
      state: { secretState: 'do-not-leak', cursor: 1 },
      summary: '已完成第 1 步',
      recordIds: ['01JSRC1'],
    });
    expect(first.status).toBe(200);
    expect(first.body.data.checkpoint).toMatchObject({
      agentId: 'opencode',
      threadId: 'th_alpha',
      revision: 1,
      domain: 'task:th_alpha',
      pending: false,
      source: 'cloud',
    });
    expect(JSON.stringify(first.body)).not.toContain('cap-token');

    const fetched = await request(url, 'GET');
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.checkpoint).toMatchObject({ revision: 1, state: { cursor: 1 } });

    const second = await request(url, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { cursor: 2 },
    });
    expect(second.status).toBe(200);
    expect(second.body.data.checkpoint.revision).toBe(2);

    const staleRevision = await request(url, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { cursor: 3 },
    });
    expect(staleRevision.status).toBe(409);
    expect(staleRevision.body.error.code).toBe('revision_mismatch');
    expect(JSON.stringify(staleRevision.body)).not.toContain('do-not-leak');
    expect(fake.checkpoints).toHaveLength(2);

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const cached = await request(url, 'GET');
    expect(cached.status).toBe(200);
    expect(cached.body.data).toMatchObject({
      source: 'cache',
      degraded: true,
      checkpoint: { revision: 2, stale: true },
    });
    expect(cached.body.degraded).toBe(true);

    const failedDelete = await request(url, 'DELETE');
    expect(failedDelete.status).toBe(503);
    expect(failedDelete.body.error.code).toBe('capability_unavailable');
    expect(failedDelete.body.data?.deleted).not.toBe(true);

    fake.setFailure(null);
    const deleted = await request(url, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(fake.checkpoints).toHaveLength(0);
    const gone = await request(url, 'GET');
    expect(gone.body.data.checkpoint).toBeNull();

    const syncQuery = await request(`${server.url}/checkpoints/th_alpha?agentId=opencode&sync=cloud`, 'GET');
    expect(syncQuery.status).toBe(400);
    expect(syncQuery.body.error.code).toBe('legacy_sync_unsupported');
  });

  it('checkpoint：lease 冲突由 capability 裁定；capability 不可用进入 outbox 并返回 pending', async () => {
    const { server, fake, runtime } = await setup();
    const url = `${server.url}/checkpoints/th_lease?agentId=opencode`;

    const first = await request(url, 'PUT', {
      agentId: 'opencode',
      state: { cursor: 1 },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.checkpoint.lease.hostId).toBe('h_fake');
    fake.setCheckpointLeaseHost('h_other');

    const lease = await request(url, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 1,
      state: { cursor: 2 },
    });
    expect(lease.status).toBe(409);
    expect(lease.body.error.code).toBe('checkpoint_lease_held');
    expect(fake.checkpoints).toHaveLength(1);

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const pending = await request(`${server.url}/checkpoints/th_offline?agentId=opencode`, 'PUT', {
      agentId: 'opencode',
      state: { cursor: 9 },
      summary: 'offline pending',
    });
    expect(pending.status).toBe(202);
    expect(pending.body.data).toMatchObject({
      pending: true,
      degraded: true,
      checkpoint: {
        agentId: 'opencode',
        threadId: 'th_offline',
        revision: null,
        pending: true,
        stale: true,
      },
    });
    expect(pending.body.data.checkpoint.committed).toBeUndefined();
    expect(fake.checkpoints.filter((checkpoint) => checkpoint.threadId === 'th_offline')).toHaveLength(0);

    const status = await request(`${server.url}/status`, 'GET');
    expect(status.body.data.degraded).toBe(true);
    expect(status.body.data.counts).toMatchObject({ outbox: 1, objectWritesQueued: 1 });
    expect(JSON.stringify(status.body)).not.toContain('offline pending');
    expect(JSON.stringify(status.body)).not.toContain('cap-token');

    fake.setFailure(null);
    const replayed = await runtime.replayer.replayOnce();
    expect(replayed.remaining).toBe(0);
    expect(fake.checkpoints.filter((checkpoint) => checkpoint.threadId === 'th_offline')).toHaveLength(1);

    const recovered = await request(`${server.url}/checkpoints/th_offline?agentId=opencode`, 'GET');
    expect(recovered.status).toBe(200);
    expect(recovered.body.data.checkpoint).toMatchObject({ revision: 1, pending: false, source: 'cloud' });
  });

  it('checkpoint：域/权限约束拒绝其他 Agent 与非法域', async () => {
    const { server, fake } = await setup();
    const agentDomain = await request(`${server.url}/checkpoints/th_alpha?agentId=opencode`, 'PUT', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      state: { cursor: 1 },
    });
    expect(agentDomain.status).toBe(400);
    expect(agentDomain.body.error.code).toBe('domain_mismatch');

    const otherAgent = await request(`${server.url}/checkpoints/th_alpha`, 'PUT', {
      agentId: 'hermes',
      actor: { type: 'agent', agentId: 'opencode' },
      state: { cursor: 1 },
    });
    expect(otherAgent.status).toBe(403);
    expect(otherAgent.body.error.code).toBe('forbidden_scope');
    expect(fake.checkpoints).toHaveLength(0);

    const missingAgent = await request(`${server.url}/checkpoints/th_alpha`, 'GET');
    expect(missingAgent.status).toBe(400);
    expect(missingAgent.body.error.code).toBe('invalid_agent_id');
  });

  it('self：upsert/get/revision 取最大、agent 域隔离、无 sync、outbox 恢复', async () => {
    const { server, fake, runtime } = await setup();
    const url = `${server.url}/self/opencode`;

    const sync = await request(url, 'PUT', {
      expectedRevision: 0,
      displayName: 'OpenCode',
      sync: 'local',
    });
    expect(sync.status).toBe(400);
    expect(sync.body.error.code).toBe('legacy_sync_unsupported');
    expect(fake.selfRecords).toHaveLength(0);

    const first = await request(url, 'PUT', {
      expectedRevision: 0,
      displayName: 'OpenCode',
      goals: ['ship W4c'],
      traits: ['careful'],
      preferences: { theme: 'dark' },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.selfRecord).toMatchObject({
      agentId: 'opencode',
      domain: 'agent:opencode',
      revision: 1,
      content: { displayName: 'OpenCode', goals: ['ship W4c'] },
    });

    const second = await request(url, 'PUT', {
      expectedRevision: 1,
      displayName: 'OpenCode',
      goals: ['ship W4c', 'review'],
    });
    expect(second.status).toBe(200);
    expect(second.body.data.selfRecord.revision).toBe(2);

    const fetched = await request(url, 'GET');
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.selfRecord).toMatchObject({
      revision: 2,
      domain: 'agent:opencode',
      content: { displayName: 'OpenCode', goals: ['ship W4c', 'review'] },
    });

    const otherAgent = await request(`${server.url}/self/hermes`, 'PUT', {
      agentId: 'opencode',
      expectedRevision: 0,
      displayName: 'Hermes',
    });
    expect(otherAgent.status).toBe(403);
    expect(otherAgent.body.error.code).toBe('forbidden_scope');
    expect(fake.selfRecords.filter((record) => record.agentId === 'hermes')).toHaveLength(0);

    const actorMismatch = await request(`${server.url}/self/hermes`, 'PUT', {
      actor: { type: 'agent', agentId: 'opencode' },
      expectedRevision: 0,
      displayName: 'Hermes',
    });
    expect(actorMismatch.status).toBe(403);
    expect(actorMismatch.body.error.code).toBe('forbidden_scope');

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const pending = await request(`${server.url}/self/opencode`, 'PUT', {
      expectedRevision: 2,
      displayName: 'OpenCode',
      goals: ['offline'],
    });
    expect(pending.status).toBe(202);
    expect(pending.body.data).toMatchObject({
      pending: true,
      degraded: true,
      selfRecord: { agentId: 'opencode', revision: null, pending: true, stale: true },
    });
    expect(fake.selfRecords).toHaveLength(2);

    fake.setFailure(null);
    const replayed = await runtime.replayer.replayOnce();
    expect(replayed.remaining).toBe(0);
    expect(fake.selfRecords).toHaveLength(3);
    const recovered = await request(url, 'GET');
    expect(recovered.body.data.selfRecord.revision).toBe(3);

    const status = await request(`${server.url}/status`, 'GET');
    expect(status.body.data.counts).toMatchObject({
      compacts: 0,
      checkpoints: 0,
      selfRecords: 3,
    });
    const version = await request(`${server.url}/version`, 'GET');
    expect(version.body.data.capabilities).toMatchObject({
      checkpoint: true,
      compact: true,
      self: true,
    });
  });

  it('compact：capability 不可用时带 sourceIds 进入 outbox，恢复后只写一次', async () => {
    const { server, fake, runtime } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const pending = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      sourceIds: ['01JSRC1', '01JSRC2'],
      dryRun: false,
    });
    expect(pending.status).toBe(202);
    expect(pending.body.data).toMatchObject({
      status: 'pending',
      queued: true,
      degraded: true,
      compactId: null,
      sourceIds: ['01JSRC1', '01JSRC2'],
    });
    expect(fake.compacts).toHaveLength(0);

    fake.setFailure(null);
    const replayed = await runtime.replayer.replayOnce();
    expect(replayed.remaining).toBe(0);
    expect(fake.compacts).toHaveLength(1);

    const repeated = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      sourceIds: ['01JSRC1', '01JSRC2'],
    });
    expect(repeated.status).toBe(200);
    expect(fake.compacts).toHaveLength(1);
  });

  it('status/version/namespaces 暴露对象能力与计数，且不泄漏 token/正文', async () => {
    const { server } = await setup();
    const compact = await request(`${server.url}/compact`, 'POST', {
      agentId: 'opencode',
      domain: 'agent:opencode',
      limit: 2,
    });
    expect(compact.status).toBe(200);
    const checkpoint = await request(`${server.url}/checkpoints/th_status?agentId=opencode`, 'PUT', {
      agentId: 'opencode',
      state: { cursor: 1 },
      summary: 'status checkpoint body',
    });
    expect(checkpoint.status).toBe(200);
    const self = await request(`${server.url}/self/opencode`, 'PUT', {
      expectedRevision: 0,
      displayName: 'OpenCode',
    });
    expect(self.status).toBe(200);

    const status = await request(`${server.url}/status`, 'GET');
    expect(status.status).toBe(200);
    expect(status.body.data.counts).toMatchObject({
      compacts: 1,
      checkpoints: 1,
      selfRecords: 1,
      objectWritesQueued: 0,
      objectWritesFailed: 0,
    });
    expect(status.body.data.degraded).toBe(false);
    expect(JSON.stringify(status.body)).not.toContain('status checkpoint body');
    expect(JSON.stringify(status.body)).not.toContain('cap-token');
    expect(JSON.stringify(status.body)).not.toContain('host-token');

    const version = await request(`${server.url}/version`, 'GET');
    expect(version.body.data.capabilities).toMatchObject({
      checkpoint: true,
      compact: true,
      self: true,
    });

    const namespaces = await request(`${server.url}/namespaces?agentId=opencode`, 'GET');
    expect(namespaces.status).toBe(200);
    const agent = namespaces.body.data.domains.find((domain: any) => domain.domain === 'agent:opencode');
    expect(agent).toMatchObject({ readable: true, writable: true, crossAgent: false });
  });
});
