// P1：能力卡（agent_capability_card）schema / 发布 / 版本 / tombstone / 隐私 / internal 可见性。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import {
  AGENT_NAMESPACE,
  AGENT_TASK_TOOL_NAMES,
  CAPABILITY_CARD_KIND,
  CapabilityCardPublisher,
  PLAN_SENTINEL,
  TASK_TOOLS,
  activeCapabilityCards,
  agentDirectoryStore,
  appendCapabilityCard,
  capabilityCardFingerprint,
  compileCapabilityCards,
  fleetConfigPath,
  latestCapabilityCards,
  listCapabilityCards,
  loadFleetConfig,
  publishAgentDirectory,
  publishCapabilityCards,
  readMasterKeyFile,
  saveFleetConfig,
  signAgentCapabilityCard,
  toolByName,
  validateAgentCapabilityCard,
  validateFleetConfig,
  verifyAgentCapabilityCardSignature,
  type AgentCapabilityCard,
  type FleetAgentConfig,
  type FleetConfig,
} from '../../packages/fleet/src/index.js';
import { offlineMebularOptions, onboardDevice } from '../../packages/fleet/src/index.js';
import { MebularTaskEventStore } from '../../packages/fleet/src/index.js';
import { ExecutorRegistry, FleetWorker, EchoExecutor, ExecutionLog } from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

const ROOT = process.cwd();

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function fleetConfig(device: string, agents: FleetAgentConfig[], options: { namespace?: string; peers?: FleetConfig['peers'] } = {}): FleetConfig {
  return {
    v: 1,
    device,
    dir: join(tmpdir(), `fleet-cards-${device}`),
    storagePath: join(tmpdir(), `fleet-cards-${device}`, 'store.jsonl'),
    masterKeyFile: join(tmpdir(), `fleet-cards-${device}`, 'master-key.json'),
    namespace: options.namespace ?? 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: options.peers ?? [],
    agents,
  };
}

async function openMebular(dir: string, device: string): Promise<Mebular> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  return mebular;
}

function cardFromFixture(name: 'capability' | 'capabilityTombstone'): unknown {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'packages/fleet/protocol/card.example.json'), 'utf-8')) as Record<string, unknown>;
  return fixture[name];
}

describe('P1 fleet config：capabilities optional + __plan__ 保留名', () => {
  it('旧 config（无 capabilities）仍完全有效', () => {
    const legacy = fleetConfig('device-A', [{ name: 'echo', kind: 'echo' }]);
    expect(validateFleetConfig(legacy)).toEqual([]);
    const withOptional = fleetConfig('device-A', [{ name: 'worker', kind: 'echo', capabilities: ['code.write', 'review'] }]);
    expect(validateFleetConfig(withOptional)).toEqual([]);
  });

  it('capabilities 形状非法被拒', () => {
    const bad = fleetConfig('device-A', [{ name: 'worker', kind: 'echo', capabilities: ['ok', ''] }]);
    expect(validateFleetConfig(bad).join('; ')).toContain('agent.capabilities');
    const notArray = { ...bad, agents: [{ name: 'worker', kind: 'echo', capabilities: 'code.write' }] };
    expect(validateFleetConfig(notArray).join('; ')).toContain('agent.capabilities');
  });

  it('真实 device/agent/peer 不得使用保留名 __plan__', () => {
    expect(validateFleetConfig(fleetConfig(PLAN_SENTINEL, [{ name: 'echo', kind: 'echo' }])).join('; ')).toContain('device 不得使用保留名');
    expect(validateFleetConfig(fleetConfig('device-A', [{ name: PLAN_SENTINEL, kind: 'echo' }])).join('; ')).toContain('agent.name 不得使用保留名');
    expect(validateFleetConfig(fleetConfig('device-A', [{ name: 'echo', kind: 'echo' }], { peers: [{ device: PLAN_SENTINEL }] })).join('; ')).toContain('peer.device 不得使用保留名');
  });
});

