// W2b：/internal/memory/v1 写端点（write/update/delete/archive/internal-object/sync）。
// 真实 Mebular + MemoryService + 沙箱 home；不启网络/模型。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager, Mebular, MemoryService } from '@mebular/core';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { readCapabilityToken } from '../../packages/mcp/src/memory-runtime-token.mjs';
import { TOOL_NAMES } from '../../packages/mcp/src/tools.mjs';

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

  it('批量写入：顺序一致、计数正确；observation 落为 fact 语义', async () => {
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
    const node = await app.graph.getNode(observation.id);
    expect(node.type).toBe('fact');
    expect(node.metadata.kind).toBe('observation');

    const query = await post(capability('/query'), {
      actor: agent,
      query: marker,
      types: ['observation'],
    }, { token });
    expect(query.status).toBe(200);
    expect(query.body.data.records.map((entry) => entry.id)).toContain(observation.id);
    expect(query.body.data.records.every((entry) => entry.kind === 'observation')).toBe(true);
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

    const ledger = await stat(join(home, 'memory-runtime', 'capability-idempotency.json'));
    expect(ledger.mode & 0o777).toBe(0o600);
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
      state: { plan: ['a'], cursor: 1 },
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
      state: { plan: ['a'], cursor: 1 },
      summary: 'step 1',
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
      state: { plan: ['a', 'b'], cursor: 2 },
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
      state: {},
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
      state: {},
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
      state: {},
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
      state: {},
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
      state: {},
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
      state: { plan: ['forced'] },
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
