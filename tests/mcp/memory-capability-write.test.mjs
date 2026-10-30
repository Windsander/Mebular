// W2b：/internal/memory/v1 写端点（write/update/delete/archive/internal-object/sync）。
// 真实 Mebular + MemoryService + 沙箱 home；不启网络/模型。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager, Mebular, MemoryService } from '@mebular/core';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { readCapabilityToken } from '../../packages/mcp/src/memory-runtime-token.mjs';
import { TOOL_NAMES, TOOL_SPECS } from '../../packages/mcp/src/tools.mjs';

let home;
let cloudRoot;
let app;
let service;
let server;
let base;
let token;
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;

const agent = { type: 'agent', agentId: 'opencode' };

function request(path, { method = 'GET', body, token: bearer, headers = {} } = {}) {
  const url = new URL(`${base}${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function post(path, body, options = {}) {
  return request(path, { method: 'POST', body, ...options });
}

function capability(path) {
  return `/internal/memory/v1${path}`;
}

function writeBody(items, extra = {}) {
  return { actor: agent, ...extra, items };
}

function unique(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function writeOne(item, options = {}) {
  const res = await post(capability('/write'), writeBody([item]), { token, ...options });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'memory-capability-write-'));
  cloudRoot = join(home, 'cloud');
  process.env.MEBULAR_CLOUD_ROOT = cloudRoot;
  delete process.env.MEBULAR_CAPABILITY_TOKEN;

  const master = await new IdentityManager().generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-w2b',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);

  server = await startHttpServer({
    home,
    app,
    service,
    config: {
      deviceId: 'device-w2b',
      memoryRuntime: { enabled: true },
      sync: { namespaces: [] },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
  });
  base = `http://127.0.0.1:${server.port}`;
  token = (await readCapabilityToken({ home, env: {} }))?.token;
  expect(typeof token).toBe('string');
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  await app?.shutdown().catch(() => undefined);
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
  if (savedCapabilityToken === undefined) delete process.env.MEBULAR_CAPABILITY_TOKEN;
  else process.env.MEBULAR_CAPABILITY_TOKEN = savedCapabilityToken;
  if (home) await rm(home, { recursive: true, force: true });
});

describe('版本与能力探测', () => {
  it('/version 如实声明写能力、幂等、内部对象与同步', async () => {
    const res = await request(capability('/version'), { token });
    expect(res.status).toBe(200);
    expect(res.body.data.features).toMatchObject({
      readOnly: false,
      batchWrite: true,
      idempotency: true,
      sync: true,
      internalObjects: ['compact', 'self_record', 'context_checkpoint'],
    });
    expect(res.body.data.features.writeEndpoints).toContain('write');
    expect(res.body.data.limits.maxBatchItems).toBe(100);
    expect(res.text).not.toContain(token);
  });
});

