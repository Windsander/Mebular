// W2a：/internal/memory/v1 只读端点（真实 MemoryService + 沙箱 Mebular，不启网络/模型）。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
let seed;
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;

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

async function createNode(type, content, namespace) {
  return app.graph.createNode(type, content, undefined, { namespace });
}

async function addProvenance(id, provenance) {
  const node = await app.graph.getNode(id);
  await app.graph.updateNode(id, {
    metadata: { ...(node?.metadata ?? {}), provenance },
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'memory-capability-http-'));
  cloudRoot = join(home, 'cloud');
  process.env.MEBULAR_CLOUD_ROOT = cloudRoot;
  delete process.env.MEBULAR_CAPABILITY_TOKEN;

  const master = await new IdentityManager().generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-w2a',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);

  const now = Date.now();
  const userEntity = await createNode('entity', {
    entityType: 'user',
    name: 'user',
    properties: { timezone: 'UTC' },
  }, 'user');

  const userFact = await createNode('fact', {
    subject: 'user',
    predicate: 'theme',
    object: 'dark',
    confidence: 0.9,
  }, 'user');
  await addProvenance(userFact.id, {
    source: 'runtime',
    writerType: 'user',
    writerId: 'u_test',
    extractor: 'user',
    version: '0.3.0',
    deviceId: 'device-w2a',
    hostId: 'h_w2a',
    confirmation: 'explicit',
    at: now,
  });

  // 0.2 legacy：default 里的用户偏好，无 provenance。
  const legacyPreference = await service.write([{
    type: 'preference',
    content: 'vim',
    metadata: { preferenceType: 'editor', namespace: 'default' },
  }]);

  const [userPreference] = await service.write([{
    type: 'preference',
    content: 'dark',
    metadata: { preferenceType: 'theme', namespace: 'user' },
  }]);
  await addProvenance(userPreference.id, {
    source: 'runtime',
    writerType: 'user',
    writerId: 'u_test',
    extractor: 'user',
    version: '0.3.0',
    deviceId: 'device-w2a',
    hostId: 'h_w2a',
    confirmation: 'explicit',
    at: now,
  });

  const opencodeFact = await createNode('fact', {
    subject: 'project',
    predicate: 'tool',
    object: 'pnpm',
    confidence: 0.8,
  }, 'agent:opencode');
  await addProvenance(opencodeFact.id, {
    source: 'runtime',
    writerType: 'agent',
    writerId: 'opencode',
    extractor: 'heuristic',
    model: null,
    version: '0.3.0',
    deviceId: 'device-w2a',
    hostId: 'h_w2a',
    threadId: 'th_test',
    agentId: 'opencode',
    agentName: 'OpenCode',
    confirmation: 'none',
    at: now,
  });

  const hermesFact = await createNode('fact', {
    subject: 'project',
    predicate: 'runtime',
    object: 'hermes',
    confidence: 0.7,
  }, 'agent:hermes');
  await addProvenance(hermesFact.id, {
    source: 'runtime',
    writerType: 'agent',
    writerId: 'hermes',
    extractor: 'host',
    version: '0.3.0',
    deviceId: 'device-hermes',
    hostId: 'h_hermes',
    agentId: 'hermes',
    agentName: 'Hermes',
    confirmation: 'none',
    at: now,
  });

  const notesFact = await createNode('fact', {
    subject: 'notes',
    predicate: 'topic',
    object: 'alpha notes',
  }, 'notes');

  const userEpisode = await createNode('episode', {
    episodeType: 'conversation',
    content: 'discuss alpha release plan',
    context: 'sess-user',
  }, 'user');
  const taskEpisode = await createNode('episode', {
    episodeType: 'conversation',
    content: 'task alpha checkpoint',
    context: 'sess-task',
  }, 'task:th_test');
  const hermesEpisode = await createNode('episode', {
    episodeType: 'conversation',
    content: 'hermes alpha memory',
    context: 'sess-hermes',
  }, 'agent:hermes');
  const userObservation = await createNode('episode', {
    episodeType: 'observation',
    content: 'night owl habit',
  }, 'user');
  await addProvenance(hermesEpisode.id, {
    source: 'runtime',
    writerType: 'agent',
    writerId: 'hermes',
    agentId: 'hermes',
    agentName: 'Hermes',
    deviceId: 'device-hermes',
    hostId: 'h_hermes',
    at: now,
  });

  const [sharedSkill] = await service.write([{
    type: 'skill',
    content: 'deploy\nrelease flow',
    metadata: { namespace: 'shared', category: 'ops' },
  }]);
  const [hermesSkill] = await service.write([{
    type: 'skill',
    content: 'hermes deploy\nhermes release flow',
    metadata: { namespace: 'agent:hermes', category: 'ops' },
  }]);
  await addProvenance(hermesSkill.id, {
    source: 'runtime',
    writerType: 'agent',
    writerId: 'hermes',
    extractor: 'host',
    agentId: 'hermes',
    agentName: 'Hermes',
    at: now,
  });

  const agentPreference = await service.write([{
    type: 'preference',
    content: 'light',
    metadata: { preferenceType: 'theme', namespace: 'agent:hermes' },
  }]);

  const compact = await createNode('compact', { summary: 'internal alpha compact' }, 'notes');
  await app.graph.updateNode(compact.id, {
    metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
  });
  const selfRecord = await createNode('self_record', { displayName: 'OpenCode' }, 'agent:opencode');
  await app.graph.updateNode(selfRecord.id, {
    metadata: { internal: true, internalObject: { schema: 1, kind: 'self_record' } },
  });
  const checkpoint = await createNode('context_checkpoint', { summary: 'checkpoint alpha' }, 'task:th_test');
  await app.graph.updateNode(checkpoint.id, {
    metadata: { internal: true, internalObject: { schema: 1, kind: 'context_checkpoint' } },
  });

  await app.graph.createEdge(userEntity.id, userFact.id, 'prefers');
  await app.graph.createEdge(userEntity.id, hermesFact.id, 'related_to');
  await app.graph.createEdge(userEntity.id, compact.id, 'related_to');
  await app.graph.createEdge(userEpisode.id, taskEpisode.id, 'related_to');
  await app.graph.createEdge(userEpisode.id, hermesEpisode.id, 'related_to');

  seed = {
    userEntity,
    userFact,
    userPreference: userPreference[0],
    legacyPreference: legacyPreference[0],
    opencodeFact,
    hermesFact,
    notesFact,
    userEpisode,
    taskEpisode,
    hermesEpisode,
    userObservation,
    sharedSkill,
    hermesSkill,
    agentPreference: agentPreference[0],
    compact,
    selfRecord,
    checkpoint,
  };

  server = await startHttpServer({
    home,
    app,
    service,
    config: {
      deviceId: 'device-w2a',
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

const actor = { type: 'agent', agentId: 'opencode' };

describe('GET /version', () => {
  it('返回 capability/schema/mcp/core 版本、features 与 limits；不含 token', async () => {
    const res = await request('/internal/memory/v1/version', { token });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.capabilityVersion).toBe(1);
    expect(res.body.requestId).toMatch(/^req_/);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.degraded).toBe(false);
    expect(res.body.data).toMatchObject({
      capabilityApiVersion: 1,
      schemaVersion: 1,
      features: {
        domains: true,
        owner: true,
        provenance: true,
        graph: true,
        readOnly: false,
        batchWrite: true,
        idempotency: true,
        sync: true,
        internalObjects: ['compact', 'self_record', 'context_checkpoint'],
      },
      limits: { maxBodyBytes: 2 * 1024 * 1024, maxDomains: 16, maxLimit: 50, maxGraphDepth: 5 },
      domains: { reserved: ['user', 'default', 'shared', 'system'], agentPrefix: 'agent:', taskPrefix: 'task:' },
    });
    expect(res.text).not.toContain(token);
    expect(res.headers['x-mebular-capability-version']).toBe('1');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('GET /status 与 /namespaces', () => {
  it('status 返回身份/计数/域/同步，不泄漏 token', async () => {
    const query = `?actor=${encodeURIComponent(JSON.stringify(actor))}`;
    const res = await request(`/internal/memory/v1/status${query}`, { token });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.initialized).toBe(true);
    expect(data.identity.deviceId).toBe('device-w2a');
    expect(data.identity.hostId).toMatch(/^h_[0-9a-f]{16}$/);
    expect(data.counts.compacts).toBe(1);
    expect(data.counts.checkpoints).toBe(1);
    expect(data.counts.selfRecords).toBe(1);
    expect(data.counts.memoryRecords).toBeGreaterThanOrEqual(7);
    expect(data.domains.some((entry) => entry.domain === 'agent:hermes')).toBe(true);
    expect(data.sync.subscriptions).toEqual({ mode: 'all', namespaces: [] });
    expect(res.text).not.toContain(token);
  });

  it('status 缺 actor → 400 invalid_request', async () => {
    const res = await request('/internal/memory/v1/status', { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('namespaces 只读返回域/订阅/内部对象计数', async () => {
    const res = await request(`/internal/memory/v1/namespaces?agentId=opencode`, { token });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.subscriptions.mode).toBe('all');
    expect(data.policyDomain).toBe('__policy__');
    const notes = data.domains.find((entry) => entry.domain === 'notes');
    expect(notes).toMatchObject({ ownerType: 'other', ownerId: 'notes', count: 2, internalObjects: 1 });
    const opencode = data.domains.find((entry) => entry.domain === 'agent:opencode');
    expect(opencode).toMatchObject({ ownerType: 'agent', ownerId: 'opencode' });
    expect(opencode.internalObjects).toBe(1);
    expect(data.legacyNamespaces).toContain('notes');
    expect(res.text).not.toContain(token);
  });
});

describe('POST /query', () => {
  it('默认域 = user + agent:<actor> + default；带 threadId 时加 task:<threadId>', async () => {
    const withoutThread = await post('/internal/memory/v1/query', { actor, query: 'alpha' }, { token });
    expect(withoutThread.status).toBe(200);
    expect(withoutThread.body.data.records.map((record) => record.id)).toEqual([seed.userEpisode.id]);
    expect(withoutThread.body.data.records[0]).toMatchObject({
      domain: 'user',
      ownerType: 'user',
      legacy: true,
    });
    expect(withoutThread.body.data.records[0].provenance.source).toBe('legacy');

    const withThread = await post('/internal/memory/v1/query', {
      actor,
      query: 'alpha',
      threadId: 'th_test',
    }, { token });
    expect(withThread.status).toBe(200);
    expect(new Set(withThread.body.data.records.map((record) => record.domain)))
      .toEqual(new Set(['user', 'task:th_test']));
    expect(withThread.body.data.usedDomains).toEqual(['user', 'agent:opencode', 'default', 'task:th_test']);
  });

  it('显式 domains 可读其他 Agent 域，且保留 agentId/agentName/provenance', async () => {
    const res = await post('/internal/memory/v1/query', {
      actor,
      query: 'alpha',
      domains: ['agent:hermes'],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.records).toHaveLength(1);
    const record = res.body.data.records[0];
    expect(record.id).toBe(seed.hermesEpisode.id);
    expect(record.ownerType).toBe('agent');
    expect(record.ownerId).toBe('hermes');
    expect(record.provenance.agentId).toBe('hermes');
    expect(record.provenance.agentName).toBe('Hermes');
    expect(record.provenance.deviceId).toBe('device-hermes');
  });

  it('未知/未订阅域默认 warning 跳过，strictDomains=true → 403', async () => {
    const lenient = await post('/internal/memory/v1/query', {
      actor,
      query: 'alpha',
      domains: ['agent:ghost'],
    }, { token });
    expect(lenient.status).toBe(200);
    expect(lenient.body.data.records).toEqual([]);
    expect(lenient.body.data.usedDomains).toEqual([]);
    expect(lenient.body.warnings[0]).toMatchObject({ code: 'domain_unavailable', domain: 'agent:ghost' });

    const strict = await post('/internal/memory/v1/query', {
      actor,
      query: 'alpha',
      domains: ['agent:ghost'],
      strictDomains: true,
    }, { token });
    expect(strict.status).toBe(403);
    expect(strict.body.error.code).toBe('domain_read_forbidden');
  });

  it('拒绝 __policy__ 等非法域；限制 domains ≤ 16', async () => {
    const policy = await post('/internal/memory/v1/query', {
      actor,
      domains: ['__policy__'],
    }, { token });
    expect(policy.status).toBe(400);
    expect(policy.body.error.code).toBe('domain_invalid');

    const tooMany = await post('/internal/memory/v1/query', {
      actor,
      domains: Array.from({ length: 17 }, (_, index) => `task:t${index}`),
    }, { token });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('invalid_request');
  });

  it('内部对象默认不返回', async () => {
    const res = await post('/internal/memory/v1/query', {
      actor,
      query: 'checkpoint',
      domains: ['notes', 'task:th_test'],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.records.some((record) => record.id === seed.compact.id)).toBe(false);
    expect(res.body.data.records.some((record) => record.id === seed.checkpoint.id)).toBe(false);
    expect(res.body.data.records.map((record) => record.id)).toEqual([seed.taskEpisode.id]);
  });

  it('types 使用语义类型：preference 只返回偏好，observation 只返回观察', async () => {
    const preferences = await post('/internal/memory/v1/query', {
      actor,
      types: ['preference'],
    }, { token });
    expect(preferences.status).toBe(200);
    expect(preferences.body.data.records.length).toBeGreaterThanOrEqual(2);
    expect(preferences.body.data.records.every((record) => record.kind === 'preference')).toBe(true);
    expect(preferences.body.data.records.some((record) => record.id === seed.agentPreference.id)).toBe(false);

    const observations = await post('/internal/memory/v1/query', {
      actor,
      query: 'night',
      types: ['observation'],
    }, { token });
    expect(observations.status).toBe(200);
    expect(observations.body.data.records.map((record) => record.id)).toEqual([seed.userObservation.id]);
    expect(observations.body.data.records[0].kind).toBe('observation');
  });

  it('actor 缺失/agentId 非法 → 400', async () => {
    const missing = await post('/internal/memory/v1/query', { query: 'alpha' }, { token });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('invalid_request');

    const invalid = await post('/internal/memory/v1/query', {
      actor: { type: 'agent', agentId: 'OpenCode' },
      query: 'alpha',
    }, { token });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_agent_id');
  });
});

describe('POST /search', () => {
  it('返回命中记录；关系端点按域过滤（不泄漏其他 Agent 域）', async () => {
    const res = await post('/internal/memory/v1/search', {
      actor,
      query: 'alpha',
      includeRelations: true,
      threadId: 'th_test',
    }, { token });
    expect(res.status).toBe(200);
    const ids = res.body.data.records.map((record) => record.id);
    expect(ids).toContain(seed.userEpisode.id);
    expect(ids).toContain(seed.taskEpisode.id);
    expect(ids).not.toContain(seed.hermesEpisode.id);
    const targets = res.body.data.relations.map((relation) => relation.targetId);
    expect(targets).toContain(seed.taskEpisode.id);
    expect(targets).not.toContain(seed.hermesEpisode.id);
  });

  it('search 缺少 query → 400', async () => {
    const res = await post('/internal/memory/v1/search', { actor }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('POST /history', () => {
  it('默认域只返回 user/default 的 conversation episode；threadId 加入 task 域', async () => {
    const withoutThread = await post('/internal/memory/v1/history', { actor }, { token });
    expect(withoutThread.status).toBe(200);
    expect(withoutThread.body.data.episodes.map((episode) => episode.id)).toEqual([seed.userEpisode.id]);
    expect(withoutThread.body.data.episodes[0].content.episodeType).toBe('conversation');

    const withThread = await post('/internal/memory/v1/history', {
      actor,
      threadId: 'th_test',
    }, { token });
    expect(withThread.status).toBe(200);
    expect(new Set(withThread.body.data.episodes.map((episode) => episode.id)))
      .toEqual(new Set([seed.userEpisode.id, seed.taskEpisode.id]));
    expect(withThread.body.data.episodes.some((episode) => episode.id === seed.checkpoint.id)).toBe(false);
  });

  it('sessionIds 过滤沿用 0.2 episode.context 语义', async () => {
    const res = await post('/internal/memory/v1/history', {
      actor,
      sessionIds: ['sess-user'],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.episodes.map((episode) => episode.id)).toEqual([seed.userEpisode.id]);
  });
});

describe('POST /profile', () => {
  it('user 域 + 非 Agent 域 legacy 用户事实；排除 agent:*；legacyCount 明确', async () => {
    const res = await post('/internal/memory/v1/profile', { actor }, { token });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.properties).toEqual({ timezone: 'UTC' });
    expect(data.preferences.map((preference) => preference.domain).sort()).toEqual(['default', 'user']);
    expect(data.legacyCount).toBe(1);
    const userPreference = data.preferences.find((preference) => preference.domain === 'user');
    expect(userPreference.legacy).toBe(false);
    const legacyPreference = data.preferences.find((preference) => preference.domain === 'default');
    expect(legacyPreference.legacy).toBe(true);
    expect(data.preferences.some((preference) => preference.id === seed.agentPreference.id)).toBe(false);
  });
});

describe('POST /skills', () => {
  it('默认域含 shared，不含其他 Agent 域', async () => {
    const res = await post('/internal/memory/v1/skills', { actor }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.skills.map((skill) => skill.id)).toEqual([seed.sharedSkill.id]);
    expect(res.body.data.skills[0]).toMatchObject({ domain: 'shared', ownerType: 'other', ownerId: 'shared' });
  });

  it('显式 agent:hermes 返回其他 Agent 技能并保留来源', async () => {
    const res = await post('/internal/memory/v1/skills', {
      actor,
      domains: ['agent:hermes'],
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.skills.map((skill) => skill.id)).toEqual([seed.hermesSkill.id]);
    expect(res.body.data.skills[0]).toMatchObject({
      domain: 'agent:hermes',
      ownerType: 'agent',
      ownerId: 'hermes',
    });
    expect(res.body.data.skills[0].provenance.agentName).toBe('Hermes');
  });
});

describe('POST /graph', () => {
  it('默认域 + 起点域；不遍历其他 Agent 域/内部对象', async () => {
    const res = await post('/internal/memory/v1/graph', {
      actor,
      startId: seed.userEntity.id,
      maxDepth: 2,
    }, { token });
    expect(res.status).toBe(200);
    expect(res.body.data.start).toMatchObject({ id: seed.userEntity.id, domain: 'user' });
    expect(res.body.data.nodes.map((node) => node.id)).toEqual([seed.userFact.id]);
    expect(res.body.data.edges).toHaveLength(1);
    expect(res.body.data.edges[0]).toMatchObject({
      source: seed.userEntity.id,
      target: seed.userFact.id,
      relation: 'prefers',
    });
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.nodes.some((node) => node.id === seed.hermesFact.id)).toBe(false);
  });

  it('显式 domains 不含起点域 → 404 not_found；strict → 403', async () => {
    const missing = await post('/internal/memory/v1/graph', {
      actor,
      startId: seed.hermesFact.id,
      domains: ['user'],
    }, { token });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const strict = await post('/internal/memory/v1/graph', {
      actor,
      startId: seed.hermesFact.id,
      domains: ['user'],
      strictDomains: true,
    }, { token });
    expect(strict.status).toBe(403);
    expect(strict.body.error.code).toBe('domain_read_forbidden');
  });

  it('内部对象起点 → 404 internal_object', async () => {
    const res = await post('/internal/memory/v1/graph', {
      actor,
      startId: seed.compact.id,
    }, { token });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('internal_object');
  });
});

describe('W2b 写端点已实现', () => {
  it.each(['write', 'update', 'delete', 'archive'])(
    'POST /%s 空请求给出结构化 400，而不是 501 占位',
    async (endpoint) => {
      const res = await post(`/internal/memory/v1/${endpoint}`, { actor }, { token });
      expect(res.status).not.toBe(501);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('invalid_request');
    },
  );

  it('POST /internal-object 空请求 → 400 internal_kind_invalid（不是 501）', async () => {
    const res = await post('/internal/memory/v1/internal-object', { actor }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('internal_kind_invalid');
  });

  it('POST /sync 空请求 → 400 invalid_request（不是 501）', async () => {
    const res = await post('/internal/memory/v1/sync', { actor }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('公共工具面不变', () => {
  it('仍为 29 个工具，capability 不计入工具面', () => {
    expect(TOOL_NAMES).toHaveLength(29);
    expect(TOOL_NAMES).not.toContain('memory_capability');
  });
});
