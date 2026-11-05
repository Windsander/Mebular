// P6 coverage hardening：daemon store/backend、card publisher 与 routing provider 的分支/错误路径。
// 这些类在生产中通过 `/app/*` 只读面工作；本测试用本地 HTTP stub 覆盖成功/失败/过滤分支，
// 不改变任何公共 MCP/UI 行为。
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { DaemonRoleCardStore } from '../../packages/fleet/src/store/role-card-store.js';
import { DaemonAgentBackend } from '../../packages/fleet/src/store/daemon-agent-backend.js';
import { CapabilityCardPublisher } from '../../packages/fleet/src/runtime/card-publisher.js';
import { daemonRoutingProvider, embeddedRoutingProvider } from '../../packages/fleet/src/runtime/routing-context.js';
import { compileCapabilityCards, type FleetAgentBackend } from '../../packages/fleet/src/cards.js';
import type { AgentRoleCard } from '../../packages/fleet/src/role-cards.js';
import type { FleetConfig } from '../../packages/fleet/src/config.js';
import type { TaskEventStore } from '../../packages/fleet/src/store/file-store.js';

type Reply = { status: number; body: unknown };

let server: Server;
let base: string;
let roleNodes: unknown[] = [];
let roleAppend: Reply = { status: 200, body: { ok: true } };
let nodesReply: Reply = { status: 200, body: { ok: true, nodes: [] } };
let nodeAppend: Reply = { status: 200, body: { ok: true } };
let peersReply: Reply = { status: 200, body: { ok: true, peers: [] } };
let subscriptionsReply: Reply = { status: 200, body: { ok: true, namespaces: [] } };
let cardReply: Reply = { status: 200, body: { ok: true, card: null } };