describe('POST /write', () => {
  it('单条写入：服务端推导 domain/owner/provenance，可被 read API 召回', async () => {
    const marker = unique('pnpm');
    const res = await writeOne({
      clientItemId: unique('cand_fact'),
      domain: 'agent:opencode',
      kind: 'fact',
      content: { subject: 'project', predicate: 'tool', object: marker, confidence: 0.8 },
      tags: ['tooling'],
      provenance: {
        source: 'runtime',
        extractor: 'heuristic',
        threadId: 'th_write',
        messageIds: ['m1'],
        rawChunkIds: ['rc_1'],
        confirmation: 'none',
      },
    });
    const result = res.body.data.results[0];
    expect(res.body.data).toMatchObject({ created: 1, duplicates: 0, failed: 0, partial: false, replayed: false });
    expect(result).toMatchObject({
      status: 'created',
      domain: 'agent:opencode',
      ownerType: 'agent',
      ownerId: 'opencode',
      type: 'fact',
      kind: 'fact',
    });
    const node = await app.graph.getNode(result.id);
    expect(node.namespace).toBe('agent:opencode');
    expect(node.metadata.internal).toBeUndefined();
    expect(node.metadata.provenance).toMatchObject({
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'heuristic',
      deviceId: 'device-w2b',
      threadId: 'th_write',
    });
    expect(node.metadata.provenance.hostId).toMatch(/^h_[0-9a-f]{16}$/);
    expect(node.metadata.clientItemId).toBeTruthy();
    expect(node.metadata.contentHash).toMatch(/^sha256:/);

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(query.status).toBe(200);
    const record = query.body.data.records.find((entry) => entry.id === result.id);
    expect(record).toMatchObject({
      domain: 'agent:opencode',
      ownerType: 'agent',
      ownerId: 'opencode',
      kind: 'fact',
    });
    expect(record.provenance.writerId).toBe('opencode');
    expect(record.provenance.deviceId).toBe('device-w2b');
  });

  it('批量写入：顺序一致、计数正确；observation 落为 episode 语义', async () => {
    const marker = unique('batch-observation');
    const res = await post(capability('/write'), writeBody([
      {
        clientItemId: unique('batch_default'),
        domain: 'default',
        kind: 'observation',
        content: { content: marker },
        provenance: { source: 'runtime', extractor: 'heuristic' },
      },
      {
        clientItemId: unique('batch_shared'),
        domain: 'shared',
        kind: 'preference',
        content: { entity: 'team', preferenceType: 'style', value: unique('concise') },
        provenance: { source: 'runtime', extractor: 'heuristic' },
      },
    ]), { token });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.partial).toBe(false);
    expect(res.body.data.results.map((entry) => entry.status)).toEqual(['created', 'created']);
    const observation = res.body.data.results[0];
    expect(observation.type).toBe('episode');
    const node = await app.graph.getNode(observation.id);
    expect(node.type).toBe('episode');
    expect(node.content).toMatchObject({ episodeType: 'observation', content: marker });
    expect(node.metadata.kind).toBe('observation');

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      types: ['observation'],
    }, { token });
    expect(query.status).toBe(200);
    expect(query.body.data.records.map((entry) => entry.id)).toContain(observation.id);
    expect(query.body.data.records.every((entry) => entry.kind === 'observation')).toBe(true);
    expect(query.body.data.records.find((entry) => entry.id === observation.id)?.type).toBe('episode');
    expect(query.body.data.records.find((entry) => entry.id === observation.id)?.text).toBe(marker);
  });

  it('Idempotency-Key 重放返回首次结果；同键不同 body → 409', async () => {
    const key = unique('idem-key');
    const marker = unique('idem-content');
    const body = writeBody([{
      clientItemId: unique('idem_client'),
      domain: 'agent:opencode',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    }]);
    const first = await post(capability('/write'), body, { token, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(200);
    expect(first.body.data.replayed).toBe(false);
    const id = first.body.data.results[0].id;

    const replay = await post(capability('/write'), body, { token, headers: { 'idempotency-key': key } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.results[0].id).toBe(id);
    expect(replay.body.data.created).toBe(1);
    const count = (await app.storage.listNodes({ namespace: 'agent:opencode' }))
      .filter((node) => node.content?.content === marker).length;
    expect(count).toBe(1);

    const conflict = await post(capability('/write'), writeBody([{
      clientItemId: unique('idem_client_2'),
      domain: 'agent:opencode',
      kind: 'observation',
      content: { content: unique('different') },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    }]), { token, headers: { 'idempotency-key': key } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');

    if (process.platform !== 'win32') {
      const ledger = await stat(join(home, 'memory-runtime', 'capability-idempotency.json'));
      expect(ledger.mode & 0o777).toBe(0o600);
    }
  });

  it('内容重复 / clientItemId 重复 → duplicate，不写第二条', async () => {
    const marker = unique('dup-content');
    const item = {
      clientItemId: unique('dup_client'),
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    };
    const first = await writeOne(item);
    const second = await writeOne(item);
    expect(second.body.data.created).toBe(0);
    expect(second.body.data.duplicates).toBe(1);
    expect(second.body.data.results[0]).toMatchObject({
      status: 'duplicate',
      duplicate: true,
      id: first.body.data.results[0].id,
    });

    const clientDup = await writeOne({
      clientItemId: item.clientItemId,
      domain: 'default',
      kind: 'observation',
      content: { content: unique('different-content-same-client') },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    expect(clientDup.body.data.results[0]).toMatchObject({
      status: 'duplicate',
      id: first.body.data.results[0].id,
    });

    // 同内容但显式 validFrom 不同 → 不是重复；同 validFrom → 重复。
    const versionedMarker = unique('versioned-content');
    const versionedBase = {
      domain: 'default',
      kind: 'observation',
      content: { content: versionedMarker },
      provenance: { source: 'runtime' },
    };
    const early = await writeOne({ ...versionedBase, validFrom: 1_000 });
    const later = await writeOne({ ...versionedBase, validFrom: 2_000 });
    expect(later.body.data.results[0].status).toBe('created');
    expect(later.body.data.results[0].id).not.toBe(early.body.data.results[0].id);
    const same = await writeOne({ ...versionedBase, validFrom: 1_000 });
    expect(same.body.data.results[0]).toMatchObject({
      status: 'duplicate',
      id: early.body.data.results[0].id,
    });
  });

  it('批量含非法项 → 422，且零写入（校验原子）', async () => {
    const marker = unique('atomic-must-not-exist');
    const res = await post(capability('/write'), writeBody([
      {
        domain: 'agent:opencode',
        kind: 'observation',
        content: { content: marker },
        provenance: { source: 'runtime' },
      },
      {
        domain: 'agent:opencode',
        kind: 'fact',
        content: { subject: 'x', predicate: 'y' },
      },
    ]), { token });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.index).toBe(1);
    const found = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(found.body.data.records).toEqual([]);
  });

  it('批量落库中途失败 → partial=true，已写项保留、失败项可重放', async () => {
    const markerA = unique('partial-a');
    const markerB = unique('partial-b');
    const originalCreate = app.graph.createNode;
    let calls = 0;
    app.graph.createNode = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated create failure');
      return originalCreate.apply(app.graph, args);
    };
    try {
      const res = await post(capability('/write'), writeBody([
        {
          domain: 'agent:opencode',
          kind: 'observation',
          content: { content: markerA },
          provenance: { source: 'runtime' },
        },
        {
          domain: 'agent:opencode',
          kind: 'observation',
          content: { content: markerB },
          provenance: { source: 'runtime' },
        },
      ]), { token });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ created: 1, failed: 1, partial: true });
      expect(res.body.data.results.map((entry) => entry.status)).toEqual(['created', 'failed']);
      const query = await post(capability('/query'), {
        actor: agent,
        query: markerA,
        domains: ['agent:opencode'],
      }, { token });
      expect(query.body.data.records).toHaveLength(1);
      const retry = await post(capability('/write'), writeBody([{
        domain: 'agent:opencode',
        kind: 'observation',
        content: { content: markerB },
        provenance: { source: 'runtime' },
      }]), { token });
      expect(retry.body.data.created).toBe(1);
    } finally {
      app.graph.createNode = originalCreate;
    }
  });

  it('owner 不一致 / 超量 / 非法域给出结构化错误，且不泄漏正文', async () => {
    const owner = await post(capability('/write'), writeBody([{
      domain: 'agent:opencode',
      ownerType: 'user',
      ownerId: 'u_x',
      kind: 'observation',
      content: { content: 'owner-mismatch-secret' },
    }]), { token });
    expect(owner.status).toBe(400);
    expect(owner.body.error.code).toBe('owner_mismatch');
    expect(owner.text).not.toContain('owner-mismatch-secret');

    const tooMany = await post(capability('/write'), writeBody(
      Array.from({ length: 101 }, (_, index) => ({
        domain: 'default',
        kind: 'observation',
        content: { content: `too-many-${index}` },
      })),
    ), { token });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.error.code).toBe('payload_too_large');

    const badDomain = await post(capability('/write'), writeBody([{
      domain: '__policy__',
      kind: 'observation',
      content: { content: 'x' },
    }]), { token });
    expect(badDomain.status).toBe(400);
    expect(badDomain.body.error.code).toBe('domain_invalid');

    const legacy = await post(capability('/write'), writeBody([{
      domain: 'default',
      kind: 'observation',
      content: { content: 'x' },
    }], { sync: 'cloud' }), { token });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.code).toBe('legacy_sync_unsupported');
  });
});

