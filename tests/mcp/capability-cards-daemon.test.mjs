// CR-002：daemon-store 能力卡发布/读取/签名/internal + task_targets.cards + 旧 app/nodes 回归。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';
import { ensureFleetSyncNamespaces } from '../../packages/mcp/src/config.mjs';

const fleet = await import('../../packages/fleet/src/index.ts');
const { InMemoryHub } = await import('../../dist/index.js');

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

function config(device, agents, peers = []) {
  return {
    v: 1,
    device,
    dir: home,
    storagePath: join(home, 'store.jsonl'),
    masterKeyFile: join(home, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers,
    agents,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-daemon-cards-'));
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
  await writeFile(join(home, 'fleet.config.json'), JSON.stringify(config('device-A', [{ name: 'worker', kind: 'echo' }])));
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  await app?.shutdown().catch(() => undefined);
  if (home) await rm(home, { recursive: true, force: true });
});

describe('CR-002 daemon 能力卡', () => {
  it('DaemonAgentBackend.getSubscriptions 走只读 /app/policy/subscriptions', async () => {
    const backend = new fleet.DaemonAgentBackend({ endpoint: base });
    await app.subscribeNamespace('tasks');
    expect(await backend.getSubscriptions('device-A')).toContain('tasks');
    expect(await backend.getSubscriptions('device-unknown')).toEqual([]);
  });

  it('publish → read → 签名可验证 → internal metadata 正确；并发同版本只写一次', async () => {
    const backend = new fleet.DaemonAgentBackend({
      endpoint: base,
      publicKeyFor: (device) => (device === 'device-A' ? app.identity.getDeviceKey('device-A').publicKey : undefined),
    });
    const draft = fleet.compileCapabilityCards({
      config: config('device-A', [{ name: 'worker', kind: 'echo', capabilities: ['code.write'] }]),
      now: 100,
    })[0];
    const signed = await backend.signAndAppendCard(draft);
    expect(fleet.validateAgentCapabilityCard(signed)).toEqual({ ok: true, errors: [] });
    expect(signed.device).toBe('device-A');
    expect(signed.signature.keyId).toBe('device-A');
    const identity = app.identity.getDeviceKey('device-A');
    expect(await fleet.verifyAgentCapabilityCardSignature(signed, identity.publicKey)).toBe(true);

    const nodes = (await app.graph.listNodes({ type: 'agent_capability_card' }))
      .filter((node) => node.namespace === 'agents');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].metadata).toMatchObject({
      internal: true,
      internalObject: { kind: 'agent_capability_card' },
    });
    const listed = await backend.listCards();
    expect(listed).toHaveLength(1);
    expect(listed[0].version).toBe(1);
    expect((await service.listRecords({ namespace: 'agents' })).total).toBe(0);
    const wrongKeyBackend = new fleet.DaemonAgentBackend({
      endpoint: base,
      publicKeyFor: () => new Uint8Array(32),
    });
    expect(await wrongKeyBackend.listCards()).toEqual([]);

    // 同版本同内容重放：返回已有卡，不重复写节点。
    const replay = await backend.signAndAppendCard(draft);
    expect(replay.signature.sig).toBe(signed.signature.sig);
    expect((await app.graph.listNodes({ type: 'agent_capability_card' })).filter((node) => node.namespace === 'agents')).toHaveLength(1);

    // 并发同版本：守护内串行 + 内容指纹幂等；仍只有一个节点。
    const next = { ...draft, version: 2, capabilities: ['code.write', 'fleet.task', 'review'], provenance: { ...draft.provenance, publishedAt: 200 } };
    const [a, b] = await Promise.all([backend.signAndAppendCard(next), backend.signAndAppendCard(next)]);
    expect(a.version).toBe(2);
    expect(b.version).toBe(2);
    expect((await app.graph.listNodes({ type: 'agent_capability_card' }))
      .filter((node) => node.namespace === 'agents' && node.content?.version === 2)).toHaveLength(1);
    expect((await backend.listCards()).find((card) => card.version === 2)?.capabilities).toEqual(['code.write', 'fleet.task', 'review']);
  });

  it('同版本不同内容 → 409 card_version_conflict，不写伪卡', async () => {
    const backend = new fleet.DaemonAgentBackend({
      endpoint: base,
      publicKeyFor: (device) => (device === 'device-A' ? app.identity.getDeviceKey('device-A').publicKey : undefined),
    });
    const draft = fleet.compileCapabilityCards({
      config: config('device-A', [{ name: 'worker', kind: 'echo', capabilities: ['code.write'] }]),
      now: 300,
    })[0];
    // 已存在 version 1/2；用 version 2 但不同内容提交。
    const conflict = { ...draft, version: 2, capabilities: ['other'] };
    await expect(backend.signAndAppendCard(conflict)).rejects.toMatchObject({ code: 'card_version_conflict' });
    expect((await app.graph.listNodes({ type: 'agent_capability_card' }))
      .filter((node) => node.namespace === 'agents' && node.content?.version === 2)).toHaveLength(1);
  });

  it('专用端点拒绝 device_mismatch / namespace_invalid / signature / stale / gap', async () => {
    const latest = fleet.latestCapabilityCards(await new fleet.DaemonAgentBackend({
      endpoint: base,
      publicKeyFor: (device) => (device === 'device-A' ? app.identity.getDeviceKey('device-A').publicKey : undefined),
    }).listCards()).find((card) => card.agent === 'worker');
    const draft = fleet.compileCapabilityCards({
      config: config('device-A', [{ name: 'worker', kind: 'echo' }]),
      now: 500,
    })[0];

    const mismatch = await request('/app/capability-cards', {
      method: 'POST',
      body: { card: { ...draft, device: 'device-X', version: (latest?.version ?? 0) + 1 } },
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe('device_mismatch');

    const badNs = await request('/app/capability-cards', {
      method: 'POST',
      body: { namespace: 'tasks', card: { ...draft, version: (latest?.version ?? 0) + 1 } },
    });
    expect(badNs.status).toBe(400);
    expect(badNs.body.error).toBe('namespace_invalid');

    const withSignature = await request('/app/capability-cards', {
      method: 'POST',
      body: { card: { ...draft, version: (latest?.version ?? 0) + 1, signature: { alg: 'Ed25519', keyId: 'device-A', sig: 'x' } } },
    });
    expect(withSignature.status).toBe(422);
    expect(withSignature.body.error).toBe('card_invalid');

    const stale = await request('/app/capability-cards', {
      method: 'POST',
      body: { card: { ...draft, version: Math.max(0, (latest?.version ?? 1) - 1), capabilities: ['stale'] } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('card_stale');

    const gap = await request('/app/capability-cards', {
      method: 'POST',
      body: { card: { ...draft, version: (latest?.version ?? 1) + 2 } },
    });
    expect(gap.status).toBe(409);
    expect(gap.body.error).toBe('card_version_gap');
  });

  it('daemon 端点需要 bearer token / memory.write scope', async () => {
    const authHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-cards-auth-'));
    const tokensFile = join(authHome, 'tokens.json');
    const readToken = 'fleet-read-token';
    const writeToken = 'fleet-write-token';
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
      const draft = fleet.compileCapabilityCards({
        config: config('device-A', [{ name: 'tokened', kind: 'echo' }]),
        now: 1,
      })[0];
      const noAuth = await fetch(`${authBase}/app/capability-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card: draft }),
      });
      expect(noAuth.status).toBe(401);
      const readOnly = await fetch(`${authBase}/app/capability-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
        body: JSON.stringify({ card: draft }),
      });
      expect(readOnly.status).toBe(403);
      const allowed = await fetch(`${authBase}/app/capability-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
        body: JSON.stringify({ card: draft }),
      });
      expect(allowed.status).toBe(200);
      const body = await allowed.json();
      expect(body.ok).toBe(true);
      expect(body.card.agent).toBe('tokened');
    } finally {
      await authServer.close().catch(() => undefined);
      await rm(authHome, { recursive: true, force: true });
    }
  });

  it('P7：/app/capability-cards 对齐 plans/role：read-only 403 + payload 必须对象 400', async () => {
    const badArray = await request('/app/capability-cards', { method: 'POST', body: [] });
    expect(badArray.status).toBe(400);
    expect(badArray.body.error).toBe('card body 必须为对象');
    const badNull = await request('/app/capability-cards', { method: 'POST', body: null });
    expect(badNull.status).toBe(400);
    expect(badNull.body.error).toBe('card body 必须为对象');

    const readonlyHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-cards-readonly-'));
    const readonlyServer = await startHttpServer({
      home: readonlyHome,
      app,
      service,
      config: { deviceId: 'device-A', sync: { namespaces: [] }, mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
      deviceId: 'device-A',
      namespace: 'tasks',
      writesEnabled: false,
    });
    try {
      const readonlyBase = `http://127.0.0.1:${readonlyServer.port}`;
      const res = await fetch(`${readonlyBase}/app/capability-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card: {} }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('read_only');
    } finally {
      await readonlyServer.close().catch(() => undefined);
      await rm(readonlyHome, { recursive: true, force: true });
    }
  });

  it('task_targets.cards 在 daemon 模式可用；旧 targets / 旧 task_submit 不变', async () => {
    const bHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-cards-b-'));
    const masterB = await Mebular.generateUserMasterKey();
    const bApp = new Mebular({
      storagePath: join(bHome, 'store.jsonl'),
      deviceId: 'device-B',
      encryption: { userMasterKey: masterB.publicKey, userMasterPrivateKey: masterB.privateKey },
      network: { enabled: false },
    });
    await bApp.initialize();
    try {
      // 为 device-B 造目录/卡：卡由 B 的真实设备私钥签名，author=createdBy=B。
      await fleet.agentDirectoryStore(app, 'agents').append({
        v: 1,
        device: 'device-B',
        agents: [{ name: 'echo', kind: 'echo', capabilities: ['code.write'] }],
        updatedAt: 1,
        version: 1,
      });
      const cardB = fleet.compileCapabilityCards({
        config: config('device-B', [{ name: 'echo', kind: 'echo', capabilities: ['code.write'] }]),
        now: 1,
      })[0];
      const signedB = await fleet.signAgentCapabilityCard(bApp, cardB);
      const bPublicKey = bApp.identity.getDeviceKey('device-B').publicKey;
      const nodeId = await fleet.appendCapabilityCard(app, signedB);
      await app.graph.updateNode(nodeId, { createdBy: 'device-B' });
      const remoteBackend = new fleet.DaemonAgentBackend({
        endpoint: base,
        publicKeyFor: (device) => {
          if (device === 'device-A') return app.identity.getDeviceKey('device-A').publicKey;
          if (device === 'device-B') return bPublicKey;
          return undefined;
        },
      });
      expect((await remoteBackend.listCards()).some((card) => card.device === 'device-B' && card.agent === 'echo')).toBe(true);
      const fakeId = await fleet.appendCapabilityCard(app, {
        ...signedB,
        agent: 'fake',
        signature: { ...signedB.signature, sig: 'AAAA' },
      });
      await app.graph.updateNode(fakeId, { createdBy: 'device-B' });
      await fleet.appendCapabilityCard(app, { ...signedB, agent: 'wrong-author' }); // createdBy = device-A
      const trustedRemote = await remoteBackend.listCards();
      expect(trustedRemote.some((card) => card.agent === 'fake')).toBe(false);
      expect(trustedRemote.some((card) => card.agent === 'wrong-author')).toBe(false);
      const taskStore = new fleet.MebularTaskEventStore(app, { namespace: 'tasks' });
      await taskStore.append({
        v: 1,
        eventId: 'task-inflight#created',
        taskId: 'task-inflight',
        type: 'created',
        actor: { device: 'device-A', agent: 'board' },
        at: 1,
        toStatus: 'queued',
        trace: { chain: [] },
        to: { device: 'device-B', agent: 'echo' },
        intent: 'queued',
      });

      await writeFile(join(home, 'fleet.config.json'), JSON.stringify(config('device-A', [{ name: 'worker', kind: 'echo' }], [{ device: 'device-B' }])));
      const live = {
        deviceId: app.deviceId,
        graph: app.graph,
        identity: app.identity,
        sync: { getPeerPublicKey: (device) => (device === 'device-B' ? bPublicKey : undefined) },
        getSubscriptions: async (device) => (device === 'device-B' ? ['tasks'] : []),
        getPeerPath: (device) => (device === 'device-B' ? { kind: 'direct', address: 'test', since: 1 } : null),
        shutdown: async () => undefined,
      };
      const targets = await fleet.toolByName('task_targets').handler({}, { dir: home, mebular: live });
      expect(targets.ok).toBe(true);
      expect(targets.targets).toEqual([{ device: 'device-B', agent: 'echo', kind: 'echo' }]);
      expect(targets.cards).toEqual([{
        device: 'device-B',
        agent: 'echo',
        version: 1,
        capabilities: ['code.write', 'fleet.task'],
        online: true,
        inflight: 1,
      }]);

      // 无公钥：cards 降级为空，旧 targets 不受影响。
      const noKey = await fleet.toolByName('task_targets').handler({}, {
        dir: home,
        mebular: { ...live, sync: { getPeerPublicKey: () => undefined } },
      });
      expect(noKey.targets).toEqual(targets.targets);
      expect(noKey.cards).toEqual([]);

      const submit = await fleet.toolByName('task_submit').handler(
        { intent: 'old-explicit-to', to: { device: 'device-B', agent: 'echo' } },
        { dir: home, mebular: live },
      );
      expect(submit.ok).toBe(true);
      expect(submit.state.to).toEqual({ device: 'device-B', agent: 'echo' });
      expect(submit.state.from.device).toBe('device-A');
      expect(submit.taskId).toMatch(/^task-device-A-/);
      expect(fleet.TASK_TOOLS).toHaveLength(16);
      expect(fleet.TASK_TOOLS.some((tool) => /^(plan|agent_card)_/.test(tool.name))).toBe(false);
    } finally {
      await bApp.shutdown().catch(() => undefined);
      await rm(bHome, { recursive: true, force: true });
    }
  });

  it('/app/nodes 接受 optional metadata 并原样返回；旧 task_event 调用不受影响', async () => {
    const created = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'meta_probe',
        namespace: 'probe',
        content: { ok: true },
        metadata: { source: 'meta_probe', confidence: 0.5 },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.node.metadata).toEqual({ source: 'meta_probe', confidence: 0.5 });
    const listed = await request('/app/nodes?namespace=probe&type=meta_probe');
    expect(listed.body.nodes[0].metadata).toEqual({ source: 'meta_probe', confidence: 0.5 });

    const store = new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' });
    const event = {
      v: 1,
      eventId: 'legacy-task#created',
      taskId: 'legacy-task',
      type: 'created',
      actor: { device: 'device-A', agent: 'board' },
      at: 1,
      toStatus: 'queued',
      trace: { chain: [] },
      to: { device: 'device-B', agent: 'echo' },
      intent: 'legacy',
    };
    expect(await store.append(event)).toBe(true);
    expect(await store.append(event)).toBe(false);
    expect((await store.all()).map((entry) => entry.taskId)).toContain('legacy-task');
    const taskNodes = await request('/app/nodes?namespace=tasks&type=task_event');
    const node = taskNodes.body.nodes.find((entry) => entry.content?.taskId === 'legacy-task');
    expect(node).toBeTruthy();
    expect(node.metadata).toBeUndefined();
  });

  it('/app/nodes 拒绝伪造 card/role；能力卡只能走专用端点', async () => {
    const before = (await app.graph.listNodes({ type: 'agent_capability_card' })).length;
    const byType = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'agent_capability_card',
        namespace: 'agents',
        content: { fake: true },
        metadata: { internal: true, internalObject: { kind: 'agent_capability_card' } },
      },
    });
    expect(byType.status).toBe(403);
    expect(byType.body.error).toBe('internal_object_write_forbidden');
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
    expect((await app.graph.listNodes({ type: 'agent_capability_card' })).length).toBe(before);
  });

  it('配置 mtime 与 registry 变化触发 daemon 重发；错误不阻塞', async () => {
    const backend = new fleet.DaemonAgentBackend({
      endpoint: base,
      publicKeyFor: (device) => (device === 'device-A' ? app.identity.getDeviceKey('device-A').publicKey : undefined),
    });
    const registry = new fleet.ExecutorRegistry();
    registry.register('worker', new fleet.EchoExecutor());
    const publisher = new fleet.CapabilityCardPublisher({ backend, config: config('device-A', [{ name: 'worker', kind: 'echo' }]), registry, checkIntervalMs: 0, log: () => undefined });
    registry.onChange(() => publisher.onRegistryChange());
    await publisher.publish();
    await publisher.tick();
    const before = fleet.latestCapabilityCards(await backend.listCards()).find((card) => card.agent === 'worker');
    expect(before).toBeTruthy();

    registry.register('reviewer', new fleet.EchoExecutor());
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const worker = fleet.latestCapabilityCards(await backend.listCards()).find((card) => card.agent === 'worker');
      if (worker && worker.version > before.version) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const afterRegistry = fleet.latestCapabilityCards(await backend.listCards()).find((card) => card.agent === 'worker');
    expect(afterRegistry.version).toBeGreaterThan(before.version);

    await writeFile(join(home, 'fleet.config.json'), JSON.stringify(config('device-A', [
      { name: 'worker', kind: 'echo', capabilities: ['code.write', 'review'] },
    ])));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publisher.tick();
    const afterConfig = fleet.latestCapabilityCards(await backend.listCards()).find((card) => card.agent === 'worker');
    expect(afterConfig.capabilities).toEqual(['code.write', 'fleet.task', 'review']);
    expect(afterConfig.version).toBeGreaterThan(afterRegistry.version);
    expect(publisher.status().lastError).toBeNull();
  });

  it('无身份/签名失败 → 409 identity_unavailable，不写伪卡', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-cards-noid-'));
    let created = 0;
    const fakeApp = {
      deviceId: 'device-X',
      identity: { getDeviceKey: () => undefined },
      graph: {
        listNodes: async () => [],
        createNode: async () => { created += 1; return { id: 'n1', type: 'agent_capability_card', namespace: 'agents' }; },
      },
    };
    const fakeServer = await startHttpServer({
      home: fakeHome,
      app: fakeApp,
      service: null,
      config: { deviceId: 'device-X', sync: { namespaces: [] }, mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
      deviceId: 'device-X',
      namespace: 'tasks',
      writesEnabled: true,
    });
    const fakeBase = `http://127.0.0.1:${fakeServer.port}`;
    try {
      const draft = fleet.compileCapabilityCards({
        config: config('device-X', [{ name: 'worker', kind: 'echo' }]),
        now: 1,
      })[0];
      const res = await fetch(`${fakeBase}/app/capability-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card: draft }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toBe('identity_unavailable');
      expect(created).toBe(0);
    } finally {
      await fakeServer.close().catch(() => undefined);
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('旧 worker + daemon task store 回归：普通 task 仍执行并回写 done', async () => {
    const store = new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' });
    const registry = new fleet.ExecutorRegistry();
    registry.register('echo', new fleet.EchoExecutor());
    const log = await fleet.ExecutionLog.open(join(home, 'exec-daemon.jsonl'));
    const worker = new fleet.FleetWorker({ device: 'device-Z', agent: 'worker', store, transport: new fleet.NullTransport(), registry, log });
    const res = await fetch(`${base}/app/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'task_event',
        namespace: 'tasks',
        content: {
          v: 1,
          eventId: 'worker-regression#created',
          taskId: 'worker-regression',
          type: 'created',
          actor: { device: 'device-A', agent: 'board' },
          at: 1,
          toStatus: 'queued',
          trace: { chain: [] },
          to: { device: 'device-Z', agent: 'echo' },
          intent: 'run',
        },
      }),
    });
    expect(res.status).toBe(200);
    await worker.pollOnce();
    expect(log.size()).toBe(1);
    const states = await worker.statesView();
    expect(states.find((state) => state.taskId === 'worker-regression')?.status).toBe('done');
  });

  it('旧 daemon 配置幂等补齐 agents；两台 app 经同步互见能力卡', async () => {
    const old = { sync: { namespaces: ['tasks'] } };
    const ensured = ensureFleetSyncNamespaces(old);
    expect(ensured.sync.namespaces).toEqual(['tasks', 'agents']);
    expect(ensureFleetSyncNamespaces(ensured).sync.namespaces).toEqual(['tasks', 'agents']);
    expect(ensureFleetSyncNamespaces({ sync: { namespaces: [] } }).sync.namespaces).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), 'fleet-daemon-sync-'));
    const master = await Mebular.generateUserMasterKey();
    const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const hub = new InMemoryHub();
    const mk = (device) => new Mebular({
      storagePath: join(root, `${device}.jsonl`),
      deviceId: device,
      encryption,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        namespaces: ensured.sync.namespaces,
        antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
      },
    });
    const cfg = (device, capabilities) => ({
      v: 1,
      device,
      dir: join(root, device),
      storagePath: join(root, `${device}.jsonl`),
      masterKeyFile: join(root, `${device}.json`),
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
      agents: [{ name: 'worker', kind: 'echo', capabilities }],
    });
    const a = mk('device-A');
    const b = mk('device-B');
    try {
      await a.initialize();
      await b.initialize();
      expect(a.sync.getSubscriptionNamespaces()).toContain('agents');
      expect(b.sync.getSubscriptionNamespaces()).toContain('agents');
      await b.node.connectToPeer(a.node.peerId);
      await a.node.connectToPeer(b.node.peerId);
      await fleet.publishFleetCards({ mebular: a, config: cfg('device-A', ['code.write']), now: 1 });
      await fleet.publishFleetCards({ mebular: b, config: cfg('device-B', ['review']), now: 1 });

      const deadline = Date.now() + 10_000;
      let visible = false;
      while (Date.now() < deadline) {
        await a.sync.runAntiEntropyCycle();
        await b.sync.runAntiEntropyCycle();
        const sets = await Promise.all([a, b].map(async (app) => {
          const cards = fleet.activeCapabilityCards(fleet.latestCapabilityCards(await fleet.listCapabilityCards(app)));
          return cards.map((card) => card.device).sort();
        }));
        visible = sets.every((devices) => JSON.stringify(devices) === JSON.stringify(['device-A', 'device-B']));
        if (visible) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(visible).toBe(true);
    } finally {
      await a.shutdown().catch(() => undefined);
      await b.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