function makeRoleCard(overrides: Partial<AgentRoleCard> = {}): AgentRoleCard {
  return {
    v: 1,
    kind: 'agent_role_card',
    device: 'device-A',
    agent: 'worker',
    version: 1,
    summary: 'worker: 2 samples; prefers code',
    strengths: [{ tag: 'code', confidence: 0.8 }],
    preferredIntents: ['code'],
    avoid: [],
    confidence: 0.8,
    evidenceRefs: [{ kind: 'task', id: 'task-device-A-0123abcd' }],
    shadow: true,
    provenance: { source: 'local-tasks', sampleSize: 2, generatedAt: 1, generator: 'rules' },
    ...overrides,
  };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let reply: Reply;
    if (url.pathname === '/app/role-cards') {
      reply = req.method === 'GET' ? { status: 200, body: { ok: true, nodes: roleNodes } } : roleAppend;
    } else if (url.pathname === '/app/nodes') {
      reply = req.method === 'GET' ? nodesReply : nodeAppend;
    } else if (url.pathname === '/app/peers') {
      reply = peersReply;
    } else if (url.pathname === '/app/policy/subscriptions') {
      reply = subscriptionsReply;
    } else if (url.pathname === '/app/capability-cards') {
      reply = cardReply;
    } else {
      reply = { status: 404, body: { ok: false, error: 'not_found' } };
    }
    res.statusCode = reply.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function resetReplies(): void {
  roleNodes = [];
  roleAppend = { status: 200, body: { ok: true } };
  nodesReply = { status: 200, body: { ok: true, nodes: [] } };
  nodeAppend = { status: 200, body: { ok: true } };
  peersReply = { status: 200, body: { ok: true, peers: [] } };
  subscriptionsReply = { status: 200, body: { ok: true, namespaces: [] } };
  cardReply = { status: 200, body: { ok: true, card: null } };
}

describe('P6 daemon store hardening', () => {
  it('DaemonRoleCardStore filters, sorts and reads role cards', async () => {
    resetReplies();
    const card = makeRoleCard();
    const internal = { internal: true, internalObject: { kind: 'agent_role_card' } };
    roleNodes = [
      { id: 'deleted', namespace: 'agents', createdBy: 'device-A', deletedAt: 1, content: card, metadata: internal },
      { id: 'other-ns', namespace: 'other', createdBy: 'device-A', content: card, metadata: internal },
      { id: 'no-internal', namespace: 'agents', createdBy: 'device-A', content: card, metadata: {} },
      { id: 'bad-kind', namespace: 'agents', createdBy: 'device-A', content: card, metadata: { internal: true, internalObject: { kind: 'other' } } },
      { id: 'bad-card', namespace: 'agents', createdBy: 'device-A', content: { nope: true }, metadata: internal },
      { id: 'bad-author', namespace: 'agents', createdBy: 'device-B', content: card, metadata: internal },
      { id: 'v1-b', namespace: 'agents', createdBy: 'device-A', content: card, metadata: internal },
      { id: 'v1-a', namespace: 'agents', createdBy: 'device-A', content: card, metadata: internal },
      { id: 'v2', namespace: 'agents', createdBy: 'device-A', content: { ...card, version: 2 }, metadata: internal },
    ];
    const store = new DaemonRoleCardStore({ endpoint: base, namespace: 'agents' });
    const stored = await store.listStored();
    expect(stored.map((entry) => entry.nodeId)).toEqual(['v1-a', 'v1-b', 'v2']);
    expect((await store.list()).map((entry) => entry.version)).toEqual([1, 1, 2]);
    await store.close();
  });

  it('DaemonRoleCardStore maps append results and errors', async () => {
    resetReplies();
    const store = new DaemonRoleCardStore({ endpoint: base });
    const card = makeRoleCard();

    roleAppend = { status: 200, body: { ok: true, card, nodeId: 'n1', createdBy: 'device-A', replayed: false } };
    expect(await store.append(card)).toMatchObject({ stored: true, replayed: false, nodeId: 'n1' });

    roleAppend = { status: 200, body: { ok: true, card, nodeId: 'n1', createdBy: 'device-A', replayed: true } };
    expect(await store.append(card)).toMatchObject({ stored: false, replayed: true });

    roleAppend = { status: 200, body: { ok: true, card: { ...card, v: 2 }, nodeId: 'n2', createdBy: 'device-A' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_SCHEMA' });

    roleAppend = { status: 200, body: { ok: true, card: { ...card, version: 2 }, nodeId: 'n3', createdBy: 'device-A' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_CONFLICT' });

    roleAppend = { status: 200, body: { ok: true, card, nodeId: 'n4', createdBy: 'device-B' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_AUTHOR' });

    roleAppend = { status: 409, body: { ok: false, error: 'ROLE_CARD_CONFLICT', message: 'conflict' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_CONFLICT' });

    roleAppend = { status: 422, body: { ok: false, error: 'card_invalid', errors: ['bad'] } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_SCHEMA' });

    roleAppend = { status: 403, body: { ok: false, error: 'device_mismatch' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_AUTHOR' });

    roleAppend = { status: 400, body: { ok: false, error: 'namespace_invalid' } };
    await expect(store.append(card)).rejects.toMatchObject({ code: 'ROLE_CARD_SCHEMA' });

    roleAppend = { status: 500, body: { ok: false, error: 'unknown' } };
    await expect(store.append(card)).rejects.toThrow('appendRoleCard');

    roleAppend = { status: 500, body: { ok: false } };
    await expect(store.append(card)).rejects.toThrow('appendRoleCard');
  });

  it('DaemonRoleCardStore requires endpoint and list errors surface', async () => {
    expect(() => new DaemonRoleCardStore({ endpoint: '' })).toThrow('endpoint');
    resetReplies();
    // GET 使用 roleNodes；错误路径用独立 stub 覆盖。
    const listFailure = createServer((_req, res) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'list_failed' }));
    });
    await new Promise<void>((resolve) => listFailure.listen(0, '127.0.0.1', resolve));
    const failureBase = `http://127.0.0.1:${(listFailure.address() as AddressInfo).port}`;
    const failing = new DaemonRoleCardStore({ endpoint: failureBase });
    await expect(failing.listStored()).rejects.toThrow('listRoleCards');
    await failing.close();
    await new Promise<void>((resolve) => listFailure.close(() => resolve()));
  });

  it('DaemonAgentBackend covers daemon error and peer branches', async () => {
    resetReplies();
    expect(() => new DaemonAgentBackend({ endpoint: '' })).toThrow('endpoint');
    peersReply = {
      status: 200,
      body: {
        ok: true,
        peers: [
          { device: '', publicKeyHex: 'a'.repeat(64) },
          { device: 'device-B', publicKeyHex: 'not-hex' },
          { device: 'device-C', publicKeyHex: 'a'.repeat(64) },
        ],
      },
    };
    const backend = new DaemonAgentBackend({ endpoint: base });
    expect(await backend.listOnlineDevices()).toEqual(['device-C']);

    subscriptionsReply = { status: 200, body: { ok: true, namespaces: 'bad' } };
    expect(await backend.getSubscriptions('device-C')).toEqual([]);

    subscriptionsReply = { status: 500, body: { ok: false, error: 'nope' } };
    await expect(backend.getSubscriptions('device-C')).rejects.toThrow('getSubscriptions');

    nodesReply = { status: 500, body: { ok: false, error: 'nope' } };
    await expect(backend.listDirectories()).rejects.toThrow('listNodes');

    nodesReply = { status: 200, body: { ok: true, nodes: [
      { id: 'n1', type: 'agent_capability_card', namespace: 'agents', content: {}, metadata: {} },
      { id: 'n2', type: 'agent_capability_card', namespace: 'agents', content: {}, metadata: { internal: true, internalObject: { kind: 'other' } } },
      { id: 'n3', type: 'agent_capability_card', namespace: 'agents', content: {}, metadata: { internal: true, internalObject: { kind: 'agent_capability_card' } } },
    ] } };
    expect(await backend.listCards()).toEqual([]);

    nodeAppend = { status: 500, body: { ok: false, error: 'nope' } };
    await expect(backend.appendDirectory({ v: 1, device: 'device-A', agents: [], updatedAt: 1, version: 1 })).rejects.toThrow('createNode');

    const draft = compileCapabilityCards({
      config: { device: 'device-A', namespace: 'tasks', agents: [{ name: 'worker', kind: 'echo' }] },
      now: 1,
    })[0]!;
    cardReply = { status: 500, body: { ok: false, error: 'card_failed', message: 'no' } };
    await expect(backend.signAndAppendCard(draft)).rejects.toThrow('能力卡发布失败');

    cardReply = { status: 200, body: { ok: true, card: { ...draft, v: 2 } } };
    await expect(backend.signAndAppendCard(draft)).rejects.toMatchObject({ code: 'invalid_card' });
  });
});

describe('P6 card publisher hardening', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-p6-publisher-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function configFor(targetDir: string): FleetConfig {
    return {
      v: 1,
      device: 'device-A',
      dir: targetDir,
      storagePath: join(targetDir, 'store.jsonl'),
      masterKeyFile: join(targetDir, 'master-key.json'),
      namespace: 'tasks',
      peers: [],
      agents: [{ name: 'worker', kind: 'echo' }],
    } as unknown as FleetConfig;
  }

  it('publishes, records errors and reloads config safely', async () => {
    expect(() => new CapabilityCardPublisher({ config: configFor(dir) })).toThrow('需要 backend');

    const backend: FleetAgentBackend = {
      listCards: async () => [],
      signAndAppendCard: async (draft) => ({ ...draft, signature: { alg: 'ed25519', keyId: 'device-A', sig: 'x' } }) as never,
      listDirectories: async () => [],
      appendDirectory: async () => true,
    };
    const configPath = join(dir, 'fleet.config.json');
    await writeFile(configPath, '{}');
    const publisher = new CapabilityCardPublisher({
      backend,
      config: configFor(dir),
      configPath,
      checkIntervalMs: 0,
      log: () => undefined,
    });
    expect((await publisher.publish())?.errors).toEqual([]);
    expect(publisher.status().lastPublishedAt).not.toBeNull();
    expect(publisher.currentConfig().device).toBe('device-A');

    const errorBackend: FleetAgentBackend = {
      ...backend,
      signAndAppendCard: async () => { throw new Error('sign failed'); },
    };
    const errorPublisher = new CapabilityCardPublisher({ backend: errorBackend, config: configFor(dir), configPath, log: () => undefined });
    expect((await errorPublisher.publish())?.errors.length).toBeGreaterThan(0);
    expect(errorPublisher.status().lastError).toContain('sign failed');

    const throwingBackend: FleetAgentBackend = {
      ...backend,
      listCards: async () => { throw new Error('list failed'); },
    };
    const throwingPublisher = new CapabilityCardPublisher({ backend: throwingBackend, config: configFor(dir), configPath, log: () => undefined });
    expect(await throwingPublisher.publish()).toBeNull();
    expect(throwingPublisher.status().lastError).toContain('list failed');

    const missingPath = join(dir, 'missing.json');
    const missingPublisher = new CapabilityCardPublisher({ backend, config: configFor(dir), configPath: missingPath, checkIntervalMs: 0, log: () => undefined });
    await missingPublisher.tick();
    expect(missingPublisher.status().lastError).toContain('config stat');

    await publisher.tick();
    await publisher.tick();
    await writeFile(configPath, '{invalid');
    await utimes(configPath, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    await publisher.tick();
    expect(publisher.status().lastError).toContain('config reload');

    publisher.onRegistryChange();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('P6 routing provider hardening', () => {
  const store: TaskEventStore = {
    all: async () => [],
    byTask: async () => [],
    append: async () => true,
  } as unknown as TaskEventStore;

  it('embedded provider covers auth/online fallbacks', async () => {
    const mebular = {
      graph: { listNodes: async () => [] },
      identity: {},
      sync: { getOnlinePeers: () => { throw new Error('no sync'); } },
      getSubscriptions: async (device: string) => {
        if (device === 'device-B') return ['tasks'];
        if (device === 'device-C') throw new Error('unknown');
        return [];
      },
      getPeerPath: (device: string) => {
        if (device === 'device-C') return { state: 'open' };
        if (device === 'device-D') return null;
        throw new Error('path failed');
      },
    };
    const provider = embeddedRoutingProvider({
      mebular: mebular as never,
      config: { device: 'device-A', namespace: 'tasks', peers: [{ device: 'device-B' }, { device: 'device-C' }, { device: 'device-D' }, { device: 'device-E' }], roleCards: { enabled: true } } as never,
      store,
    });
    expect(await provider.authorized?.()).toEqual({ devices: ['device-A', 'device-B'] });
    expect(provider.roleCardMode).toBe('enabled');
    expect(provider.online?.('device-A')).toBe(true);
    expect(provider.online?.('device-C')).toBe(true);
    expect(provider.online?.('device-D')).toBe(false);
    expect(provider.online?.('device-E')).toBe(false);
    expect(await provider.observations?.()).toEqual([]);
    await expect(provider.cards?.()).resolves.toEqual([]);
    await expect(provider.roleCards?.()).resolves.toEqual([]);
  });

  it('daemon provider covers auth, onlineDevices and role card defaults', async () => {
    const backend = {
      listCards: async () => [],
      getSubscriptions: async (device: string) => {
        if (device === 'device-B') return ['tasks'];
        throw new Error('unknown');
      },
    };
    const provider = daemonRoutingProvider({
      backend,
      config: { device: 'device-A', namespace: 'tasks', peers: [{ device: 'device-B' }, { device: 'device-C' }], roleCards: { enabled: false } } as never,
      store,
      online: (device) => device === 'device-B',
      onlineDevices: async () => ['device-B', '', 42 as never],
    });
    expect(await provider.authorized?.()).toEqual({ devices: ['device-A', 'device-B'] });
    expect(provider.online?.('device-A')).toBe(true);
    expect(provider.online?.('device-B')).toBe(true);
    expect(provider.online?.('device-C')).toBe(false);
    expect(await provider.onlineDevices?.()).toEqual(['device-A', 'device-B']);
    await expect(provider.roleCards?.()).resolves.toEqual([]);
    await expect(provider.cards?.()).resolves.toEqual([]);
    await expect(provider.observations?.()).resolves.toEqual([]);

    const failing = daemonRoutingProvider({
      backend,
      config: { device: 'device-A', namespace: 'tasks', peers: [], roleCards: { enabled: true } } as never,
      store,
      onlineDevices: async () => { throw new Error('peers failed'); },
    });
    expect(await failing.onlineDevices?.()).toEqual(['device-A']);
    expect(failing.roleCardMode).toBe('enabled');
  });
});