describe('统一 MemoryRecord 写路径', () => {
  const publicWrite = TOOL_SPECS.find((spec) => spec.name === 'memory_write');

  async function writeViaPublic(items) {
    expect(publicWrite).toBeDefined();
    const result = await publicWrite.handler(service, { items });
    expect(result.isError).toBeUndefined();
    return result.structuredContent.stored;
  }

  async function nodeCreatedEvent(id) {
    const events = await app.eventLog.listEvents();
    return events.find((event) => event.type === 'node_created' && event.data?.node?.id === id);
  }

  it('同一 observation：公共 memory_write 与 capability /write 都落为 episode(observation)', async () => {
    const marker = unique('parity-observation');
    const tags = ['parity-observation-tag'];
    const publicStored = await writeViaPublic([{
      type: 'observation',
      content: marker,
      metadata: { tags, namespace: 'default' },
    }]);
    const capabilityWrite = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      tags,
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    const capabilityResult = capabilityWrite.body.data.results[0];

    expect(publicStored[0]).toMatchObject({ type: 'observation' });
    expect(capabilityResult).toMatchObject({ type: 'episode', kind: 'observation' });

    const publicNode = await app.graph.getNode(publicStored[0].id);
    const capabilityNode = await app.graph.getNode(capabilityResult.id);
    for (const node of [publicNode, capabilityNode]) {
      expect(node.type).toBe('episode');
      expect(node.content).toEqual({ episodeType: 'observation', content: marker });
      expect(node.tags).toEqual(expect.arrayContaining(tags));
      expect(node.namespace).toBe('default');
      expect(node.metadata?.internal).toBeUndefined();
      expect(node.deletedAt).toBeUndefined();
    }

    // 默认可见性：普通检索与 capability 语义查询都能召回（不需要 includeInternal）。
    const found = await service.search({ query: marker });
    expect(found.memories.map((memory) => memory.id).sort())
      .toEqual([publicNode.id, capabilityNode.id].sort());
    const capabilityQuery = await post(capability('/query'), {
      actor: agent,
      query: marker,
      types: ['observation'],
      domains: ['default'],
    }, { token });
    expect(capabilityQuery.status).toBe(200);
    expect(capabilityQuery.body.data.records.map((record) => record.id))
      .toEqual(expect.arrayContaining([publicNode.id, capabilityNode.id]));
    expect(capabilityQuery.body.data.records.every((record) => record.kind === 'observation')).toBe(true);

    // 同步参与：两者都经 GraphStore 产生 node_created 事件（同一事件日志/同步源）。
    for (const node of [publicNode, capabilityNode]) {
      const event = await nodeCreatedEvent(node.id);
      expect(event).toBeDefined();
      expect(event.namespace).toBe('default');
      expect(event.author).toBe(app.deviceId);
    }
  });

  it('legacy fact observation 仍可读，并与新 episode observation 按内容去重', async () => {
    const marker = unique('legacy-observation');
    const legacy = await app.graph.createNode('fact', { content: marker }, undefined, { namespace: 'default' });
    const contentHash = `sha256:${createHash('sha256')
      .update(JSON.stringify({ content: { content: marker }, kind: 'observation' }))
      .digest('hex')}`;
    await app.graph.updateNode(legacy.id, {
      metadata: { kind: 'observation', contentHash },
    });

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      types: ['observation'],
      domains: ['default'],
    }, { token });
    expect(query.status).toBe(200);
    expect(query.body.data.records.map((record) => record.id)).toContain(legacy.id);
    expect(query.body.data.records.find((record) => record.id === legacy.id)).toMatchObject({
      type: 'fact',
      kind: 'observation',
      text: marker,
    });

    const res = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.duplicates).toBe(1);
    expect(res.body.data.results[0]).toMatchObject({ status: 'duplicate', id: legacy.id });
  });

  it('同一 preference：公共工具与 capability 都是 fact + preference 标签、同一三元组', async () => {
    const value = unique('parity-preference');
    const tags = ['parity-preference-tag'];
    const publicStored = await writeViaPublic([{
      type: 'preference',
      content: value,
      metadata: { preferenceType: 'theme', tags, namespace: 'default' },
    }]);
    const capability = await writeOne({
      domain: 'default',
      kind: 'preference',
      content: { entity: 'user', preferenceType: 'theme', value },
      tags,
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    const capabilityResult = capability.body.data.results[0];

    const publicNode = await app.graph.getNode(publicStored[0].id);
    const capabilityNode = await app.graph.getNode(capabilityResult.id);
    expect(publicStored[0].type).toBe('preference');
    expect(capabilityResult).toMatchObject({ type: 'fact', kind: 'preference' });
    for (const node of [publicNode, capabilityNode]) {
      expect(node.type).toBe('fact');
      expect(node.content).toMatchObject({ subject: 'user', predicate: 'theme', object: value });
      expect(node.tags).toEqual(expect.arrayContaining(['preference', ...tags]));
      expect(node.namespace).toBe('default');
      expect(node.metadata?.internal).toBeUndefined();
    }

    const preferences = await service.query({
      types: ['preference'],
      filters: { namespace: 'default' },
    });
    expect(preferences.memories.map((memory) => memory.id))
      .toEqual(expect.arrayContaining([publicNode.id, capabilityNode.id]));
  });

  it('fact 结构化字段保留；公共 fact 仍是 userId/note/content 形状', async () => {
    const object = unique('parity-fact');
    const capability = await writeOne({
      domain: 'default',
      kind: 'fact',
      content: {
        subject: 'service',
        predicate: 'port',
        object,
        confidence: 0.66,
        source: 'host-doc',
      },
      tags: ['parity-fact-tag'],
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    const capabilityNode = await app.graph.getNode(capability.body.data.results[0].id);
    expect(capabilityNode.type).toBe('fact');
    expect(capabilityNode.content).toEqual({
      subject: 'service',
      predicate: 'port',
      object,
      confidence: 0.66,
      source: 'host-doc',
    });
    expect(capabilityNode.tags).toContain('parity-fact-tag');

    const publicMarker = unique('parity-public-fact');
    const publicStored = await writeViaPublic([{
      type: 'fact',
      content: publicMarker,
      metadata: { namespace: 'default' },
    }]);
    const publicNode = await app.graph.getNode(publicStored[0].id);
    expect(publicNode.type).toBe('fact');
    expect(publicNode.content).toMatchObject({ subject: 'user', predicate: 'note', object: publicMarker });
  });

  it('relatedTo 统一由写入服务处理；内部对象与缺失目标不建边', async () => {
    const targetMarker = unique('related-target');
    const targetStored = await writeViaPublic([{
      type: 'fact',
      content: targetMarker,
      metadata: { namespace: 'default' },
    }]);
    const targetId = targetStored[0].id;
    const internal = await app.graph.createNode('compact', { summary: unique('related-internal') }, undefined, {
      namespace: 'default',
    });
    await app.graph.updateNode(internal.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    const missingId = '01JDOESNOTEXIST0000000000000';

    const res = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: unique('related-source') },
      relatedTo: [targetId, internal.id, missingId],
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    const id = res.body.data.results[0].id;
    const edges = await app.graph.listEdges({ source: id });
    expect(edges.map((edge) => edge.target)).toEqual([targetId]);
    expect(res.body.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'related_to_skipped', id: internal.id }),
      expect.objectContaining({ code: 'related_to_skipped', id: missingId }),
    ]));
    expect(await app.graph.listEdges({ source: targetId })).toEqual([]);
    expect(await app.graph.listEdges({ target: internal.id })).toEqual([]);
  });
});

