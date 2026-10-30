// C1：域内详情对象 + capability `/internal/memory/v1/detail`。
// 真实 Mebular + MemoryService + 沙箱 home；不启网络/模型。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
const user = { type: 'user' };
const DAY = 24 * 60 * 60 * 1000;

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

function unique(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function createRecord(domain, marker) {
  const [stored] = await service.write([{
    type: 'observation',
    content: marker,
    metadata: { namespace: domain },
  }]);
  return stored.id;
}

function detailItem(domain, recordIds, text, extra = {}) {
  return {
    domain,
    detailKind: 'raw_chunk',
    role: 'user',
    recordIds,
    text,
    provenance: { source: 'runtime', extractor: 'host', ...(extra.provenance ?? {}) },
    ...extra,
  };
}

async function writeDetail(items, { actor = agent, extra = {}, headers = {} } = {}) {
  return post(capability('/detail'), { actor, op: 'write', ...extra, items }, { token, headers });
}

async function getDetail(id, { actor = agent, extra = {} } = {}) {
  return post(capability('/detail'), { actor, op: 'get', id, ...extra }, { token });
}

async function listDetails({ actor = agent, extra = {} } = {}) {
  return post(capability('/detail'), { actor, op: 'list', ...extra }, { token });
}

async function detailNode(id) {
  return app.graph.getNode(id);
}

async function allDetailNodes() {
  return (await app.graph.listNodes({ type: 'detail_record' }))
    .filter((node) => node.metadata?.internal === true && node.metadata?.internalObject?.kind === 'detail_record');
}

async function nodeCreatedEvent(id) {
  const events = await app.eventLog.listEvents();
  return events.find((event) => event.type === 'node_created' && event.data?.node?.id === id);
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'memory-capability-detail-'));
  cloudRoot = join(home, 'cloud');
  process.env.MEBULAR_CLOUD_ROOT = cloudRoot;
  delete process.env.MEBULAR_CAPABILITY_TOKEN;

  const master = await new IdentityManager().generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-c1',
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
      deviceId: 'device-c1',
      memoryRuntime: {
        enabled: true,
        // 测试用收紧配额：默认值由 core 常量与 package 测试覆盖；这里让淘汰/413 可实测。
        detailLimits: {
          domainBytes: 64 * 1024,
          cloudBytes: 256 * 1024,
          threadBytes: 64 * 1024,
        },
      },
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

