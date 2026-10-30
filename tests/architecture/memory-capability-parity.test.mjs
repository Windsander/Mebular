// W10 契约：公共记忆读路径与 capability 读路径返回同一记录集合/顺序。
//
// 选择规则（类型展开、域/namespace、内部/归档、分页、profile、graph）只有
// MemoryService 一份；capability 只做授权域、owner/provenance 投影和信封差异。

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager, Mebular, MemoryService } from '@mebular/core';
import { toolByName as mcpToolByName } from '../../packages/mcp/src/tools.mjs';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { readCapabilityToken } from '../../packages/mcp/src/memory-runtime-token.mjs';

let home;
let app;
let service;
let server;
let base;
let token;
let seed;

const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;

function request(path, { method = 'GET', body, bearer, headers = {} } = {}) {
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
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function capability(path, body) {
  return request(`/internal/memory/v1${path}`, { method: 'POST', body, bearer: token });
}

const actor = { type: 'agent', agentId: 'opencode' };

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'memory-capability-parity-'));
  process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
  delete process.env.MEBULAR_CAPABILITY_TOKEN;

  const master = await new IdentityManager().generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-parity',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);

  const [userFact, userPreference, userObservation, oldObservation, userEpisode, sharedSkill, agentFact, agentPreference, agentEpisode] = await Promise.all([
    service.write([{ type: 'fact', content: 'parity fact alpha', metadata: { namespace: 'user' } }]),
    service.write([{ type: 'preference', content: 'parity dark', metadata: { preferenceType: 'theme', namespace: 'user' } }]),
    service.write([{ type: 'observation', content: 'parity observation alpha', metadata: { namespace: 'user' } }]),
    service.write([{ type: 'fact', content: 'parity legacy observation alpha', metadata: { namespace: 'default' } }]),
    service.write([{ type: 'episode', content: 'parity conversation alpha', metadata: { episodeType: 'conversation', namespace: 'user' } }]),
    service.write([{ type: 'skill', content: 'parity deploy\nrun parity skill', metadata: { category: 'ops', namespace: 'shared' } }]),
    service.write([{ type: 'fact', content: 'parity hermes fact', metadata: { namespace: 'agent:hermes' } }]),
    service.write([{ type: 'preference', content: 'parity light', metadata: { preferenceType: 'theme', namespace: 'agent:hermes' } }]),
    service.write([{ type: 'episode', content: 'parity hermes episode', metadata: { episodeType: 'conversation', namespace: 'agent:hermes' } }]),
  ]);

  // legacy fact observation（升级前 capability 的写入形状）。
  await app.graph.updateNode(oldObservation[0].id, {
    metadata: { ...(await app.graph.getNode(oldObservation[0].id))?.metadata, kind: 'observation' },
  });

  // 内部对象与归档节点：两者都必须从公共读路径与 capability 默认结果中消失。
  const internal = await app.graph.createNode('fact', {
    subject: 'internal',
    predicate: 'hidden',
    object: 'parity internal alpha',
  }, undefined, { namespace: 'user' });
  await app.graph.updateNode(internal.id, { metadata: { internal: true } });
  const archived = await service.write([{ type: 'fact', content: 'parity archived alpha', metadata: { namespace: 'user' } }]);
  await service.archive([archived[0].id]);

  const userEntity = await app.graph.createNode('entity', {
    entityType: 'user',
    name: 'user',
    properties: { timezone: 'UTC' },
  }, undefined, { namespace: 'user' });
  await app.graph.createEdge(userEntity.id, userFact[0].id, 'related_to');
  await app.graph.createEdge(userEntity.id, agentFact[0].id, 'related_to');
  await app.graph.createEdge(userEntity.id, internal.id, 'related_to');
  await app.graph.createEdge(userEpisode[0].id, userFact[0].id, 'related_to');
  await app.graph.createEdge(userEpisode[0].id, agentEpisode[0].id, 'related_to');

  seed = {
    userFact: userFact[0],
    userPreference: userPreference[0],
    userObservation: userObservation[0],
    oldObservation: oldObservation[0],
    userEpisode: userEpisode[0],
    sharedSkill: sharedSkill[0],
    agentFact: agentFact[0],
    agentPreference: agentPreference[0],
    agentEpisode: agentEpisode[0],
    internal,
    archived: archived[0],
    userEntity,
  };

  server = await startHttpServer({
    home,
    app,
    service,
    config: {
      deviceId: 'device-parity',
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

describe('W10 读取统一：公共 MemoryService 与 capability 同集合/同顺序', () => {
  it('query：fact/preference/episode/observation（含 legacy）一致，内部/归档被统一过滤', async () => {
    const types = ['fact', 'preference', 'episode', 'observation', 'skill', 'entity'];
    const domains = ['user', 'default'];
    const publicResult = await service.query({ query: 'parity', types, domains });
    const res = await capability('/query', { actor, query: 'parity', types, domains });
    expect(res.status).toBe(200);
    expect(res.body.data.records.map((record) => record.id))
      .toEqual(publicResult.memories.map((memory) => memory.id));
    expect(res.body.data.total).toBe(publicResult.totalMatches);
    const ids = res.body.data.records.map((record) => record.id);
    expect(ids).toContain(seed.oldObservation.id);
    expect(ids).not.toContain(seed.internal.id);
    expect(ids).not.toContain(seed.archived.id);
    expect(ids).not.toContain(seed.agentFact.id);
  });

  it('query types=observation：只返回 observation episode + legacy observation fact', async () => {
    const publicResult = await service.query({ query: 'parity', types: ['observation'], domains: ['user', 'default'] });
    const res = await capability('/query', {
      actor,
      query: 'parity',
      types: ['observation'],
      domains: ['user', 'default'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.records.map((record) => record.id))
      .toEqual(publicResult.memories.map((memory) => memory.id));
    expect(new Set(res.body.data.records.map((record) => record.id)))
      .toEqual(new Set([seed.userObservation.id, seed.oldObservation.id]));
  });

  it('公共 MCP 工具与 capability 对同一域范围返回相同 ID 集合（query/search/graph）', async () => {
    const domains = ['user', 'default'];
    const types = ['fact', 'preference', 'episode', 'observation'];

    const publicQuery = await mcpToolByName('memory_query').handler(service, {
      query: 'parity',
      types,
      limit: 50,
      filters: { namespace: domains },
    });
    const capabilityQuery = await capability('/query', {
      actor,
      query: 'parity',
      types,
      domains,
      limit: 50,
    });
    expect(capabilityQuery.body.data.records.map((record) => record.id))
      .toEqual(publicQuery.structuredContent.memories.map((memory) => memory.id));

    const publicSearch = await mcpToolByName('memory_search').handler(service, {
      query: 'alpha',
      types,
      limit: 50,
      filters: { namespace: domains },
    });
    const capabilitySearch = await capability('/search', {
      actor,
      query: 'alpha',
      types,
      domains,
      limit: 50,
    });
    expect(capabilitySearch.body.data.records.map((record) => record.id))
      .toEqual(publicSearch.structuredContent.memories.map((memory) => memory.id));

    const publicGraph = await mcpToolByName('memory_graph').handler(service, {
      startId: seed.userEntity.id,
      maxDepth: 2,
      edgeTypes: ['related_to'],
      namespace: domains,
    });
    const capabilityGraph = await capability('/graph', {
      actor,
      startId: seed.userEntity.id,
      maxDepth: 2,
      edgeTypes: ['related_to'],
      domains,
    });
    expect(capabilityGraph.body.data.nodes.map((node) => node.id))
      .toEqual(publicGraph.structuredContent.visitedNodes
        .filter((node) => node.id !== seed.userEntity.id)
        .map((node) => node.id));
  });

  it('query 分页：offset/limit 与 total 在服务层执行，capability 不再自行截断', async () => {
    const types = ['fact'];
    const domains = ['user', 'default'];
    const publicAll = await service.query({ query: 'parity', types, domains });
    const res = await capability('/query', { actor, query: 'parity', types, domains, limit: 1, offset: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.records.map((record) => record.id))
      .toEqual(publicAll.memories.slice(1, 2).map((memory) => memory.id));
    expect(res.body.data.total).toBe(publicAll.totalMatches);
  });

  it('search：命中与关系端点使用同一域/内部/归档过滤', async () => {
    const domains = ['user', 'default'];
    const types = ['fact', 'preference', 'episode', 'observation'];
    const publicResult = await service.search({ query: 'alpha', types, domains, includeRelations: true });
    const res = await capability('/search', { actor, query: 'alpha', types, domains, includeRelations: true });
    expect(res.status).toBe(200);
    expect(res.body.data.records.map((record) => record.id))
      .toEqual(publicResult.memories.map((memory) => memory.id));
    expect(res.body.data.relations).toEqual(publicResult.relations.map((relation) => ({
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      edgeType: relation.edgeType,
      ...(relation.reason !== undefined ? { reason: relation.reason } : {}),
    })));
    const endpoints = res.body.data.relations.flatMap((relation) => [relation.sourceId, relation.targetId]);
    expect(endpoints).not.toContain(seed.agentEpisode.id);
    expect(endpoints).not.toContain(seed.internal.id);
  });

  it('history：会话过滤、域过滤与分页一致', async () => {
    const domains = ['user', 'default'];
    const publicResult = await service.history({ domains, limit: 1, offset: 0 });
    const res = await capability('/history', { actor, domains, limit: 1, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.episodes.map((episode) => episode.id))
      .toEqual(publicResult.episodes.map((episode) => episode.id));
    expect(res.body.data.total).toBe(publicResult.totalCount);
    expect(res.body.data.episodes.map((episode) => episode.id)).not.toContain(seed.agentEpisode.id);
  });

  it('profile：域过滤由 MemoryService 执行，同一域范围偏好/属性一致', async () => {
    const domains = ['user', 'default'];
    const publicResult = await service.profile({ domains });
    const res = await capability('/profile', { actor, domains });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.map((preference) => preference.id))
      .toEqual(publicResult.preferences.map((preference) => preference.id));
    expect(res.body.data.properties).toEqual(publicResult.properties);
    expect(res.body.data.preferences.map((preference) => preference.id))
      .not.toContain(seed.agentPreference.id);
  });

  it('skills：域过滤、搜索与 limit 一致', async () => {
    const domains = ['user', 'default', 'shared'];
    const publicPage = await service.skillPage({ domains, search: 'parity', limit: 1 });
    const res = await capability('/skills', { actor, domains, search: 'parity', limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.skills.map((skill) => skill.id))
      .toEqual(publicPage.skills.map((skill) => skill.id));
    expect(res.body.data.total).toBe(publicPage.total);
  });

  it('graph：深度、边类型、域与内部/归档过滤一致', async () => {
    const domains = ['user', 'default'];
    const options = { domains, maxDepth: 2, edgeTypes: ['related_to'] };
    const publicResult = await service.graph(seed.userEntity.id, options);
    const res = await capability('/graph', { actor, startId: seed.userEntity.id, ...options });
    expect(res.status).toBe(200);
    const publicIds = publicResult.visitedNodes.filter((node) => node.id !== seed.userEntity.id).map((node) => node.id);
    expect(res.body.data.nodes.map((node) => node.id)).toEqual(publicIds);
    expect(publicIds).toContain(seed.userFact.id);
    expect(publicIds).not.toContain(seed.agentFact.id);
    expect(publicIds).not.toContain(seed.internal.id);
    expect(res.body.data.edges.map((edge) => edge.id).sort())
      .toEqual(publicResult.visitedEdges.map((edge) => edge.id).sort());
  });
});

describe('W10 状态/统计统一', () => {
  it('status/namespaces 的计数与域来自 MemoryService.stats()', async () => {
    const stats = await service.stats();
    const status = await service.status();
    const statusRes = await request(`/internal/memory/v1/status?agentId=opencode`, { bearer: token });
    const namespacesRes = await request(`/internal/memory/v1/namespaces?agentId=opencode`, { bearer: token });
    expect(statusRes.status).toBe(200);
    expect(namespacesRes.status).toBe(200);
    expect(statusRes.body.data.counts).toEqual(stats.counts);
    expect(namespacesRes.body.data.domains.map((entry) => ({
      domain: entry.domain,
      count: entry.count,
      memoryRecords: entry.memoryRecords,
      internalObjects: entry.internalObjects,
      lastUpdatedAt: entry.lastUpdatedAt,
    }))).toEqual(stats.domains.map((entry) => ({
      domain: entry.domain,
      count: entry.count,
      memoryRecords: entry.memoryRecords,
      internalObjects: entry.internalObjects,
      lastUpdatedAt: entry.lastUpdatedAt,
    })));
    expect(status.nodeCount).toBe(stats.nodeCount);
    expect(status.edgeCount).toBe(stats.edgeCount);
  });

  it('sync GET 与 MemoryService.syncStatus 同一数据源', async () => {
    const syncStatus = await service.syncStatus();
    const res = await request(`/internal/memory/v1/sync`, { bearer: token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      running: syncStatus.running,
      pendingEvents: syncStatus.pendingEventCount,
      lastSyncAt: syncStatus.lastSyncAt,
      isSyncing: syncStatus.isSyncing,
    });
  });
});