describe('写权限矩阵', () => {
  const item = (domain, extra = {}) => ({
    domain,
    kind: 'observation',
    content: { content: unique(`perm-${domain}`) },
    provenance: { source: 'runtime', extractor: 'heuristic' },
    ...extra,
  });

  it('Agent 只能写自己的 agent 域；其他 Agent / system 被拒绝', async () => {
    const other = await post(capability('/write'), writeBody([item('agent:hermes')]), { token });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('domain_write_forbidden');
    expect(other.body.error.details.allowedDomain).toBe('agent:opencode');

    const system = await post(capability('/write'), writeBody([item('system')]), { token });
    expect(system.status).toBe(403);
    expect(system.body.error.code).toBe('domain_write_forbidden');

    const own = await post(capability('/write'), writeBody([item('agent:opencode')]), { token });
    expect(own.status).toBe(200);
    expect(own.body.data.results[0].ownerType).toBe('agent');
  });

  it('task 域需要参与者且 threadId 匹配', async () => {
    const ok = await post(capability('/write'), writeBody([
      item('task:th_permission', { provenance: { source: 'runtime', threadId: 'th_permission' } }),
    ]), { token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.results[0].domain).toBe('task:th_permission');

    const mismatch = await post(capability('/write'), writeBody([
      item('task:th_permission', { provenance: { source: 'runtime', threadId: 'th_other' } }),
    ]), { token });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('domain_write_forbidden');

    const viaRequest = await post(capability('/write'), {
      actor: agent,
      threadId: 'th_permission',
      items: [item('task:th_permission')],
    }, { token });
    expect(viaRequest.status).toBe(200);
  });

  it('default / shared 对 Agent 开放', async () => {
    for (const domain of ['default', 'shared', 'notes']) {
      const res = await post(capability('/write'), writeBody([item(domain)]), { token });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toMatchObject({
        domain,
        ownerType: 'other',
        ownerId: domain,
      });
    }
  });

  it('user 域：Agent 必须 explicit + source；policy/none 拒绝；用户本人可直接写', async () => {
    const denied = await post(capability('/write'), writeBody([item('user')]), { token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('domain_write_forbidden');
    expect(denied.body.error.details.allowedDomain).toBe('agent:opencode');

    const policy = await post(capability('/write'), writeBody([item('user', {
      provenance: { source: 'runtime', confirmation: 'policy' },
    })]), { token });
    expect(policy.status).toBe(403);

    const missingSource = await post(capability('/write'), writeBody([item('user', {
      provenance: { confirmation: 'explicit' },
    })]), { token });
    expect(missingSource.status).toBe(403);

    const confirmed = await post(capability('/write'), writeBody([item('user', {
      provenance: { source: 'runtime', extractor: 'host', confirmation: 'explicit' },
    })]), { token });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.results[0]).toMatchObject({ ownerType: 'user', ownerId: 'user' });

    const byUser = await post(capability('/write'), {
      actor: { type: 'user' },
      items: [item('user')],
    }, { token });
    expect(byUser.status).toBe(200);
    expect(byUser.body.data.results[0].ownerType).toBe('user');
  });

  it('user actor 可治理 agent:other / system；system actor 可写全部域', async () => {
    for (const domain of ['agent:hermes', 'system']) {
      const res = await post(capability('/write'), {
        actor: { type: 'user' },
        items: [item(domain)],
      }, { token });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].domain).toBe(domain);
    }
    for (const domain of ['user', 'agent:hermes', 'system']) {
      const res = await post(capability('/write'), {
        actor: { type: 'system' },
        items: [item(domain)],
      }, { token });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].domain).toBe(domain);
    }
  });
});

