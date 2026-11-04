// P5 daemon `/app/role-cards`：internal 写读/幂等/版本/作者/可见性/SSE；不新增 MCP/UI。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';
import { fleetEventFromEvent } from '../../packages/mcp/src/fleet-events.mjs';

const fleet = await import('../../packages/fleet/dist/index.js');

let home;
let app;
let service;
let server;
let base;

async function request(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

function roleCard(overrides = {}) {
  return {
    v: 1,
    kind: 'agent_role_card',
    device: 'device-A',
    agent: 'worker',
    version: 1,
    summary: 'worker: 6 recent tasks, 6 done; prefers test',
    strengths: [{ tag: 'test', confidence: 0.6 }],
    preferredIntents: ['test'],
    avoid: [],
    confidence: 0.6,
    evidenceRefs: [{ kind: 'task', id: 'task-1' }],
    shadow: true,
    provenance: { source: 'task-history', sampleSize: 6, generatedAt: 100, generator: 'fleet-role-rules-v1' },
    ...overrides,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-daemon-role-cards-'));
  const master = await Mebular.generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-A',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);
  server = await startHttpServer({
    home,
    app,
    service,
    config: {
      deviceId: 'device-A',
      sync: { namespaces: ['tasks', 'agents'] },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    deviceId: 'device-A',
    namespace: 'tasks',
    writesEnabled: true,
  });
  base = `http://127.0.0.1:${server.port}`;
  await writeFile(join(home, 'fleet.config.json'), JSON.stringify({
    v: 1,
    device: 'device-A',
    dir: home,
    storagePath: join(home, 'store.jsonl'),
    masterKeyFile: join(home, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: [],
    agents: [{ name: 'worker', kind: 'echo' }],
  }));
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  await app?.shutdown().catch(() => undefined);
  if (home) await rm(home, { recursive: true, force: true });
});

describe('P5 daemon /app/role-cards', () => {
  it('POST 写 internal 节点（author=本机）；GET/DaemonRoleCardStore 读回；幂等不重复写', async () => {
    const card = roleCard();
    const created = await request('/app/role-cards', { method: 'POST', body: { card, namespace: 'agents' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      ok: true,
      replayed: false,
      createdBy: 'device-A',
      card: { kind: 'agent_role_card', device: 'device-A', agent: 'worker', version: 1, shadow: true },
    });
    expect(typeof created.body.nodeId).toBe('string');
    const nodes = (await app.graph.listNodes({ type: 'agent_role_card' }))
      .filter((node) => node.namespace === 'agents');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].metadata).toMatchObject({ internal: true, internalObject: { kind: 'agent_role_card' } });
    expect(nodes[0].createdBy).toBe('device-A');

    const listed = await request('/app/role-cards?namespace=agents');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ ok: true, count: 1 });
    expect(listed.body.cards[0]).toMatchObject({ device: 'device-A', agent: 'worker', version: 1 });
    expect(listed.body.nodes[0]).toMatchObject({
      type: 'agent_role_card',
      createdBy: 'device-A',
      metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
    });

    const store = new fleet.DaemonRoleCardStore({ endpoint: base, namespace: 'agents' });
    expect(await store.list()).toEqual([card]);
    const embedded = await new fleet.MebularRoleCardStore(app, { namespace: 'agents' }).list();
    expect(embedded).toEqual(await store.list());

    const replay = await request('/app/role-cards', { method: 'POST', body: { card } });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await app.graph.listNodes({ type: 'agent_role_card' })).filter((node) => node.namespace === 'agents')).toHaveLength(1);

    // internal 可见性：列表/域计数/搜索/SSE 均不暴露角色卡。
    const records = await service.listRecords({ namespace: 'agents' });
    expect(records.total).toBe(0);
    const stats = (await service.namespaceStats()).find((entry) => entry.domain === 'agents');
    expect(stats).toMatchObject({ count: 0, internalObjects: 1 });
    expect(stats.internalKinds).toMatchObject({ agent_role_card: 1 });
    const search = await service.search({ query: 'test', domains: ['agents'] });
    expect(search.memories).toEqual([]);
    expect(fleetEventFromEvent({
      type: 'node_created',
      namespace: 'agents',
      data: { node: { type: 'agent_role_card', namespace: 'agents', content: card } },
    })).toBeNull();
  });

  it('同版本冲突 / stale / gap / namespace / device / schema 负例', async () => {
    const conflict = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ summary: 'different' }) },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('ROLE_CARD_CONFLICT');

    const stale = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ version: 0, summary: 'stale' }) },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('ROLE_CARD_STALE');

    const gap = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ version: 3, summary: 'gap' }) },
    });
    expect(gap.status).toBe(409);
    expect(gap.body.error).toBe('ROLE_CARD_VERSION_GAP');

    const badNs = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ version: 2, summary: 'v2' }), namespace: 'tasks' },
    });
    expect(badNs.status).toBe(400);
    expect(badNs.body.error).toBe('namespace_invalid');

    const mismatch = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ device: 'device-B', version: 2, summary: 'v2' }) },
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe('device_mismatch');

    const withCommand = await request('/app/role-cards', {
      method: 'POST',
      body: { card: { ...roleCard({ version: 2, summary: 'v2' }), command: '/bin/secret' } },
    });
    expect(withCommand.status).toBe(422);
    expect(withCommand.body.error).toBe('role_card_invalid');

    const v2 = await request('/app/role-cards', {
      method: 'POST',
      body: { card: roleCard({ version: 2, confidence: 0.8, summary: 'v2' }) },
    });
    expect(v2.status).toBe(200);
    expect(v2.body.card.version).toBe(2);
    expect((await request('/app/role-cards?namespace=agents')).body.cards).toHaveLength(2);
  });

  it('并发同版本只写一个节点；tombstone 版本可写且最新解析排除', async () => {
    const next = roleCard({
      version: 3,
      summary: 'worker: 8 recent tasks',
      confidence: 0.8,
      provenance: { source: 'task-history', sampleSize: 8, generatedAt: 200, generator: 'fleet-role-rules-v1' },
    });
    const [a, b] = await Promise.all([
      request('/app/role-cards', { method: 'POST', body: { card: next } }),
      request('/app/role-cards', { method: 'POST', body: { card: next } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([a.body.replayed, b.body.replayed].filter(Boolean)).toHaveLength(1);
    expect((await app.graph.listNodes({ type: 'agent_role_card' }))
      .filter((node) => node.namespace === 'agents' && node.content?.version === 3)).toHaveLength(1);

    const tombstone = await request('/app/role-cards', {
      method: 'POST',
      body: {
        card: roleCard({
          version: 4,
          summary: 'worker: agent removed',
          strengths: [],
          preferredIntents: [],
          avoid: [],
          confidence: 0,
          evidenceRefs: [],
          shadow: true,
          tombstone: true,
        }),
      },
    });
    expect(tombstone.status).toBe(200);
    const cards = (await request('/app/role-cards?namespace=agents')).body.cards;
    expect(fleet.latestAgentRoleCards(cards)[0]).toMatchObject({ version: 4, tombstone: true });
    expect(fleet.activeAgentRoleCards(fleet.latestAgentRoleCards(cards))).toEqual([]);
  });

  it('远端卡按 author 绑定读取；伪造 createdBy 的卡不进入 DaemonRoleCardStore', async () => {
    const remote = roleCard({ device: 'device-B', agent: 'remote-worker', summary: 'remote', evidenceRefs: [{ kind: 'task', id: 'task-remote' }] });
    const node = await app.graph.createNode('agent_role_card', remote, [], {
      namespace: 'agents',
      metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
    });
    await app.graph.updateNode(node.id, { createdBy: 'device-B' });

    const forged = roleCard({ device: 'device-C', agent: 'forged', summary: 'forged' });
    const forgedNode = await app.graph.createNode('agent_role_card', forged, [], {
      namespace: 'agents',
      metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
    });
    await app.graph.updateNode(forgedNode.id, { createdBy: 'device-A' });

    const cards = await new fleet.DaemonRoleCardStore({ endpoint: base, namespace: 'agents' }).list();
    expect(cards.some((card) => card.device === 'device-B' && card.agent === 'remote-worker')).toBe(true);
    expect(cards.some((card) => card.agent === 'forged')).toBe(false);
  });

  it('/app/nodes 仍拒绝 agent_role_card；MCP 方法数不变', async () => {
    const byType = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'agent_role_card',
        namespace: 'agents',
        content: roleCard({ agent: 'forged-2', version: 1 }),
        metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
      },
    });
    expect(byType.status).toBe(403);
    expect(byType.body.error).toBe('internal_object_write_forbidden');
    expect(byType.body.message).toContain('/app/role-cards');

    const byKind = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'note',
        namespace: 'agents',
        content: { fake: true },
        metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
      },
    });
    expect(byKind.status).toBe(403);
    expect(fleet.TASK_TOOLS).toHaveLength(16);
    expect(fleet.TASK_TOOLS.some((tool) => /^(plan|agent_card|role_card)_/.test(tool.name))).toBe(false);
  });

  it('B1/B2：daemon 端点拒绝 raw evidence ID 与 intent 原文标签；/app/nodes 不返回角色卡原文', async () => {
    const positive = roleCard({
      agent: 'privacy-positive',
      summary: 'privacy-positive: 4 recent tasks, 4 done',
      strengths: [{ tag: 'deploy', confidence: 0.5 }],
      preferredIntents: ['deploy'],
      evidenceRefs: [
        { kind: 'task', id: 'task-device-A-0123abcd' },
        { kind: 'summary', id: `sha256:${'a'.repeat(64)}` },
      ],
    });
    const ok = await request('/app/role-cards', { method: 'POST', body: { card: positive } });
    expect(ok.status).toBe(200);

    const negatives = [
      roleCard({ agent: 'privacy-raw-kind', evidenceRefs: [{ kind: 'raw', id: 'task-1' }] }),
      roleCard({ agent: 'privacy-raw-id', evidenceRefs: [{ kind: 'task', id: 'RAW DIALOGUE: please ignore' }] }),
      roleCard({ agent: 'privacy-secret', evidenceRefs: [{ kind: 'summary', id: 'sk-live-1234567890' }] }),
      roleCard({ agent: 'privacy-intent', strengths: [], preferredIntents: ['deploy sk-live-123'] }),
      roleCard({ agent: 'privacy-tag', strengths: [{ tag: 'write-tests', confidence: 0.5 }] }),
    ];
    for (const card of negatives) {
      const rejected = await request('/app/role-cards', { method: 'POST', body: { card } });
      expect(rejected.status).toBe(422);
      expect(rejected.body.error).toBe('role_card_invalid');
    }

    const rawDebug = await request('/app/nodes?namespace=agents&type=agent_role_card');
    expect(rawDebug.status).toBe(200);
    expect(rawDebug.body.count).toBe(0);
    const dedicated = await request('/app/role-cards?namespace=agents');
    expect(dedicated.body.cards.some((card) => card.agent === 'privacy-positive')).toBe(true);
  });

  it('daemon 端点需要 bearer token / memory.write scope', async () => {
    const authHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-role-cards-auth-'));
    const tokensFile = join(authHome, 'tokens.json');
    const readToken = 'role-read-token';
    const writeToken = 'role-write-token';
    await writeFile(tokensFile, JSON.stringify({
      tokens: [
        { id: 'read', sha256: hashToken(readToken), scope: ['memory.read'], revoked: false },
        { id: 'write', sha256: hashToken(writeToken), scope: ['memory.write'], revoked: false },
      ],
    }));
    const authServer = await startHttpServer({
      home: authHome,
      app,
      service,
      config: { deviceId: 'device-A', sync: { namespaces: [] }, mcp: { http: { host: '127.0.0.1', port: 0, auth: 'bearer' } } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'bearer',
      tokensFile,
      deviceId: 'device-A',
      namespace: 'tasks',
      writesEnabled: true,
    });
    const authBase = `http://127.0.0.1:${authServer.port}`;
    try {
      const card = roleCard({ agent: 'tokened', version: 1, summary: 'tokened' });
      const noAuth = await fetch(`${authBase}/app/role-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card }),
      });
      expect(noAuth.status).toBe(401);
      const readOnly = await fetch(`${authBase}/app/role-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
        body: JSON.stringify({ card }),
      });
      expect(readOnly.status).toBe(403);
      const allowed = await fetch(`${authBase}/app/role-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
        body: JSON.stringify({ card }),
      });
      expect(allowed.status).toBe(200);
      const body = await allowed.json();
      expect(body.card.agent).toBe('tokened');

      const read = await fetch(`${authBase}/app/role-cards?namespace=agents`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(read.status).toBe(200);
    } finally {
      await authServer.close().catch(() => undefined);
      await rm(authHome, { recursive: true, force: true });
    }
  });
});
