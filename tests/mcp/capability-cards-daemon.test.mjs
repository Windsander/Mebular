// CR-002：daemon-store 能力卡发布/读取/签名/internal + task_targets.cards + 旧 app/nodes 回归。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';

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
  it('publish → read → 签名可验证 → internal metadata 正确；并发同版本只写一次', async () => {
    const backend = new fleet.DaemonAgentBackend({ endpoint: base });
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
    const backend = new fleet.DaemonAgentBackend({ endpoint: base });
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

  it('task_targets.cards 在 daemon 模式可用；旧 targets / 旧 task_submit 不变', async () => {
    // 为 device-B 造目录/卡（B 的卡由 B 签；这里只要读取面形状，签名用占位）。
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
    await fleet.appendCapabilityCard(app, {
      ...cardB,
      signature: { alg: 'Ed25519', keyId: 'device-B', sig: 'not-verified-by-task-targets' },
    });
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
  });

  it('/app/nodes 接受 optional metadata 并原样返回；旧 task_event 调用不受影响', async () => {
    const created = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'meta_probe',
        namespace: 'probe',
        content: { ok: true },
        metadata: { internal: true, internalObject: { kind: 'meta_probe' } },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.node.metadata).toEqual({ internal: true, internalObject: { kind: 'meta_probe' } });
    const listed = await request('/app/nodes?namespace=probe&type=meta_probe');
    expect(listed.body.nodes[0].metadata).toEqual({ internal: true, internalObject: { kind: 'meta_probe' } });

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

  it('配置 mtime 与 registry 变化触发 daemon 重发；错误不阻塞', async () => {
    const backend = new fleet.DaemonAgentBackend({ endpoint: base });
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
});