describe('POST /update', () => {
  async function createFact() {
    const res = await writeOne({
      clientItemId: unique('update_base'),
      domain: 'agent:opencode',
      kind: 'fact',
      content: { subject: 'project', predicate: 'version', object: '0.2', confidence: 0.7 },
      tags: ['old'],
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    return res.body.data.results[0].id;
  }

  it('更新 content/tags/metadata；id/createdAt/domain/provenance 不变', async () => {
    const id = await createFact();
    const before = await app.graph.getNode(id);
    const res = await post(capability('/update'), {
      actor: agent,
      items: [{
        id,
        expectedUpdatedAt: before.updatedAt,
        patch: {
          content: { object: '0.3' },
          tags: ['new'],
          metadata: { userNote: 'corrected' },
        },
      }],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ updated: 1, failed: 0, partial: false, replayed: false });
    const node = await app.graph.getNode(id);
    expect(node.id).toBe(id);
    expect(node.createdAt).toBe(before.createdAt);
    expect(node.namespace).toBe('agent:opencode');
    expect(node.content).toMatchObject({ subject: 'project', predicate: 'version', object: '0.3', confidence: 0.7 });
    expect(node.tags).toEqual(['new']);
    expect(node.metadata.userNote).toBe('corrected');
    expect(node.metadata.updatedBy).toMatchObject({ actorType: 'agent', actorId: 'opencode' });
    expect(node.metadata.provenance.writerId).toBe('opencode');

    // 更新后 contentHash 同步刷新：再写同样内容应视为 duplicate，而不是造第二条。
    const duplicate = await writeOne({
      domain: 'agent:opencode',
      kind: 'fact',
      content: { subject: 'project', predicate: 'version', object: '0.3', confidence: 0.7 },
      provenance: { source: 'runtime' },
    });
    expect(duplicate.body.data.results[0]).toMatchObject({ status: 'duplicate', id });
  });

  it('preference 更新兼容 entity/preferenceType/value 写入形状', async () => {
    const created = await writeOne({
      domain: 'agent:opencode',
      kind: 'preference',
      content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
      provenance: { source: 'runtime' },
    });
    const id = created.body.data.results[0].id;
    const res = await post(capability('/update'), {
      actor: agent,
      items: [{ id, patch: { content: { value: 'light' } } }],
    }, { token });
    expect(res.status).toBe(200);
    const node = await app.graph.getNode(id);
    expect(node.content).toMatchObject({ subject: 'user', predicate: 'theme', object: 'light' });
    expect(node.tags).toContain('preference');
  });

  it('observation 更新后仍是 episode(observation)；正文与 kind 保持', async () => {
    const marker = unique('update-observation');
    const created = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime', extractor: 'heuristic' },
    });
    const id = created.body.data.results[0].id;
    const updatedText = `${marker}-updated`;
    const res = await post(capability('/update'), {
      actor: { type: 'user' },
      items: [{ id, patch: { content: { content: updatedText } } }],
    }, { token });
    expect(res.status).toBe(200);
    const node = await app.graph.getNode(id);
    expect(node.type).toBe('episode');
    expect(node.content).toMatchObject({ episodeType: 'observation', content: updatedText });
    expect(node.metadata.kind).toBe('observation');
    const query = await post(capability('/query'), {
      actor: agent,
      query: updatedText,
      types: ['observation'],
      domains: ['default'],
    }, { token });
    expect(query.body.data.records.find((record) => record.id === id)).toMatchObject({
      type: 'episode',
      kind: 'observation',
      text: updatedText,
    });
  });

  it('受保护字段与非法 patch 被拒绝（422），时间字段给出明确限制', async () => {
    const id = await createFact();
    for (const patch of [
      { metadata: { internal: true } },
      { metadata: { provenance: { source: 'host' } } },
      { metadata: { ownerType: 'user' } },
      { metadata: { archivedAt: 1 } },
      { domain: 'user' },
      { validTo: Date.now() + 1000 },
    ]) {
      const res = await post(capability('/update'), {
        actor: agent,
        items: [{ id, patch }],
      }, { token });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    const after = await app.graph.getNode(id);
    expect(after.metadata.internal).toBeUndefined();
    expect(after.metadata.provenance.source).toBe('runtime');
  });

  it('旧 expectedUpdatedAt → 409 update_conflict；内部对象 → 404', async () => {
    const id = await createFact();
    const node = await app.graph.getNode(id);
    const conflict = await post(capability('/update'), {
      actor: agent,
      items: [{ id, expectedUpdatedAt: (node.updatedAt ?? 1) - 1, patch: { content: { object: 'x' } } }],
    }, { token });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('update_conflict');
    expect(conflict.body.error.details.currentUpdatedAt).toBe(node.updatedAt);

    const internal = await app.graph.createNode('compact', { summary: 'update-internal' }, undefined, { namespace: 'notes' });
    await app.graph.updateNode(internal.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    const internalRes = await post(capability('/update'), {
      actor: { type: 'user' },
      items: [{ id: internal.id, patch: { content: { summary: 'x' } } }],
    }, { token });
    expect(internalRes.status).toBe(404);
    expect(internalRes.body.error.code).toBe('internal_object');
  });

  it('Agent 不能更新其他 Agent 或 user 域记录；user 可治理', async () => {
    const own = await createFact();
    const ok = await post(capability('/update'), {
      actor: agent,
      items: [{ id: own, patch: { content: { object: 'own-update' } } }],
    }, { token });
    expect(ok.status).toBe(200);

    const hermes = await post(capability('/write'), {
      actor: { type: 'agent', agentId: 'hermes' },
      items: [{
        domain: 'agent:hermes',
        kind: 'observation',
        content: { content: unique('hermes-update') },
        provenance: { source: 'runtime', extractor: 'heuristic' },
      }],
    }, { token });
    const hermesId = hermes.body.data.results[0].id;
    const denied = await post(capability('/update'), {
      actor: agent,
      items: [{ id: hermesId, patch: { content: { content: 'hijack' } } }],
    }, { token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden_scope');

    const userRecord = await post(capability('/write'), {
      actor: { type: 'user' },
      items: [{
        domain: 'user',
        kind: 'observation',
        content: { content: unique('user-update') },
      }],
    }, { token });
    const userId = userRecord.body.data.results[0].id;
    const userDenied = await post(capability('/update'), {
      actor: agent,
      items: [{ id: userId, patch: { content: { content: 'hijack-user' } } }],
    }, { token });
    expect(userDenied.status).toBe(403);

    const governed = await post(capability('/update'), {
      actor: { type: 'user' },
      items: [{ id: hermesId, patch: { content: { content: 'governed' } } }],
    }, { token });
    expect(governed.status).toBe(200);
  });
});

describe('POST /delete 与 /archive', () => {
  it('删除写墓碑；默认查询不再返回', async () => {
    const marker = unique('delete-me');
    const created = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime' },
    });
    const id = created.body.data.results[0].id;
    const res = await post(capability('/delete'), {
      actor: { type: 'user' },
      ids: [id],
      reason: 'test',
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toEqual([id]);
    expect(res.body.data.partial).toBe(false);
    expect((await app.graph.getNode(id)).deletedAt).toBeGreaterThan(0);
    const query = await post(capability('/query'), { actor: agent, query: marker }, { token });
    expect(query.body.data.records).toEqual([]);
  });

  it('归档/解除归档；归档默认不召回，includeArchived 可查', async () => {
    const marker = unique('archive-me');
    const created = await writeOne({
      domain: 'default',
      kind: 'observation',
      content: { content: marker },
      provenance: { source: 'runtime' },
    });
    const id = created.body.data.results[0].id;
    const archived = await post(capability('/archive'), {
      actor: { type: 'user' },
      ids: [id],
      archived: true,
    }, { token });
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toEqual([id]);
    expect((await app.graph.getNode(id)).metadata.archivedAt).toBeGreaterThan(0);
    const hidden = await post(capability('/query'), { actor: agent, query: marker }, { token });
    expect(hidden.body.data.records).toEqual([]);
    const visible = await post(capability('/query'), {
      actor: agent,
      query: marker,
      includeArchived: true,
    }, { token });
    expect(visible.body.data.records.map((record) => record.id)).toContain(id);

    const unarchived = await post(capability('/archive'), {
      actor: { type: 'user' },
      ids: [id],
      archived: false,
    }, { token });
    expect(unarchived.body.data.unarchived).toEqual([id]);
    expect((await app.graph.getNode(id)).metadata.archivedAt).toBeUndefined();
  });

  it('内部对象不能经普通 delete/archive；Agent 治理权限受限', async () => {
    const internal = await app.graph.createNode('compact', { summary: 'internal-delete-test' }, undefined, { namespace: 'notes' });
    await app.graph.updateNode(internal.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    const deleted = await post(capability('/delete'), {
      actor: { type: 'user' },
      ids: [internal.id],
    }, { token });
    expect(deleted.body.data.internal).toEqual([internal.id]);
    expect((await app.graph.getNode(internal.id)).deletedAt).toBeUndefined();
    const archived = await post(capability('/archive'), {
      actor: { type: 'user' },
      ids: [internal.id],
    }, { token });
    expect(archived.body.data.internal).toEqual([internal.id]);

    const own = await writeOne({
      domain: 'agent:opencode',
      kind: 'observation',
      content: { content: unique('own-govern') },
      provenance: { source: 'runtime' },
    });
    const other = await post(capability('/write'), {
      actor: { type: 'agent', agentId: 'hermes' },
      items: [{
        domain: 'agent:hermes',
        kind: 'observation',
        content: { content: unique('other-govern') },
        provenance: { source: 'runtime' },
      }],
    }, { token });
    const result = await post(capability('/delete'), {
      actor: agent,
      ids: [own.body.data.results[0].id, other.body.data.results[0].id],
    }, { token });
    expect(result.status).toBe(200);
    expect(result.body.data.deleted).toEqual([own.body.data.results[0].id]);
    expect(result.body.data.forbidden).toEqual([other.body.data.results[0].id]);
    expect(result.body.data.partial).toBe(true);
  });
});

describe('POST /internal-object', () => {
  it('compact：同域 source、幂等、stale 计算、无内部边、受控删除', async () => {
    const first = await writeOne({
      domain: 'agent:opencode',
      kind: 'fact',
      content: { subject: 'project', predicate: 'dep', object: unique('compact-dep') },
      provenance: { source: 'runtime' },
    });
    const second = await writeOne({
      domain: 'agent:opencode',
      kind: 'observation',
      content: { content: unique('compact-note') },
      provenance: { source: 'runtime' },
    });
    const sourceA = first.body.data.results[0].id;
    const sourceB = second.body.data.results[0].id;
    const body = {
      actor: agent,
      kind: 'compact',
      op: 'upsert',
      domain: 'agent:opencode',
      summary: 'weekly compaction',
      sourceIds: [sourceA, sourceB],
      strategy: 'summary',
      tokenCount: 12,
    };
    const res = await post(capability('/internal-object'), body, { token });
    expect(res.status).toBe(200);
    const object = res.body.data.object;
    expect(object).toMatchObject({
      type: 'compact',
      kind: 'compact',
      domain: 'agent:opencode',
      ownerType: 'agent',
      internal: true,
      stale: false,
      tokenCount: 12,
    });
    expect(object.sourceIds).toEqual([sourceA, sourceB]);
    expect(object.sourceHashes).toHaveLength(2);
    expect(object.sourceHashes.every((hash) => hash.startsWith('sha256:'))).toBe(true);
    expect(res.text).not.toContain(token);

    const node = await app.graph.getNode(object.id);
    expect(node.metadata.internal).toBe(true);
    expect(node.metadata.internalObject).toMatchObject({ schema: 1, kind: 'compact' });
    expect(node.metadata.runtime).toBeUndefined();
    expect((node.tags ?? []).some((tag) => tag.startsWith('mebular:runtime:'))).toBe(false);
    expect(await app.graph.listEdges({ source: object.id })).toEqual([]);
    expect(await app.graph.listEdges({ target: object.id })).toEqual([]);

    const again = await post(capability('/internal-object'), body, { token });
    expect(again.status).toBe(200);
    expect(again.body.data.object.id).toBe(object.id);

    const got = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'get',
      id: object.id,
    }, { token });
    expect(got.status).toBe(200);
    expect(got.body.data.object.id).toBe(object.id);

    const list = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'list',
      domains: ['agent:opencode'],
    }, { token });
    expect(list.body.data.objects.map((entry) => entry.id)).toContain(object.id);

    // 源记录更新后 stale=true。
    const updated = await post(capability('/update'), {
      actor: agent,
      items: [{ id: sourceA, patch: { content: { object: unique('compact-dep-v2') } } }],
    }, { token });
    expect(updated.status).toBe(200);
    const stale = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'get',
      id: object.id,
    }, { token });
    expect(stale.body.data.object.stale).toBe(true);

    const cross = await post(capability('/write'), {
      actor: { type: 'user' },
      items: [{
        domain: 'default',
        kind: 'observation',
        content: { content: unique('cross-domain-source') },
      }],
    }, { token });
    const crossRes = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'upsert',
      domain: 'agent:opencode',
      summary: 'cross',
      sourceIds: [cross.body.data.results[0].id],
    }, { token });
    expect(crossRes.status).toBe(400);
    expect(crossRes.body.error.code).toBe('domain_mismatch');

    const missing = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'upsert',
      domain: 'agent:opencode',
      summary: 'missing',
      sourceIds: ['01JDOESNOTEXIST0000000000000'],
    }, { token });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const denied = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'delete',
      id: object.id,
    }, { token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden_scope');

    const deleted = await post(capability('/internal-object'), {
      actor: { type: 'user' },
      kind: 'compact',
      op: 'delete',
      id: object.id,
    }, { token });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect((await app.graph.getNode(object.id)).deletedAt).toBeGreaterThan(0);
  });

  it('self_record：始终 agent 域、revision 冲突、其他 Agent 拒绝、无 sync 字段', async () => {
    const first = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      expectedRevision: 0,
      record: {
        displayName: 'OpenCode',
        goals: ['ship'],
        traits: ['careful'],
        preferences: { tone: 'direct' },
        capabilities: ['code'],
        boundaries: ['no secrets'],
      },
    }, { token });
    expect(first.status).toBe(200);
    const object = first.body.data.object;
    expect(object).toMatchObject({
      type: 'self_record',
      kind: 'self_record',
      domain: 'agent:opencode',
      ownerType: 'agent',
      ownerId: 'opencode',
      internal: true,
      agentId: 'opencode',
      revision: 1,
      content: { displayName: 'OpenCode' },
    });
    expect('sync' in object).toBe(false);

    const second = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      expectedRevision: 1,
      record: { displayName: 'OpenCode v2' },
    }, { token });
    expect(second.status).toBe(200);
    expect(second.body.data.object.revision).toBe(2);

    const conflict = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      expectedRevision: 1,
      record: { displayName: 'stale' },
    }, { token });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('revision_mismatch');
    expect(conflict.body.error.details.currentRevision).toBe(2);

    const got = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'get',
      agentId: 'opencode',
    }, { token });
    expect(got.status).toBe(200);
    expect(got.body.data.object.revision).toBe(2);

    const otherAgent = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      record: { displayName: 'hijack' },
    }, { token });
    expect(otherAgent.status).toBe(403);
    expect(otherAgent.body.error.code).toBe('forbidden_scope');

    const wrongDomain = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      domain: 'default',
      record: { displayName: 'wrong-domain' },
    }, { token });
    expect(wrongDomain.status).toBe(400);
    expect(wrongDomain.body.error.code).toBe('domain_mismatch');

    const legacy = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'self_record',
      op: 'upsert',
      agentId: 'opencode',
      sync: 'local',
      record: { displayName: 'legacy' },
    }, { token });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.code).toBe('legacy_sync_unsupported');
  });

  it('context_checkpoint：task/default 域、revision、租约、跨 Agent 拒绝、删除', async () => {
    const first = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      expectedRevision: 0,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
        goal: 'test checkpoint',
        nextSteps: [{ id: 'n1', text: 'verify' }],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: 'step 1',
      leaseMs: 60_000,
    }, { token });
    expect(first.status).toBe(200);
    const object = first.body.data.object;
    expect(object).toMatchObject({
      type: 'context_checkpoint',
      kind: 'context_checkpoint',
      domain: 'task:th_ckpt',
      ownerType: 'other',
      ownerId: 'task:th_ckpt',
      internal: true,
      agentId: 'opencode',
      threadId: 'th_ckpt',
      revision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
        goal: 'test checkpoint',
      },
      summary: 'step 1',
      contentMode: 'structured',
      structured: true,
      expiresAt: 0,
    });
    expect(object.lease.hostId).toMatch(/^h_[0-9a-f]{16}$/);
    expect('sync' in object).toBe(false);

    const second = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      expectedRevision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
        goal: 'test checkpoint 2',
        nextSteps: [{ id: 'n1', text: 'verify more' }],
      },
    }, { token });
    expect(second.status).toBe(200);
    expect(second.body.data.object.revision).toBe(2);

    const got = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'get',
      agentId: 'opencode',
      threadId: 'th_ckpt',
    }, { token });
    expect(got.status).toBe(200);
    expect(got.body.data.object.revision).toBe(2);

    const wrongDomain = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'user',
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
        summary: null,
      },
    }, { token });
    expect(wrongDomain.status).toBe(400);
    expect(wrongDomain.body.error.code).toBe('domain_mismatch');

    const wrongThread = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_other',
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_other', threadId: 'th_ckpt', fleetTaskId: null },
      },
    }, { token });
    expect(wrongThread.status).toBe(400);
    expect(wrongThread.body.error.code).toBe('domain_mismatch');

    const otherAgent = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
      },
    }, { token });
    expect(otherAgent.status).toBe(403);

    const forced = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      force: true,
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
      },
    }, { token });
    expect(forced.status).toBe(403);
    expect(forced.body.error.code).toBe('forbidden_scope');

    // 其他 host 持租约 → 409；user 可 force 抢占。
    const hostLease = await app.graph.createNode('context_checkpoint', {
      agentId: 'opencode',
      threadId: 'th_ckpt',
      revision: 5,
      state: { plan: ['leased'] },
      summary: null,
      recordIds: [],
      lease: { hostId: 'h_other', until: Date.now() + 60_000 },
      expiresAt: 0,
    }, undefined, { namespace: 'task:th_ckpt' });
    await app.graph.updateNode(hostLease.id, {
      metadata: {
        internal: true,
        internalObject: { schema: 1, kind: 'context_checkpoint', agentId: 'opencode', threadId: 'th_ckpt', revision: 5 },
      },
    });
    const leaseHeld = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      expectedRevision: 5,
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
      },
    }, { token });
    expect(leaseHeld.status).toBe(409);
    expect(leaseHeld.body.error.code).toBe('checkpoint_lease_held');

    const forcedByUser = await post(capability('/internal-object'), {
      actor: { type: 'user' },
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt',
      domain: 'task:th_ckpt',
      expectedRevision: 5,
      force: true,
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt', threadId: 'th_ckpt', fleetTaskId: null },
        summary: 'forced',
      },
    }, { token });
    expect(forcedByUser.status).toBe(200);
    expect(forcedByUser.body.data.object.revision).toBe(6);

    const denied = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'delete',
      agentId: 'opencode',
      threadId: 'th_ckpt',
    }, { token });
    expect(denied.status).toBe(403);

    const deleted = await post(capability('/internal-object'), {
      actor: { type: 'user' },
      kind: 'context_checkpoint',
      op: 'delete',
      agentId: 'opencode',
      threadId: 'th_ckpt',
    }, { token });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(deleted.body.data.count).toBeGreaterThanOrEqual(3);
    const afterDelete = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'get',
      agentId: 'opencode',
      threadId: 'th_ckpt',
    }, { token });
    expect(afterDelete.body.data.object).toBeNull();
  });

  it('context_checkpoint schema 2：结构化字段、task 共享 revision、跨 Agent 读、summary_only 降级', async () => {
    const taskState = (revisionText) => ({
      schema: 2,
      contentMode: 'structured',
      task: { key: 'task:fleet_ckpt_2', threadId: 'th_ckpt_2', fleetTaskId: 'fleet_ckpt_2' },
      goal: revisionText,
      constraints: [{ id: 'c1', text: '不新增公共工具', source: 'user' }],
      decisions: [{ id: 'd1', text: '复用图存储', reason: '不建第二套存储', at: 0, recordIds: [] }],
      progress: {
        done: [{ id: 'p1', text: '契约冻结', recordIds: [] }],
        doing: [{ id: 'p2', text: 'sidecar 写入' }],
        blocked: [{ id: 'p3', text: '等待资产', reason: '发布未闭环' }],
      },
      nextSteps: [{ id: 'n1', text: 'DSH 真实旅程', owner: 'dsh' }],
      files: [{ path: 'packages/mcp/src/memory-capability.mjs', role: 'write', status: 'in_progress' }],
      openQuestions: [{ id: 'q1', text: '详情跨域复制？', blocking: true }],
      references: { recordIds: ['01JREF'], detailIds: ['01KDETAIL'], messageIds: ['m1'], fleetTaskId: 'fleet_ckpt_2', urls: [] },
    });
    const first = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_ckpt_2',
      domain: 'task:fleet_ckpt_2',
      expectedRevision: 0,
      state: taskState('跨设备任务'),
      summary: null,
      recordIds: ['01JREF'],
      detailIds: ['01KDETAIL'],
    }, { token });
    expect(first.status).toBe(200);
    expect(first.body.data.object).toMatchObject({
      domain: 'task:fleet_ckpt_2',
      threadId: 'th_ckpt_2',
      revision: 1,
      schema: 2,
      contentMode: 'structured',
      structured: true,
      detailIds: ['01KDETAIL'],
    });
    expect(first.body.data.object.updatedBy.agentId).toBe('opencode');

    const hermesRead = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'context_checkpoint',
      op: 'get',
      agentId: 'hermes',
      threadId: 'th_ckpt_2',
      domain: 'task:fleet_ckpt_2',
    }, { token });
    expect(hermesRead.status).toBe(200);
    expect(hermesRead.body.data.object).toMatchObject({ revision: 1, agentId: 'opencode' });

    const hermesWrite = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'hermes',
      threadId: 'th_ckpt_2',
      domain: 'task:fleet_ckpt_2',
      expectedRevision: 1,
      state: taskState('Hermes 接续'),
    }, { token });
    expect(hermesWrite.status).toBe(200);
    expect(hermesWrite.body.data.object.revision).toBe(2);
    expect(hermesWrite.body.data.object.updatedBy.agentId).toBe('hermes');

    const summaryOnly = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'opencode' },
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_summary_only',
      domain: 'task:th_summary_only',
      expectedRevision: 0,
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_summary_only', threadId: 'th_summary_only', fleetTaskId: null },
        goal: null,
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
    }, { token });
    expect(summaryOnly.status).toBe(200);
    expect(summaryOnly.body.data.object).toMatchObject({ contentMode: 'summary_only', structured: false, degraded: true });
    expect(summaryOnly.body.degraded).toBe(true);
    expect(summaryOnly.body.warnings).toContain('checkpoint_summary_only');
    expect(summaryOnly.body.warnings).toContain('summary_unavailable');

    const invalidSummaryOnly = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_bad_summary',
      domain: 'task:th_bad_summary',
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_bad_summary', threadId: 'th_bad_summary', fleetTaskId: null },
        goal: '伪装结构化',
      },
      summary: 'only summary',
    }, { token });
    expect(invalidSummaryOnly.status).toBe(422);
    expect(invalidSummaryOnly.body.error.code).toBe('validation_failed');

    const oversizedGoal = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_big_goal',
      domain: 'task:th_big_goal',
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_big_goal', threadId: 'th_big_goal', fleetTaskId: null },
        goal: 'x'.repeat(2049),
        nextSteps: [{ id: 'n1', text: 'next' }],
      },
    }, { token });
    expect(oversizedGoal.status).toBe(413);
    expect(oversizedGoal.body.error.code).toBe('payload_too_large');

    // Legacy schema 1 is readable but never promoted to structured.
    const legacyNode = await app.graph.createNode('context_checkpoint', {
      agentId: 'opencode',
      threadId: 'th_legacy_ckpt',
      revision: 1,
      state: { plan: ['old'] },
      summary: 'legacy summary',
      recordIds: [],
      lease: null,
      expiresAt: 0,
    }, undefined, { namespace: 'task:th_legacy_ckpt' });
    await app.graph.updateNode(legacyNode.id, {
      metadata: {
        internal: true,
        internalObject: { schema: 1, kind: 'context_checkpoint', agentId: 'opencode', threadId: 'th_legacy_ckpt', revision: 1 },
      },
    });
    const legacyRead = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'get',
      agentId: 'opencode',
      threadId: 'th_legacy_ckpt',
    }, { token });
    expect(legacyRead.status).toBe(200);
    expect(legacyRead.body.data.object).toMatchObject({
      schema: 1,
      contentMode: null,
      structured: false,
      legacy: true,
      summary: 'legacy summary',
    });
    expect(legacyRead.body.degraded).toBe(true);
  });

  it('context_checkpoint default：按 (agentId, threadId) revision 隔离，其他 Agent 不可读', async () => {
    const defaultState = (goal) => ({
      schema: 2,
      contentMode: 'structured',
      task: { key: 'default', threadId: 'th_default_ckpt', fleetTaskId: null },
      goal,
      nextSteps: [{ id: 'n1', text: 'default next' }],
      references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
    });
    const first = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_default_ckpt',
      domain: 'default',
      expectedRevision: 0,
      state: defaultState('default one'),
    }, { token });
    expect(first.status).toBe(200);
    const second = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_default_ckpt',
      domain: 'default',
      expectedRevision: 1,
      state: defaultState('default two'),
    }, { token });
    expect(second.status).toBe(200);
    expect(second.body.data.object.revision).toBe(2);

    const hermesRead = await post(capability('/internal-object'), {
      actor: { type: 'agent', agentId: 'hermes' },
      kind: 'context_checkpoint',
      op: 'get',
      agentId: 'opencode',
      threadId: 'th_default_ckpt',
      domain: 'default',
    }, { token });
    expect(hermesRead.status).toBe(403);
    expect(hermesRead.body.error.code).toBe('forbidden_scope');
  });
});