describe('版本与详情写入', () => {
  it('/version 声明 details 与 detail limits，公共工具仍 29 个且无 detail 工具', async () => {
    const res = await request(capability('/version'), { token });
    expect(res.status).toBe(200);
    expect(res.body.data.features).toMatchObject({
      details: true,
      detailKinds: ['raw_chunk', 'message', 'tool_output', 'document_slice'],
      readOnly: false,
    });
    expect(res.body.data.features.readEndpoints).toContain('detail');
    expect(res.body.data.features.writeEndpoints).toContain('detail');
    expect(res.body.data.limits).toMatchObject({
      maxDetailTextBytes: 256 * 1024,
      maxDetailBatchItems: 100,
      maxDetailGetBytes: 64 * 1024,
      maxDetailListLimit: 50,
      detailDomainQuotaBytes: 256 * 1024 * 1024,
      detailCloudQuotaBytes: 1024 * 1024 * 1024,
      detailThreadQuotaBytes: 64 * 1024 * 1024,
    });
    expect(TOOL_NAMES).toHaveLength(29);
    expect(TOOL_NAMES.some((name) => /detail|raw_chunk|runtime/i.test(name))).toBe(false);
    expect(res.text).not.toContain(token);
  });

  it('写入 detail_record 节点：域/owner/provenance/contentHash/metadata；node_created 事件可查', async () => {
    const marker = unique('detail-write');
    const recordId = await createRecord('agent:opencode', marker);
    const res = await writeDetail([detailItem('agent:opencode', [recordId], marker, {
      messageId: 'm1',
      chunkIndex: 2,
      turn: 3,
      threadId: 'th_detail',
      redaction: { applied: false, rules: [] },
      retentionClass: 'conversation',
      expiresAt: 0,
      provenance: {
        source: 'runtime',
        extractor: 'host',
        threadId: 'th_detail',
        messageIds: ['m1'],
        confirmation: 'none',
      },
    })]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 1, duplicates: 0, failed: 0, partial: false, replayed: false });
    const entry = res.body.data.results[0];
    expect(entry).toMatchObject({
      status: 'created',
      type: 'detail_record',
      kind: 'detail_record',
      domain: 'agent:opencode',
      detailKind: 'raw_chunk',
      contentHash: sha256(marker),
      ownerType: 'agent',
      ownerId: 'opencode',
    });
    const node = await detailNode(entry.id);
    expect(node.type).toBe('detail_record');
    expect(node.namespace).toBe('agent:opencode');
    expect(node.metadata.internal).toBe(true);
    expect(node.metadata.internalObject).toMatchObject({
      schema: 1,
      kind: 'detail_record',
      detailKind: 'raw_chunk',
      threadId: 'th_detail',
      recordIds: [recordId],
      contentHash: sha256(marker),
    });
    expect(node.metadata.provenance).toMatchObject({
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'host',
      deviceId: 'device-c1',
      threadId: 'th_detail',
      agentId: 'opencode',
      messageIds: ['m1'],
    });
    expect(node.content).toMatchObject({
      detailKind: 'raw_chunk',
      text: marker,
      mime: 'text/plain',
      role: 'user',
      messageId: 'm1',
      chunkIndex: 2,
      turn: 3,
      threadId: 'th_detail',
      recordIds: [recordId],
      contentHash: sha256(marker),
      redaction: { applied: false, rules: [] },
      retentionClass: 'conversation',
    });
    expect(typeof node.content.expiresAt).toBe('number');
    expect(node.content.expiresAt).toBeGreaterThan(Date.now() + 29 * DAY);
    const event = await nodeCreatedEvent(entry.id);
    expect(event).toBeDefined();
    expect(event.namespace).toBe('agent:opencode');

    const got = await getDetail(entry.id, { extra: { includeText: true, maxBytes: 4096 } });
    expect(got.status).toBe(200);
    expect(got.body.data.detail).toMatchObject({
      id: entry.id,
      type: 'detail_record',
      kind: 'detail_record',
      detailKind: 'raw_chunk',
      domain: 'agent:opencode',
      ownerType: 'agent',
      ownerId: 'opencode',
      text: marker,
      truncated: false,
      redacted: false,
      availability: ['available'],
      recordIds: [recordId],
    });
    expect(got.body.data.detail.provenance.deviceId).toBe('device-c1');
  });

  it('Idempotency-Key 重放返回首次结果；同键不同 body → 409', async () => {
    const marker = unique('detail-idem');
    const recordId = await createRecord('agent:opencode', marker);
    const key = unique('detail-idem-key');
    const item = detailItem('agent:opencode', [recordId], marker, { clientItemId: unique('detail-idem-item') });
    const first = await writeDetail([item], { headers: { 'idempotency-key': key } });
    expect(first.status).toBe(200);
    expect(first.body.data.replayed).toBe(false);
    const id = first.body.data.results[0].id;

    const replay = await writeDetail([item], { headers: { 'idempotency-key': key } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.results[0].id).toBe(id);
    const nodes = (await allDetailNodes()).filter((node) => node.content?.text === marker);
    expect(nodes).toHaveLength(1);

    const conflict = await writeDetail([
      detailItem('agent:opencode', [recordId], `${marker}-different`, {
        clientItemId: unique('detail-idem-item-2'),
      }),
    ], { headers: { 'idempotency-key': key } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('同域按 (domain, detailKind, contentHash, chunkIndex) 去重；chunkIndex 不同则另写', async () => {
    const marker = unique('detail-dedupe');
    const recordId = await createRecord('agent:opencode', marker);
    const first = await writeDetail([detailItem('agent:opencode', [recordId], marker, {
      clientItemId: unique('det'),
      chunkIndex: 0,
    })]);
    const id = first.body.data.results[0].id;
    const again = await writeDetail([detailItem('agent:opencode', [recordId], marker, {
      clientItemId: unique('det'),
      chunkIndex: 0,
    })]);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: 0, duplicates: 1, failed: 0, partial: false });
    expect(again.body.data.results[0]).toMatchObject({ status: 'duplicate', id });

    const otherChunk = await writeDetail([detailItem('agent:opencode', [recordId], marker, {
      chunkIndex: 1,
    })]);
    expect(otherChunk.body.data.created).toBe(1);
    expect(otherChunk.body.data.results[0].id).not.toBe(id);
  });

  it('同一文本跨域按域复制：ID 不同、contentHash 相同', async () => {
    const marker = unique('detail-cross-domain-copy');
    const agentRecord = await createRecord('agent:opencode', marker);
    const defaultRecord = await createRecord('default', marker);
    const res = await writeDetail([
      detailItem('agent:opencode', [agentRecord], marker),
      detailItem('default', [defaultRecord], marker),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    const [first, second] = res.body.data.results;
    expect(first.id).not.toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
    expect((await detailNode(first.id)).namespace).toBe('agent:opencode');
    expect((await detailNode(second.id)).namespace).toBe('default');
  });

  it('recordIds 必须非空、存在、同域、非内部；跨域拒绝且不建悬空引用', async () => {
    const marker = unique('detail-recordids');
    const defaultRecord = await createRecord('default', marker);
    const ownRecord = await createRecord('agent:opencode', marker);
    const cross = await writeDetail([detailItem('agent:opencode', [defaultRecord], marker)]);
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe('validation_failed');
    expect(cross.body.error.details.field).toBe('recordIds');

    const missing = await writeDetail([detailItem('agent:opencode', ['01JDOESNOTEXIST0000000000000'], marker)]);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('validation_failed');

    const empty = await writeDetail([detailItem('agent:opencode', [], marker)]);
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('validation_failed');

    const internal = await app.graph.createNode('compact', { summary: unique('detail-internal-target') }, undefined, {
      namespace: 'agent:opencode',
    });
    await app.graph.updateNode(internal.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    const internalRes = await writeDetail([detailItem('agent:opencode', [internal.id], marker)]);
    expect(internalRes.status).toBe(422);
    expect(internalRes.body.error.details.field).toBe('recordIds');

    const leaked = (await allDetailNodes()).filter((node) => node.content?.text === marker);
    expect(leaked).toEqual([]);
    expect(ownRecord).toBeTruthy();
  });

  it('context_checkpoint 可作为同域引用目标；compact 仍拒绝', async () => {
    const marker = unique('detail-recordids-checkpoint');
    const checkpoint = await post(capability('/internal-object'), {
      actor: user,
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: 'opencode',
      threadId: 'th_detail_ref',
      domain: 'default',
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'default', threadId: 'th_detail_ref', fleetTaskId: null },
        goal: 'detail link',
        nextSteps: [{ id: 'n1', text: 'link detail' }],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
    }, { token });
    expect(checkpoint.status).toBe(200);
    const checkpointId = checkpoint.body.data.object.id;
    const linked = await writeDetail([
      detailItem('default', [checkpointId], marker),
    ], { actor: user });
    expect(linked.status).toBe(200);
    expect(linked.body.data.created).toBe(1);
    expect((await detailNode(linked.body.data.results[0].id)).content.recordIds).toEqual([checkpointId]);

    const compact = await app.graph.createNode('compact', { summary: unique('detail-compact-ref') }, undefined, {
      namespace: 'default',
    });
    await app.graph.updateNode(compact.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    const rejected = await writeDetail([detailItem('default', [compact.id], marker)], { actor: user });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.details.field).toBe('recordIds');
  });

  it('受保护字段不可伪造：internal/internalObject/owner/contentHash/expiresAt/type', async () => {
    const marker = unique('detail-protected');
    const recordId = await createRecord('agent:opencode', marker);
    const valid = detailItem('agent:opencode', [recordId], marker);
    const cases = [
      { ...valid, internal: true },
      { ...valid, internalObject: { schema: 1, kind: 'detail_record' } },
      { ...valid, metadata: { internal: true } },
      { ...valid, metadata: { expiresAt: Date.now() + DAY } },
      { ...valid, contentHash: `sha256:${'0'.repeat(64)}` },
      { ...valid, expiresAt: Date.now() + 3600 * DAY },
      { ...valid, type: 'episode' },
    ];
    for (const item of cases) {
      const res = await writeDetail([item]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    for (const [field, value] of [
      ['ownerType', 'user'],
      ['ownerId', 'u_other'],
      ['namespace', 'default'],
    ]) {
      const res = await writeDetail([{ ...valid, [field]: value }]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('owner_mismatch');
    }
    const leaked = (await allDetailNodes()).filter((node) => node.content?.text === marker);
    expect(leaked).toEqual([]);
  });

  it('校验原子：批量含跨域 recordIds 时整批 422，零写入', async () => {
    const marker = unique('detail-atomic');
    const own = await createRecord('agent:opencode', marker);
    const other = await createRecord('agent:hermes', marker);
    const validText = `${marker}-valid`;
    const res = await writeDetail([
      detailItem('agent:opencode', [own], validText),
      detailItem('agent:opencode', [other], marker),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.index).toBe(1);
    const leaked = (await allDetailNodes()).filter((node) => node.content?.text === validText);
    expect(leaked).toEqual([]);
  });
});

describe('读取、截断、列表与内部可见性', () => {
  it('get includeText=false / maxBytes 夹紧；list 默认只返回元数据', async () => {
    const marker = unique('detail-get');
    const recordId = await createRecord('agent:opencode', marker);
    const text = `${marker}-abcdefghijklmnopqrstuvwxyz`;
    const written = await writeDetail([detailItem('agent:opencode', [recordId], text, {
      messageId: 'm-get',
      chunkIndex: 4,
      retentionClass: 'conversation',
    })]);
    const id = written.body.data.results[0].id;

    const metadataOnly = await getDetail(id, { extra: { includeText: false } });
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body.data.detail.text).toBeNull();
    expect(metadataOnly.body.data.detail.chunkIndex).toBe(4);

    const truncated = await getDetail(id, { extra: { maxBytes: 5 } });
    expect(truncated.status).toBe(200);
    expect(truncated.body.data.detail.truncated).toBe(true);
    expect(truncated.body.data.detail.text).toBe(text.slice(0, 5));

    const listed = await listDetails({ extra: { domains: ['agent:opencode'], recordIds: [recordId], limit: 10 } });
    expect(listed.status).toBe(200);
    const entry = listed.body.data.details.find((detail) => detail.id === id);
    expect(entry).toBeDefined();
    expect(entry.text).toBeNull();
    expect(entry).toMatchObject({
      detailKind: 'raw_chunk',
      domain: 'agent:opencode',
      messageId: 'm-get',
      chunkIndex: 4,
      recordIds: [recordId],
    });
    expect(listed.body.data).toMatchObject({ offset: 0, limit: 10 });
    expect(listed.body.data.hasMore).toBe(false);

    const byKind = await listDetails({ extra: { domains: ['agent:opencode'], detailKinds: ['tool_output'] } });
    expect(byKind.body.data.details.every((detail) => detail.detailKind === 'tool_output')).toBe(true);

    const maxLimit = await listDetails({ extra: { domains: ['agent:opencode'], limit: 1000 } });
    expect(maxLimit.body.data.limit).toBe(50);
  });

  it('详情默认不出现在 /query /search /history /profile /skills /graph、公共工具与 Console 列表', async () => {
    const marker = unique('detail-hidden');
    const recordId = await createRecord('agent:opencode', marker);
    const text = `${marker}-secret-detail-text`;
    const written = await writeDetail([detailItem('agent:opencode', [recordId], text)]);
    const detailId = written.body.data.results[0].id;

    const query = await post(capability('/query'), {
      actor: agent,
      query: text,
      domains: ['agent:opencode'],
      limit: 50,
    }, { token });
    expect(query.status).toBe(200);
    expect(query.body.data.records.map((record) => record.id)).not.toContain(detailId);
    expect(query.body.data.records.every((record) => record.kind !== 'detail_record')).toBe(true);

    const search = await post(capability('/search'), {
      actor: agent,
      query: text,
      domains: ['agent:opencode'],
      limit: 50,
    }, { token });
    expect(search.status).toBe(200);
    expect(search.body.data.records.map((record) => record.id)).not.toContain(detailId);

    const history = await post(capability('/history'), {
      actor: agent,
      domains: ['agent:opencode'],
      limit: 50,
    }, { token });
    expect(history.status).toBe(200);
    expect(history.body.data.episodes.map((episode) => episode.id)).not.toContain(detailId);

    const profile = await post(capability('/profile'), {
      actor: agent,
      domains: ['agent:opencode'],
    }, { token });
    expect(profile.status).toBe(200);
    expect(JSON.stringify(profile.body.data)).not.toContain(detailId);

    const skills = await post(capability('/skills'), {
      actor: agent,
      domains: ['agent:opencode'],
    }, { token });
    expect(skills.status).toBe(200);
    expect(JSON.stringify(skills.body.data)).not.toContain(detailId);

    const graph = await post(capability('/graph'), {
      actor: agent,
      startId: recordId,
      domains: ['agent:opencode'],
      maxDepth: 2,
    }, { token });
    expect(graph.status).toBe(200);
    expect(graph.body.data.nodes.map((node) => node.id)).not.toContain(detailId);

    const publicQuery = TOOL_SPECS.find((spec) => spec.name === 'memory_query');
    const publicResult = await publicQuery.handler(service, { query: text, limit: 50 });
    expect(publicResult.structuredContent.memories.map((memory) => memory.id)).not.toContain(detailId);

    const publicSearch = TOOL_SPECS.find((spec) => spec.name === 'memory_search');
    const publicSearchResult = await publicSearch.handler(service, { query: text, limit: 50 });
    expect(publicSearchResult.structuredContent.memories.map((memory) => memory.id)).not.toContain(detailId);

    const consoleList = await service.listRecords({ limit: 1000 });
    expect(consoleList.nodes.map((node) => node.id)).not.toContain(detailId);
    const consoleInternal = await service.listRecords({ includeInternal: true, limit: 1000 });
    expect(consoleInternal.nodes.map((node) => node.id)).toContain(detailId);
  });

  it('list 的 domains 域过滤与 strictDomains；read 不返回其他域详情', async () => {
    const marker = unique('detail-domain-list');
    const recordId = await createRecord('agent:opencode', marker);
    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const id = written.body.data.results[0].id;
    const other = await listDetails({ extra: { domains: ['default'] } });
    expect(other.status).toBe(200);
    expect(other.body.data.details.map((detail) => detail.id)).not.toContain(id);
    const strict = await listDetails({ extra: { domains: ['__missing__'], strictDomains: true } });
    expect(strict.status).toBe(400);
    expect(strict.body.error.code).toBe('domain_invalid');
    const unknown = await listDetails({ extra: { domains: ['agent:unknown'], strictDomains: true } });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.code).toBe('domain_read_forbidden');
  });
});

describe('保留、过期与配额', () => {
  it('retentionClass 默认到期：conversation 30d / tool_output 7d / document_slice 90d / pinned 0', async () => {
    const marker = unique('detail-retention');
    const recordId = await createRecord('agent:opencode', marker);
    const now = Date.now();
    const expected = {
      conversation: 30 * DAY,
      tool_output: 7 * DAY,
      document_slice: 90 * DAY,
      pinned: 0,
    };
    for (const [retentionClass, delta] of Object.entries(expected)) {
      const res = await writeDetail([detailItem('agent:opencode', [recordId], `${marker}-${retentionClass}`, {
        retentionClass,
      })]);
      expect(res.status).toBe(200);
      const node = await detailNode(res.body.data.results[0].id);
      expect(node.content.retentionClass).toBe(retentionClass);
      if (delta === 0) {
        expect(node.content.expiresAt).toBe(0);
      } else {
        expect(node.content.expiresAt).toBeGreaterThanOrEqual(now + delta - 5_000);
        expect(node.content.expiresAt).toBeLessThanOrEqual(now + delta + 5_000);
      }
    }

    const overCap = await writeDetail([detailItem('agent:opencode', [recordId], `${marker}-over`, {
      retentionClass: 'tool_output',
      expiresAt: Date.now() + 8 * DAY,
    })]);
    expect(overCap.status).toBe(422);
    expect(overCap.body.error.code).toBe('validation_failed');
    expect(overCap.body.error.details.field).toBe('expiresAt');
  });

  it('过期详情：get 410、list 默认排除；user includeExpired 可见，agent 不可治理读取', async () => {
    const marker = unique('detail-expired');
    const recordId = await createRecord('agent:opencode', marker);
    const recordBefore = await app.graph.getNode(recordId);
    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker, {
      expiresAt: Date.now() - 1_000,
    })]);
    expect(written.status).toBe(200);
    const id = written.body.data.results[0].id;
    const record = await app.graph.getNode(recordId);
    expect(record.metadata?.detailAvailable).toBeUndefined();
    expect(record.updatedAt).toBe(recordBefore.updatedAt);

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(query.body.data.records.find((entry) => entry.id === recordId))
      .toMatchObject({ detailAvailable: false });

    const got = await getDetail(id);
    expect(got.status).toBe(410);
    expect(got.body.error.code).toBe('detail_expired');

    const listed = await listDetails({ extra: { domains: ['agent:opencode'], recordIds: [recordId] } });
    expect(listed.status).toBe(200);
    expect(listed.body.data.details.map((detail) => detail.id)).not.toContain(id);

    const hiddenToAgent = await listDetails({ extra: { domains: ['agent:opencode'], includeExpired: true } });
    expect(hiddenToAgent.status).toBe(403);
    expect(hiddenToAgent.body.error.code).toBe('forbidden_scope');

    const governance = await listDetails({
      actor: user,
      extra: { domains: ['agent:opencode'], includeExpired: true },
    });
    expect(governance.status).toBe(200);
    expect(governance.body.data.details.find((detail) => detail.id === id)).toMatchObject({
      availability: ['expired'],
      text: null,
    });

    const governanceGet = await getDetail(id, { actor: user, extra: { includeExpired: true } });
    expect(governanceGet.status).toBe(200);
    expect(governanceGet.body.data.detail).toMatchObject({
      id,
      availability: ['expired'],
      text: marker,
    });
  });

  it('单条 text > 256 KiB → 413 payload_too_large，不写节点', async () => {
    const marker = unique('detail-too-large');
    const recordId = await createRecord('agent:opencode', marker);
    const text = 'x'.repeat(256 * 1024 + 1);
    const res = await writeDetail([detailItem('agent:opencode', [recordId], text)]);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
    const nodes = (await allDetailNodes()).filter((node) => node.content?.text === text);
    expect(nodes).toEqual([]);
  });

  it('域配额：先淘汰最旧 tool_output，再按需淘汰 conversation；写墓碑 quota_evicted', async () => {
    const marker = unique('detail-quota-evict');
    const domain = 'quota_evict';
    const recordId = await createRecord(domain, marker);
    const first = await writeDetail([detailItem(domain, [recordId], 'a'.repeat(30 * 1024), {
      retentionClass: 'tool_output',
    })]);
    const second = await writeDetail([detailItem(domain, [recordId], 'b'.repeat(30 * 1024), {
      retentionClass: 'tool_output',
    })]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstId = first.body.data.results[0].id;
    const secondId = second.body.data.results[0].id;

    const third = await writeDetail([detailItem(domain, [recordId], 'c'.repeat(10 * 1024), {
      retentionClass: 'conversation',
    })]);
    expect(third.status).toBe(200);
    expect(third.body.data.created).toBe(1);
    expect(third.body.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'detail_quota_evicted', ids: expect.arrayContaining([firstId]) }),
    ]));
    const firstNode = await detailNode(firstId);
    expect(firstNode.deletedAt).toBeGreaterThan(0);
    expect(firstNode.metadata.deletedReason).toBe('quota_evicted');
    expect((await detailNode(secondId)).deletedAt).toBeUndefined();

    const firstGet = await getDetail(firstId, { actor: user });
    expect(firstGet.status).toBe(410);
    expect(firstGet.body.error.code).toBe('detail_deleted');
    expect(firstGet.body.error.details.reason).toBe('quota_evicted');
  });

  it('配额无法淘汰（pinned）→ 结构化 413 detail_quota_exceeded，记录与已写详情保留', async () => {
    const marker = unique('detail-quota-fail');
    const domain = 'quota_pinned';
    const recordId = await createRecord(domain, marker);
    const first = await writeDetail([detailItem(domain, [recordId], 'a'.repeat(30 * 1024), {
      retentionClass: 'pinned',
    })]);
    const second = await writeDetail([detailItem(domain, [recordId], 'b'.repeat(30 * 1024), {
      retentionClass: 'pinned',
    })]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const failed = await writeDetail([detailItem(domain, [recordId], 'c'.repeat(30 * 1024), {
      retentionClass: 'pinned',
    })]);
    expect(failed.status).toBe(413);
    expect(failed.body.error.code).toBe('detail_quota_exceeded');
    expect(failed.body.error.details).toMatchObject({
      scope: 'domain',
      domain,
      limitBytes: 64 * 1024,
      evicted: [],
    });
    expect(failed.body.error.details.usedBytes).toBeGreaterThan(0);
    expect(failed.body.error.details.requiredBytes).toBeGreaterThan(64 * 1024);
    expect((await detailNode(first.body.data.results[0].id)).deletedAt).toBeUndefined();
    expect(await app.graph.getNode(recordId)).not.toBeNull();
    expect((await allDetailNodes()).filter((node) => node.content?.text === 'c'.repeat(30 * 1024))).toEqual([]);
  });

  it('批量配额部分失败 → 200 partial=true、逐项结果，不静默丢弃', async () => {
    const marker = unique('detail-quota-partial');
    const domain = 'quota_partial';
    const recordId = await createRecord(domain, marker);
    await writeDetail([detailItem(domain, [recordId], 'a'.repeat(30 * 1024), { retentionClass: 'pinned' })]);
    await writeDetail([detailItem(domain, [recordId], 'b'.repeat(30 * 1024), { retentionClass: 'pinned' })]);
    const res = await writeDetail([
      detailItem(domain, [recordId], 'c'.repeat(20 * 1024), { retentionClass: 'pinned' }),
      detailItem(domain, [recordId], 'd'.repeat(10 * 1024), { retentionClass: 'pinned' }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.failed).toBe(2);
    expect(res.body.data.results.map((entry) => entry.status)).toEqual(['failed', 'failed']);
    expect(res.body.data.results.every((entry) => entry.code === 'detail_quota_exceeded')).toBe(true);
  });

  it('部分失败的幂等键不缓存：释放配额后重放同一键可补齐失败项，已成功项不重复', async () => {
    const marker = unique('detail-quota-retry');
    const domain = 'quota_retry';
    const recordId = await createRecord(domain, marker);
    const first = await writeDetail([detailItem(domain, [recordId], 'a'.repeat(30 * 1024), {
      retentionClass: 'pinned',
    })]);
    await writeDetail([detailItem(domain, [recordId], 'b'.repeat(30 * 1024), { retentionClass: 'pinned' })]);
    const key = unique('detail-quota-retry-key');
    const bodyItems = [
      detailItem(domain, [recordId], 'c'.repeat(30 * 1024), { retentionClass: 'pinned' }),
      detailItem(domain, [recordId], 'd'.repeat(30 * 1024), { retentionClass: 'pinned' }),
    ];
    const firstAttempt = await writeDetail(bodyItems, { headers: { 'idempotency-key': key } });
    expect(firstAttempt.status).toBe(200);
    expect(firstAttempt.body.data.partial).toBe(true);
    expect(firstAttempt.body.data.failed).toBe(2);

    // 释放一条已写详情，重放同一幂等键应重新执行失败项，而不是返回缓存失败。
    await post(capability('/detail'), {
      actor: user,
      op: 'delete',
      ids: [first.body.data.results[0].id],
    }, { token });
    const retry = await writeDetail(bodyItems, { headers: { 'idempotency-key': key } });
    expect(retry.status).toBe(200);
    expect(retry.body.data.created).toBe(1);
    expect(retry.body.data.failed).toBe(1);
    expect(retry.body.data.partial).toBe(true);
    expect(retry.body.data.replayed).toBe(false);
  });
});

describe('删除、墓碑与级联', () => {
  it('删除详情只墓碑详情，不删除记录；记录 detailAvailable 派生为 false；get 410 detail_deleted', async () => {
    const marker = unique('detail-delete');
    const recordId = await createRecord('agent:opencode', marker);
    const recordBefore = await app.graph.getNode(recordId);
    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const id = written.body.data.results[0].id;
    expect((await app.graph.getNode(recordId)).updatedAt).toBe(recordBefore.updatedAt);

    const res = await post(capability('/detail'), {
      actor: user,
      op: 'delete',
      ids: [id],
      reason: 'user_requested',
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: [id], notFound: [], forbidden: [], partial: false });

    const node = await detailNode(id);
    expect(node.deletedAt).toBeGreaterThan(0);
    expect(node.metadata.deletedReason).toBe('user_requested');
    const record = await app.graph.getNode(recordId);
    expect(record).not.toBeNull();
    expect(record.deletedAt).toBeUndefined();
    expect(record.metadata?.detailAvailable).toBeUndefined();
    expect(record.updatedAt).toBe(recordBefore.updatedAt);

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    const view = query.body.data.records.find((entry) => entry.id === recordId);
    expect(view).toMatchObject({ detailAvailable: false });

    const got = await getDetail(id);
    expect(got.status).toBe(410);
    expect(got.body.error.code).toBe('detail_deleted');

    const again = await post(capability('/detail'), {
      actor: user,
      op: 'delete',
      ids: [id],
    }, { token });
    expect(again.body.data.notFound).toEqual([id]);
  });

  it('Agent 只能删除自己域内、自己写入的详情；user 可治理', async () => {
    const marker = unique('detail-delete-scope');
    const ownRecord = await createRecord('agent:opencode', marker);
    const own = await writeDetail([detailItem('agent:opencode', [ownRecord], marker)]);
    const ownId = own.body.data.results[0].id;

    const hermesRecord = await createRecord('agent:hermes', marker);
    const hermes = await post(capability('/detail'), {
      actor: { type: 'agent', agentId: 'hermes' },
      op: 'write',
      items: [detailItem('agent:hermes', [hermesRecord], marker)],
    }, { token });
    const hermesId = hermes.body.data.results[0].id;

    const denied = await post(capability('/detail'), {
      actor: agent,
      op: 'delete',
      ids: [ownId, hermesId],
    }, { token });
    expect(denied.status).toBe(200);
    expect(denied.body.data.deleted).toEqual([ownId]);
    expect(denied.body.data.forbidden).toEqual([hermesId]);
    expect(denied.body.data.partial).toBe(true);

    const governed = await post(capability('/detail'), {
      actor: user,
      op: 'delete',
      ids: [hermesId],
    }, { token });
    expect(governed.body.data.deleted).toEqual([hermesId]);
  });

  it('公共 memory_delete 删除记录时级联墓碑 linked 详情；Compact 只 stale 不删除', async () => {
    const marker = unique('detail-cascade-public');
    const recordId = await createRecord('agent:opencode', marker);
    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const detailId = written.body.data.results[0].id;
    const compact = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'upsert',
      domain: 'agent:opencode',
      summary: 'cascade compact',
      sourceIds: [recordId],
    }, { token });
    const compactId = compact.body.data.object.id;

    const publicDelete = TOOL_SPECS.find((spec) => spec.name === 'memory_delete');
    const result = await publicDelete.handler(service, { ids: [recordId] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.deleted).toEqual([recordId]);
    expect(result.structuredContent.detailsDeleted).toEqual([detailId]);

    const detail = await detailNode(detailId);
    expect(detail.deletedAt).toBeGreaterThan(0);
    expect(detail.metadata.deletedReason).toBe('record_deleted');
    const compactNode = await app.graph.getNode(compactId);
    expect(compactNode.deletedAt).toBeUndefined();
    const stale = await post(capability('/internal-object'), {
      actor: agent,
      kind: 'compact',
      op: 'get',
      id: compactId,
    }, { token });
    expect(stale.body.data.object.stale).toBe(true);
  });

  it('capability /delete 删除记录时同样级联；删除详情不删除记录', async () => {
    const marker = unique('detail-cascade-capability');
    const recordId = await createRecord('agent:opencode', marker);
    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const detailId = written.body.data.results[0].id;
    const res = await post(capability('/delete'), {
      actor: user,
      ids: [recordId],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toEqual([recordId]);
    expect(res.body.data.detailsDeleted).toEqual([detailId]);
    expect((await detailNode(detailId)).metadata.deletedReason).toBe('record_deleted');
    expect((await app.graph.getNode(recordId)).deletedAt).toBeGreaterThan(0);
  });

  it('多个记录引用同一条详情：仍有 live 记录时不级联；最后一条删除才墓碑', async () => {
    const marker = unique('detail-cascade-multi');
    const first = await createRecord('agent:opencode', `${marker}-1`);
    const second = await createRecord('agent:opencode', `${marker}-2`);
    const written = await writeDetail([detailItem('agent:opencode', [first, second], marker)]);
    const detailId = written.body.data.results[0].id;

    const firstDelete = await post(capability('/delete'), { actor: user, ids: [first] }, { token });
    expect(firstDelete.body.data.detailsDeleted).toBeUndefined();
    expect((await detailNode(detailId)).deletedAt).toBeUndefined();

    const secondDelete = await post(capability('/delete'), { actor: user, ids: [second] }, { token });
    expect(secondDelete.body.data.detailsDeleted).toEqual([detailId]);
    expect((await detailNode(detailId)).metadata.deletedReason).toBe('record_deleted');
  });

  it('详情写入/删除/过期不推进记录 updatedAt：旧 Compact 不因派生标记误判 stale', async () => {
    const marker = unique('detail-compact-stale');
    const recordId = await createRecord('agent:opencode', marker);
    const recordBefore = await app.graph.getNode(recordId);
    // 模拟旧版 Compact：没有 sourceHashes，只能回退到 updatedAt 判定。
    const compact = await app.graph.createNode('compact', {
      summary: 'legacy compact without hashes',
      sourceIds: [recordId],
      sourceHashes: [],
      strategy: 'summary',
    }, undefined, { namespace: 'agent:opencode' });
    await app.graph.updateNode(compact.id, {
      metadata: {
        internal: true,
        internalObject: {
          schema: 1,
          kind: 'compact',
          sourceIds: [recordId],
          sourceHashes: [],
        },
      },
    });
    const compactStale = async () => {
      const res = await post(capability('/internal-object'), {
        actor: agent,
        kind: 'compact',
        op: 'get',
        id: compact.id,
      }, { token });
      expect(res.status).toBe(200);
      return res.body.data.object.stale;
    };
    expect(await compactStale()).toBe(false);

    const written = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const detailId = written.body.data.results[0].id;
    const afterWrite = await app.graph.getNode(recordId);
    expect(afterWrite.metadata?.detailAvailable).toBeUndefined();
    expect(afterWrite.updatedAt).toBe(recordBefore.updatedAt);
    expect(await compactStale()).toBe(false);

    await post(capability('/detail'), { actor: user, op: 'delete', ids: [detailId] }, { token });
    const afterDelete = await app.graph.getNode(recordId);
    expect(afterDelete.metadata?.detailAvailable).toBeUndefined();
    expect(afterDelete.updatedAt).toBe(recordBefore.updatedAt);
    expect(await compactStale()).toBe(false);

    await writeDetail([detailItem('agent:opencode', [recordId], `${marker}-expired`, {
      expiresAt: Date.now() - 1_000,
    })]);
    expect((await app.graph.getNode(recordId)).updatedAt).toBe(recordBefore.updatedAt);
    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(query.body.data.records.find((entry) => entry.id === recordId))
      .toMatchObject({ detailAvailable: false });
    expect(await compactStale()).toBe(false);
  });

  it('写入新详情后记录 detailAvailable 派生恢复 true（不改 metadata/updatedAt）', async () => {
    const marker = unique('detail-availability-restore');
    const recordId = await createRecord('agent:opencode', marker);
    const recordBefore = await app.graph.getNode(recordId);
    const first = await writeDetail([detailItem('agent:opencode', [recordId], marker)]);
    const firstId = first.body.data.results[0].id;
    await post(capability('/detail'), { actor: user, op: 'delete', ids: [firstId] }, { token });
    const afterDelete = await app.graph.getNode(recordId);
    expect(afterDelete.metadata?.detailAvailable).toBeUndefined();
    expect(afterDelete.updatedAt).toBe(recordBefore.updatedAt);
    const unavailable = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(unavailable.body.data.records.find((entry) => entry.id === recordId))
      .toMatchObject({ detailAvailable: false });

    await writeDetail([detailItem('agent:opencode', [recordId], `${marker}-again`)]);
    const afterWrite = await app.graph.getNode(recordId);
    expect(afterWrite.metadata?.detailAvailable).toBeUndefined();
    expect(afterWrite.updatedAt).toBe(recordBefore.updatedAt);
    const available = await post(capability('/query'), {
      actor: agent,
      query: marker,
      domains: ['agent:opencode'],
    }, { token });
    expect(available.body.data.records.find((entry) => entry.id === recordId))
      .toMatchObject({ detailAvailable: true });
  });
});