describe('P1 能力卡 schema / 生成 / 隐私', () => {
  it('夹具 capability 与 tombstone 通过 schema 校验', () => {
    expect(validateAgentCapabilityCard(cardFromFixture('capability'))).toEqual({ ok: true, errors: [] });
    expect(validateAgentCapabilityCard(cardFromFixture('capabilityTombstone'))).toEqual({ ok: true, errors: [] });
  });

  it('schema 拒绝 allowSubcontract、未知工具与敏感字段', () => {
    const capability = cardFromFixture('capability') as Record<string, unknown>;
    const withAllow = { ...capability, permissions: { taskNamespaces: ['tasks'], allowSubcontract: true } };
    expect(validateAgentCapabilityCard(withAllow).ok).toBe(false);
    const withUnknownTool = { ...capability, tools: ['task_submit', 'agent_card_read'] };
    expect(validateAgentCapabilityCard(withUnknownTool).ok).toBe(false);
    const withCommand = { ...capability, command: '/usr/local/bin/agent' };
    expect(validateAgentCapabilityCard(withCommand).ok).toBe(false);
    const withEnv = { ...capability, runtime: { ...(capability.runtime as object), env: { TOKEN: 'x' } } };
    expect(validateAgentCapabilityCard(withEnv).ok).toBe(false);
  });

  it('从 config + registry + 运行环境编译：字段齐全、无 command/env、tools 对齐 16 方法', () => {
    const config = fleetConfig('device-A', [
      { name: 'worker', kind: 'command', command: '/secret/bin/agent', baseArgs: ['--token', 'shh'], capabilities: ['code.write', 'review', 'code.write'] },
      { name: 'echo', kind: 'echo' },
    ]);
    const registry = new ExecutorRegistry();
    registry.register('worker', new EchoExecutor());
    registry.register('echo', new EchoExecutor());
    const drafts = compileCapabilityCards({ config, registry, now: 1_700_000_000_000, runtime: { os: 'test-os', arch: 'test-arch', runtime: 'node', runtimeVersion: '22.x' } });
    expect(drafts.map((card) => card.agent)).toEqual(['echo', 'worker']);
    const worker = drafts.find((card) => card.agent === 'worker')!;
    expect(worker.kind).toBe(CAPABILITY_CARD_KIND);
    expect(worker.device).toBe('device-A');
    expect(worker.capabilities).toEqual(['code.write', 'fleet.task', 'review']);
    expect(worker.tools).toEqual([...AGENT_TASK_TOOL_NAMES]);
    expect(worker.permissions.taskNamespaces).toEqual(['tasks']);
    expect(worker.runtime).toEqual({ os: 'test-os', arch: 'test-arch', runtime: 'node', runtimeVersion: '22.x' });
    expect(worker.provenance.source).toBe('config+executor-registry+runtime');
    expect(worker.provenance.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(worker.provenance.registryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(worker.provenance.publishedAt).toBe(1_700_000_000_000);
    expect(JSON.stringify(drafts)).not.toMatch(/\/secret\/bin\/agent|--token|shh|"command"|"baseArgs"|"env"|allowSubcontract/);
    expect(new Set(AGENT_TASK_TOOL_NAMES).size).toBe(16);
    expect([...AGENT_TASK_TOOL_NAMES].sort()).toEqual(TASK_TOOLS.map((tool) => tool.name).sort());
  });

  it('指纹忽略 version/publishedAt 与数组顺序', () => {
    const config = fleetConfig('device-A', [{ name: 'worker', kind: 'echo', capabilities: ['b', 'a'] }]);
    const first = compileCapabilityCards({ config, now: 1 })[0]!;
    const second = { ...first, version: 9, provenance: { ...first.provenance, publishedAt: 2 }, capabilities: ['fleet.task', 'b', 'a'] };
    expect(capabilityCardFingerprint(first)).toBe(capabilityCardFingerprint(second));
  });
});

describe('P1 签名 / 发布 / 版本 / tombstone', () => {
  it('签名使用设备身份；同内容不重复发版；移除 agent 发 tombstone', async () => {
    const dir = await tempDir('fleet-cards-publish-');
    const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo', capabilities: ['code.write'] }];
    await onboardDevice({ dir, device: 'device-A', agents });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      const first = await publishCapabilityCards({ mebular, config, now: 100 });
      expect(first.errors).toEqual([]);
      expect(first.published).toBe(1);
      let cards = await listCapabilityCards(mebular);
      expect(cards).toHaveLength(1);
      const identity = mebular.identity.getDeviceKey('device-A')!;
      expect(await verifyAgentCapabilityCardSignature(cards[0]!, identity.publicKey)).toBe(true);
      expect(cards[0]!.signature.keyId).toBe('device-A');

      const second = await publishCapabilityCards({ mebular, config, now: 200 });
      expect(second.published).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(await listCapabilityCards(mebular)).toHaveLength(1);

      const changedConfig: FleetConfig = {
        ...config,
        agents: [{ name: 'worker', kind: 'echo', capabilities: ['code.write', 'review'] }],
      };
      const third = await publishCapabilityCards({ mebular, config: changedConfig, now: 300 });
      expect(third.published).toBe(1);
      cards = latestCapabilityCards(await listCapabilityCards(mebular));
      expect(cards[0]!.version).toBe(2);
      expect(cards[0]!.capabilities).toEqual(['code.write', 'fleet.task', 'review']);

      const removed = await publishCapabilityCards({ mebular, config: { ...changedConfig, agents: [] }, now: 400 });
      expect(removed.tombstoned).toBe(1);
      cards = latestCapabilityCards(await listCapabilityCards(mebular));
      expect(cards).toHaveLength(1);
      expect(cards[0]!.tombstone).toBe(true);
      expect(cards[0]!.version).toBe(3);
      expect(cards[0]!.capabilities).toEqual([]);
      expect(cards[0]!.tools).toEqual([]);
      expect(cards[0]!.limits).toEqual({});
      expect(cards[0]!.permissions.taskNamespaces).toEqual([]);

      const again = await publishCapabilityCards({ mebular, config: { ...changedConfig, agents: [] }, now: 500 });
      expect(again.tombstoned).toBe(0);
      expect(again.unchanged).toBe(0);
      expect(latestCapabilityCards(await listCapabilityCards(mebular))[0]!.version).toBe(3);
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无设备私钥时返回可观测错误，不伪造 signature', async () => {
    const dir = await tempDir('fleet-cards-nosigner-');
    const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo' }];
    await onboardDevice({ dir, device: 'device-A', agents });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      const unsigned = compileCapabilityCards({ config, now: 1 })[0]!;
      const fake = {
        graph: mebular.graph,
        identity: { getDeviceKey: () => undefined },
      } as unknown as Pick<Mebular, 'graph' | 'identity'>;
      const result = await publishCapabilityCards({ mebular: fake, config, now: 1 });
      expect(result.published).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('签名不可用');
      expect(await listCapabilityCards(mebular)).toHaveLength(0);
      // 直接签名同样必须失败，而不是写入空签名。
      await expect(signAgentCapabilityCard(fake, unsigned)).rejects.toThrow(/签名不可用/);
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Agent 目录：版本单调、同内容不重复发版、agent 移除更新目录', async () => {
    const dir = await tempDir('fleet-cards-dir-');
    const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo', capabilities: ['code.write'] }];
    await onboardDevice({ dir, device: 'device-A', agents });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      const first = await publishAgentDirectory(mebular, config, { now: 100 });
      expect(first.published).toBe(true);
      expect(first.version).toBe(1);
      const second = await publishAgentDirectory(mebular, config, { now: 200 });
      expect(second.published).toBe(false);
      expect(second.version).toBe(1);
      const changed = await publishAgentDirectory(mebular, {
        ...config,
        agents: [{ name: 'worker', kind: 'echo', capabilities: ['review'] }],
      }, { now: 300 });
      expect(changed.published).toBe(true);
      expect(changed.version).toBe(2);
      const removed = await publishAgentDirectory(mebular, { ...config, agents: [] }, { now: 400 });
      expect(removed.published).toBe(true);
      expect(removed.version).toBe(3);
      expect(removed.entry.agents).toEqual([]);
      const entries = await agentDirectoryStore(mebular, AGENT_NAMESPACE).all();
      expect(entries.some((entry) => entry.version === 3 && entry.agents.length === 0)).toBe(true);
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P1 自动发布：配置变更 + agent 注册变化', () => {
  it('publisher 启动发布；注册变化与配置 mtime 变化后重发且失败不抛出', async () => {
    const dir = await tempDir('fleet-cards-publisher-');
    const agents: FleetAgentConfig[] = [
      { name: 'worker', kind: 'echo', capabilities: ['code.write'] },
      { name: 'reviewer', kind: 'echo' },
    ];
    await onboardDevice({ dir, device: 'device-A', agents });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      const registry = new ExecutorRegistry();
      registry.register('worker', new EchoExecutor());
      const publisher = new CapabilityCardPublisher({ mebular, config, registry, checkIntervalMs: 0, log: () => undefined });
      registry.onChange(() => publisher.onRegistryChange());
      await publisher.publish();
      expect((await listCapabilityCards(mebular)).some((card) => card.agent === 'worker')).toBe(true);
      expect((await listCapabilityCards(mebular)).some((card) => card.agent === 'reviewer')).toBe(true);
      // tick 首次只记录 mtime 基线。
      await publisher.tick();

      const beforeRegistry = latestCapabilityCards(await listCapabilityCards(mebular)).find((card) => card.agent === 'worker')!;
      registry.register('reviewer', new EchoExecutor());
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const worker = latestCapabilityCards(await listCapabilityCards(mebular)).find((card) => card.agent === 'worker');
        if (worker !== undefined && worker.version > beforeRegistry.version) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const afterRegistry = latestCapabilityCards(await listCapabilityCards(mebular)).find((card) => card.agent === 'worker')!;
      expect(afterRegistry.version).toBeGreaterThan(beforeRegistry.version);

      await saveFleetConfig(fleetConfigPath(dir), {
        ...config,
        agents: [
          { name: 'worker', kind: 'echo', capabilities: ['code.write', 'review'] },
          { name: 'reviewer', kind: 'echo' },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await publisher.tick();
      const worker = latestCapabilityCards(await listCapabilityCards(mebular)).find((card) => card.agent === 'worker')!;
      expect(worker.capabilities).toEqual(['code.write', 'fleet.task', 'review']);
      expect(worker.version).toBeGreaterThan(afterRegistry.version);
      expect(publisher.status().lastError).toBeNull();
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P1 internal 可见性：记忆列表/搜索/域计数', () => {
  it('能力卡是 internal 节点，不出现在普通记忆读面或域计数', async () => {
    const dir = await tempDir('fleet-cards-internal-');
    const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo' }];
    await onboardDevice({ dir, device: 'device-A', agents });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      await publishCapabilityCards({ mebular, config, now: 100 });
      const raw = await mebular.graph.listNodes({ type: CAPABILITY_CARD_KIND });
      expect(raw).toHaveLength(1);
      expect(raw[0]!.namespace).toBe(AGENT_NAMESPACE);
      expect(raw[0]!.metadata).toMatchObject({ internal: true, internalObject: { kind: CAPABILITY_CARD_KIND } });

      const service = new MemoryService(mebular);
      const listed = await service.listRecords({ namespace: AGENT_NAMESPACE });
      expect(listed.total).toBe(0);
      expect(listed.nodes).toEqual([]);
      const search = await service.search({ query: 'worker', domains: [AGENT_NAMESPACE] });
      expect(search.memories).toEqual([]);
      const stats = await service.namespaceStats({ includeReserved: true });
      const agentsDomain = stats.find((entry) => entry.domain === AGENT_NAMESPACE)!;
      expect(agentsDomain).toMatchObject({ count: 0, memoryRecords: 0, internalObjects: 1 });
      expect(agentsDomain.internalKinds[CAPABILITY_CARD_KIND]).toBe(1);
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P1 task_targets.cards additive + 旧调用 + __plan__ worker', () => {
  it('task_targets 保留旧 targets（字段/顺序），cards 只做 additive 摘要', async () => {
    const dir = await tempDir('fleet-cards-targets-');
    await onboardDevice({
      dir,
      device: 'device-A',
      agents: [{ name: 'worker', kind: 'echo' }],
      peerDevice: 'device-B',
    });
    const mebular = await openMebular(dir, 'device-A');
    try {
      const config = await loadFleetConfig(fleetConfigPath(dir));
      await agentDirectoryStore(mebular, AGENT_NAMESPACE).append({
        v: 1,
        device: 'device-B',
        agents: [{ name: 'echo', kind: 'echo' }, { name: 'worker', kind: 'echo', capabilities: ['code.write'] }],
        updatedAt: 1,
        version: 1,
      });
      const unsigned = compileCapabilityCards({
        config: fleetConfig('device-B', [{ name: 'echo', kind: 'echo', capabilities: ['code.write'] }]),
        now: 1,
      })[0]!;
      const card: AgentCapabilityCard = {
        ...unsigned,
        signature: { alg: 'Ed25519', keyId: 'device-B', sig: 'test-signature-not-verified' },
      };
      await appendCapabilityCard(mebular, card);
      const store = new MebularTaskEventStore(mebular, { namespace: 'tasks' });
      await store.append(mkEvent('created', 'task-inflight', {
        to: { device: 'device-B', agent: 'echo' },
        intent: 'queued-to-B',
      }));

      const app = {
        deviceId: 'device-A',
        graph: mebular.graph,
        getSubscriptions: async (device: string) => (device === 'device-B' ? ['tasks'] : []),
        getPeerPath: (device: string) => (device === 'device-B' ? { kind: 'direct', address: 'test', since: 1 } : null),
        shutdown: async () => undefined,
      };
      const result = await toolByName('task_targets')!.handler({}, { dir, mebular: app as never }) as {
        ok: boolean;
        targets: Array<Record<string, unknown>>;
        cards: Array<Record<string, unknown>>;
      };
      expect(result.ok).toBe(true);
      expect(result.targets).toEqual([
        { device: 'device-B', agent: 'echo', kind: 'echo' },
        { device: 'device-B', agent: 'worker', kind: 'echo' },
      ]);
      expect(result.cards).toEqual([
        {
          device: 'device-B',
          agent: 'echo',
          version: 1,
          capabilities: ['code.write', 'fleet.task'],
          online: true,
          inflight: 1,
        },
      ]);

      const submit = await toolByName('task_submit')!.handler(
        { intent: 'old-explicit-to', to: { device: 'device-B', agent: 'worker' } },
        { dir, mebular: app as never },
      ) as { ok: boolean; taskId: string; state: { to: { device: string; agent: string }; from: { device: string } } };
      expect(submit.ok).toBe(true);
      expect(submit.state.to).toEqual({ device: 'device-B', agent: 'worker' });
      expect(submit.state.from.device).toBe('device-A');
      expect(submit.taskId).toMatch(/^task-device-A-/);
      expect(TASK_TOOLS).toHaveLength(16);
      expect(TASK_TOOLS.some((tool) => /^(plan|agent_card)_/.test(tool.name))).toBe(false);
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('旧 worker 显式跳过 __plan__ root task：不执行、不写 failed', async () => {
    const dir = await tempDir('fleet-cards-plan-sentinel-');
    const mebular = await openMebular(await (async () => {
      await onboardDevice({ dir, device: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
      return dir;
    })(), 'device-B');
    try {
      const store = new MebularTaskEventStore(mebular, { namespace: 'tasks' });
      const root = mkEvent('created', 'plan-demo#1#root', {
        to: { device: PLAN_SENTINEL, agent: PLAN_SENTINEL },
        intent: 'plan-root',
      });
      await store.append(root);
      const registry = new ExecutorRegistry();
      registry.register('echo', new EchoExecutor());
      const log = await ExecutionLog.open(join(dir, 'exec.jsonl'));
      const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport: { publish: async () => undefined, drain: async () => [], close: async () => undefined }, registry, log });
      await worker.pollOnce();
      expect(log.size()).toBe(0);
      const states = await worker.statesView();
      expect(states.find((state) => state.taskId === 'plan-demo#1#root')?.status).toBe('queued');
    } finally {
      await mebular.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P1 能力卡读取工具', () => {
  it('activeCapabilityCards 排除 tombstone；latest 按版本取最大', () => {
    const base = compileCapabilityCards({ config: fleetConfig('device-A', [{ name: 'worker', kind: 'echo' }]), now: 1 })[0]!;
    const signed = (version: number, tombstone = false): AgentCapabilityCard => ({
      ...base,
      version,
      tombstone,
      signature: { alg: 'Ed25519', keyId: 'device-A', sig: 'x' },
    });
    const cards = [signed(1), signed(3), signed(2), signed(4, true)];
    expect(latestCapabilityCards(cards)[0]!.version).toBe(4);
    expect(activeCapabilityCards(latestCapabilityCards(cards))).toEqual([]);
  });
});