describe('GET/POST /sync', () => {
  it('GET 返回真实同步状态；网络未启用不伪造 running', async () => {
    const res = await request(capability('/sync'), { token });
    expect(res.status).toBe(200);
    expect(res.body.data.subscriptions).toEqual({ mode: 'all', namespaces: [] });
    expect(res.body.data.peers).toEqual([]);
    expect(res.body.data.running).toBe(false);
    expect(res.body.data.degraded).toBe(true);
    expect(res.body.warnings[0].code).toBe('sync_unavailable');
    expect(res.text).not.toContain(token);
  });

  it('POST 只做安全单次同步；网络未启用 → 503 sync_unavailable', async () => {
    const res = await post(capability('/sync'), {
      action: 'now',
      peerId: 'device-b',
      address: 'https://example.invalid',
      waitMs: 1000,
    }, { token });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('sync_unavailable');
    expect(res.body.error.retryable).toBe(true);

    const invalid = await post(capability('/sync'), { action: 'full' }, { token });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_request');
  });

  it('现有 API 足够时，POST 映射单次同步结果', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'memory-capability-sync-'));
    const savedToken = process.env.MEBULAR_CAPABILITY_TOKEN;
    const savedRoot = process.env.MEBULAR_CLOUD_ROOT;
    delete process.env.MEBULAR_CAPABILITY_TOKEN;
    process.env.MEBULAR_CLOUD_ROOT = join(fakeHome, 'cloud');
    const fakeApp = {
      deviceId: 'device-sync',
      isInitialized: () => true,
      storage: { listNodes: async () => [] },
      graph: { getNode: async () => null },
      sync: {
        getSyncStatus: async () => ({ isSyncing: false, pendingCount: 4, lastSyncAt: 123 }),
      },
    };
    const calls = [];
    const fakeService = {
      status: async () => ({ running: true, pendingEventCount: 4, deviceId: 'device-sync' }),
      syncStatus: async () => ({
        running: true,
        pendingEventCount: 4,
        lastSyncAt: 123,
        isSyncing: false,
        peerId: null,
      }),
      sync: async (peerId, address) => {
        calls.push({ peerId, address });
        return {
          peerDeviceId: peerId,
          receivedEvents: 3,
          sentEvents: 1,
          durationMs: 120,
          duplicates: 0,
          conflicts: [],
        };
      },
    };
    let fakeServer;
    try {
      fakeServer = await startHttpServer({
        home: fakeHome,
        app: fakeApp,
        service: fakeService,
        config: {
          memoryRuntime: { enabled: true },
          sync: { namespaces: ['default'] },
          mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
        },
        buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
        host: '127.0.0.1',
        port: 0,
        auth: 'none',
      });
      const fakeBase = `http://127.0.0.1:${fakeServer.port}`;
      const fakeToken = (await readCapabilityToken({ home: fakeHome, env: {} }))?.token;
      const getRes = await new Promise((resolve, reject) => {
        const req = http.request(`${fakeBase}${capability('/sync')}`, {
          headers: { authorization: `Bearer ${fakeToken}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
        });
        req.on('error', reject);
        req.end();
      });
      expect(getRes.data.running).toBe(true);
      expect(getRes.data.lastSyncAt).toBe(123);
      expect(getRes.data.degraded).toBe(false);

      const postRes = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          action: 'now',
          peerId: 'device-b',
          address: 'https://device-b.invalid',
          waitMs: 1000,
        });
        const req = http.request(`${fakeBase}${capability('/sync')}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fakeToken}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
          }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body.data).toMatchObject({
        synced: true,
        peerId: 'device-b',
        applied: 3,
        pushed: 1,
        tookMs: 120,
        replayed: false,
      });
      expect(calls).toEqual([{ peerId: 'device-b', address: 'https://device-b.invalid' }]);
    } finally {
      await fakeServer?.close().catch(() => undefined);
      if (savedToken === undefined) delete process.env.MEBULAR_CAPABILITY_TOKEN;
      else process.env.MEBULAR_CAPABILITY_TOKEN = savedToken;
      if (savedRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
      else process.env.MEBULAR_CLOUD_ROOT = savedRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('公共工具面与轻量模式边界', () => {
  it('29 个公共工具不变，capability 不计入工具面', () => {
    expect(TOOL_NAMES).toHaveLength(29);
    expect(TOOL_NAMES).not.toContain('memory_capability');
    expect(TOOL_NAMES).not.toContain('memory_runtime_write');
  });
});
